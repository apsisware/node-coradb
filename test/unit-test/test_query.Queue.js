'use strict';

const assert = require('node:assert');
const Queue = require('../../src/query/Queue');

/**
 * The request queue.
 *
 * One request at a time goes to the database, so everything else waits here.
 * The part worth testing is what happens to those waiting requests when they
 * are thrown away: each one is a promise somebody is waiting on, and a queue
 * that discards them without a word leaves those callers waiting for ever.
 */
describe('test_query.Queue', function () {
  /** An item that never finishes, so it holds the queue open. */
  const blocking = () => () => undefined;

  it('runs one item at a time, in order', function (done) {
    const queue = new Queue();
    const ran = [];

    queue.push((finish) => {
      ran.push('a');
      finish();
    });
    queue.push((finish) => {
      ran.push('b');
      finish();
    });
    queue.push(() => {
      ran.push('c');
      assert.deepEqual(ran, ['a', 'b', 'c']);
      done();
    });
  });

  it('counts what is waiting and what is running', function (done) {
    const queue = new Queue();

    assert.equal(queue.isEmpty(), true);
    assert.equal(queue.getDepth(), 0);

    queue.push(blocking());
    queue.push(blocking());

    setImmediate(() => {
      // One running, one still waiting.
      assert.equal(queue.getDepth(), 2);
      assert.equal(queue.isEmpty(), false);
      done();
    });
  });

  it('tells each dropped request why', function (done) {
    const queue = new Queue();
    const told = [];
    const reason = new Error('the connection went');

    queue.push(blocking());

    setImmediate(() => {
      queue.push(blocking(), (err) => told.push(err));
      queue.push(blocking(), (err) => told.push(err));

      queue.empty(reason);

      assert.deepEqual(told, [reason, reason]);
      done();
    });
  });

  it('leaves the running request alone — it owns the socket', function (done) {
    const queue = new Queue();
    let dropped = false;

    queue.push(blocking(), () => {
      dropped = true;
    });

    setImmediate(() => {
      queue.empty(new Error('gone'));

      // Only the caller that took the socket down can answer that one.
      assert.equal(dropped, false);
      assert.equal(queue.items.length, 0);
      done();
    });
  });

  it('drops silently when given no reason, as it always did', function (done) {
    const queue = new Queue();
    let told = false;

    queue.push(blocking());

    setImmediate(() => {
      queue.push(blocking(), () => {
        told = true;
      });

      queue.empty();

      assert.equal(told, false);
      assert.equal(queue.items.length, 0);
      done();
    });
  });

  it('carries on telling the rest when one refuses its failure', function (done) {
    const queue = new Queue();
    const told = [];

    queue.push(blocking());

    setImmediate(() => {
      queue.push(blocking(), () => {
        throw new Error('I will not hear it');
      });
      queue.push(blocking(), () => told.push('second'));

      queue.empty(new Error('gone'));

      assert.deepEqual(told, ['second']);
      done();
    });
  });

  it('accepts an item with no way to report a failure', function (done) {
    const queue = new Queue();

    queue.push(blocking());

    setImmediate(() => {
      queue.push(blocking());
      // Nothing to call, and nothing to crash on.
      queue.empty(new Error('gone'));
      assert.equal(queue.items.length, 0);
      done();
    });
  });

  it('puts an urgent request at the front', function (done) {
    const queue = new Queue();
    const ran = [];

    queue.push((finish) => {
      ran.push('first');
      setImmediate(finish);
    });

    setImmediate(() => {
      queue.push((finish) => {
        ran.push('back');
        finish();
        assert.deepEqual(ran, ['first', 'front', 'back']);
        done();
      });
      queue.unshift((finish) => {
        ran.push('front');
        finish();
      });
    });
  });
});
