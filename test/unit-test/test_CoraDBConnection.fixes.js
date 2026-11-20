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

  describe('column nullability: the server sends is_non_null', function () {
    // It was read the other way round, so NOT NULL and primary-key columns
    // came back nullable: true, and nullable ones nullable: false.
    const NULLABILITY = {
      columns: [['id', 'int'], ['note', 'string', { nullable: true }]],
      rows: [[1, 'a']],
    };

    it('reports a NOT NULL column as not nullable and a nullable one as nullable', async function () {
      cas = await fakeCas({ onQuery: () => NULLABILITY, columnsOf: () => NULLABILITY.columns });
      open();

      // Without values (PREPARE_AND_EXECUTE) and with values (PREPARE, EXECUTE).
      for (const [sql, params] of [['select id, note from t', undefined], ['select id, note from t where id = ?', [1]]]) {
        const { columns } = await conn.sql(sql, params);

        assert.deepStrictEqual(columns.map((c) => [c.name, c.nullable]), [['id', false], ['note', true]]);
      }

      // A cursor's columns.
      const cursor = await conn.cursor('select id, note from t');

      assert.deepStrictEqual(cursor.columns.map((c) => c.nullable), [false, true]);
      await cursor.close();
    });
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

  describe('getSchema(): as the server sends it', function () {
    // SCHEMA_INFO reply: handle, row count, no columns. FETCH reply: 0, rows.
    const schemaReply = (count) => new Out().int(7).int(count).int(0).reply();

    it('returns [] for an empty result without fetching (as JDBC), and closes the handle', async function () {
      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_SCHEMA_INFO]: () => schemaReply(0),
          // What the server answers a FETCH of some empty results.
          [FC.CAS_FC_FETCH]: () => new Out().int(-1).int(-10012).str('No more data').reply(),
        },
      });
      open();

      assert.deepStrictEqual(await conn.getSchema(CAS.CoraDBSchemaType.CCI_SCH_PRIMARY_KEY, 'no_such_table'), []);
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_FETCH));
      assert.ok(cas.log.some((e) => e.fc === FC.CAS_FC_CLOSE_REQ_HANDLE));
    });

    it('reads a collection column of ATTRIBUTE as SET / MULTISET / SEQUENCE with its element type', async function () {
      // The domain short as the server encodes it for protocol V7+:
      // (0x80 | collection bits) << 8 | type.
      const columns = [['n', 0x80, T.CCI_U_TYPE_INT], ['s', 0x80 | 0x20, T.CCI_U_TYPE_INT],
        ['m', 0x80 | 0x40, T.CCI_U_TYPE_STRING], ['l', 0x80 | 0x60, T.CCI_U_TYPE_DOUBLE]];

      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_SCHEMA_INFO]: () => schemaReply(columns.length),
          [FC.CAS_FC_FETCH]: () => {
            const out = new Out().int(0).int(columns.length);

            columns.forEach(([name, high, low], i) => {
              out.int(i + 1).bytes(8).str(name)
                .int(2).short((((high << 8) | low) << 16) >> 16) // domain, as a signed short
                .int(2).short(0).int(4).int(10) // scale, precision
                .int(2).short(0).int(2).short(0).int(2).short(0).int(2).short(0) // indexed, non_null, shared, unique
                .int(1).byte(0) // default: '' (the server always sends a string)
                .int(4).int(i + 1).str('t').str('t') // order, class, source class
                .int(2).short(0).str(''); // is_key, remarks
            });

            return out.reply();
          },
        },
      });
      open();

      const attrs = await conn.getSchema(CAS.CoraDBSchemaType.CCI_SCH_ATTRIBUTE, 't');

      assert.deepStrictEqual(attrs.map((a) => [a.Name, a.TypeName, a.ElementTypeName]), [
        ['n', 'Int', undefined],
        ['s', 'Set', 'Int'],
        ['m', 'Multiset', 'String'],
        ['l', 'Sequence', 'Double'],
      ]);
    });

    it('keeps the position of each column in a primary key (KeySeq)', async function () {
      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_SCHEMA_INFO]: () => schemaReply(2),
          // Sorted by column name, as the server sends them.
          [FC.CAS_FC_FETCH]: () => new Out().int(0).int(2)
            .int(1).bytes(8).str('t').str('a').int(4).int(2).str('pk_t')
            .int(2).bytes(8).str('t').str('b').int(4).int(1).str('pk_t')
            .reply(),
        },
      });
      open();

      const keys = await conn.getSchema(CAS.CoraDBSchemaType.CCI_SCH_PRIMARY_KEY, 't');

      assert.deepStrictEqual(keys.map((k) => [k.ColumnName, k.KeySeq]), [['a', 2], ['b', 1]]);
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

  describe('values the server sends with no bytes, or all zeros', function () {
    it('reads an empty BIT VARYING as an empty Buffer (not NULL), and an all-zero object id as null', async function () {
      const columns = [['v', T.CCI_U_TYPE_VARBIT], ['o', T.CCI_U_TYPE_OBJECT], ['g', T.CCI_U_TYPE_GRAPH_OBJECT]];
      const oid = Buffer.from([0, 0, 0, 7, 0, 3, 0, 1]);

      cas = await fakeCas({
        onQuery: () => ({
          columns,
          rows: [
            // Size 0: an empty value (the server's B''); size -1 is NULL.
            [{ raw: Buffer.alloc(0) }, { raw: Buffer.alloc(8) }, { raw: oid }],
            [null, null, null],
          ],
        }),
      });
      open();

      const { rows } = await conn.sql('select v, o, g from t', { rowsAs: 'arrays' });

      assert.ok(Buffer.isBuffer(rows[0][0]) && rows[0][0].length === 0);
      assert.strictEqual(rows[0][1], null);
      assert.strictEqual(rows[0][2], 'OID:@7|3|1');
      assert.deepStrictEqual(rows[1], [null, null, null]);
    });
  });

  describe('a lost session with auto-commit off, as the JDBC driver decides', function () {
    // TRANSACTION_LOST only when the session had a transaction open (the CAS
    // info status); otherwise the next request reconnects, as JDBC does when
    // !isActive(). It used to be refused whatever the status.
    const lose = async () => {
      await new Promise((resolve) => {
        conn._socket.once('close', resolve);
        conn._socket.destroy();
      });
    };

    it('reconnects silently after a commit, when nothing was pending', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.setAutoCommitMode(false);
      await conn.sql('insert into t values (1)');
      await conn.commit();
      assert.strictEqual(conn._CASInfo[CAS.CAS_INFO_STATUS], CAS.CAS_INFO_STATUS_INACTIVE);

      await lose();

      assert.strictEqual((await conn.sql('select a from t')).rowCount, 2);
      assert.strictEqual(conn.getAutoCommitMode(), false);
    });

    it('still fails with TRANSACTION_LOST when a transaction was open', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.setAutoCommitMode(false);
      await conn.sql('insert into t values (1)');
      assert.strictEqual(conn._CASInfo[CAS.CAS_INFO_STATUS], CAS.CAS_INFO_STATUS_ACTIVE);

      await lose();

      await assert.rejects(conn.sql('select a from t'), { code: 'TRANSACTION_LOST' });
      await conn.rollback();
      assert.strictEqual((await conn.sql('select a from t')).rowCount, 2);
    });
  });

  describe('a reply the driver cannot read', function () {
    it('fails the statement with PROTOCOL_ERROR and does not run it again', async function () {
      let runs = 0;

      cas = await fakeCas({
        onQuery: (sql) => {
          if (!/broken/.test(sql)) return answer(sql);
          runs += 1;
          // A value that claims to run past the end of the reply.
          const raw = Buffer.alloc(4);

          raw.writeInt32BE(1);
          return { columns: [['a', 'int']], rows: [[{ raw, size: 1000 }]] };
        },
      });
      open();

      await assert.rejects(conn.sql('select broken'), { code: 'PROTOCOL_ERROR' });
      // The server ran it once; it was not sent again on a new connection.
      assert.strictEqual(runs, 1);
    });
  });

  describe('a handle number the server hands out again', function () {
    // The CAS gives each new statement the lowest free number, so a closed
    // handle's number comes back at once. The driver went by the number alone.
    const keysReply = (ids) => {
      const out = new Out().int(0).byte(CAS.CoraDBStatementType.CORADB_STMT_INSERT).int(ids.length).byte(0).int(1);

      out.byte(T.CCI_U_TYPE_INT).short(0).int(10).str('id');
      out.int(ids.length);
      ids.forEach((id, i) => out.int(i + 1).bytes(8).int(4).int(id));

      return out.reply();
    };

    it('does not answer getGeneratedKeys() or skip closeQuery() for the next statement under the number', async function () {
      cas = await fakeCas({
        onQuery: answer,
        reuseHandles: true,
        handlers: { [FC.CAS_FC_GET_GENERATED_KEYS]: () => keysReply([41]) },
      });
      open();

      const insert = await conn.query('insert into t values (null)', undefined, undefined, { getGeneratedKeys: true });
      const select = await conn.query('select a from t');

      // The same number: the INSERT's handle was closed, and handed out again.
      assert.strictEqual(select.queryHandle, insert.queryHandle);
      // Not answered from the INSERT's stored keys: for a handle that is open,
      // the server is asked.
      const asks = () => cas.log.filter((e) => e.fc === FC.CAS_FC_GET_GENERATED_KEYS).length;
      const asked = asks();

      await conn.getGeneratedKeys(select.queryHandle);
      assert.strictEqual(asks(), asked + 1);

      // A real close, sent to the server.
      const closes = () => cas.log.filter((e) => e.fc === FC.CAS_FC_CLOSE_REQ_HANDLE).length;
      const before = closes();

      await conn.closeQuery(select.queryHandle);
      assert.strictEqual(closes(), before + 1);
      assert.deepStrictEqual(conn._queryResultSets, {});
    });

    it('does not let a cursor a rollback closed read or close the next statement under its number', async function () {
      cas = await fakeCas({
        onQuery: (sql) => (/from a\b/.test(sql)
          ? { columns: [['a', 'int']], rows: [[1], [2], [3], [4]] }
          : { columns: [['b', 'int']], rows: [[100], [200], [300], [400]] }),
        reuseHandles: true,
        fetchSize: 2,
      });
      open();
      await conn.setAutoCommitMode(false);

      const c1 = await conn.cursor('select a from a', { rowsAs: 'arrays' });

      assert.deepStrictEqual(await c1.next(), [[1], [2]]);
      await conn.rollback();

      const c2 = await conn.cursor('select b from b', { rowsAs: 'arrays' });

      assert.strictEqual(c2._handle, c1._handle);
      // c1's statement is gone: it reads nothing of c2's.
      await assert.rejects(c1.next(), { code: 'NO_ACTIVE_QUERY' });
      // And closing it leaves c2 alone.
      await c1.close();
      assert.deepStrictEqual(await c2.next(), [[100], [200]]);
      assert.deepStrictEqual(await c2.next(), [[300], [400]]);
      await c2.close();
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
  describe('the text formatter: MATCH patterns, years, arrays', function () {
    it('fills a ? inside a MATCH edge pattern, where [ is not a quoted name', function () {
      // The edge follows a `-`; `[x?]` later on is a quoted name, its ? text.
      const sql = 'SELECT * FROM MATCH (a:v)-[e:knows WHERE e.w > ?]->(b:v) WHERE a.id = ? AND [x?] = ?';

      assert.strictEqual(Helpers._countPlaceholders(sql), 3);
      assert.strictEqual(
        Helpers._sqlFormat(sql, [5, 7, 9]),
        'SELECT * FROM MATCH (a:v)-[e:knows WHERE e.w > 5]->(b:v) WHERE a.id = 7 AND [x?] = 9'
      );
    });

    it('reads <-[...]- and PATH_COMP patterns the same way', function () {
      assert.strictEqual(
        Helpers._sqlFormat('SELECT * FROM MATCH (a)<- [e WHERE e.w = ?] -(b)', ['x']),
        "SELECT * FROM MATCH (a)<- [e WHERE e.w = 'x'] -(b)"
      );
      assert.strictEqual(Helpers._countPlaceholders('SELECT PATH_COMP (a)-[e WHERE e.w > ?]->(b) FROM t'), 1);
      // Outside a graph pattern, a ? in [...] is part of a name.
      assert.strictEqual(Helpers._countPlaceholders('SELECT a-[b?] FROM t'), 0);
    });

    it('starts each statement of a batch outside MATCH', function () {
      assert.deepStrictEqual(
        Helpers._sqlFormatBatch(['UPDATE t SET x = 1 FROM MATCH (a)-[e:k WHERE e.w > ?]->(b)', 'DELETE FROM t WHERE id = ? AND [c?] = 1'], [5, 7]),
        ['UPDATE t SET x = 1 FROM MATCH (a)-[e:k WHERE e.w > 5]->(b)', 'DELETE FROM t WHERE id = 7 AND [c?] = 1']
      );
    });

    it('writes a year below 1000 with four digits (the server reads two as 19xx / 20xx)', function () {
      const d = new Date(0);

      d.setUTCFullYear(45, 0, 2);
      assert.strictEqual(Helpers._sqlFormat('SELECT ?', [d]), "SELECT '1/2/0045 0:0:0.000'");
    });

    it('refuses an array, which went out as the text 1,2', function () {
      assert.throws(() => Helpers._sqlFormat('SELECT * FROM t WHERE id IN (?)', [[1, 2]]), { code: 'INVALID_PARAMETER' });
    });
  });

  describe('bound NUMERIC and JSON values', function () {
    const numeric = (value) => bind([{ type: 'numeric', value }]).values[0];

    it('sends a NUMERIC as plain digits: no exponent, no +', function () {
      assert.strictEqual(numeric(1e-7), '0.0000001');
      assert.strictEqual(numeric('1.5E3'), '1500');
      assert.strictEqual(numeric(1e21), '1000000000000000000000');
      assert.strictEqual(numeric('-0.000123e2'), '-0.0123');
      assert.strictEqual(numeric('+12.5'), '12.5');
      assert.strictEqual(numeric('.5'), '0.5');
      assert.strictEqual(numeric('007'), '7');
      assert.strictEqual(numeric('12345678901234567890.0123456789'), '12345678901234567890.0123456789');
      assert.strictEqual(numeric(12345678901234567890n), '12345678901234567890');
      assert.throws(() => numeric('1e400'), { code: 'INVALID_PARAMETER' });
    });

    it('refuses a JSON value with no JSON form (it went out as NULL)', function () {
      assert.throws(() => bind([{ type: 'json', value: () => 1 }]), { code: 'INVALID_PARAMETER' });
      assert.throws(() => bind([{ type: 'json', value: Symbol('s') }]), { code: 'INVALID_PARAMETER' });
      assert.strictEqual(bind([{ type: 'json', value: { a: 1 } }]).values[0], '{"a":1}');
    });
  });

  describe('AUTO_COMMIT as a database parameter (the server refuses it)', function () {
    it('sets and reads the connection\'s own auto-commit mode', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.connect();

      await conn.setDatabaseParameter('AUTO_COMMIT', 0);
      assert.strictEqual(conn.getAutoCommitMode(), false);
      assert.strictEqual(await conn.getDatabaseParameter('autoCommit'), 0);

      await conn.setDatabaseParameter(CAS.CCIDbParam.CCI_PARAM_AUTO_COMMIT, 1);
      assert.strictEqual(conn.getAutoCommitMode(), true);
      assert.strictEqual(await conn.getDatabaseParameter('AUTO_COMMIT'), 1);

      // Neither went to the server as a SET_DB_PARAMETER / GET_DB_PARAMETER.
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_SET_DB_PARAMETER || e.fc === FC.CAS_FC_GET_DB_PARAMETER));
    });

    it('rejects an unknown parameter through the callback as well', function (done) {
      cas = { close: async () => undefined };
      conn = CoraDB.createConnection({ host: '127.0.0.1:1', database: 'x' });
      conn.getDatabaseParameter('nope', (err) => {
        assert.strictEqual(err.code, 'INVALID_PARAMETER');
        done();
      });
    });
  });

  describe('protocol details as the real server sends them', function () {
    it('names the server\'s default isolation level (4, READ COMMITTED)', function () {
      assert.strictEqual(CAS.CoraDBIsolationLevel.TRAN_DEFAULT_ISOLATION, CoraDB.IsolationLevel.READ_COMMITTED);
    });

    it('reads a CHECK_CAS reply with no body as a live session', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.connect();

      assert.strictEqual(await conn.isValid(), true);
      assert.ok(cas.log.some((e) => e.fc === FC.CAS_FC_CHECK_CAS));
    });

    it('reads a broker that reports V10 as speaking V9, the version the driver announced', async function () {
      cas = await fakeCas({ onQuery: answer, brokerVersion: CAS.CAS_PROTO_INDICATOR | 10 });
      open();
      await conn.connect();

      assert.strictEqual(conn.brokerInfo.protocolVersion, 9);
    });

    it('decodes a column\'s default value in the connection\'s charset, as JDBC does', function () {
      const ValueDecoder = require('../../src/packets/ValueDecoder');
      const PacketReader = require('../../src/packets/PacketReader');
      const out = new Out();
      // VARCHAR, ISO-8859-1: [2-byte type | charset][type]
      out.byte(CAS.ColumnTypeMask.HAS_2_BYTES | CAS.CharsetId.ISO8859_1).byte(T.CCI_U_TYPE_STRING);
      out.short(0).int(10).str('c').str('c').str('t').byte(0);
      const latin1 = Buffer.from('café', 'latin1');
      out.int(latin1.length + 1);
      out.parts.push(latin1, Buffer.from([0]));
      for (let i = 0; i < 7; ++i) out.byte(0);

      const reader = new PacketReader();
      reader.charset = 'latin1';
      reader.write(Buffer.concat(out.parts));

      const info = ValueDecoder.readColumnInfo(reader);

      assert.strictEqual(info.DefaultValue, 'café');
      assert.strictEqual(info.IsNullable, true);
    });
  });

  describe('the charset option (JDBC charSet)', function () {
    const LATIN1_E = Buffer.from('é', 'latin1');
    const UTF8_E = Buffer.from('é', 'utf8');

    it('is UTF-8 until the database says otherwise, and takes the ISO-8859-1 names', function () {
      assert.strictEqual(CoraDB.createConnection({ database: 'x' }).charset, 'utf8');

      for (const name of ['iso-8859-1', 'ISO-8859-1', 'iso_8859_1', 'latin1', 'iso88591']) {
        assert.strictEqual(CoraDB.createConnection({ database: 'x', charset: name }).charset, 'latin1');
      }

      assert.throws(() => CoraDB.createConnection({ database: 'x', charset: 'euc-kr' }), { code: 'INVALID_PARAMETER' });
    });

    it('sends SQL text and string parameters in ISO-8859-1', async function () {
      cas = await fakeCas({ onQuery: answer });
      open({ charset: 'iso-8859-1' });

      await conn.sql("update t set a = 'café'");
      await conn.sql('update t set a = ? where b = ?', ['été', 1]);
      await conn.execute(["update t set a = 'déjà'", 'update t set a = 2']);

      const sent = cas.log.filter((e) => e.raw);

      // The text statement, then the EXECUTE that carries the bound value.
      assert.ok(sent[0].raw.includes(Buffer.from("'café'", 'latin1')));
      assert.ok(sent.some((e) => e.fc === FC.CAS_FC_EXECUTE && e.raw.includes(Buffer.from('été', 'latin1'))));
      assert.ok(!sent.some((e) => e.raw.includes(UTF8_E)));
      assert.ok(cas.log.some((e) => e.fc === FC.CAS_FC_EXECUTE_BATCH));
    });

    it('sends UTF-8 by default', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await conn.sql("update t set a = 'café'");

      const sent = cas.log.find((e) => e.raw);

      assert.ok(sent.raw.includes(UTF8_E) && !sent.raw.includes(Buffer.from("café'", 'latin1')));
    });

    it('refuses a character ISO-8859-1 cannot hold, before anything is sent', async function () {
      cas = await fakeCas({ onQuery: answer });
      open({ charset: 'iso-8859-1' });
      await conn.connect();

      const before = cas.log.length;

      await assert.rejects(conn.sql("update t set a = '€'"), { code: 'INVALID_PARAMETER' });
      await assert.rejects(conn.sql('update t set a = ?', ['5 €']), { code: 'INVALID_PARAMETER' });
      // A PREPARE may go out for the second; no statement text with the character did.
      assert.ok(!cas.log.slice(before).some((e) => e.raw && e.raw.includes(Buffer.from('€', 'utf8'))));

      // The connection goes on.
      assert.strictEqual((await conn.sql('select a from t')).rows.length, 2);
      assert.ok(LATIN1_E.length === 1);
    });
  });
  describe("charset: 'auto' (the default: the database's own charset)", function () {
    it('reads ISO-8859-1 from an ISO-8859-1 database, once, and sends text in it', async function () {
      cas = await fakeCas({ onQuery: answer, dbCharset: 3 });
      open();

      assert.strictEqual(conn.charset, 'utf8');
      await conn.connect();
      assert.strictEqual(conn.charset, 'latin1');

      // Its handle closed: nothing left in the handle table.
      assert.deepStrictEqual(Object.keys(conn._queryResultSets), []);

      await conn.sql("update t set a = 'caf\u00e9'");
      assert.ok(cas.log.some((e) => e.raw && e.raw.includes(Buffer.from("'caf\u00e9'", 'latin1'))));

      // Not asked again after a reconnect: the database is the same.
      await conn.close();
      await conn.connect();
      assert.strictEqual(cas.charsetAsked(), 1);
      assert.strictEqual(conn.charset, 'latin1');
    });

    it('keeps UTF-8 for a UTF-8 database; takes the option written out too', async function () {
      cas = await fakeCas({ onQuery: answer });
      open({ charset: 'AUTO' });
      await conn.connect();

      assert.strictEqual(conn.charset, 'utf8');
      assert.strictEqual(cas.charsetAsked(), 1);
    });

    it('keeps UTF-8 and warns when the server refuses the query; the connect succeeds', async function () {
      const warnings = [];

      cas = await fakeCas({ onQuery: answer, dbCharset: { code: -493, message: 'no db_root' } });
      open({ logger: { warn: (m) => warnings.push(m) } });
      await conn.connect();

      assert.strictEqual(conn.charset, 'utf8');
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /no db_root/);
      assert.strictEqual((await conn.sql('select a from t')).rows.length, 2);
    });

    it('sends a literal that names its charset in that charset (_utf8, _iso88591)', async function () {
      cas = await fakeCas({ onQuery: answer, dbCharset: 3 });
      open();

      // An ISO-8859-1 database with a UTF-8 column: the literal's bytes are
      // UTF-8, the rest of the statement ISO-8859-1.
      await conn.sql("insert into t values (_utf8'이é', 'é')");

      const raw = cas.log.find((e) => e.raw).raw;

      assert.ok(raw.includes(Buffer.from("_utf8'이é'", 'utf8')));
      assert.ok(raw.includes(Buffer.from(", 'é')", 'latin1')));
      // Outside such a literal, a character ISO-8859-1 cannot hold is refused.
      await assert.rejects(conn.sql("insert into t values ('이')"), { code: 'INVALID_PARAMETER' });
    });

    it('writes and reads CLOB text as UTF-8 when the charset was read, in the charset when it was set', async function () {
      const written = [];
      const handlers = {
        [FC.CAS_FC_LOB_WRITE]: (body) => {
          const at = 4 + body.readInt32BE(0) + 4 + 8;
          const length = body.readInt32BE(at);

          written.push(Buffer.from(body.subarray(at + 4, at + 4 + length)));
          return new Out().int(length).reply();
        },
      };
      const clob = () => {
        const handle = Buffer.alloc(18);

        handle.writeInt32BE(CAS.CCILOBType.CCI_LOB_TYPE_CLOB, 0);
        handle.writeInt32BE(2, 12);
        return { packedLobHandle: handle, lobLength: 0, lobType: T.CCI_U_TYPE_CLOB, fileLocator: 'x' };
      };

      cas = await fakeCas({ onQuery: answer, dbCharset: 3, handlers });
      open();
      await conn.connect();
      assert.strictEqual(conn.charset, 'latin1');

      // As every earlier version wrote it: text ISO-8859-1 cannot hold too.
      await conn.lobWrite(clob(), 0, 'café 이');
      assert.deepStrictEqual(written.pop(), Buffer.from('café 이', 'utf8'));
      conn.abort();

      open({ charset: 'iso-8859-1' });
      await conn.lobWrite(clob(), 0, 'café');
      assert.deepStrictEqual(written.pop(), Buffer.from('café', 'latin1'));
    });

    it('does not ask with an explicit charset', async function () {
      cas = await fakeCas({ onQuery: answer, dbCharset: 3 });
      open({ charset: 'utf-8' });
      await conn.connect();
      assert.strictEqual(conn.charset, 'utf8');
      conn.abort();

      open({ charset: 'iso-8859-1' });
      await conn.connect();
      assert.strictEqual(conn.charset, 'latin1');

      assert.strictEqual(cas.charsetAsked(), 0);
    });
  });
  describe('SQL text in the charsets it names (charset.js encodeSql)', function () {
    const Text = require('../../src/charset');
    const hex = (s, c) => Text.encodeSql(s, c).toString('hex');
    const bytes = (...parts) => Buffer.concat(parts.map(([t, c]) => Buffer.from(t, c))).toString('hex');

    it('sends the whole statement in the connection charset when no literal names another', function () {
      assert.strictEqual(hex("select 'café'", 'latin1'), bytes(["select 'café'", 'latin1']));
      assert.strictEqual(hex("select 'café'", 'utf8'), bytes(["select 'café'", 'utf8']));
    });

    it('sends _utf8 and _iso88591 literals in their own charset, either way round', function () {
      assert.strictEqual(hex("select _UTF8'é', 'é'", 'latin1'),
        bytes(['select ', 'latin1'], ["_UTF8'é'", 'utf8'], [", 'é'", 'latin1']));
      assert.strictEqual(hex("select _iso88591'é', 'é'", 'utf8'),
        bytes(['select ', 'utf8'], ["_iso88591'é'", 'latin1'], [", 'é'", 'utf8']));
    });

    it('does not take a name inside a literal or a quoted name for a charset', function () {
      assert.strictEqual(hex("select 'it''s _utf8''é''', \"_utf8'x\"", 'latin1'),
        bytes(["select 'it''s _utf8''é''', \"_utf8'x\"", 'latin1']));
    });

    it('sends a comment ISO-8859-1 cannot hold as UTF-8; refuses such text anywhere else, naming where', function () {
      assert.strictEqual(hex("select 1 -- 한\nfrom t /* 국 */", 'latin1'),
        bytes(['select 1 ', 'latin1'], ['-- 한', 'utf8'], ['\nfrom t ', 'latin1'], ['/* 국 */', 'utf8']));
      assert.throws(() => Text.encodeSql("select _utf8'x', '이'", 'latin1'), /U\+C774, at 18\)/);
    });

    it('lets Node refuse what is not text, as before', function () {
      assert.throws(() => Text.sqlByteLength(1234, 'latin1'), /The "string" argument must be of type string/);
      assert.throws(() => Text.byteLength(1234, 'latin1'), /The "string" argument must be of type string/);
    });
  });
});
