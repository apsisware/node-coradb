'use strict';

const assert = require('node:assert');
const Net = require('node:net');

const CoraDB = require('../../index');
const Helpers = require('../../src/utils/Helpers');
const OpenDatabasePacket = require('../../src/packets/OpenDatabasePacket');
const PacketReader = require('../../src/packets/PacketReader');
const PacketWriter = require('../../src/packets/PacketWriter');
const PrepareExecutePacket = require('../../src/packets/PrepareExecutePacket');
const ExecuteQueryPacket = require('../../src/packets/ExecuteQueryPacket');
const ValueDecoder = require('../../src/packets/ValueDecoder');
const { fakeCas, Out, columnInfo, errorReply } = require('./helpers/fakeCas');

/*
 * The fixes from the fourth code review (D1–D19, the numbers contract, and
 * the items it left unconfirmed). Most of them are about what happens on the
 * wire when a connection is lost, so most run against the pretend CAS over a
 * real socket.
 */

const CAS = CoraDB.CASConstants;
const FC = CAS.CASFunctionCode;
const T = CAS.CoraDBDataType;
const ROLLBACK = CAS.CCITransactionType.CCI_TRAN_ROLLBACK;

const PEOPLE = {
  columns: [['id', 'int'], ['name', 'string']],
  rows: [[1, 'Ann'], [2, 'Bob'], [3, 'Cid'], [4, 'Dan'], [5, null]],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(test, ms = 1000) {
  const until = Date.now() + ms;

  while (!test()) {
    if (Date.now() > until) {
      throw new Error('waitFor: timed out');
    }

    await sleep(5);
  }
}

/** Fails with a message if `promise` has not settled within `ms`. */
function within(promise, ms, what) {
  let timer;

  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function answer(sql) {
  if (/\bfrom people\b/i.test(sql)) return PEOPLE;
  if (/^\s*select\s+1\b/i.test(sql)) return { columns: [['1', 'int']], rows: [[1]] };
  if (/victim/i.test(sql)) return { error: { code: -72, message: 'Your transaction has been aborted (deadlock victim).' } };
  if (/^\s*(update|insert|delete)\b/i.test(sql)) return { affected: 1 };
  return { affected: 0 };
}

function int32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

describe('test_CoraDBConnection.review4', function () {
  this.timeout(5000);

  let cas;
  let conn;
  const servers = [];

  const open = (extra) => {
    conn = CoraDB.createConnection(Object.assign(
      { host: `127.0.0.1:${cas.port}`, user: 'dba', password: '', database: 'demodb' },
      extra
    ));
    return conn;
  };

  afterEach(async function () {
    if (conn) conn.abort();
    conn = undefined;
    if (cas) await cas.close();
    cas = undefined;
    while (servers.length) {
      const s = servers.pop();
      await new Promise((r) => s.close(() => r()));
    }
  });

  /** A raw TCP server for the cases the pretend CAS cannot act out. */
  async function rawServer(onSocket, options) {
    const sockets = new Set();
    const server = Net.createServer(options || {}, (s) => {
      sockets.add(s);
      s.on('error', () => undefined);
      s.on('close', () => sockets.delete(s));
      onSocket(s);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const close = server.close.bind(server);
    server.close = (cb) => {
      for (const s of sockets) s.destroy();
      close(cb);
    };
    servers.push(server);
    return server;
  }

  describe('D1: handles do not survive their session', function () {
    it('a prepared statement from before a reconnect fails STATEMENT_CLOSED and runs nothing', async function () {
      cas = await fakeCas({ handlesPerSession: true, onQuery: answer });
      open();

      const archive = await conn.prepare('update orders set archived = 1 where id = ?');
      await archive.run([10]);

      cas.dropAll();
      await waitFor(() => !conn.connectionOpened);

      // The new session hands out the same handle number.
      const wipe = await conn.prepare('delete from orders where customer_id = ?');
      assert.strictEqual(wipe._prepared.queryHandle, archive._prepared.queryHandle);

      await assert.rejects(archive.run([42]), { code: 'STATEMENT_CLOSED' });

      const executed = cas.log.filter((e) => e.fc === FC.CAS_FC_EXECUTE).map((e) => e.sql);
      assert.deepStrictEqual(executed, ['update orders set archived = 1 where id = ?']);

      // Closing the old one must not close the new session's handle.
      await archive.close();
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_CLOSE_REQ_HANDLE && e.session === 2));

      assert.strictEqual((await wipe.run([1])).affectedRows, 1);
    });

    it('a cursor from before a reconnect neither fetches nor closes the new session\'s handle', async function () {
      cas = await fakeCas({ handlesPerSession: true, fetchSize: 2, onQuery: answer });
      open();

      const cursor = await conn.cursor('select * from people');
      assert.strictEqual((await cursor.next()).length, 2);

      cas.dropAll();
      await waitFor(() => !conn.connectionOpened);

      const other = await conn.query('select * from people where 2 = 2');
      // The new session gave out the same server number; the caller's handle
      // for it is a different one (see M6 in test_CoraDBConnection.fixes.js).
      assert.strictEqual(other._handle, cursor._handle);
      assert.notStrictEqual(other.queryHandle, cursor._handle);

      await assert.rejects(cursor.next(), { code: 'NO_ACTIVE_QUERY' });
      await cursor.close();

      const session2 = cas.log.filter((e) => e.session === 2).map((e) => e.fc);
      assert.ok(!session2.includes(FC.CAS_FC_FETCH));
      assert.ok(!session2.includes(FC.CAS_FC_CLOSE_REQ_HANDLE));
      // The new session's handle is still there to use.
      assert.strictEqual((await conn.fetch(other.queryHandle)).result.ColumnValues.length, 2);
    });

    it('forgets the handles when the socket closes, and fetch() then refuses without reconnecting', async function () {
      cas = await fakeCas({ fetchSize: 2, onQuery: answer });
      open();

      const r = await conn.query('select * from people');
      cas.dropAll();
      await waitFor(() => !conn.connectionOpened);

      assert.deepStrictEqual(conn._queryResultSets, {});
      await assert.rejects(conn.fetch(r.queryHandle), { code: 'NO_ACTIVE_QUERY' });
      assert.strictEqual(cas.logins(), 1);
    });
  });

  describe('D2, D15, D16, D17: the text formatter', function () {
    it('writes a negative number in parentheses, so `-?` never becomes a comment', function () {
      assert.strictEqual(
        Helpers._sqlFormat('UPDATE acct SET bal = bal-? WHERE id = ?', [-5, 7]),
        'UPDATE acct SET bal = bal-(-5) WHERE id = 7'
      );
      assert.strictEqual(Helpers._sqlFormat('SELECT ?-?', [-5n, -1.5]), 'SELECT (-5)-(-1.5)');
      assert.strictEqual(Helpers._sqlFormat('SELECT ?, ?', [0, 12]), 'SELECT 0, 12');
      assert.throws(() => Helpers._sqlFormat('SELECT ?', [NaN]), { code: 'INVALID_PARAMETER' });
      assert.throws(() => Helpers._sqlFormat('SELECT ?', [Infinity]), { code: 'INVALID_PARAMETER' });
    });

    it('pads milliseconds to three digits', function () {
      const sql = Helpers._sqlFormat('SELECT ?', [new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 7))]);
      assert.strictEqual(sql, "SELECT '1/2/2024 3:4:5.007'");
    });

    it('skips `//` comments, so a quote or ? in one does not shift the parameters', function () {
      assert.strictEqual(
        Helpers._sqlFormat("SELECT 1 // don't ?\nFROM t WHERE a = ? AND b = 'x'", ['v']),
        "SELECT 1 // don't ?\nFROM t WHERE a = 'v' AND b = 'x'"
      );
      assert.strictEqual(Helpers._sqlFormat("SELECT 'http://x?' , ?", [1]), "SELECT 'http://x?' , 1");
    });

    it('escapes only the quote, by doubling it; backslashes and newlines are left alone', function () {
      assert.strictEqual(
        Helpers._sqlFormat('INSERT INTO t VALUES (?)', ["it's a\\path\nline2\t\"q\""]),
        "INSERT INTO t VALUES ('it''s a\\path\nline2\t\"q\"')"
      );
      assert.strictEqual(Helpers._escapeString("a'b\"c", '"'), 'a\'b""c');
      assert.throws(() => Helpers._sqlFormat('SELECT ?', ['a\0b']), { code: 'INVALID_PARAMETER' });
    });
  });

  describe('D3, D12: transaction()', function () {
    it('fails with TRANSACTION_LOST when the session drops part-way, and commits nothing', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await assert.rejects(conn.transaction(async (tx) => {
        await tx.sql('update acct set bal = bal - 100 where id = 1');
        cas.dropAll();
        await waitFor(() => !conn.connectionOpened);
        await tx.sql('update acct set bal = bal + 100 where id = 2');
        return 'ok';
      }), { code: 'TRANSACTION_LOST' });

      assert.ok(!cas.log.some((e) => e.sql === 'update acct set bal = bal + 100 where id = 2'));
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_END_TRAN));
      assert.strictEqual(conn.getAutoCommitMode(), true);

      // The connection is usable again afterwards, on a new session.
      assert.strictEqual((await conn.sql('select 1')).rowCount, 1);
      assert.strictEqual(cas.logins(), 2);
    });

    it('refuses to commit on a session other than the one it began in', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await assert.rejects(conn.transaction(async (tx) => {
        await tx.sql('update a set n = 1');
        cas.dropAll();
        await waitFor(() => !conn.connectionOpened);
        await tx.connect(); // an explicit reconnect, by someone
        await tx.sql('update b set n = 2');
      }), { code: 'TRANSACTION_LOST' });

      const ends = cas.log.filter((e) => e.fc === FC.CAS_FC_END_TRAN).map((e) => [e.session, e.type]);
      // No commit anywhere; the new session's statement is rolled back.
      assert.deepStrictEqual(ends, [[2, ROLLBACK]]);
    });

    it('with auto-commit off, a lost session fails later requests until rollback()', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await conn.setAutoCommitMode(false);
      await conn.sql('update a set n = 1');
      cas.dropAll();
      await waitFor(() => !conn.connectionOpened);

      await assert.rejects(conn.sql('update a set n = 2'), { code: 'TRANSACTION_LOST' });
      await assert.rejects(conn.commit(), { code: 'TRANSACTION_LOST' });
      assert.strictEqual(cas.logins(), 1);

      await conn.rollback();
      await conn.sql('update a set n = 3');
      assert.strictEqual(cas.logins(), 2);
      assert.deepStrictEqual(cas.log.filter((e) => e.sql).map((e) => e.sql), ['update a set n = 1', 'update a set n = 3']);
      assert.strictEqual(conn.getAutoCommitMode(), false);
    });

    it('leaves statements queued before it in their own mode', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.connect();

      const a = conn.sql("insert into audit values ('login')");
      const b = conn.transaction(async (tx) => {
        await tx.sql('update acct set bal = 0');
        throw new Error('business rule failed');
      });

      await a;
      await assert.rejects(b, /business rule failed/);

      const sent = cas.log.filter((e) => e.sql).map((e) => [e.sql, e.autoCommit]);
      assert.deepStrictEqual(sent, [["insert into audit values ('login')", 1], ['update acct set bal = 0', 0]]);
    });

    it('setAutoCommitMode() takes effect in queue order and resolves once it has', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.connect();

      const before = conn.sql('update a set n = 1');
      const change = conn.setAutoCommitMode(false);
      const after = conn.sql('update a set n = 2');

      await change;
      assert.strictEqual(conn.getAutoCommitMode(), false);
      await Promise.all([before, after]);

      assert.deepStrictEqual(cas.log.filter((e) => e.sql).map((e) => e.autoCommit), [1, 0]);
      await conn.rollback();
    });
  });

  describe('-72: a deadlock victim inside a transaction', function () {
    it('makes transaction() fail TRANSACTION_ROLLED_BACK (retryable), even when fn caught it', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      let caught;

      await assert.rejects(conn.transaction(async (tx) => {
        await tx.sql('update a set n = 1');
        caught = await tx.sql('update victim set n = 2').catch((e) => e);
        await tx.sql('update b set n = 3');
        return 'done';
      }), (err) => {
        assert.strictEqual(err.code, 'TRANSACTION_ROLLED_BACK');
        assert.strictEqual(err.retryable, true);
        assert.strictEqual(err.cause.code, -72);
        return true;
      });

      // The statement on its own is not worth retrying: its transaction is gone.
      assert.strictEqual(caught.code, -72);
      assert.strictEqual(caught.retryable, false);
      assert.strictEqual(caught.transactionRolledBack, true);
      assert.ok(!CoraDB.isRetryable(caught));

      const ends = cas.log.filter((e) => e.fc === FC.CAS_FC_END_TRAN).map((e) => e.type);
      assert.deepStrictEqual(ends, [ROLLBACK]);
    });

    it('stays retryable with auto-commit on, where the statement was the whole transaction', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await assert.rejects(conn.sql('update victim set n = 2'), (err) => err.code === -72 && err.retryable === true);
    });
  });

  describe('D4, D5, D10, D11: losing the socket answers everyone', function () {
    it('D4: a clean close (FIN) fails the request in flight and the queue behind it', async function () {
      cas = await fakeCas({ onQuery: (sql) => (/die/.test(sql) ? { close: true } : answer(sql)) });
      open();
      let disconnects = 0;
      conn.on('disconnect', () => disconnects++);
      await conn.connect();

      const first = conn.sql('select die');
      const queued = conn.sql('select 1');

      await within(assert.rejects(first, { code: 'CONNECTION_CLOSED' }), 1000, 'in-flight request');
      await within(assert.rejects(queued, { code: 'CONNECTION_CLOSED' }), 1000, 'queued request');
      // The request in flight was the first of its transaction, so it was run
      // once more on a new connection, as the JDBC driver does — and the
      // server closed that one too.
      assert.strictEqual(cas.log.filter((e) => e.sql === 'select die').length, 2);
      assert.strictEqual(disconnects, 2);
      assert.strictEqual(conn.getQueueLength(), 0);

      // The next request reconnects.
      assert.strictEqual((await conn.sql('select 1')).rowCount, 1);
    });

    for (const mode of ['reset', 'end']) {
      it(`D5: a ${mode} during the login on a reused socket fails connect() instead of hanging`, async function () {
        const server = await rawServer((s) => {
          let stage = 0;
          s.on('data', () => {
            if (stage++ === 0) return s.write(Buffer.from([0, 0, 0, 0])); // keep this socket
            if (mode === 'reset') s.resetAndDestroy(); else s.end();
          });
        });
        conn = CoraDB.createConnection({ host: `127.0.0.1:${server.address().port}`, user: 'dba', database: 'db' });

        await within(assert.rejects(conn.connect()), 1000, 'connect');
        assert.strictEqual(conn.connectionPending, false);
        // Not CONNECTION_ALREADY_PENDING: a later connect really tries again.
        await within(assert.rejects(conn.connect(), (e) => e.code !== 'CONNECTION_ALREADY_PENDING'), 1000, 'second connect');
      });
    }

    it('D5: a login that gets no answer times out', async function () {
      const server = await rawServer((s) => {
        let stage = 0;
        s.on('data', () => {
          if (stage++ === 0) s.write(Buffer.from([0, 0, 0, 0]));
          // ...and then silence.
        });
      });
      conn = CoraDB.createConnection({ host: `127.0.0.1:${server.address().port}`, user: 'dba', database: 'db', connectionTimeout: 100 });

      await within(assert.rejects(conn.connect(), { code: 'ETIMEDOUT' }), 1000, 'connect');
      assert.strictEqual(conn.connectionPending, false);
    });

    it('D10: a reply that cannot be parsed fails the request, not the process', async function () {
      cas = await fakeCas({
        onQuery: (sql) => (/broken/.test(sql)
          ? { columns: [['a', 'int'], ['b', 'int']], rows: [[{ raw: int32(1), size: 1000 }, 2]] }
          : answer(sql)),
      });
      open();
      await conn.connect();

      const broken = conn.sql('select broken');
      const queued = conn.sql('select 1');

      await assert.rejects(broken, { code: 'PROTOCOL_ERROR' });
      await assert.rejects(queued, { code: 'CONNECTION_CLOSED' });
      assert.strictEqual(conn.connectionOpened, false);
      assert.strictEqual((await conn.sql('select 1')).rowCount, 1);
    });

    it('D11: close() while a request is still connecting answers that request', async function () {
      const server = await rawServer(() => undefined); // never answers the client-info exchange
      conn = CoraDB.createConnection({ host: `127.0.0.1:${server.address().port}`, user: 'dba', database: 'db' });

      const pending = conn.sql('select 1');
      const queued = conn.sql('select 2');
      await sleep(30);
      await conn.close();

      await within(assert.rejects(pending, { code: 'CONNECTION_CLOSED' }), 500, 'connecting request');
      await within(assert.rejects(queued, { code: 'CLOSED_WHILE_QUEUED' }), 500, 'queued request');
      assert.strictEqual(conn.connectionPending, false);
      await waitFor(() => conn.getQueueLength() === 0);
    });
  });

  describe('D6: connect after a failed connect', function () {
    it('tries every host again from the start', async function () {
      const probe = Net.createServer();
      await new Promise((r) => probe.listen(0, '127.0.0.1', r));
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));

      conn = CoraDB.createConnection({ host: `127.0.0.1:${port}`, user: 'dba', database: 'db' });
      await assert.rejects(conn.connect(), (e) => e.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(e.message)));

      cas = await fakeCas({ port, onQuery: answer });
      await conn.connect();
      assert.strictEqual((await conn.sql('select 1')).rowCount, 1);
    });
  });

  describe('D7: lobWrite', function () {
    it('appends at a non-zero offset, and fails rather than loops when nothing is written', async function () {
      const writes = [];
      let acceptNothing = false;
      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_LOB_WRITE]: (body) => {
            let at = 0;
            const handleLength = body.readInt32BE(at);
            at += 4 + handleLength + 4;
            const off = Number(body.readBigInt64BE(at));
            at += 8;
            const dl = body.readInt32BE(at);
            writes.push({ off, data: body.subarray(at + 4, at + 4 + dl).toString() });
            return new Out().int(acceptNothing ? 0 : dl).reply();
          },
        },
      });
      open();

      const lob = { packedLobHandle: Buffer.alloc(20), lobLength: 0, lobType: T.CCI_U_TYPE_CLOB, fileLocator: 'x' };
      await conn.lobWrite(lob, 0, 'hello ');
      await within(conn.lobWrite(lob, lob.lobLength, 'world'), 1000, 'second write');
      assert.deepStrictEqual(writes, [{ off: 0, data: 'hello ' }, { off: 6, data: 'world' }]);
      assert.strictEqual(lob.lobLength, 11);

      acceptNothing = true;
      writes.length = 0;
      await within(assert.rejects(conn.lobWrite(lob, 11, 'more'), { code: 'LOB_WRITE_FAILED' }), 1000, 'stalled write');
      assert.strictEqual(writes.length, 1);
      assert.strictEqual(lob.lobLength, 11);
    });
  });

  describe('D8, D9, contract C: values', function () {
    it('D8: reads SMALLINT signed, on the text and the bound path', async function () {
      const columns = [['s', 'short'], ['i', 'int']];
      cas = await fakeCas({ onQuery: () => ({ columns, rows: [[-1, 42], [-32768, 7]] }), columnsOf: () => columns });
      open();

      assert.deepStrictEqual((await conn.sql('select s, i from t')).rows, [{ s: -1, i: 42 }, { s: -32768, i: 7 }]);
      assert.deepStrictEqual((await conn.sql('select s, i from t where x = ?', [1])).rows, [{ s: -1, i: 42 }, { s: -32768, i: 7 }]);
    });

    it('D9: skips what it cannot decode by its size, and never returns an Error as a value', async function () {
      const columns = [['g', T.CCI_U_TYPE_GRAPH_OBJECT], ['d', 'double'], ['u', 99], ['seq', T.CCI_U_TYPE_SEQUENCE], ['i', 'int']];
      const seq = Buffer.concat([Buffer.from([T.CCI_U_TYPE_INT]), int32(2), int32(4), int32(10), int32(4), int32(20)]);
      const binary = Buffer.from([0xff, 0x00, 0x01]);
      cas = await fakeCas({
        onQuery: () => ({
          columns,
          rows: [
            [{ raw: Buffer.from('{"label":"Person","id":1}\0') }, 1.5, { raw: Buffer.from([1, 2, 3]) }, { raw: seq }, 7],
            [{ raw: binary }, 2.5, { raw: Buffer.from([4]) }, null, 8],
          ],
        }),
      });
      open();

      const { rows } = await conn.sql('MATCH (p:Person) RETURN p');

      assert.strictEqual(rows[0].g, '{"label":"Person","id":1}');
      assert.deepStrictEqual(rows[1].g, { type: 'GraphObject', raw: binary });
      assert.deepStrictEqual(rows[0].u, { type: 'Unknown', typeCode: 99, raw: Buffer.from([1, 2, 3]) });
      assert.deepStrictEqual(rows[0].seq, [10, 20]);
      assert.deepStrictEqual(rows.map((r) => [r.d, r.i]), [[1.5, 7], [2.5, 8]]);

      for (const row of rows) {
        for (const value of Object.values(row)) {
          assert.ok(!(value instanceof Error));
        }
      }
    });

    it('D9: reads the time-zone types on the bound-parameter path too', async function () {
      const dt = Buffer.alloc(14);
      [2024, 3, 10, 12, 0, 0, 0].forEach((v, i) => dt.writeInt16BE(v, i * 2));
      const value = Buffer.concat([dt, Buffer.from('Europe/Bucharest\0')]);
      const columns = [['t', T.CCI_U_TYPE_DATETIMETZ], ['i', 'int']];
      cas = await fakeCas({ onQuery: () => ({ columns, rows: [[{ raw: value }, 42]] }), columnsOf: () => columns });
      open();

      for (const r of [await conn.sql('select t, i from t'), await conn.sql('select t, i from t where a = ?', [1])]) {
        assert.strictEqual(r.rows[0].i, 42);
        assert.match(r.rows[0].t.toString(), /^2024-03-10 12:00:00\.000 Europe\/Bucharest$/);
      }
    });

    it('C: BIGINT outside the safe range and inexact NUMERIC come back as strings', async function () {
      const columns = [['b', 'bigint'], ['n', 'numeric']];
      cas = await fakeCas({
        onQuery: () => ({
          columns,
          rows: [
            ['9007199254740993', '123.40'],
            ['-9223372036854775808', '12345678901234567890'],
            [42, '0.1'],
            ['9007199254740991', '0.1000000000000000055511151231257827'],
          ],
        }),
      });
      open();

      const { rows } = await conn.sql('select b, n from t', { rowsAs: 'arrays' });
      assert.deepStrictEqual(rows, [
        ['9007199254740993', 123.4],
        ['-9223372036854775808', '12345678901234567890'],
        [42, 0.1],
        [9007199254740991, '0.1000000000000000055511151231257827'],
      ]);
    });

    it('C: the number rules on their own', function () {
      assert.strictEqual(ValueDecoder.bigintValue(2n ** 53n), '9007199254740992');
      assert.strictEqual(ValueDecoder.bigintValue(-(2n ** 53n) + 1n), -9007199254740991);
      assert.strictEqual(ValueDecoder.numericValue('-0.000'), -0);
      assert.strictEqual(ValueDecoder.numericValue('00012.50'), 12.5);
      assert.strictEqual(ValueDecoder.numericValue('1e400'), '1e400');
      assert.strictEqual(ValueDecoder.numericValue('0.0000001'), 1e-7);
      assert.strictEqual(ValueDecoder.numericValue('100000000000000000000000'), 1e23);
      assert.strictEqual(ValueDecoder.numericValue('123456789012345678901234'), '123456789012345678901234');
    });
  });

  describe('D13: close()', function () {
    it('closes the session even when closing a handle fails', async function () {
      cas = await fakeCas({
        onQuery: answer,
        handlers: { [FC.CAS_FC_CLOSE_REQ_HANDLE]: () => errorReply({ code: -1006, message: 'Invalid server handle' }) },
      });
      open();

      await conn.query('select * from people');
      await conn.query('select * from people where 1 = 1');
      await within(conn.close(), 1000, 'close');

      const fcs = cas.log.map((e) => e.fc);
      assert.deepStrictEqual(fcs.slice(-3), [FC.CAS_FC_CLOSE_REQ_HANDLE, FC.CAS_FC_CLOSE_REQ_HANDLE, FC.CAS_FC_CON_CLOSE]);
      assert.strictEqual(conn.connectionOpened, false);
      assert.strictEqual(conn._socket, null);
    });

    it('waits for the request already running instead of writing beside it', async function () {
      cas = await fakeCas({ onQuery: async (sql) => { await sleep(60); return answer(sql); } });
      open();
      await conn.connect();

      const running = conn.sql('select * from people');
      await sleep(10);
      await conn.close();

      assert.strictEqual((await running).rowCount, 5);
      assert.strictEqual(cas.log[cas.log.length - 1].fc, FC.CAS_FC_CON_CLOSE);
    });
  });

  describe('D14: a late timeout cancel', function () {
    it('does not abort the connection once the timed-out request has given way to the next one', async function () {
      cas = await fakeCas({
        onQuery: async (sql) => {
          if (/slowA/.test(sql)) await sleep(120);
          if (/slowB/.test(sql)) await sleep(300);
          return answer(sql);
        },
        // The broker takes the cancel and never answers it.
        onCancel: (socket) => setTimeout(() => socket.destroy(), 200),
      });
      open();
      await conn.connect();
      assert.ok(conn.canBrokerCancel());

      let aborts = 0;
      const abort = conn.abort.bind(conn);
      conn.abort = (...args) => {
        aborts += 1;
        return abort(...args);
      };

      const a = conn.sql('select slowA from people', { timeoutMs: 50 });
      const b = conn.sql('select slowB from people');

      await assert.rejects(a, { code: 'TIMEOUT' });
      assert.strictEqual((await b).rowCount, 5);
      await sleep(20);

      assert.ok(cas.log.some((e) => e.cancel), 'the broker was asked while A was running');
      assert.strictEqual(aborts, 0);
      assert.strictEqual(conn.connectionOpened, true);
    });

    it('cancel({ onlyWhile }) interrupts nothing once the test fails', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.connect();

      assert.deepStrictEqual(await conn.cancel({ onlyWhile: () => false }), { method: 'none' });
      assert.strictEqual(conn.connectionOpened, true);
      assert.ok(!cas.log.some((e) => e.cancel));
    });
  });

  describe('D18: getSchema()', function () {
    it('closes the handle the schema request opened', async function () {
      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_SCHEMA_INFO]: () => new Out().int(77).int(1).int(0).reply(),
          [FC.CAS_FC_FETCH]: (body) => {
            if (body.readInt32BE(4) !== 77) return undefined;
            return new Out().int(0).int(1).int(1).bytes(8).str('people').int(2).short(2).str('').reply();
          },
        },
      });
      open();

      const tables = await conn.getSchema(CoraDB.SchemaType.CCI_SCH_CLASS);
      assert.strictEqual(tables[0].Name, 'people');

      const closes = cas.log.filter((e) => e.fc === FC.CAS_FC_CLOSE_REQ_HANDLE).map((e) => e.handle);
      assert.deepStrictEqual(closes, [77]);
    });
  });

  describe('D19: login fields', function () {
    it('are written as UTF-8', function () {
      const p = new OpenDatabasePacket({ database: 'demodb', user: 'dba', password: 'pässwörd' });
      const w = new PacketWriter(p.getBufferLength());
      p.write(w);
      assert.strictEqual(w._buffer.length, p.getBufferLength());
      assert.deepStrictEqual(w._buffer.subarray(64, 64 + 10), Buffer.concat([Buffer.from('pässwörd'), Buffer.alloc(0)]));
      assert.strictEqual(w._buffer[64 + 10], 0);
    });

    it('longer than 31 bytes are refused before anything is sent', async function () {
      assert.throws(() => new OpenDatabasePacket({ database: 'd', user: 'u', password: 'p'.repeat(32) }).write(new PacketWriter(628)), { code: 'INVALID_PARAMETER' });
      new OpenDatabasePacket({ database: 'd', user: 'u', password: 'p'.repeat(31) }).write(new PacketWriter(628));

      cas = await fakeCas({ onQuery: answer });
      open({ password: 'ä'.repeat(16) }); // 32 bytes
      await assert.rejects(conn.connect(), { code: 'INVALID_PARAMETER' });
      assert.ok(!conn._socket);
      assert.strictEqual(conn.connectionPending, false);
      assert.strictEqual(cas.log.length + cas.logins(), 0);
    });
  });

  describe('the unconfirmed items', function () {
    it('include_column_info on EXECUTE is read, not skipped over', function () {
      const out = new Out()
        .int(1) // rows
        .byte(0) // cache reusable
        .int(1).byte(CAS.CoraDBStatementType.CORADB_STMT_SELECT).int(1).bytes(8).int(0).int(0) // one result info
        .byte(1) // include_column_info
        .int(0).byte(CAS.CoraDBStatementType.CORADB_STMT_SELECT).int(1).byte(0).int(1);
      columnInfo(out, ['v', 'int']);
      out.int(0) // shard id
        .int(0).int(1) // fetch code, tuple count
        .int(1).bytes(8).int(4).int(42); // one row

      const packet = new PrepareExecutePacket({ protocolVersion: 7 });
      Object.assign(packet, { statementType: CAS.CoraDBStatementType.CORADB_STMT_SELECT, columnCount: 0, infoArray: [] });

      const reader = new PacketReader();
      reader.write(out.reply());
      assert.strictEqual(packet.parseExecute(reader), undefined);
      assert.deepStrictEqual(packet.resultSet.ColumnNames, ['v']);
      assert.deepStrictEqual(packet.resultSet.ColumnValues, [[42]]);
      assert.strictEqual(reader._bytesRemaining(), 0);
    });

    it('a two-byte collection type keeps the collection and its element type', function () {
      const out = new Out().int(5).int(0).byte(CAS.CoraDBStatementType.CORADB_STMT_SELECT).int(0).byte(0).int(2);
      // SET OF INT, then a plain STRING sent as two bytes.
      out.byte(0x80 | 0x20).byte(T.CCI_U_TYPE_INT).short(0).int(0).str('tags').str('tags').str('t').byte(1).int(0);
      for (let i = 0; i < 7; ++i) out.byte(0);
      out.byte(0x80).byte(T.CCI_U_TYPE_STRING).short(0).int(0).str('name').str('name').str('t').byte(1).int(0);
      for (let i = 0; i < 7; ++i) out.byte(0);

      const packet = new PrepareExecutePacket({ protocolVersion: 7 });
      const reader = new PacketReader();
      reader.write(out.reply());
      packet.parsePrepare(reader);

      assert.strictEqual(packet.infoArray[0].ColumnType, T.CCI_U_TYPE_SET);
      assert.strictEqual(packet.infoArray[0].CollectionElementType, T.CCI_U_TYPE_INT);
      assert.strictEqual(packet.infoArray[1].ColumnType, T.CCI_U_TYPE_STRING);

      const set = Buffer.concat([Buffer.from([T.CCI_U_TYPE_INT]), int32(2), int32(4), int32(1), int32(4), int32(2)]);
      const name = Buffer.from('Ann\0');
      const row = Buffer.concat([int32(1), Buffer.alloc(8), int32(set.length), set, int32(name.length), name]);
      const rows = new PacketReader();
      rows.write(row);
      packet.currentTupleCount = 0;
      assert.deepStrictEqual(packet.getValues(rows, 1), [[[1, 2], 'Ann']]);
    });

    it('a late close from the broker socket after a redirect leaves the new connection alone', async function () {
      cas = await fakeCas({ skipClientInfo: true, onQuery: answer });
      let brokerSocket;
      const broker = await rawServer((s) => {
        brokerSocket = s;
        s.once('data', () => s.write(int32(cas.port)));
      }, { allowHalfOpen: true });
      conn = CoraDB.createConnection({ host: `127.0.0.1:${broker.address().port}`, user: 'dba', database: 'db' });

      await conn.connect();
      assert.strictEqual(conn.connectionOpened, true);

      brokerSocket.end(); // only now does the old socket close
      await sleep(30);

      assert.strictEqual(conn.connectionOpened, true);
      assert.strictEqual((await conn.sql('select 1')).rowCount, 1);
      assert.strictEqual(cas.logins(), 1);
    });

    it('small values are copied out of the reply instead of pinning it', function () {
      const reply = Buffer.alloc(64 * 1024); // not from the shared pool
      reply.writeInt32BE(4, 0);
      const reader = new PacketReader();
      reader.write(reply);

      const head = reader._parseBytes(8);
      assert.notStrictEqual(head.buffer, reply.buffer);

      const bits = ValueDecoder.readValue(reader, T.CCI_U_TYPE_VARBIT, 3);
      assert.ok(Buffer.isBuffer(bits));
      assert.notStrictEqual(bits.buffer, reply.buffer);

      const lob = Buffer.alloc(64 * 1024);
      lob.writeInt32BE(T.CCI_U_TYPE_BLOB, 0);
      lob.writeBigInt64BE(5n, 4);
      lob.writeInt32BE(2, 12);
      lob.write('x\0', 16);
      const lobReader = new PacketReader();
      lobReader.write(lob);
      const blob = lobReader.readBlob(18);
      assert.notStrictEqual(blob.packedLobHandle.buffer, lob.buffer);
      assert.strictEqual(blob.fileLocator, 'x');
    });

    it('ExecuteQueryPacket and PrepareExecutePacket read rows with the same decoder', function () {
      assert.strictEqual(ExecuteQueryPacket.prototype.getValues.length, PrepareExecutePacket.prototype.getValues.length);
      for (const P of [ExecuteQueryPacket, PrepareExecutePacket]) {
        const p = new P({ logger: { debug() {} } });
        Object.assign(p, { infoArray: [{ ColumnType: 77 }, { ColumnType: T.CCI_U_TYPE_INT }], columnCount: 2, currentTupleCount: 0 });
        const r = new PacketReader();
        r.write(Buffer.concat([int32(1), Buffer.alloc(8), int32(3), Buffer.from('abc'), int32(4), int32(9)]));
        const [[unknown, n]] = p.getValues(r, 1);
        assert.deepStrictEqual(unknown, { type: 'Unknown', typeCode: 77, raw: Buffer.from('abc') });
        assert.strictEqual(n, 9);
      }
    });
  });
});
