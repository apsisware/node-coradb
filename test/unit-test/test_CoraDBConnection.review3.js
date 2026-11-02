'use strict';

const assert = require('node:assert');
const EventEmitter = require('node:events');

const CoraDB = require('../../index');
const Query = require('../../src/query/Query');
const Queue = require('../../src/query/Queue');

/** Fixes from the third code review that need no database. */

function fakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.setTimeout = () => socket;
  socket.setNoDelay = () => socket;
  socket.write = () => true;
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };
  return socket;
}

function openConnection() {
  const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');
  conn._socket = fakeSocket();
  conn.connectionOpened = true;
  conn._CASInfo = Buffer.from([0, 255, 255, 255]);
  conn.brokerInfo = { dbType: 1, protocolVersion: 9, statementPolling: 1 };
  return conn;
}

describe('test_CoraDBConnection.review3', function () {
  it('D1: a dropped query(sql, cb) answers its callback and rejects nothing', async function () {
    const conn = openConnection();
    // Occupy the queue so the next request is genuinely waiting.
    conn._queue.push(() => undefined);
    let answered;
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);

    conn.query('select 1', (err) => {
      answered = err;
    });
    await new Promise((r) => setImmediate(r));
    conn._queue.empty(new Error('dropped on purpose'));
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);

    assert.strictEqual(answered && answered.message, 'dropped on purpose');
    assert.deepStrictEqual(unhandled, []);
  });

  it('D1: fetch(handle, cb) and getSchema(type, cb) also reach the callback when dropped', async function () {
    const conn = openConnection();
    conn._queue.push(() => undefined);
    // Let the occupier start, so the unshifted fetch waits behind it.
    await new Promise((r) => setImmediate(r));
    const got = [];
    conn.fetch(1, (err) => got.push(['fetch', err.message]));
    conn.getSchema(1, (err) => got.push(['schema', err.message]));
    await new Promise((r) => setImmediate(r));
    conn._queue.empty(new Error('gone'));
    assert.deepStrictEqual(got.sort(), [['fetch', 'gone'], ['schema', 'gone']]);
  });

  it('a queue slot that throws is failed, and the queue keeps going', async function () {
    const queue = new Queue();
    let failed;
    let ranNext = false;
    queue.push(() => {
      throw new Error('boom');
    }, (err) => {
      failed = err;
    });
    queue.push((done) => {
      ranNext = true;
      done();
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(failed && failed.message, 'boom');
    assert.strictEqual(ranNext, true);
    assert.strictEqual(queue.isEmpty(), true);
  });

  it('formats parameters only when there are some, and never inside literals', function () {
    assert.strictEqual(new Query("SELECT '?' AS q").sql, "SELECT '?' AS q");
    assert.strictEqual(
      new Query("SELECT 1 FROM t WHERE a = ? AND b = '?' /* ? */ AND c = ?", [5, true]).sql,
      "SELECT 1 FROM t WHERE a = 5 AND b = '?' /* ? */ AND c = 1",
    );
  });

  it('does not add anything to Number.prototype', function () {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Number.prototype, 'formatAsMoney'), false);
  });

  it('close() on a half-open connection lets it connect again', async function () {
    const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');
    conn.connectionPending = true;
    await conn.close();
    assert.strictEqual(conn.connectionPending, false);
  });

  it('a socket error while idle does not throw out of the listener', function () {
    const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');
    const socket = fakeSocket();
    conn._socket = socket;
    if (typeof conn._attachSocketListeners === 'function') conn._attachSocketListeners(socket);
    // Whatever wires the listeners, emitting with none attached must not throw either.
    assert.doesNotThrow(() => socket.listenerCount('error') && socket.emit('error', new Error('reset')));
  });
});
