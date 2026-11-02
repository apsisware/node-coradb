'use strict';

const assert = require('node:assert');
const Net = require('node:net');

const CoraDB = require('../../index');
const CASConstants = require('../../src/constants/CASConstants');
const OpenDatabasePacket = require('../../src/packets/OpenDatabasePacket');
const PacketReader = require('../../src/packets/PacketReader');

/**
 * `cancel()` on the wire.
 *
 * A cancel is the one request this driver sends that does not travel on the
 * connection's own socket, and it is also the one nothing in a normal run
 * checks: a cancel that is silently wrong does not fail, it simply does not
 * stop the statement, and the caller never learns the difference because the
 * fallback abort stops it anyway — by closing the connection and rolling the
 * transaction back. So the bytes, the address and the process id are asserted
 * here against a listener that answers the way a CAS does.
 */

/** A stand-in for the CAS listener: records the request, answers as told. */
function fakeListener(answer) {
  const received = [];
  const server = Net.createServer((socket) => {
    socket.on('data', (data) => {
      received.push(data);

      const reply = Buffer.alloc(4);

      reply.writeInt32BE(answer, 0);
      socket.write(reply);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      received,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

/** A connection that believes it is logged in, without a database behind it. */
function openConnection() {
  const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');

  conn._socket = null;
  conn.connectionOpened = true;
  conn._CASInfo = Buffer.from([0, 255, 255, 255]);

  return conn;
}

/** The login reply as the broker lays it out, so the parse can be checked. */
function loginReply({ responseCode, sessionId }) {
  const buffer = Buffer.alloc(4 + 4 + 4 + 8 + 4);
  let at = 0;

  buffer.writeInt32BE(16, at); at += 4;          // response length
  buffer.writeInt32BE(0, at); at += 4;           // casInfo
  buffer.writeInt32BE(responseCode, at); at += 4;
  // brokerInfo: dbType, reserved, statement polling, pconnect, version, ...
  Buffer.from([1, 1, 1, 0, CASConstants.CAS_PROTOCOL_VERSION, 0, 0, 0]).copy(buffer, at);
  at += 8;
  buffer.writeInt32BE(sessionId, at);

  return buffer;
}

describe('test_CoraDBConnection.cancel wire format', function () {
  it('tells the login response code apart from the session id', function () {
    // These are two different numbers, and the cancel names the first. Reading
    // the second instead asks the listener about a process it has never heard
    // of, which it answers by doing nothing at all.
    const packet = new OpenDatabasePacket({ logger: { debug() {} } });
    const reader = new PacketReader();

    reader.write(loginReply({ responseCode: 4242, sessionId: 777 }));
    packet.parse(reader);

    assert.equal(packet.responseCode, 4242);
    assert.equal(packet.sessionId, 777);
    // The name that used to carry the session id under a process id's name.
    assert.equal(packet.casProcessId, undefined);
  });

  it('sends the ten bytes to the listener, naming the CAS process', async function () {
    const listener = await fakeListener(0);
    const conn = openConnection();

    conn._casProcessId = 0x01020304;
    conn._cancelHost = { host: '127.0.0.1', port: listener.port };

    const outcome = await conn.cancel();

    assert.equal(outcome.method, 'broker');

    const request = Buffer.concat(listener.received);

    assert.deepEqual(
      [...request],
      [0x58, 0x31, CASConstants.CAS_VERSION, 0, 0, 0, 0x01, 0x02, 0x03, 0x04]
    );

    await listener.stop();
  });

  it('leaves the connection and its transaction alone when accepted', async function () {
    // The whole point of asking rather than aborting: the statement stops, the
    // session lives, and uncommitted work is still there to commit.
    const listener = await fakeListener(0);
    const conn = openConnection();

    conn._casProcessId = 4242;
    conn._cancelHost = { host: '127.0.0.1', port: listener.port };

    const outcome = await conn.cancel();

    assert.equal(outcome.method, 'broker');
    assert.equal(conn.connectionOpened, true);

    await listener.stop();
  });

  it('reads a negative answer as a refusal and aborts instead', async function () {
    // -1019 is CAS_ER_QUERY_CANCEL. A refusal is not a cancel, so the blunt
    // instrument has to follow; the alternative is a statement that runs on.
    const listener = await fakeListener(-1019);
    const conn = openConnection();

    conn._casProcessId = 4242;
    conn._cancelHost = { host: '127.0.0.1', port: listener.port };

    const outcome = await conn.cancel();

    assert.equal(outcome.method, 'abort');
    assert.equal(conn.connectionOpened, false);

    await listener.stop();
  });

  it('takes any non-negative answer as done', async function () {
    // The listener answers with a code, not a boolean; only the sign is the
    // verdict. Insisting on zero turned successful cancels into aborts.
    const listener = await fakeListener(1);
    const conn = openConnection();

    conn._casProcessId = 4242;
    conn._cancelHost = { host: '127.0.0.1', port: listener.port };

    const outcome = await conn.cancel();

    assert.equal(outcome.method, 'broker');

    await listener.stop();
  });
});
