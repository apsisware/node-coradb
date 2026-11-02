'use strict';

const assert = require('node:assert');

const CoraDB = require('../../index');
const Helpers = require('../../src/utils/Helpers');
const PacketWriter = require('../../src/packets/PacketWriter');
const PrepareExecutePacket = require('../../src/packets/PrepareExecutePacket');
const Query = require('../../src/query/Query');
const { bind } = require('../../src/params');
const ColumnMetaData = require('../../src/resultset/ColumnMetaData');
const { fakeCas, Out } = require('./helpers/fakeCas');

/*
 * Regression tests for the bugs found in the review of version 0.9.9. The
 * protocol ones run against the pretend CAS over a real socket.
 */

const CAS = CoraDB.CASConstants;
const FC = CAS.CASFunctionCode;
const T = CAS.CoraDBDataType;

const ROWS = { columns: [['a', 'int']], rows: [[1], [2]] };
const SIX = { columns: [['a', 'int']], rows: [[1], [2], [3], [4], [5], [6]] };

function answer(sql) {
  if (/\bfrom t\b/i.test(sql)) return ROWS;
  if (/\bfrom six\b/i.test(sql)) return SIX;
  return { affected: 1 };
}

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

/**
 * EXECUTE_BATCH, which the pretend CAS does not answer by itself: records
 * the statements and the query timeout, and answers one row changed each.
 */
function batchHandler(seen) {
  return (body) => {
    // addByte(auto-commit): 5 bytes; addInt(timeout): 8 bytes; then each
    // statement as [int length][text][NUL].
    const timeout = body.readInt32BE(9);
    const sqls = [];

    for (let at = 13; at < body.length;) {
      const len = body.readInt32BE(at);
      sqls.push(body.toString('utf8', at + 4, at + 4 + len - 1));
      at += 4 + len;
    }

    seen.push({ timeout, sqls });

    const out = new Out().int(0).int(sqls.length);

    sqls.forEach(() => out.byte(CAS.CoraDBStatementType.CORADB_STMT_UPDATE).int(1).int(0).short(0).short(0));
    out.int(0); // shard id

    return out.reply();
  };
}

/** A packed LOB handle: type, size, locator size (with its NUL), locator. */
function lobHandle(locator, lobType = CAS.CCILOBType.CCI_LOB_TYPE_BLOB) {
  const head = Buffer.alloc(16);

  head.writeInt32BE(lobType, 0);
  head.writeBigInt64BE(0n, 4);
  head.writeInt32BE(locator.length + 1, 12);

  return Buffer.concat([head, locator, Buffer.from([0])]);
}

describe('test_CoraDBConnection.fixes', function () {
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

  describe('H1: a BLOB/CLOB parameter must be a LOB object', function () {
    it('refuses a Buffer as a BLOB before sending, and the connection stays usable', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await assert.rejects(
        conn.executeWithTypedParams('insert into t values (?)', [Buffer.from('abc')], ['blob']),
        (err) => err.code === 'INVALID_PARAMETER'
      );

      const r = await conn.queryAll('select a from t');

      assert.strictEqual(r.ColumnValues.length, 2);
    });

    it('refuses a CLOB object bound as a BLOB, and anything without a well-formed handle', function () {
      const clob = { packedLobHandle: lobHandle(Buffer.from('f')), lobLength: 0, lobType: T.CCI_U_TYPE_CLOB };

      assert.throws(() => bind([{ type: 'blob', value: clob }]), (err) => err.code === 'INVALID_PARAMETER');
      assert.throws(() => bind([{ type: 'clob', value: { packedLobHandle: Buffer.alloc(3), lobLength: 0 } }]),
        (err) => err.code === 'INVALID_PARAMETER');
      assert.throws(() => bind([{ type: 'blob', value: 'not a lob' }]), (err) => err.code === 'INVALID_PARAMETER');
    });

    it('accepts the LOB object lobNew() returns', function () {
      const blob = { packedLobHandle: lobHandle(Buffer.from('file:/x')), lobLength: 5, lobType: T.CCI_U_TYPE_BLOB };

      assert.strictEqual(bind([{ type: 'blob', value: blob }]).values[0], blob);
    });
  });

  describe('L12: a LOB parameter sends its handle byte for byte', function () {
    it('keeps a locator that is not valid UTF-8, with the declared length equal to what is written', function () {
      const handle = lobHandle(Buffer.from([0xff, 0xfe, 0x41]));
      const blob = { packedLobHandle: handle, lobLength: 10, lobType: T.CCI_U_TYPE_BLOB };
      const pkt = new PrepareExecutePacket({
        casInfo: Buffer.alloc(4), autoCommit: true, protocolVersion: 9, queryTimeout: 0,
        paramValues: [blob], paramTypes: ['blob'],
      });

      pkt.queryHandle = 1;
      pkt.statementType = CAS.CoraDBStatementType.CORADB_STMT_INSERT;

      const length = pkt.getExecuteBufferLength();
      const writer = new PacketWriter(length);

      pkt.writeExecute(writer);

      assert.strictEqual(writer._offset, length);

      const sent = writer._buffer.subarray(writer._offset - handle.length, writer._offset);

      // The locator bytes as they were, the current size written in.
      assert.deepStrictEqual(sent.subarray(16), handle.subarray(16));
      assert.strictEqual(sent.readBigInt64BE(4), 10n);
    });
  });

  describe('H2: an array of statements keeps its callback and binds its values', function () {
    it('Query: values go left to right across the statements', function () {
      const cb = () => {};
      const q = new Query(['update t set a = ?', "update t set b = '?', c = ?, d = ?"], [1, 2, 3], cb);

      assert.deepStrictEqual(q.sql, ['update t set a = 1', "update t set b = '?', c = 2, d = 3"]);
      assert.strictEqual(q.callback, cb);
    });

    it('Query: (statements, callback) still works', function () {
      const cb = () => {};
      const q = new Query(['update t set a = 1'], cb);

      assert.deepStrictEqual(q.sql, ['update t set a = 1']);
      assert.strictEqual(q.callback, cb);
    });

    it('execute([...], params, callback) calls the callback with the counts', async function () {
      const seen = [];

      cas = await fakeCas({ onQuery: answer, handlers: { [FC.CAS_FC_EXECUTE_BATCH]: batchHandler(seen) } });
      open();

      const counts = await new Promise((resolve, reject) => {
        conn.execute(['update t set a = ?', 'update t set b = ?'], [5, 6], (err, result) => (err ? reject(err) : resolve(result)));
      });

      assert.deepStrictEqual(counts, [1, 1]);
      assert.deepStrictEqual(seen[0].sqls, ['update t set a = 5', 'update t set b = 6']);
    });
  });

  describe('L5/L6: text formatting of values', function () {
    it('leaves every placeholder with no value as it is', function () {
      assert.strictEqual(Helpers._sqlFormat('select ?, ?, ?', [1]), 'select 1, ?, ?');
    });

    it('writes a Buffer as a hexadecimal literal', function () {
      assert.strictEqual(Helpers._sqlFormat('select ?', [Buffer.from([0x0a, 0xff])]), "select X'0aff'");
    });

    it('refuses an invalid Date and a plain object', function () {
      assert.throws(() => Helpers._sqlFormat('select ?', [new Date('nope')]), (err) => err.code === 'INVALID_PARAMETER');
      assert.throws(() => Helpers._sqlFormat('select ?', [{ a: 1 }]), (err) => err.code === 'INVALID_PARAMETER');
    });
  });

  describe('M1: execute() of several statements sends the query timeout', function () {
    it('sends setQueryTimeout()\'s value with EXECUTE_BATCH', async function () {
      const seen = [];

      cas = await fakeCas({ onQuery: answer, handlers: { [FC.CAS_FC_EXECUTE_BATCH]: batchHandler(seen) } });
      open();
      conn.setQueryTimeout(5000);

      await conn.execute(['update t set a = 1', 'update t set b = 2']);

      assert.strictEqual(seen[0].timeout, 5000);
    });
  });

  describe('M2: queryAsObjects() of a statement that returns no rows', function () {
    it('resolves with no rows and a handle that can be closed', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      const r = await conn.queryAsObjects('update t set a = 1');

      assert.deepStrictEqual(r.result, []);
      await conn.closeQuery(r.queryHandle);
      assert.deepStrictEqual(conn._queryResultSets, {});
    });
  });

  describe('M3: getSchema() of a schema type it cannot read', function () {
    it('refuses it with INVALID_SCHEMA_TYPE, sending nothing', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.connect();

      await assert.rejects(conn.getSchema(CAS.CoraDBSchemaType.CCI_SCH_TRIGGER, 'x'), (err) => {
        assert.strictEqual(err.code, 'INVALID_SCHEMA_TYPE');
        assert.match(err.message, /not supported/);
        return true;
      });
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_SCHEMA_INFO));
    });
  });

  describe('M4: MAX_STRING_LENGTH can be read', function () {
    it('asks the server for it', async function () {
      cas = await fakeCas({
        onQuery: answer,
        handlers: { [FC.CAS_FC_GET_DB_PARAMETER]: () => new Out().int(0).int(1073741823).reply() },
      });
      open();

      const value = await conn.getDatabaseParameter(CAS.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH);

      assert.strictEqual(value, 1073741823);
    });

    it('still refuses to set it', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await assert.rejects(conn.setDatabaseParameter(CAS.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH, 1), (err) => err.code === -10011);
    });
  });

  describe('M5: a null or partial logger', function () {
    it('works with logger: null', async function () {
      cas = await fakeCas({ onQuery: answer });
      open({ logger: null });

      assert.strictEqual((await conn.queryAll('select a from t')).ColumnValues.length, 2);
    });

    it('works with a logger that has only some of the levels', async function () {
      const lines = [];

      cas = await fakeCas({ onQuery: answer });
      open({ logger: { info: (...a) => lines.push(a.join(' ')) } });

      assert.strictEqual((await conn.queryAll('select a from t')).ColumnValues.length, 2);
      assert.ok(lines.length > 0);
    });
  });

  describe('M6: a handle from before a reconnect', function () {
    it('is refused by fetch(), closeQuery(), getMetaData() and getGeneratedKeys(); the new session\'s handle is untouched', async function () {
      cas = await fakeCas({ handlesPerSession: true, onQuery: answer });
      open();

      const old = await conn.query('select a from six');

      cas.dropAll();
      await waitFor(() => !conn.connectionOpened);

      const now = await conn.query('select a from six where 2 = 2');

      // The same number on the server; not the same handle for the caller.
      assert.strictEqual(now._handle, old.queryHandle);
      assert.notStrictEqual(now.queryHandle, old.queryHandle);

      const ended = (err) => err.code === 'NO_ACTIVE_QUERY' && /session that has ended/.test(err.message);

      await assert.rejects(conn.fetch(old.queryHandle), ended);
      await assert.rejects(conn.closeQuery(old.queryHandle), ended);
      await assert.rejects(conn.getMetaData(old.queryHandle), ended);
      await assert.rejects(conn.getGeneratedKeys(old.queryHandle), ended);

      const session2 = cas.log.filter((e) => e.session === 2).map((e) => e.fc);

      assert.ok(!session2.includes(FC.CAS_FC_FETCH));
      assert.ok(!session2.includes(FC.CAS_FC_CLOSE_REQ_HANDLE));

      // The new handle still works, and fetch() answers with it.
      assert.ok(await conn.getMetaData(now.queryHandle));

      const f = await conn.fetch(now.queryHandle);

      assert.strictEqual(f.queryHandle, now.queryHandle);
      assert.deepStrictEqual(f.result.ColumnValues, [[3], [4]]);
      await conn.closeQuery(now.queryHandle);
      assert.deepStrictEqual(conn._queryResultSets, {});
    });

    it('leaves the first session\'s handles as the server numbered them', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      const r = await conn.query('select a from six');

      assert.strictEqual(r.queryHandle, r._handle);
      assert.ok(conn._queryResultSets[r.queryHandle]);
      await conn.closeQuery(r.queryHandle);
    });
  });

  describe('M7: requestTimeoutMs limits the classic methods too', function () {
    it('query() fails with TIMEOUT and its callback is answered once', async function () {
      cas = await fakeCas({
        onQuery: async (sql) => {
          if (/sleep/.test(sql)) await sleep(300);
          return answer(sql);
        },
      });
      open({ requestTimeoutMs: 50 });

      let cancelled = 0;
      conn.cancel = () => {
        cancelled += 1;
        return Promise.resolve({ method: 'broker' });
      };

      const calls = [];
      const started = Date.now();

      await assert.rejects(
        conn.query('select a from t where sleep = 1', (...a) => calls.push(a)),
        (err) => err.code === 'TIMEOUT' && err.statement === 'select a from t where sleep = 1'
      );
      assert.ok(Date.now() - started < 250);
      assert.strictEqual(cancelled, 1);

      // A request still waiting behind it is dropped, not sent.
      await assert.rejects(conn.commit(), (err) => err.code === 'TIMEOUT');

      await sleep(350);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0][0].code, 'TIMEOUT');
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_END_TRAN));
    });

    it('changes nothing with no requestTimeoutMs', async function () {
      cas = await fakeCas({
        onQuery: async (sql) => {
          await sleep(80);
          return answer(sql);
        },
      });
      open();

      assert.strictEqual((await conn.queryAll('select a from t')).ColumnValues.length, 2);
    });
  });

  describe('M8: a cursor does not lose the batch of a fetch that timed out', function () {
    it('hands it out on the next call', async function () {
      let slow = false;

      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_FETCH]: async () => {
            if (slow) await sleep(120);
          },
        },
      });
      open();

      // The cancel is not ours to make (or too late): the fetch finishes.
      conn.cancel = () => Promise.resolve({ method: 'broker' });

      const cursor = await conn.cursor('select a from six');

      assert.deepStrictEqual(await cursor.next(), [{ a: 1 }, { a: 2 }]);

      slow = true;
      await assert.rejects(cursor.next({ timeoutMs: 30 }), (err) => err.code === 'TIMEOUT');
      slow = false;

      assert.deepStrictEqual(await cursor.next(), [{ a: 3 }, { a: 4 }]);
      assert.deepStrictEqual(await cursor.next(), [{ a: 5 }, { a: 6 }]);
      assert.deepStrictEqual(await cursor.next(), []);
      assert.strictEqual(cursor.done, true);
    });
  });

  describe('L11: getSchema() reads every row, in as many fetches as it takes', function () {
    it('fetches again when a reply has fewer rows than the result', async function () {
      const tables = ['a', 'b', 'c', 'd', 'e'];
      const asked = [];

      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_SCHEMA_INFO]: () => new Out().int(7).int(tables.length).int(0).reply(),
          // [int 4][handle][int 4][start][int 4][count]: two rows at most.
          [FC.CAS_FC_FETCH]: (body) => {
            const start = body.readInt32BE(12);
            const count = body.readInt32BE(20);
            const rows = tables.slice(start - 1, start - 1 + Math.min(count, 2));
            const out = new Out().int(0).int(rows.length);

            asked.push([start, count]);
            rows.forEach((name, i) => out.int(start + i).bytes(8).str(name).int(2).short(2).str(''));

            return out.reply();
          },
        },
      });
      open();

      const result = await conn.getSchema(CAS.CoraDBSchemaType.CCI_SCH_CLASS);

      assert.deepStrictEqual(result.map((r) => r.Name), tables);
      assert.deepStrictEqual(asked, [[1, 5], [3, 3], [5, 1]]);
    });
  });

  describe('L1: cancel() with an invalid timeout', function () {
    it('refuses it before making any socket', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.connect();

      for (const timeout of [-1, '2000', NaN]) {
        await assert.rejects(conn.cancel({ timeout }), (err) => err.code === 'INVALID_PARAMETER');
      }

      assert.ok(!cas.log.some((e) => e.cancel));
      assert.strictEqual((await conn.queryAll('select a from t')).ColumnValues.length, 2);
    });
  });

  describe('L2: connectionTimeout is read as a number of milliseconds', function () {
    it('takes a string of digits, and treats a negative value as none', async function () {
      cas = await fakeCas({ onQuery: answer });

      open({ connectionTimeout: '5000' });
      assert.strictEqual(conn.getConnectionTimeout(), 5000);
      await conn.connect();
      conn.abort();

      open({ connectionTimeout: -1 });
      assert.strictEqual(conn.getConnectionTimeout(), 0);
      await conn.connect();

      conn.setConnectionTimeout('250');
      assert.strictEqual(conn.getConnectionTimeout(), 250);
      conn.setConnectionTimeout('soon');
      assert.strictEqual(conn.getConnectionTimeout(), 0);
    });
  });

  describe('L3: createConnection(null)', function () {
    it('makes a connection with the defaults', function () {
      const c = CoraDB.createConnection(null);

      assert.deepStrictEqual(c.hosts, [{ host: 'localhost', port: 33000 }]);
    });
  });

  describe('L4: requests failed together each get their own error', function () {
    it('the waiting request does not report the running one\'s statement', async function () {
      cas = await fakeCas({
        onQuery: async (sql) => {
          if (/slow/.test(sql)) await sleep(200);
          return answer(sql);
        },
      });
      open();
      await conn.connect();

      const running = conn.query('update slow set a = 1');
      const waiting = conn.query('select a from t');
      const failures = Promise.all([running.catch((e) => e), waiting.catch((e) => e)]);

      await sleep(30);
      conn.abort();

      const [first, second] = await failures;

      assert.strictEqual(first.code, 'ABORTED');
      assert.strictEqual(second.code, 'ABORTED');
      assert.notStrictEqual(first, second);
      assert.strictEqual(first.statement, 'update slow set a = 1');
      assert.notStrictEqual(second.statement, 'update slow set a = 1');
    });
  });

  describe('L7: a parameter type that cannot be sent', function () {
    it('throws instead of writing a length that does not match', function () {
      const pkt = new PrepareExecutePacket({
        casInfo: Buffer.alloc(4), autoCommit: true, protocolVersion: 9, queryTimeout: 0,
        paramValues: [1], paramTypes: ['object'],
      });

      assert.throws(() => pkt.getExecuteBufferLength(), (err) => err.code === 'INVALID_DATA_TYPE');
      assert.throws(() => pkt._writeParamValue(new PacketWriter(64)), (err) => err.code === 'INVALID_DATA_TYPE');
    });
  });

  describe('L8: isUpdatable of a query() reply', function () {
    it('reads 0 as not updatable', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      const r = await conn.query('select a from t');

      assert.strictEqual(conn._queryResultSets[r._handle].isUpdatable, false);
    });
  });

  describe('L9: column metadata names', function () {
    it('keeps one field per value, with the old names as aliases', function () {
      const c = new ColumnMetaData();

      c.scale = 2;
      c.precision = 10;
      c.IsNullable = true;
      c.DefaultValue = 'x';

      assert.strictEqual(c.Scale, 2);
      assert.strictEqual(c.Precision, 10);
      assert.strictEqual(c.IsNullabe, true);
      assert.strictEqual(c.DafaultValue, 'x');

      const keys = Object.keys(c);

      for (const name of ['Scale', 'Precision', 'IsNullabe', 'DafaultValue']) {
        assert.ok(!keys.includes(name), name);
      }
    });
  });

  describe('L13: values and rows are not logged', function () {
    it('logs no bound value, no row, and no statement at info', async function () {
      const lines = { info: [], debug: [] };
      const logger = {
        error() {},
        warn() {},
        info: (...a) => lines.info.push(a.map(String).join(' ')),
        debug: (...a) => lines.debug.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')),
      };

      cas = await fakeCas({ onQuery: answer });
      open({ logger });

      await conn.executeWithTypedParams('update t set a = ?', ['secret-value'], ['varchar']);
      await conn.queryAll("select a from t where b = 'secret-literal'");

      assert.ok(!lines.debug.some((l) => l.includes('secret-value')));
      assert.ok(!lines.info.some((l) => l.includes('secret-literal')));
    });
  });

  describe('L14: transaction() whose function throws something that is not an Error', function () {
    it('passes on what was thrown', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      for (const thrown of [null, undefined, 'plain text']) {
        await assert.rejects(conn.transaction(() => {
          throw thrown;
        }), (err) => err === thrown);
      }
    });
  });

  describe('index.d.ts: what it declares is there', function () {
    it('exports Cursor and PreparedStatement', async function () {
      assert.strictEqual(typeof CoraDB.Cursor, 'function');
      assert.strictEqual(typeof CoraDB.PreparedStatement, 'function');

      cas = await fakeCas({ onQuery: answer });
      open();

      const cursor = await conn.cursor('select a from t');

      assert.ok(cursor instanceof CoraDB.Cursor);
      await cursor.close();
    });

    it('CASConstants\' type name functions work when taken off the object', function () {
      const { getCoraDBDataTypeName, getCoraDBDataTypeNumber } = CoraDB.CASConstants;

      assert.strictEqual(getCoraDBDataTypeNumber(getCoraDBDataTypeName(T.CCI_U_TYPE_INT)), T.CCI_U_TYPE_INT);
    });
  });

  describe('L10: several statements in one request (executeMulti, as JDBC execute())', function () {
    const MULTI = 'update t set a = 1; select a from six; delete from t where a = 9';
    const multiAnswer = (sql) => (/;/.test(sql)
      ? { results: [{ affected: 3 }, SIX, { affected: 0 }] }
      : answer(sql));

    it('reads every result in order: count, rows (fetched in batches), count', async function () {
      cas = await fakeCas({ onQuery: multiAnswer });
      open();

      const r = await conn.executeMulti(MULTI);

      assert.ok(r instanceof CoraDB.MultiResult);
      assert.strictEqual(r.resultCount, 3);
      assert.strictEqual(r.isResultSet, false);
      assert.strictEqual(r.getUpdateCount(), 3);
      assert.strictEqual(r.getResultSet(), null);

      assert.strictEqual(await r.getMoreResults(), true);
      assert.strictEqual(r.getUpdateCount(), -1);
      assert.deepStrictEqual(r.getResultSet().rows.map((x) => x.a), [1, 2, 3, 4, 5, 6]);
      assert.deepStrictEqual(r.getResultSet().columns.map((c) => c.name), ['a']);

      assert.strictEqual(await r.getMoreResults(), false);
      assert.strictEqual(r.getUpdateCount(), 0);

      // Past the last: -1, the handle closed, and the transaction ended (by
      // the close, which carries auto-commit, or by the commit the driver
      // sends when the CAS still reports it open — as JDBC does).
      assert.strictEqual(await r.getMoreResults(), false);
      assert.strictEqual(r.getUpdateCount(), -1);
      assert.strictEqual(await r.getMoreResults(), false);

      const fcs = cas.log.map((e) => e.fc);

      assert.strictEqual(fcs.filter((fc) => fc === FC.CAS_FC_NEXT_RESULT).length, 2);
      assert.ok(fcs.includes(FC.CAS_FC_CLOSE_REQ_HANDLE));
      assert.strictEqual(conn._CASInfo[CAS.CAS_INFO_STATUS], CAS.CAS_INFO_STATUS_INACTIVE);
      assert.deepStrictEqual(conn._queryResultSets, {});
    });

    it('is async iterable, and closes the handle', async function () {
      cas = await fakeCas({ onQuery: multiAnswer });
      open();

      const seen = [];

      for await (const result of await conn.executeMulti(MULTI)) {
        seen.push(result.isResultSet ? result.rows.length : `changed ${result.affectedRows}`);
      }

      assert.deepStrictEqual(seen, ['changed 3', 6, 'changed 0']);
      assert.deepStrictEqual(conn._queryResultSets, {});
    });

    it('close() before the end closes the handle without reading the rest', async function () {
      cas = await fakeCas({ onQuery: multiAnswer });
      open();

      const r = await conn.executeMulti(MULTI);

      await r.close();

      assert.strictEqual(r.getUpdateCount(), -1);
      assert.strictEqual(await r.getMoreResults(), false);
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_NEXT_RESULT));
      assert.deepStrictEqual(conn._queryResultSets, {});
    });

    it('does not commit by itself with auto-commit off, nor for a single result', async function () {
      cas = await fakeCas({ onQuery: multiAnswer });
      open();

      for await (const result of await conn.executeMulti('select a from t')) {
        assert.strictEqual(result.rows.length, 2);
      }

      await conn.setAutoCommitMode(false);

      for await (const result of await conn.executeMulti(MULTI)) void result;

      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_END_TRAN));
    });

    it('with values, asks the server to run every statement (CCI_EXEC_QUERY_ALL)', async function () {
      cas = await fakeCas({ onQuery: (sql) => (/;/.test(sql) ? { results: [{ affected: 1 }, { affected: 2 }] } : answer(sql)) });
      open();

      const counts = [];

      for await (const result of await conn.executeMulti('update t set a = ?; update t set b = ?', [1, 2])) {
        counts.push(result.affectedRows);
      }

      assert.deepStrictEqual(counts, [1, 2]);

      const execute = cas.log.find((e) => e.fc === FC.CAS_FC_EXECUTE);

      assert.strictEqual(execute.flag & CAS.CCIExecutionOption.CCI_EXEC_QUERY_ALL, CAS.CCIExecutionOption.CCI_EXEC_QUERY_ALL);
    });

    it('a NEXT_RESULT the server refuses fails getMoreResults() and closes the handle', async function () {
      cas = await fakeCas({
        onQuery: multiAnswer,
        handlers: { [FC.CAS_FC_NEXT_RESULT]: () => new Out().int(-1).int(-10022).reply() },
      });
      open();

      const r = await conn.executeMulti(MULTI);

      await assert.rejects(r.getMoreResults(), (err) => err.code === -10022);
      assert.strictEqual(r.getUpdateCount(), -1);
      assert.deepStrictEqual(conn._queryResultSets, {});
    });
  });

  describe('getSchema(CONSTRAINT): every field read at the size it is sent at', function () {
    it('reads NUM_PAGES and NUM_KEYS as ints, and skips columns it does not know', async function () {
      const rows = [
        [0, 'pk_event_id', 'id', 1, 115, 1, 1],
        [1, 'event_name_idx', 'name', 1, 115, 0, 1],
      ];
      const columns = ['TYPE', 'NAME', 'ATTR_NAME', 'NUM_PAGES', 'NUM_KEYS', 'PRIMARY_KEY', 'KEY_ORDER', 'ASC_DESC'];

      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_SCHEMA_INFO]: () => {
            const out = new Out().int(7).int(rows.length).int(columns.length);

            // One type byte, scale, precision, name.
            columns.forEach((name) => out.byte(T.CCI_U_TYPE_STRING).short(0).int(0).str(name));

            return out.reply();
          },
          [FC.CAS_FC_FETCH]: () => {
            const out = new Out().int(0).int(rows.length);

            rows.forEach(([type, name, attr, pages, keys, pk, order], i) => {
              out.int(i + 1).bytes(8)
                .int(2).short(type)
                .str(name)
                .str(attr)
                .int(4).int(pages)
                .int(4).int(keys)
                .int(2).short(pk)
                .int(2).short(order)
                .str('A');
            });

            return out.reply();
          },
        },
      });
      open();

      const result = await conn.getSchema(CAS.CoraDBSchemaType.CCI_SCH_CONSTRAINT, 'event');

      assert.deepStrictEqual(result, [
        { ConstraintName: 'pk_event_id', AttributeName: 'id', Type: 0, PrimaryKey: true, NumPages: 1, NumKeys: 115, KeyOrder: 1 },
        { ConstraintName: 'event_name_idx', AttributeName: 'name', Type: 1, PrimaryKey: false, NumPages: 1, NumKeys: 115, KeyOrder: 1 },
      ]);
    });

    it('names a view\'s class type', function () {
      assert.strictEqual(CAS.getCoraDBClassTypeName(0), 'System class/view');
      assert.strictEqual(CAS.getCoraDBClassTypeName(1), 'User view');
      assert.strictEqual(CAS.getCoraDBClassTypeName(2), 'User class/view');
    });
  });

  describe('generated keys, as JDBC executeUpdate(sql, RETURN_GENERATED_KEYS)', function () {
    const keysReply = (ids) => {
      const out = new Out().int(0).byte(CAS.CoraDBStatementType.CORADB_STMT_INSERT).int(ids.length).byte(0).int(1);

      // One column: type, scale, precision, name.
      out.byte(T.CCI_U_TYPE_INT).short(0).int(10).str('id');
      out.int(ids.length);
      ids.forEach((id, i) => out.int(i + 1).bytes(8).int(4).int(id));

      return out.reply();
    };

    it('sends the INSERT without auto-commit, reads the keys, closes the handle and commits, before query() resolves', async function () {
      cas = await fakeCas({ onQuery: answer, handlers: { [FC.CAS_FC_GET_GENERATED_KEYS]: () => keysReply([41, 42]) } });
      open();

      const r = await conn.query('insert into t values (null), (null)', undefined, undefined, { getGeneratedKeys: true });

      assert.deepStrictEqual(r.generatedKeys.ColumnValues, [[41], [42]]);
      // In this order, all inside query(): the close carries auto-commit and
      // ends the transaction; END_TRAN only follows when the CAS still reports
      // one open (as JDBC sends it).
      assert.deepStrictEqual(
        cas.log.filter((e) => e.fc !== FC.CAS_FC_CON_CLOSE).slice(-3).map((e) => e.fc),
        [FC.CAS_FC_PREPARE_AND_EXECUTE, FC.CAS_FC_GET_GENERATED_KEYS, FC.CAS_FC_CLOSE_REQ_HANDLE]
      );
      assert.strictEqual(conn._CASInfo[CAS.CAS_INFO_STATUS], CAS.CAS_INFO_STATUS_INACTIVE);
      assert.strictEqual(cas.log.find((e) => e.sql).autoCommit, 0);
      assert.deepStrictEqual(conn._queryResultSets, {});

      // getGeneratedKeys() answers from what was read; closeQuery() forgets it.
      const sent = cas.log.length;

      assert.deepStrictEqual(await conn.getGeneratedKeys(r.queryHandle), r.generatedKeys);
      await conn.closeQuery(r.queryHandle);
      assert.strictEqual(cas.log.length, sent);
      await assert.rejects(conn.getGeneratedKeys(r.queryHandle), { code: 'NO_ACTIVE_QUERY' });

      // Other statements keep auto-commit.
      await conn.sql('insert into t values (null)');
      assert.strictEqual(cas.log.filter((e) => e.sql).pop().autoCommit, 1);
    });

    it('does not commit by itself with auto-commit off', async function () {
      cas = await fakeCas({ onQuery: answer, handlers: { [FC.CAS_FC_GET_GENERATED_KEYS]: () => keysReply([7]) } });
      open();
      await conn.setAutoCommitMode(false);

      const r = await conn.query('insert into t values (null)', undefined, { getGeneratedKeys: true });

      assert.deepStrictEqual(r.generatedKeys.ColumnValues, [[7]]);
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_END_TRAN));
      await conn.rollback();
    });

    it('does the same on the prepare/execute path', function () {
      const pkt = new PrepareExecutePacket({
        casInfo: Buffer.alloc(4), autoCommit: true, protocolVersion: 9, queryTimeout: 0, getGeneratedKeys: true,
      });

      pkt.queryHandle = 1;
      pkt.statementType = CAS.CoraDBStatementType.CORADB_STMT_INSERT;

      const writer = new PacketWriter(pkt.getExecuteBufferLength());

      pkt.writeExecute(writer);

      // [len][casinfo][fc] [4][handle] [1][flag] [4][maxcol] [4][maxrow] [0]
      // [1][fetch flag] [1][auto-commit]
      const at = 4 + 4 + 1 + 8 + 5 + 8 + 8 + 4 + 5;

      assert.strictEqual(writer._buffer[at + 4], 0);
    });
  });
});
