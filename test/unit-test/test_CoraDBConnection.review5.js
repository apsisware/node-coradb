'use strict';

const assert = require('node:assert');

const CoraDB = require('../../index');
const Helpers = require('../../src/utils/Helpers');
const GetSchemaPacket = require('../../src/packets/GetSchemaPacket');
const PacketReader = require('../../src/packets/PacketReader');
const PacketWriter = require('../../src/packets/PacketWriter');
const Queue = require('../../src/query/Queue');
const Timezone = require('../../src/utils/Timezone');
const ValueDecoder = require('../../src/packets/ValueDecoder');
const { bind } = require('../../src/params');
const { fakeCas, Out, columnInfo, errorReply } = require('./helpers/fakeCas');

/*
 * The driver fixes from the fifth code review (DRV-1 … DRV-13, and the
 * auto-commit byte of CLOSE_REQ_HANDLE it left unconfirmed). The protocol
 * ones run against the pretend CAS over a real socket.
 */

const CAS = CoraDB.CASConstants;
const FC = CAS.CASFunctionCode;
const T = CAS.CoraDBDataType;
const STMT = CAS.CoraDBStatementType;
const ROLLBACK = CAS.CCITransactionType.CCI_TRAN_ROLLBACK;

const NUMBERS = { columns: [['a', 'int']], rows: [[1], [2], [3], [4], [5], [6]] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (/\bfrom t\b/i.test(sql)) return NUMBERS;
  if (/^\s*(update|insert|delete)\b/i.test(sql)) return { affected: 3 };
  return { affected: 0 };
}

/**
 * The EXECUTE reply of a statement whose value is a one-row result (a CALL,
 * an EVALUATE): one column of the NULL type, a row count of 1, and — unless
 * `withRows` — no rows after the tail, which the CAS sends on a FETCH.
 */
function valueReply(statementType, withRows) {
  const out = new Out();

  out.int(1).int(0).byte(statementType).int(0).byte(0).int(1);
  columnInfo(out, ['ret', T.CCI_U_TYPE_NULL]);
  out.int(1); // total tuple count
  out.byte(0).int(1).byte(statementType).int(1).bytes(8).int(0).int(0);
  out.byte(0).int(0); // include_column_info, shard id

  if (withRows) {
    out.int(0).int(1);
    valueRow(out, 7);
  }

  return out.reply();
}

/** One row with one INT that carries its own type byte. */
function valueRow(out, value) {
  out.int(1).bytes(8);
  out.int(5).byte(T.CCI_U_TYPE_INT).int(value);
}

function valueHandlers(statementType, withRows) {
  return {
    [FC.CAS_FC_PREPARE_AND_EXECUTE]: () => valueReply(statementType, withRows),
    [FC.CAS_FC_FETCH]: () => {
      const out = new Out().int(0).int(1);
      valueRow(out, 42);
      return out.reply();
    },
  };
}

const count = (cas, fc) => cas.log.filter((e) => e.fc === fc).length;

describe('test_CoraDBConnection.review5', function () {
  this.timeout(5000);

  let cas;
  let conn;

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
  });

  describe('DRV-1: the version request carries the real auto-commit mode', function () {
    it('sends 0 while auto-commit is off, so a ping does not commit the open transaction', async function () {
      const bodies = [];
      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_GET_DB_VERSION]: (body) => {
            bodies.push(Buffer.from(body));
            return new Out().int(0).str('11.4.0').reply();
          },
        },
      });
      open();

      await conn.setAutoCommitMode(false);
      await conn.execute('insert into t values (1)');
      await conn.getEngineVersion();

      await conn.rollback();
      await conn.setAutoCommitMode(true);
      await conn.getEngineVersion();

      // An int length (1), then the byte.
      assert.deepStrictEqual(bodies.map((b) => b[4]), [0, 1]);
    });
  });

  describe('CLOSE_REQ_HANDLE carries the real auto-commit mode (as CCI and JDBC send it)', function () {
    it('sends 1 with auto-commit on and 0 with it off', async function () {
      const bytes = [];
      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_CLOSE_REQ_HANDLE]: (body) => {
            bytes.push(body[body.length - 1]);
            return undefined;
          },
        },
      });
      open();

      const on = await conn.query('select a from t');
      await conn.closeQuery(on.queryHandle);

      await conn.setAutoCommitMode(false);
      const off = await conn.query('select a from t');
      await conn.closeQuery(off.queryHandle);

      assert.deepStrictEqual(bytes, [1, 0]);
    });
  });

  describe('DRV-2: no fetching for a statement without rows', function () {
    it('queryAll() on an UPDATE resolves with an empty result, sends no FETCH and closes the handle', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      const result = await within(conn.queryAll('update t set a = 1'), 1000, 'queryAll(update)');

      assert.deepStrictEqual(result, { ColumnDataTypes: [], ColumnNames: [], ColumnValues: [], RowsCount: 0 });
      assert.strictEqual(count(cas, FC.CAS_FC_FETCH), 0);
      assert.strictEqual(count(cas, FC.CAS_FC_CLOSE_REQ_HANDLE), 1);
      assert.deepStrictEqual(Object.keys(conn._queryResultSets), []);
      assert.deepStrictEqual(await conn.queryAllAsObjects('savepoint s1'), []);

      // The queue is alive.
      assert.strictEqual((await conn.queryAll('select a from t')).ColumnValues.length, 6);
    });

    it('fetch(handle, true) on an UPDATE handle resolves with no result and sends nothing', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      const r = await conn.query('update t set a = 1');
      const f = await within(conn.fetch(r.queryHandle, true), 1000, 'fetch(update, true)');

      assert.strictEqual(f.result, null);
      assert.strictEqual(count(cas, FC.CAS_FC_FETCH), 0);
      await conn.closeQuery(r.queryHandle);
    });

    it('stops at an empty batch, whatever the row count said', async function () {
      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          // The server says 6 rows, then has none to give after the first 2.
          [FC.CAS_FC_FETCH]: () => new Out().int(0).int(0).reply(),
        },
      });
      open();

      const result = await within(conn.queryAll('select a from t'), 1000, 'queryAll');

      assert.deepStrictEqual(result.ColumnValues, [[1], [2]]);
      assert.strictEqual(count(cas, FC.CAS_FC_FETCH), 1);
    });
  });

  describe('DRV-3: CALL, EVALUATE and GET STATISTICS return their value', function () {
    for (const [name, type] of [['CALL', STMT.CORADB_STMT_CALL], ['EVALUATE', STMT.CORADB_STMT_EVALUATE]]) {
      it(`${name}: queryAll() fetches the value and closes the handle`, async function () {
        cas = await fakeCas({ onQuery: answer, handlers: valueHandlers(type) });
        open();

        const result = await conn.queryAll(`${name} f()`);

        assert.deepStrictEqual(result.ColumnNames, ['ret']);
        assert.deepStrictEqual(result.ColumnValues, [[42]]);
        assert.strictEqual(count(cas, FC.CAS_FC_CLOSE_REQ_HANDLE), 1);
        assert.deepStrictEqual(Object.keys(conn._queryResultSets), []);
      });
    }

    it('sql() and cursor() return the value; query() hands it out in its first batch', async function () {
      cas = await fakeCas({ onQuery: answer, handlers: valueHandlers(STMT.CORADB_STMT_CALL) });
      open();

      const r = await conn.sql('CALL f()');
      assert.deepStrictEqual(r.rows, [{ ret: 42 }]);
      assert.strictEqual(r.affectedRows, 0);

      const cursor = await conn.cursor('CALL f()', { rowsAs: 'arrays' });
      assert.deepStrictEqual(await cursor.next(), [[42]]);
      assert.deepStrictEqual(await cursor.next(), []);
      assert.strictEqual(cursor.done, true);

      const q = await conn.query('CALL f()');
      assert.deepStrictEqual(q.result.ColumnValues, [[42]]);
      await conn.closeQuery(q.queryHandle);

      // Nothing left open on the server.
      assert.strictEqual(count(cas, FC.CAS_FC_CLOSE_REQ_HANDLE), count(cas, FC.CAS_FC_PREPARE_AND_EXECUTE));
      assert.deepStrictEqual(Object.keys(conn._queryResultSets), []);
    });

    it('reads the value when the reply carries it, without a FETCH', async function () {
      cas = await fakeCas({ onQuery: answer, handlers: valueHandlers(STMT.CORADB_STMT_CALL, true) });
      open();

      assert.deepStrictEqual((await conn.queryAll('CALL f()')).ColumnValues, [[7]]);
      assert.deepStrictEqual((await conn.sql('CALL f()', { rowsAs: 'arrays' })).rows, [[7]]);
      assert.strictEqual(count(cas, FC.CAS_FC_FETCH), 0);
    });

    it('GET STATISTICS is read as a result', function () {
      assert.strictEqual(ValueDecoder.returnsRows(STMT.CORADB_STMT_GET_STATS), true);
      assert.strictEqual(ValueDecoder.returnsRows(STMT.CORADB_STMT_UPDATE), false);
    });
  });

  describe('DRV-4: connects made at the same time share one login', function () {
    it('connect() not awaited beside a request does not fail either', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      const [, rows] = await Promise.all([conn.connect(), conn.queryAll('select a from t')]);

      assert.strictEqual(rows.ColumnValues.length, 6);
      assert.strictEqual(cas.logins(), 1);
    });

    it('two connect() calls resolve together, and a callback is answered', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      let called = 0;
      await Promise.all([conn.connect(), conn.connect(() => { called += 1; }), conn.getActiveHost()]);

      assert.strictEqual(called, 1);
      assert.strictEqual(cas.logins(), 1);
    });
  });

  describe('DRV-5: one transaction() at a time', function () {
    it('refuses an overlapping one with TRANSACTION_IN_PROGRESS and runs none of it', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      let secondRan = false;
      const first = conn.transaction(async (c) => {
        await c.sql('insert into a values (1)');
        await sleep(30);
        await c.sql('insert into a values (2)');
        return 'one';
      });
      const second = conn.transaction(async () => {
        secondRan = true;
      });

      await assert.rejects(second, (err) => err.code === 'TRANSACTION_IN_PROGRESS');
      assert.strictEqual(await first, 'one');
      assert.strictEqual(secondRan, false);

      // Both inserts ran with auto-commit off: nothing turned it back on early.
      const inserts = cas.log.filter((e) => e.sql && /insert/.test(e.sql));
      assert.deepStrictEqual(inserts.map((e) => e.autoCommit), [0, 0]);
      assert.strictEqual(conn.getAutoCommitMode(), true);

      // Free again once it is over.
      assert.strictEqual(await conn.transaction(async () => 'next'), 'next');
    });

    it('a rollback that fails on a live session surfaces as ROLLBACK_FAILED and leaves auto-commit off', async function () {
      let refuse = true;
      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_END_TRAN]: (body) => (refuse && body[body.length - 1] === ROLLBACK
            ? errorReply({ code: -1, message: 'cannot roll back' })
            : undefined),
        },
      });
      open();

      const boom = new Error('fn failed');

      await assert.rejects(
        conn.transaction(async (c) => {
          await c.sql('insert into a values (1)');
          throw boom;
        }),
        (err) => err.code === 'ROLLBACK_FAILED' && err.cause === boom && Boolean(err.rollbackError)
      );

      // Not turned back on: the next statement would commit the work.
      assert.strictEqual(conn.getAutoCommitMode(), false);

      refuse = false;
      await conn.rollback();
      await conn.setAutoCommitMode(true);
      assert.strictEqual(await conn.transaction(async () => 1), 1);
    });
  });

  describe('DRV-6: the schema request length is in UTF-8 bytes', function () {
    for (const pattern of ['orders', 'comenzi_ăîș', '주문', '', undefined]) {
      it(`declares what it sends for ${JSON.stringify(pattern)}`, function () {
        const p = new GetSchemaPacket({
          casInfo: Buffer.from([0, 0xff, 0xff, 0xff]),
          protocolVersion: 7,
          schemaType: CAS.CoraDBSchemaType.CCI_SCH_ATTRIBUTE,
          tableNamePattern: pattern,
          shardId: 0,
        });
        const w = new PacketWriter(p.getRequestSchemaBufferLength());

        p.writeRequestSchema(w);

        assert.strictEqual(w._buffer.readInt32BE(0) + 8, w._buffer.length);
        assert.strictEqual(w._buffer.length, p.getRequestSchemaBufferLength());
      });
    }
  });

  describe('DRV-7: time-zone values', function () {
    it('takes the month from the stored value, not the local zone', function () {
      const v = new Timezone(new Date(Date.UTC(2026, 0, 31, 23, 30, 0)), 'Asia/Seoul KST');

      assert.strictEqual(v.toString(), '2026-01-31 23:30:00.000 Asia/Seoul KST');
      assert.strictEqual(v.format('MM MON MONTH Q'), '01 Jan January 1');
    });

    it('valueOf() is the instant: the wall-clock time read in its zone', function () {
      const seoul = new Timezone(new Date(Date.UTC(2026, 0, 31, 23, 30, 0)), 'Asia/Seoul KST');
      const ny = new Timezone(new Date(Date.UTC(2026, 6, 1, 8, 0, 0)), 'America/New_York EDT');
      const fixed = new Timezone(new Date(Date.UTC(2026, 0, 1, 9, 0, 0)), '+09:00');

      assert.strictEqual(seoul.valueOf(), Date.UTC(2026, 0, 31, 14, 30, 0));
      assert.strictEqual(ny.valueOf(), Date.UTC(2026, 6, 1, 12, 0, 0));
      assert.strictEqual(fixed.valueOf(), Date.UTC(2026, 0, 1, 0, 0, 0));
      assert.strictEqual(fixed.tzh, '+09');
    });

    it('takes the offset in force at the wall-clock time (across a DST change)', function () {
      // 23:30 on the night DST begins in New York (08 Mar 2026, 02:00): still
      // EST there, though the same numbers read as UTC are already EDT.
      const v = new Timezone(new Date(Date.UTC(2026, 2, 7, 23, 30, 0)), 'America/New_York');

      assert.strictEqual(v.tzh, '-05');
      assert.strictEqual(v.getOffset(), 5 * 3600000);
    });

    it('writes midnight as 12 on a 12-hour clock', function () {
      const v = new Timezone(new Date(Date.UTC(2026, 0, 1, 0, 5, 0)), 'UTC UTC');

      assert.strictEqual(v.format('HH12:MI AM'), '12:05 AM');
      assert.strictEqual(v.format('HH:MI'), '12:05');
      assert.strictEqual(v.format('HH24:MI'), '00:05');
    });
  });

  describe('DRV-8: typed date parameters given as zone-less strings', function () {
    let tz;

    beforeEach(function () {
      tz = process.env.TZ;
      // A zone away from UTC, where the old reading shifted the value.
      process.env.TZ = 'Asia/Seoul';
    });

    afterEach(function () {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    const one = (type, value) => bind([{ type, value }]).values[0];

    it('are sent as written (wall clock), not shifted by the local offset', function () {
      assert.strictEqual(one('datetime', '2026-01-31 10:00:00').toISOString(), '2026-01-31T10:00:00.000Z');
      assert.strictEqual(one('timestamp', '2026-01-31T10:00:00.250').toISOString(), '2026-01-31T10:00:00.250Z');
      assert.strictEqual(one('date', '2026-01-31').toISOString(), '2026-01-31T00:00:00.000Z');
      // With a zone it is an instant, as before.
      assert.strictEqual(one('datetime', '2026-01-31T10:00:00+02:00').toISOString(), '2026-01-31T08:00:00.000Z');
    });

    it("accepts 'HH:MM:SS' for a TIME", function () {
      assert.strictEqual(one('time', '10:00:00').toISOString(), '1970-01-01T10:00:00.000Z');
      assert.strictEqual(one('time', '23:59').toISOString(), '1970-01-01T23:59:00.000Z');
    });

    it('refuses a date or time that does not exist', function () {
      for (const [type, value] of [['date', '2026-02-31'], ['datetime', '2026-01-31 24:00:00'], ['time', '10:61'], ['date', '']]) {
        assert.throws(() => one(type, value), (err) => err.code === 'INVALID_PARAMETER', `${type} ${value}`);
      }
    });
  });

  describe('DRV-9: concurrent fetches keep their order', function () {
    it('Cursor.next() and fetch() called together get the batches in call order', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      const cursor = await conn.cursor('select a from t', { rowsAs: 'arrays' });
      assert.deepStrictEqual(await cursor.next(), [[1], [2]]);
      const [a, b] = await Promise.all([cursor.next(), cursor.next()]);
      assert.deepStrictEqual([a, b], [[[3], [4]], [[5], [6]]]);

      const r = await conn.query('select a from t');
      const [f1, f2] = await Promise.all([conn.fetch(r.queryHandle), conn.fetch(r.queryHandle)]);
      assert.deepStrictEqual(f1.result.ColumnValues, [[3], [4]]);
      assert.deepStrictEqual(f2.result.ColumnValues, [[5], [6]]);
    });

    it('a close asked for after a fetch runs after it', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      const r = await conn.query('select a from t');
      const [f] = await Promise.all([conn.fetch(r.queryHandle), conn.closeQuery(r.queryHandle)]);

      assert.deepStrictEqual(f.result.ColumnValues, [[3], [4]]);
    });

    it('Queue.unshift with a key goes behind the waiting items with that key', function () {
      const q = new Queue();
      q.scheduled = true; // keep it from running, to look at the order

      q.push('later');
      q.unshift('a1', undefined, 'a');
      q.unshift('b1', undefined, 'b');
      q.unshift('a2', undefined, 'a');
      q.unshift('plain');

      assert.deepStrictEqual(q.items.map((i) => i.run), ['plain', 'b1', 'a1', 'a2', 'later']);
    });
  });

  describe('DRV-10: the text formatter knows [bracket] identifiers', function () {
    it("an apostrophe inside one does not start a string", function () {
      const sql = Helpers._sqlFormat("select [it's] from t where a = ? and b = ?", ['x', "1 or '1'='1"]);

      assert.strictEqual(sql, "select [it's] from t where a = 'x' and b = '1 or ''1''=''1'");
    });

    it('a ? inside one is not a placeholder', function () {
      assert.strictEqual(Helpers._sqlFormat('select [a?] from t where id = ?', [5]), 'select [a?] from t where id = 5');
    });
  });

  describe('DRV-11: hosts and retries', function () {
    it('reads IPv6 hosts, bare and in brackets', function () {
      const c = CoraDB.createConnection({
        hosts: ['[::1]:33001', '::1', '[fe80::1]', 'db1:33002', 'db2'],
        port: 33000,
      });

      assert.deepStrictEqual(c.hosts, [
        { host: '::1', port: '33001' },
        { host: '::1', port: 33000 },
        { host: 'fe80::1', port: 33000 },
        { host: 'db1', port: '33002' },
        { host: 'db2', port: 33000 },
      ]);
    });

    it('honours maxConnectionRetryCount: 0, and still defaults to 1', function () {
      assert.strictEqual(CoraDB.createConnection({ host: 'db', maxConnectionRetryCount: 0 }).maxConnectionRetryCount, 0);
      assert.strictEqual(CoraDB.createConnection({ host: 'db' }).maxConnectionRetryCount, 1);
    });

    it('connects to a bracketed address', async function () {
      cas = await fakeCas({ onQuery: answer });
      open({ host: `[127.0.0.1]:${cas.port}` });

      assert.strictEqual((await conn.queryAll('select a from t')).ColumnValues.length, 6);
    });
  });

  describe('DRV-12: zero dates are null', function () {
    const read = (type, bytes) => {
      const r = new PacketReader();
      r.write(bytes);
      return ValueDecoder.readValue(r, type, bytes.length);
    };

    it('DATE, DATETIME, TIMESTAMP and the time-zone types', function () {
      assert.strictEqual(read(T.CCI_U_TYPE_DATE, Buffer.alloc(6)), null);
      assert.strictEqual(read(T.CCI_U_TYPE_DATETIME, Buffer.alloc(14)), null);
      assert.strictEqual(read(T.CCI_U_TYPE_TIMESTAMP, Buffer.alloc(12)), null);
      assert.strictEqual(read(T.CCI_U_TYPE_TIMESTAMPTZ, Buffer.concat([Buffer.alloc(12), Buffer.from('UTC\0')])), null);
      assert.strictEqual(read(T.CCI_U_TYPE_DATETIMETZ, Buffer.concat([Buffer.alloc(14), Buffer.from('UTC\0')])), null);
    });

    it('a real date still reads as one', function () {
      const b = Buffer.alloc(6);
      b.writeInt16BE(2026, 0);
      b.writeInt16BE(1, 2);
      b.writeInt16BE(31, 4);

      assert.strictEqual(read(T.CCI_U_TYPE_DATE, b).toISOString(), '2026-01-31T00:00:00.000Z');
    });
  });

  describe('DRV-13: numeric parameters', function () {
    const one = (type, value) => bind([{ type, value }]).values[0];

    it('refuses blank strings and non-decimal notation', function () {
      for (const type of ['short', 'int', 'bigint', 'float', 'double', 'monetary', 'numeric']) {
        for (const value of ['', '   ', '0x10', '0b1', '1_000', 'abc']) {
          assert.throws(() => one(type, value), (err) => err.code === 'INVALID_PARAMETER', `${type} ${JSON.stringify(value)}`);
        }
      }
    });

    it('still takes decimal strings, numbers and booleans', function () {
      assert.strictEqual(one('int', ' 12 '), 12);
      assert.strictEqual(one('int', '-7'), -7);
      assert.strictEqual(one('int', true), 1);
      assert.strictEqual(one('bigint', '+9007199254740993'), 9007199254740993n);
      assert.strictEqual(one('double', '1.5e3'), 1500);
      assert.strictEqual(one('numeric', '12.50'), '12.50');
    });
  });
});
