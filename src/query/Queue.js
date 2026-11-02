module.exports = Queue;

function Queue() {
  this.items = [];
  /** Whether a turn of the loop is already booked. */
  this.scheduled = false;
  /**
   * Who is enqueueing, while it is enqueueing: set around a call by whatever
   * wants to find its own requests again later (a request with a timeout or
   * an AbortSignal), and recorded on every item pushed meanwhile.
   */
  this.context = undefined;
}

/**
 * Add a request to the back of the queue.
 *
 * `onDrop` is how the request reports failure if it is removed before it ever
 * runs. Without it a dropped request simply disappears: the promise its caller
 * is waiting on is never settled, and that caller waits for ever.
 *
 * @param item the work, called with a `done` callback
 * @param onDrop optional `(err) => void`, called if the item is dropped
 */
Queue.prototype.push = function (item, onDrop) {
  this.items.push({ run: item, onDrop: onDrop, context: this.context });
  this.process();
};

/**
 * The same, at the front. See `push`.
 *
 * With a `key` (a query handle's fetches and close), it goes behind the
 * waiting requests with the same key rather than in front of them. Two
 * `fetch()` calls on one handle used to swap places — the second jumped ahead
 * of the first — so the caller got the rows in the wrong order, and a close
 * made after a fetch ran before it.
 */
Queue.prototype.unshift = function (item, onDrop, key) {
  const entry = { run: item, onDrop: onDrop, context: this.context, key: key };
  let at = 0;

  if (key !== undefined) {
    for (let i = this.items.length - 1; i >= 0; --i) {
      if (this.items[i].key === key) {
        at = i + 1;
        break;
      }
    }
  }

  this.items.splice(at, 0, entry);
  this.process();
};

/**
 * The reason a dropped request is given: its own copy when it is an Error.
 * One instance used to go to every request dropped together, and each caller
 * could change it — the request in flight stamped its own SQL on it
 * (`err.statement`), and the queued ones then reported that statement as
 * theirs.
 */
function ownCopy(reason) {
  if (!(reason instanceof Error)) {
    return reason;
  }

  // A real Error (as `util.inspect` and `assert` know one), of the same class.
  const copy = new Error(reason.message);

  Object.setPrototypeOf(copy, Object.getPrototypeOf(reason));

  for (const key of Reflect.ownKeys(reason)) {
    Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(reason, key));
  }

  return copy;
}

/**
 * Remove the waiting requests that were enqueued under `context`, telling each
 * one why. The running request is not touched: see `empty()`.
 *
 * @return {number} how many were removed
 */
Queue.prototype.drop = function (context, reason) {
  const keep = [];
  const gone = [];

  for (const item of this.items) {
    (item.context === context ? gone : keep).push(item);
  }

  this.items = keep;

  for (const item of gone) {
    if (typeof item.onDrop === 'function') {
      try {
        item.onDrop(ownCopy(reason));
      } catch (err) {
        void err;
      }
    }
  }

  return gone.length;
};

/** Whether the running request was enqueued under `context`. */
Queue.prototype.isRunning = function (context) {
  return Boolean(this.currentItem) && this.currentItem.context === context;
};

Queue.prototype.process = function () {
  if (!this.currentItem && this.items.length && !this.scheduled) {
    // The front item is deliberately not taken off the list yet.
    // `setImmediate` leaves a gap between choosing an item and running it, and
    // an item taken off early sits in that gap belonging to nobody: still
    // waiting, but no longer something `empty()` can find and answer. It is
    // taken below, at the moment it actually starts, so `currentItem` means
    // "running" and everything else is in the list.
    this.scheduled = true;

    /*
    * From http://stackoverflow.com/a/15349865/556678.
    * Use `setImmediate` if you want to queue the function
    * behind whatever I/O event callbacks that are already
    * in the event queue. Use `process.nextTick` to effectively
    * queue the function at the head of the event queue so
    * that it executes immediately after the current function
    * completes.
    * So in a case where you're trying to break up a long
    * running, CPU-bound job using recursion, you would now
    * want to use `setImmediate` rather than `process.nextTick`
    * to queue the next iteration as otherwise any I/O event
    * callbacks wouldn't get the chance to run between iterations.
    * */
    setImmediate(() => {
      this.scheduled = false;

      // It may have been emptied, or another item may have started, in the
      // time it took to get here.
      if (this.currentItem || !this.items.length) {
        return;
      }

      const item = this.items.shift();
      this.currentItem = item;

      let released = false;
      const done = () => {
        // Once only, and only for this item: a slot that both throws and
        // later calls `done` must not release whatever runs after it.
        if (released || this.currentItem !== item) return;
        released = true;
        this.currentItem = null;
        this.process();
      };

      // Every item is a function which calls the callback we pass when done.
      // A synchronous throw out of one used to escape `setImmediate` as an
      // uncaught exception and leave `currentItem` set for ever, so no other
      // request could start. Now the item is told it failed, and the queue
      // moves on.
      try {
        item.run(done);
      } catch (err) {
        if (typeof item.onDrop === 'function') {
          try {
            item.onDrop(err);
          } catch (e) {
            void e;
          }
        }
        done();
      }
    });
  }
};

/**
 * Take the queue for the caller, now, when nothing is running.
 *
 * For work that must start at once and must not have another request start
 * beside it (`close()` on an idle connection). Returns the function that gives
 * the queue back, or null when a request is running — the caller then
 * enqueues instead.
 */
Queue.prototype.claim = function () {
  if (this.currentItem) {
    return null;
  }

  const item = { run: null, onDrop: undefined, context: undefined };
  let released = false;

  this.currentItem = item;

  return () => {
    if (released || this.currentItem !== item) return;
    released = true;
    this.currentItem = null;
    this.process();
  };
};

Queue.prototype.getDepth = function () {
  return this.items.length + (this.currentItem ? 1 : 0);
};

Queue.prototype.isEmpty = function () {
  return this.items.length === 0 && !this.currentItem;
};

/**
 * Remove every request that has not started, telling each one why.
 *
 * Note that this does not stop the request already running: that one owns the
 * socket, and only the caller that took the socket down can answer it.
 *
 * @param reason an Error handed to each dropped request. Omitting it drops
 *               them silently, which is what every caller did before they
 *               could say anything — and is how a waiting caller ends up
 *               waiting for ever.
 */
Queue.prototype.empty = function (reason) {
  const dropped = this.items;

  this.items = [];

  if (!reason) {
    return;
  }

  for (const item of dropped) {
    if (typeof item.onDrop !== 'function') {
      continue;
    }

    try {
      item.onDrop(ownCopy(reason));
    } catch (err) {
      // A request that refuses its own failure must not stop the rest of the
      // queue from being told.
      void err;
    }
  }
};
