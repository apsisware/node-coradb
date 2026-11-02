'use strict';

const assert = require('node:assert');

const CoraDB = require('../../index');
const CheckCasPacket = require('../../src/packets/CheckCasPacket');
const GeneratedKeysPacket = require('../../src/packets/GeneratedKeysPacket');
const PacketReader = require('../../src/packets/PacketReader');
const PacketWriter = require('../../src/packets/PacketWriter');
const PrepareExecutePacket = require('../../src/packets/PrepareExecutePacket');
const ValueDecoder = require('../../src/packets/ValueDecoder');
const { bind, checkTyped, CollectionValue } = require('../../src/params');
const { fakeCas, Out, columnInfo, typeBytes, errorReply } = require('./helpers/fakeCas');

/*
 * What 0.9.9 brought over from the other line of this driver: isValid()
 * (CHECK_CAS), the server-side query timeout, generated keys, strings decoded
 * in their column's charset, the single-byte type of the older protocols, and
 * SET / MULTISET / SEQUENCE parameters. The protocol parts run against the
 * pretend CAS over a real socket.
 */

const CAS = CoraDB.CASConstants;
const FC = CAS.CASFunctionCode;
const T = CAS.CoraDBDataType;
const GET_GENERATED_KEYS = CAS.CCIExecutionOption.CCI_EXEC_GET_GENERATED_KEYS;

const int32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
};

/** A reader positioned at the start of `buffer`. */
function reader(buffer) {
  const r = new PacketReader();
  r.write(buffer);
  return r;
}

/** The query timeout of an EXECUTE request without parameters: its last int. */
const lastInt = (raw) => raw.readInt32BE(raw.length - 4);

/** A GET_GENERATED_KEYS reply: one INT column `id` with these values. */
function keysReply(values, column = ['id', 'int']) {
  const out = new Out();

  out.int(0).byte(CAS.CoraDBStatementType.CORADB_STMT_SELECT).int(values.length).byte(0).int(1);
  typeBytes(out, column[1]);
  out.short(0).int(10).str(column[0]);
  out.int(values.length);
  values.forEach((v, i) => {
    out.int(i + 1).bytes(8);
    if (v === null) {
      out.int(-1);
    } else if (column[1] === 'bigint') {
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(BigInt(v));
      out.int(8);
      out.parts.push(b);
    } else {
      out.int(4).int(v);
    }
  });

  return out.reply();
}

describe('0.9.9: brought over from the other driver line', function () {
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
    if (conn) {
      await conn.close().catch(() => undefined);
      conn = undefined;
    }

    if (cas) {
      await cas.close();
      cas = undefined;
    }
  });

  describe('isValid()', function () {
    it('is true on an open connection, and asks the CAS', async function () {
      cas = await fakeCas({ onQuery: () => ({ affected: 0 }) });
      open();
      await conn.connect();

      assert.strictEqual(await conn.isValid(), true);
      assert.ok(cas.log.some((e) => e.fc === FC.CAS_FC_CHECK_CAS));
    });

    it('is false before connecting, and neither connects nor sends anything', async function () {
      cas = await fakeCas({ onQuery: () => ({ affected: 0 }) });
      open();

      assert.strictEqual(await conn.isValid(), false);
      assert.strictEqual(cas.logins(), 0);
      assert.strictEqual(cas.log.length, 0);
    });

    it('is false after close()', async function () {
      cas = await fakeCas({ onQuery: () => ({ affected: 0 }) });
      open();
      await conn.connect();
      await conn.close();

      assert.strictEqual(await conn.isValid(), false);
    });

    it('is false when the CAS answers with an error, and does not reject', async function () {
      cas = await fakeCas({
        onQuery: () => ({ affected: 0 }),
        handlers: { [FC.CAS_FC_CHECK_CAS]: () => errorReply({ code: -10005, message: 'gone' }) },
      });
      open();
      await conn.connect();

      assert.strictEqual(await conn.isValid(), false);
    });

    it('is false when the CAS closes the socket instead of answering', async function () {
      cas = await fakeCas({
        onQuery: () => ({ affected: 0 }),
        handlers: { [FC.CAS_FC_CHECK_CAS]: (body, entry, socket) => { socket.end(); return null; } },
      });
      open();
      await conn.connect();

      assert.strictEqual(await conn.isValid(), false);
    });

    it('answers a callback with (undefined, valid)', async function () {
      cas = await fakeCas({ onQuery: () => ({ affected: 0 }) });
      open();
      await conn.connect();

      const args = await new Promise((resolve) => conn.isValid((...a) => resolve(a)));

      assert.deepStrictEqual(args, [undefined, true]);
    });

    it('waits its turn behind the statement that is running', async function () {
      let release;
      cas = await fakeCas({
        onQuery: () => new Promise((resolve) => { release = () => resolve({ affected: 1 }); }),
      });
      open();
      await conn.connect();

      const update = conn.query('update t set a = 1');
      const valid = conn.isValid();

      await new Promise((r) => setTimeout(r, 30));
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_CHECK_CAS), 'CHECK_CAS went out during the statement');
      release();

      await update;
      assert.strictEqual(await valid, true);
    });
  });

  describe('the server-side query timeout', function () {
    it('sends 0 by default', async function () {
      cas = await fakeCas({ onQuery: () => ({ columns: [['a', 'int']], rows: [[1]] }) });
      open();

      await conn.query('select a from t');

      assert.strictEqual(conn.getQueryTimeout(), 0);
      assert.strictEqual(cas.log.find((e) => e.sql).queryTimeout, 0);
    });

    it('sends the connection option with every PREPARE_AND_EXECUTE', async function () {
      cas = await fakeCas({ onQuery: () => ({ columns: [['a', 'int']], rows: [[1]] }) });
      open({ queryTimeout: 1500 });

      await conn.query('select a from t');
      await conn.queryAll('select a from t');

      const sent = cas.log.filter((e) => e.fc === FC.CAS_FC_PREPARE_AND_EXECUTE).map((e) => e.queryTimeout);
      assert.deepStrictEqual(sent, [1500, 1500]);
    });

    it('takes it as the tenth positional argument too', function () {
      const c = CoraDB.createConnection('h', 33000, 'dba', '', 'db', 0, 1, undefined, 0, 700);
      assert.strictEqual(c.getQueryTimeout(), 700);
    });

    it('setQueryTimeout() applies to the statements after it; nonsense is none', async function () {
      cas = await fakeCas({ onQuery: () => ({ columns: [['a', 'int']], rows: [[1]] }) });
      open();

      conn.setQueryTimeout(250);
      await conn.query('select a from t');
      conn.setQueryTimeout(12.7);
      await conn.query('select a from t');
      conn.setQueryTimeout(-5);
      await conn.query('select a from t');
      conn.setQueryTimeout('abc');

      assert.strictEqual(conn.getQueryTimeout(), 0);
      const sent = cas.log.filter((e) => e.sql).map((e) => e.queryTimeout);
      assert.deepStrictEqual(sent, [250, 12, 0]);
    });

    it('is sent with EXECUTE: executeWithTypedParams(), sql() with parameters, prepare().run()', async function () {
      cas = await fakeCas({
        onQuery: (sql) => (/^select/i.test(sql) ? { columns: [['a', 'int']], rows: [[1]] } : { affected: 1 }),
        columnsOf: () => [['a', 'int']],
      });
      open({ queryTimeout: 900 });

      await conn.executeWithTypedParams('update t set a = 1', [], []);
      await conn.sql('select a from t where a = ?', [1]);
      const stmt = await conn.prepare('select a from t where a = ?');
      await stmt.run([2]);
      await stmt.close();

      const executes = cas.log.filter((e) => e.fc === FC.CAS_FC_EXECUTE);
      assert.strictEqual(executes.length, 3);
      // Without parameters the timeout is the last int; with them, it is the
      // int before the first parameter's type (int length 1, then the byte).
      assert.strictEqual(lastInt(executes[0].raw), 900);
      for (const e of executes.slice(1)) {
        assert.strictEqual(e.raw.readInt32BE(64), 900);
      }
    });

    it('lets the server stop the statement: its error, and the connection carries on', async function () {
      let n = 0;
      cas = await fakeCas({
        onQuery: () => (++n === 1
          ? { error: { code: -1104, message: 'Query timeout' } }
          : { columns: [['a', 'int']], rows: [[1]] }),
      });
      open({ queryTimeout: 10 });

      await assert.rejects(conn.query('select a from t'), (err) => err.code === -1104);
      assert.deepStrictEqual((await conn.query('select a from t')).result.ColumnValues, [[1]]);
    });
  });

  describe('generated keys', function () {
    it('sets the GET_GENERATED_KEYS execute flag only when asked', async function () {
      cas = await fakeCas({ onQuery: () => ({ affected: 1 }) });
      open();

      await conn.query("insert into t (name) values ('a')");
      await conn.query("insert into t (name) values ('b')", undefined, undefined, { getGeneratedKeys: true });
      await conn.query("insert into t (name) values ('c')", undefined, { getGeneratedKeys: true });

      const flags = cas.log.filter((e) => e.sql).map((e) => e.flag & GET_GENERATED_KEYS);
      assert.deepStrictEqual(flags, [0, GET_GENERATED_KEYS, GET_GENERATED_KEYS]);
      // CCI_EXEC_QUERY_ALL stays set alongside it.
      assert.ok(cas.log.filter((e) => e.sql).every((e) => e.flag & CAS.CCIExecutionOption.CCI_EXEC_QUERY_ALL));
    });

    it('sets it on EXECUTE too, on the old protocol', async function () {
      cas = await fakeCas({ onQuery: () => ({ affected: 1 }) });
      open();
      conn.setEnforceOldQueryProtocol(true);

      await conn.query("insert into t (name) values ('a')", undefined, undefined, { getGeneratedKeys: true });

      const execute = cas.log.find((e) => e.fc === FC.CAS_FC_EXECUTE);
      // Query handle (int length + int), then the flag (int length + byte).
      assert.strictEqual(execute.raw[12] & GET_GENERATED_KEYS, GET_GENERATED_KEYS);
    });

    it('getGeneratedKeys() asks for the INSERT\'s handle and reads the keys', async function () {
      let asked;
      cas = await fakeCas({
        onQuery: () => ({ affected: 2 }),
        handlers: {
          [FC.CAS_FC_GET_GENERATED_KEYS]: (body) => {
            asked = body.readInt32BE(4);
            return keysReply([41, 42]);
          },
        },
      });
      open();

      const { queryHandle } = await conn.query("insert into t (name) values ('a'), ('b')", undefined, undefined, { getGeneratedKeys: true });
      const keys = await conn.getGeneratedKeys(queryHandle);
      await conn.closeQuery(queryHandle);

      assert.strictEqual(asked, queryHandle);
      assert.deepStrictEqual(keys, {
        ColumnDataTypes: ['Int'],
        ColumnNames: ['id'],
        ColumnValues: [[41], [42]],
        RowsCount: 2,
      });
    });

    it('reads a BIGINT key beyond 2^53 as its text, like any other BIGINT', async function () {
      cas = await fakeCas({
        onQuery: () => ({ affected: 1 }),
        handlers: { [FC.CAS_FC_GET_GENERATED_KEYS]: () => keysReply(['9007199254740993'], ['id', 'bigint']) },
      });
      open();

      const { queryHandle } = await conn.query('insert into t values (null)', undefined, { getGeneratedKeys: true });
      const keys = await conn.getGeneratedKeys(queryHandle);

      assert.deepStrictEqual(keys.ColumnValues, [['9007199254740993']]);
    });

    it('answers a callback with (undefined, result)', async function () {
      cas = await fakeCas({
        onQuery: () => ({ affected: 1 }),
        handlers: { [FC.CAS_FC_GET_GENERATED_KEYS]: () => keysReply([7]) },
      });
      open();

      const { queryHandle } = await conn.query('insert into t values (null)', undefined, { getGeneratedKeys: true });
      const args = await new Promise((resolve) => conn.getGeneratedKeys(queryHandle, (...a) => resolve(a)));

      assert.strictEqual(args[0], undefined);
      assert.deepStrictEqual(args[1].ColumnValues, [[7]]);
    });

    it('fails with NO_ACTIVE_QUERY for a handle that is not open, and sends nothing', async function () {
      cas = await fakeCas({ onQuery: () => ({ affected: 1 }) });
      open();
      await conn.connect();

      await assert.rejects(conn.getGeneratedKeys(99), { code: 'NO_ACTIVE_QUERY' });
      await conn.close();
      await assert.rejects(conn.getGeneratedKeys(1), { code: 'NO_ACTIVE_QUERY' });
      assert.ok(!cas.log.some((e) => e.fc === FC.CAS_FC_GET_GENERATED_KEYS));
    });

    it('rejects with the server\'s error', async function () {
      cas = await fakeCas({
        onQuery: () => ({ affected: 1 }),
        handlers: { [FC.CAS_FC_GET_GENERATED_KEYS]: () => errorReply({ code: -10000, message: 'no keys' }) },
      });
      open();

      // The keys are read when the INSERT runs (as JDBC reads them), so it is
      // query() that fails — after closing the handle and, in auto-commit
      // mode, committing the INSERT, as JDBC does.
      await assert.rejects(
        conn.query('insert into t values (null)', undefined, { getGeneratedKeys: true }),
        (err) => err.code === -10000
      );

      assert.deepStrictEqual(conn._queryResultSets, {});
      assert.ok(cas.log.some((e) => e.fc === FC.CAS_FC_CLOSE_REQ_HANDLE));
      // The transaction is over: no INSERT is left uncommitted.
      assert.strictEqual(conn._CASInfo[0], 0);
      // And the connection is still good.
      assert.strictEqual(await conn.isValid(), true);
    });
  });

  describe('strings in their column\'s charset', function () {
    const LATIN1_CAFE = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0]);
    const UTF8_CAFE = Buffer.concat([Buffer.from('café', 'utf8'), Buffer.from([0])]);

    it('decodes ISO-8859-1 as Latin-1, UTF-8 and ASCII as UTF-8', async function () {
      const columns = [
        ['l', 'string', { charset: CAS.CharsetId.ISO8859_1 }],
        ['u', 'string', { charset: CAS.CharsetId.UTF8 }],
        ['a', 'string', { charset: CAS.CharsetId.ASCII }],
      ];
      cas = await fakeCas({
        onQuery: () => ({ columns, rows: [[{ raw: LATIN1_CAFE }, { raw: UTF8_CAFE }, { raw: UTF8_CAFE }]] }),
      });
      open();

      const { rows } = await conn.sql('select l, u, a from t');

      assert.deepStrictEqual(rows, [{ l: 'café', u: 'café', a: 'café' }]);
    });

    it('keeps the bytes of a BINARY string recoverable', async function () {
      const bytes = Buffer.from([0x00, 0x80, 0xff, 0x41]);
      const columns = [['b', 'string', { charset: CAS.CharsetId.BINARY }]];
      cas = await fakeCas({ onQuery: () => ({ columns, rows: [[{ raw: Buffer.concat([bytes, Buffer.from([0])]) }]] }) });
      open();

      const { result } = await conn.query('select b from t');

      assert.deepStrictEqual(Buffer.from(result.ColumnValues[0][0], 'latin1'), bytes);
    });

    it('decodes the elements of a collection in its charset', async function () {
      const seq = Buffer.concat([Buffer.from([T.CCI_U_TYPE_STRING]), int32(2), int32(5), LATIN1_CAFE, int32(2), Buffer.from('x\0')]);
      const columns = [['s', T.CCI_U_TYPE_SEQUENCE, { elementType: 'string', charset: CAS.CharsetId.ISO8859_1 }]];
      cas = await fakeCas({ onQuery: () => ({ columns, rows: [[{ raw: seq }]] }) });
      open();

      const { rows, columns: meta } = await conn.sql('select s from t');

      assert.deepStrictEqual(rows, [{ s: ['café', 'x'] }]);
      assert.strictEqual(meta[0].elementType, 'String');
    });

    it('records the encoding on the column\'s metadata', function () {
      const out = new Out();
      columnInfo(out, ['l', 'string', { charset: CAS.CharsetId.ISO8859_1 }]);
      columnInfo(out, ['n', 'int']);
      const r = reader(Buffer.concat(out.parts));

      const [l, n] = ValueDecoder.readColumnInfos(r, 2);

      assert.strictEqual(l.Charset, 'latin1');
      assert.strictEqual(n.Charset, 'utf8');
    });
  });

  describe('column types', function () {
    it('reads the single byte of the older protocols: collection bits and a five-bit type', function () {
      const r = reader(Buffer.from([CAS.CollectionFlag.SET | T.CCI_U_TYPE_INT, T.CCI_U_TYPE_DATE]));

      assert.deepStrictEqual(ValueDecoder.readType(r), { type: T.CCI_U_TYPE_SET, elementType: T.CCI_U_TYPE_INT, charset: null, length: 1 });
      assert.deepStrictEqual(ValueDecoder.readType(r), { type: T.CCI_U_TYPE_DATE, elementType: undefined, charset: null, length: 1 });
    });

    it('reads two bytes on V7+, a type above 31 included', function () {
      const r = reader(Buffer.from([0x80 | CAS.CharsetId.UTF8, T.CCI_U_TYPE_JSON, 0x80 | CAS.CollectionFlag.MULTISET, T.CCI_U_TYPE_DOUBLE]));

      assert.deepStrictEqual(ValueDecoder.readType(r), { type: T.CCI_U_TYPE_JSON, elementType: undefined, charset: 'utf8', length: 2 });
      assert.deepStrictEqual(ValueDecoder.readType(r), { type: T.CCI_U_TYPE_MULTISET, elementType: T.CCI_U_TYPE_DOUBLE, charset: 'utf8', length: 2 });
    });

    it('a legacy SET OF INT column reads as one, rows and all', async function () {
      const set = Buffer.concat([Buffer.from([T.CCI_U_TYPE_INT]), int32(2), int32(4), int32(1), int32(4), int32(2)]);
      const columns = [['s', T.CCI_U_TYPE_SET, { elementType: 'int', oneByte: true }]];
      cas = await fakeCas({ onQuery: () => ({ columns, rows: [[{ raw: set }]] }) });
      open();

      const { rows, columns: meta } = await conn.sql('select s from t');

      assert.deepStrictEqual(rows, [{ s: [1, 2] }]);
      assert.strictEqual(meta[0].type, 'Set');
      assert.strictEqual(meta[0].elementType, 'Int');
    });

    it('maps charset ids to Node.js encodings', function () {
      const ids = CAS.CharsetId;
      assert.deepStrictEqual(
        [ids.ASCII, ids.RAW_BITS, ids.BINARY, ids.ISO8859_1, ids.EUC_KR, ids.UTF8, 7].map((id) => CAS.getCharsetEncoding(id)),
        ['utf8', 'utf8', 'latin1', 'latin1', 'utf8', 'utf8', 'utf8']
      );
      assert.deepStrictEqual(CAS.confirmColumnType(0, T.CCI_U_TYPE_INT), { columnType: T.CCI_U_TYPE_INT, elementType: T.CCI_U_TYPE_UNKNOWN });
      assert.deepStrictEqual(CAS.confirmColumnType(CAS.CollectionFlag.SEQUENCE, T.CCI_U_TYPE_STRING), { columnType: T.CCI_U_TYPE_SEQUENCE, elementType: T.CCI_U_TYPE_STRING });
    });
  });

  describe('SET, MULTISET and SEQUENCE parameters', function () {
    it('binds { type, value } with the element type inferred, given, or in the type name', function () {
      const { values, types } = bind([
        { type: 'set', value: [1, 2, 3] },
        { type: 'multiset', value: ['a', null], elementType: 'char' },
        { type: 'list of numeric', value: ['1.50', 2] },
        { type: 'sequence(date)', value: ['2026-01-31'] },
        { type: 'MULTISET<double>', value: [1] },
      ]);

      assert.deepStrictEqual(types, ['set', 'multiset', 'sequence', 'sequence', 'multiset']);
      assert.ok(values.every((v) => v instanceof CollectionValue));
      assert.deepStrictEqual(values.map((v) => v.elementType), ['int', 'char', 'numeric', 'date', 'double']);
      assert.deepStrictEqual(values[0].items, [1, 2, 3]);
      assert.deepStrictEqual(values[1].items, ['a', null]);
      assert.deepStrictEqual(values[2].items, ['1.50', '2']);
      assert.strictEqual(values[3].items[0].toISOString(), '2026-01-31T00:00:00.000Z');
    });

    it('infers one element type: whole numbers and fractions are DOUBLE, big whole numbers BIGINT', function () {
      const { values } = bind([
        { type: 'set', value: [1, 2.5] },
        { type: 'set', value: [1, 2 ** 40] },
        { type: 'set', value: [] },
        { type: 'set', value: [null, null] },
      ]);

      assert.deepStrictEqual(values.map((v) => v.elementType), ['double', 'bigint', 'null', 'null']);
      assert.deepStrictEqual(values[1].items, [1n, 2n ** 40n]);
    });

    it('refuses what cannot be bound, by parameter, before anything is sent', function () {
      const bad = [
        [{ type: 'set', value: 'abc' }, /must be an array/],
        [{ type: 'set', value: [1, 'a'] }, /different types/],
        [{ type: 'set', value: [[1]] }, /cannot hold a collection/],
        [{ type: 'set', value: [1], elementType: 'blob' }, /cannot be the type of a collection's elements/],
        [{ type: 'set of clob', value: [1] }, /cannot be the type of a collection's elements/],
        [{ type: 'set', value: ['x'], elementType: 'int' }, /not a number/],
      ];

      for (const [param, message] of bad) {
        assert.throws(() => bind([param]), (err) => err.code === 'INVALID_PARAMETER' && message.test(err.message), JSON.stringify(param));
      }

      // A plain array is still not a value: it is too easy to mean an IN list.
      assert.throws(() => bind([[1, 2]]), { code: 'INVALID_PARAMETER' });
    });

    it('executeWithTypedParams() takes set / multiset / sequence / list, with or without an element type', function () {
      const { values, types } = checkTyped([[1, 2], ['a'], [1.5], [null]], ['set', 'multiset of varchar', 'list', 'sequence']);

      assert.deepStrictEqual(types, ['set', 'multiset', 'sequence', 'sequence']);
      assert.deepStrictEqual(values.map((v) => v.elementType), ['int', 'varchar', 'double', 'null']);
      assert.ok(CoraDB.BINDABLE_TYPES.includes('set'));
      assert.ok(CoraDB.BINDABLE_TYPES.includes('list'));
    });

    it('writes [type][length][element type][each element with its length], and declares that length', function () {
      const { values, types } = bind([{ type: 'set', value: [1, null, 3] }, 'x']);
      const packet = new PrepareExecutePacket({
        casInfo: Buffer.alloc(4),
        paramTypes: types,
        paramValues: values,
        protocolVersion: CAS.CAS_PROTOCOL_VERSION,
        sql: 'insert into t values (?, ?)',
      });
      packet.queryHandle = 1;
      const length = packet.getExecuteBufferLength();
      const writer = new PacketWriter(length);

      packet.writeExecute(writer);

      assert.strictEqual(writer._offset, length);
      assert.strictEqual(writer._buffer.readInt32BE(0), length - 8);

      const params = writer._buffer.subarray(writer._offset - (5 + 4 + 21 + 5 + 4 + 2));
      // A SET goes as a SEQUENCE, as the JDBC driver sends every collection;
      // the server makes it the column's type.
      const expected = Buffer.concat([
        int32(1), Buffer.from([T.CCI_U_TYPE_SEQUENCE]),
        int32(21), Buffer.from([T.CCI_U_TYPE_INT]),
        int32(4), int32(1), int32(0), int32(4), int32(3),
        int32(1), Buffer.from([T.CCI_U_TYPE_STRING]),
        int32(2), Buffer.from('x\0'),
      ]);
      assert.deepStrictEqual(params, expected);
    });

    it('infers the element type of a plain array given to the packet directly', function () {
      const packet = new PrepareExecutePacket({
        casInfo: Buffer.alloc(4),
        paramTypes: ['sequence', 'sequence', 'set'],
        paramValues: [['a', 'b'], [new Date(Date.UTC(2026, 0, 31, 10, 0, 0))], [true]],
        protocolVersion: CAS.CAS_PROTOCOL_VERSION,
        sql: 'x',
      });

      const p0 = packet._collectionPayload(0);
      const p1 = packet._collectionPayload(1);
      const p2 = packet._collectionPayload(2);

      assert.deepStrictEqual(p0, Buffer.concat([Buffer.from([T.CCI_U_TYPE_STRING]), int32(2), Buffer.from('a\0'), int32(2), Buffer.from('b\0')]));
      assert.strictEqual(p1[0], T.CCI_U_TYPE_DATETIME);
      assert.strictEqual(p1.readInt32BE(1), 14);
      assert.deepStrictEqual(p2, Buffer.concat([Buffer.from([T.CCI_U_TYPE_SHORT]), int32(2), Buffer.from([0, 1])]));
      // Made once: the length and the bytes are the same buffer.
      assert.strictEqual(packet._collectionPayload(0), p0);
    });

    it('goes over the wire from executeWithTypedParams() and sql()', async function () {
      cas = await fakeCas({ onQuery: () => ({ affected: 1 }) });
      open();

      await conn.executeWithTypedParams('insert into t values (?)', [[10, 20]], ['sequence']);
      await conn.sql('insert into t values (?)', [{ type: 'set', value: ['a'] }]);
      await conn.sql('insert into t values (?)', [{ type: 'multiset', value: ['a'] }]);

      const [first, second, third] = cas.log.filter((e) => e.fc === FC.CAS_FC_EXECUTE).map((e) => e.raw);
      const seq = Buffer.concat([int32(1), Buffer.from([T.CCI_U_TYPE_SEQUENCE]), int32(17), Buffer.from([T.CCI_U_TYPE_INT]), int32(4), int32(10), int32(4), int32(20)]);
      // Declared a SET, sent as a SEQUENCE (as JDBC does).
      const set = Buffer.concat([int32(1), Buffer.from([T.CCI_U_TYPE_SEQUENCE]), int32(7), Buffer.from([T.CCI_U_TYPE_STRING]), int32(2), Buffer.from('a\0')]);

      assert.deepStrictEqual(first.subarray(first.length - seq.length), seq);
      assert.deepStrictEqual(second.subarray(second.length - set.length), set);
      // A MULTISET too: sent as one, the server refused it (-454).
      assert.deepStrictEqual(third.subarray(third.length - set.length), set);
    });
  });

  describe('the packets', function () {
    it('CHECK_CAS is the function code and nothing else', function () {
      const packet = new CheckCasPacket({ casInfo: Buffer.from([0, 0xff, 0xff, 0xff]) });
      const writer = new PacketWriter(packet.getBufferLength());

      packet.write(writer);

      assert.deepStrictEqual(writer._buffer, Buffer.from([0, 0, 0, 1, 0, 0xff, 0xff, 0xff, FC.CAS_FC_CHECK_CAS]));
    });

    it('CHECK_CAS parses an error reply into an error', function () {
      const packet = new CheckCasPacket();

      assert.strictEqual(packet.parse(reader(new Out().int(0).reply())), undefined);
      const err = new CheckCasPacket().parse(reader(errorReply({ code: -10005, message: 'gone' })));
      assert.ok(err instanceof Error);
      assert.strictEqual(err.code, -10005);
    });

    it('GET_GENERATED_KEYS names the query handle', function () {
      const packet = new GeneratedKeysPacket({ casInfo: Buffer.alloc(4), queryHandle: 9 });
      const writer = new PacketWriter(packet.getBufferLength());

      packet.write(writer);

      assert.deepStrictEqual(writer._buffer, Buffer.concat([int32(9), Buffer.alloc(4), Buffer.from([FC.CAS_FC_GET_GENERATED_KEYS]), int32(4), int32(9)]));
    });

    it('GET_GENERATED_KEYS reads the short column descriptions, with NULL keys', function () {
      const packet = new GeneratedKeysPacket({ casInfo: Buffer.alloc(4), queryHandle: 1 });

      assert.strictEqual(packet.parse(reader(keysReply([5, null]))), undefined);
      assert.strictEqual(packet.infoArray[0].Name, 'id');
      assert.strictEqual(packet.infoArray[0].precision, 10);
      assert.deepStrictEqual(packet.resultSet.ColumnValues, [[5], [null]]);
    });
  });
});
