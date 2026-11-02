'use strict';

const assert = require('node:assert');
const EventEmitter = require('node:events');

const CoraDB = require('../../index');
const ErrorMessages = require('../../src/constants/ErrorMessages');

/**
 * `abort()` without a database.
 *
 * What it has to guarantee is the part that cannot be tested against a real
 * server without hanging the suite: that nothing is left waiting. A statement
 * the engine has already started cannot be called back, so the driver's job is
 * to stop waiting for it — the request in flight is failed, the requests
 * queued behind it are failed as the queue drains, and the connection can be
 * opened again afterwards.
 */

/** Stands in for the socket, which `abort()` destroys. */
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

/** A connection that believes it is logged in, without a database behind it. */
function openConnection() {
  const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');

  conn._socket = fakeSocket();
  conn.connectionOpened = true;
  // What a real login leaves behind; the packets write it as bytes.
  conn._CASInfo = Buffer.from([0, 255, 255, 255]);
  conn.brokerInfo = { dbType: 1, protocolVersion: 9, statementPolling: 1 };

  return conn;
}

describe('test_CoraDBConnection.abort', function () {
  it('fails the request that was in flight', async function () {
    const conn = openConnection();
    let reported;

    // What the driver holds while it waits for the socket to answer.
    conn._socketCurrentEventCallback = (err) => {
      reported = err;
    };

    await conn.abort();

    assert.ok(reported instanceof Error);
    assert.equal(reported.code, 'ABORTED');
  });

  it('carries the reason it was given', async function () {
    const conn = openConnection();
    let reported;

    conn._socketCurrentEventCallback = (err) => {
      reported = err;
    };

    await conn.abort('The user pressed Cancel.');

    assert.equal(reported.message, 'The user pressed Cancel.');
  });

  it('destroys the socket and closes the connection', async function () {
    const conn = openConnection();
    const socket = conn._socket;

    await conn.abort();

    assert.equal(socket.destroyed, true);
    assert.equal(conn.connectionOpened, false);
  });

  it('fails the requests queued behind it rather than dropping them', async function () {
    const conn = openConnection();
    // Nothing settles these; before `abort()` they would wait for ever,
    // because emptying the queue does not answer what was in it.
    const queued = [
      conn.queryAll('select 1'),
      conn.queryAll('select 2'),
      conn.batchExecuteNoQuery(['update t set a = 1']),
    ];

    await conn.abort('stopped');

    const outcomes = await Promise.allSettled(queued);

    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.reason.code, 'ABORTED');
    }
  });

  it('empties the queue rather than leaving work in it', async function () {
    const conn = openConnection();

    conn.queryAll('select 1').catch(() => undefined);
    conn.queryAll('select 2').catch(() => undefined);

    await conn.abort();

    // An abort is not meant to be the end of the object: nothing is left
    // queued, so the connection can be opened and used again.
    assert.equal(conn._queue.items.length, 0);
  });

  it('answers requests that never reached the socket', async function () {
    const conn = openConnection();
    // Queued behind nothing in particular — what matters is that they had not
    // started. Before the queue could report a failure these were discarded
    // silently and their callers waited for ever.
    const queued = [conn.rollback(), conn.getQueryPlan('select 1')];

    await conn.abort('stopped');

    for (const outcome of await Promise.allSettled(queued)) {
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.reason.code, 'ABORTED');
    }
  });

  it('answers a caller that used a callback rather than a promise', async function () {
    const conn = openConnection();
    // The callback is invoked asynchronously, as it would be for any other
    // outcome, so the test waits for it rather than reading a variable.
    const told = new Promise((resolve) => {
      conn.queryAll('select 1', [], resolve);
    });

    await conn.abort();

    const reported = await told;

    assert.ok(reported instanceof Error);
    assert.equal(reported.code, 'ABORTED');
  });

  it('is safe with nothing in flight and no socket', async function () {
    const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');

    await conn.abort();

    assert.equal(conn.connectionOpened, false);
  });

  it('forgets the query handles, which belong to the CAS that has gone', async function () {
    const conn = openConnection();

    conn._queryResultSets = { 1: {}, 2: {} };

    await conn.abort();

    assert.deepEqual(conn._queryResultSets, {});
  });

  it('says ERROR_ABORTED when given no reason', async function () {
    const conn = openConnection();
    let reported;

    conn._socketCurrentEventCallback = (err) => {
      reported = err;
    };

    await conn.abort();

    assert.equal(reported.message, ErrorMessages.ERROR_ABORTED);
  });
});

describe('test_CoraDBConnection.cancel', function () {
  it('cannot ask the broker before the connection has logged in', function () {
    const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');

    assert.equal(conn.canBrokerCancel(), false);
  });

  it('can ask the broker once it knows the CAS process', function () {
    const conn = openConnection();

    conn._casProcessId = 4242;
    conn._cancelHost = { host: 'localhost', port: 33000 };

    assert.equal(conn.canBrokerCancel(), true);
    assert.equal(conn.getCasProcessId(), 4242);
  });

  it('aborts when the broker cannot be asked', async function () {
    const conn = openConnection();
    const outcome = await conn.cancel();

    assert.equal(outcome.method, 'abort');
    assert.equal(conn.connectionOpened, false);
  });

  it('aborts when told not to ask the broker', async function () {
    const conn = openConnection();

    conn._casProcessId = 4242;
    conn._cancelHost = { host: 'localhost', port: 33000 };

    const outcome = await conn.cancel({ brokerCancel: false });

    assert.equal(outcome.method, 'abort');
  });

  it('falls back to an abort when the broker does not answer', async function () {
    const conn = openConnection();

    conn._casProcessId = 4242;
    // A port with nothing on it: the connection is refused, which is one of
    // the ways the broker cancel can fail. The statement still has to stop.
    conn._cancelHost = { host: '127.0.0.1', port: 1 };

    const outcome = await conn.cancel({ timeout: 300 });

    assert.equal(outcome.method, 'abort');
    assert.equal(conn.connectionOpened, false);
  });
});

/**
 * `close()` shares the queue-draining half of `abort()`: it, too, used to
 * throw away requests that had not started yet without telling their callers,
 * which left those callers waiting on a promise that could never settle.
 */
describe('test_CoraDBConnection.close', function () {
  it('tells the requests it drops why', async function () {
    const conn = openConnection();
    const queued = [conn.queryAll('select 1'), conn.rollback()];

    // `close()` itself waits for the server to answer its close packet, which
    // the fake socket never does. What is under test is what it did to the
    // work it found waiting, which it settles before writing anything.
    conn.close().catch(() => undefined);

    for (const outcome of await Promise.allSettled(queued)) {
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.reason.message, ErrorMessages.ERROR_CLOSED_WHILE_QUEUED);
    }
  });

  it('leaves nothing waiting in the queue', function () {
    const conn = openConnection();

    conn.queryAll('select 1').catch(() => undefined);
    conn.queryAll('select 2').catch(() => undefined);
    conn.close().catch(() => undefined);

    assert.equal(conn._queue.items.length, 0);
  });

  it('is safe on a connection that was never opened', async function () {
    const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');

    await conn.close();
  });
});
