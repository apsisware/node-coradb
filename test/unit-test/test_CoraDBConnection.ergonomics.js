'use strict';

const assert = require('node:assert');

const CoraDB = require('../../index');
const { bind } = require('../../src/params');
const PacketReader = require('../../src/packets/PacketReader');
const PacketWriter = require('../../src/packets/PacketWriter');
const PrepareExecutePacket = require('../../src/packets/PrepareExecutePacket');
const BatchExecuteNoQueryPacket = require('../../src/packets/BatchExecuteNoQueryPacket');
const { fakeCas } = require('./helpers/fakeCas');

/* Typed errors, parameter binding and the exported surface, without a server. */

function batchReply(statements, protocolVersion) {
  const parts = [];
  const int = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    parts.push(b);
  };

  int(0); // response code
  int(statements.length);
  for (const s of statements) {
    parts.push(Buffer.from([20]));
    if (s.error) {
      int(-1);
      if (protocolVersion > 2) int(s.error.code);
      const msg = Buffer.from(s.error.message + '\0');
      int(msg.length);
      parts.push(msg);
    } else {
      int(s.count);
      int(0);
      parts.push(Buffer.alloc(4));
    }
  }
  if (protocolVersion > 4) int(0);

  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeInt32BE(body.length, 0);

  return Buffer.concat([head, body]);
}

describe('test_CoraDBConnection.ergonomics', function () {
  describe('binding values', function () {
    it('works out the type from the value', function () {
      const d = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
      const { values, types } = bind([1, 2 ** 40, 1.5, 'x', true, d, Buffer.from([1]), null, 10n]);

      assert.deepStrictEqual(types, ['int', 'bigint', 'double', 'varchar', 'short', 'datetime', 'varbit', 'varchar', 'bigint']);
      assert.deepStrictEqual(values.slice(0, 5), [1, 2n ** 40n, 1.5, 'x', 1]);
      assert.strictEqual(values[7], null);
    });

    it('takes a type given explicitly, and checks the value against it', function () {
      const { values, types } = bind([{ type: 'numeric', value: '12.50' }, { type: 'INT', value: '7' }, { type: 'json', value: { a: 1 } }]);

      assert.deepStrictEqual(types, ['numeric', 'int', 'json']);
      assert.deepStrictEqual(values, ['12.50', 7, '{"a":1}']);
      assert.throws(() => bind([{ type: 'int', value: 2 ** 40 }]), /Parameter 1: 1099511627776 does not fit an INT/);
      assert.throws(() => bind([{ type: 'nmeric', value: 1 }]), (err) => err.code === 'INVALID_PARAMETER' && /unknown type "nmeric"/.test(err.message));
      assert.throws(() => bind([NaN]), /cannot be bound/);
      assert.throws(() => bind([[1, 2]]), /a value of type array cannot be bound/);
    });

    it('writes NULL and a 64-bit value into an execute packet of the right length', function () {
      const { values, types } = bind([null, -5n, 'é']);
      const packet = new PrepareExecutePacket({
        casInfo: Buffer.from([0, 0, 0, 0]),
        paramValues: values,
        paramTypes: types,
        protocolVersion: 9,
        sql: 'x',
      });
      packet.queryHandle = 1;
      const writer = new PacketWriter(packet.getExecuteBufferLength());
      packet.writeExecute(writer);

      // The length the header promised is the length written.
      assert.strictEqual(writer._buffer.length, packet.getExecuteBufferLength());
      assert.strictEqual(writer._buffer.readInt32BE(0), writer._buffer.length - 8);
      assert.ok(writer._buffer.includes(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfb])));
    });

    it('checks executeWithTypedParams before queueing anything', async function () {
      const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');

      await assert.rejects(conn.executeWithTypedParams('insert into t values (?)', [1], ['integr']), (err) => {
        assert.strictEqual(err.code, 'INVALID_PARAMETER');
        assert.strictEqual(err.statement, 'insert into t values (?)');
        return true;
      });
      await assert.rejects(conn.executeWithTypedParams('insert into t values (?, ?)', [1, 2], ['int']), /2 parameter\(s\) and 1 data type/);
      assert.strictEqual(conn.getQueueLength(), 0);
    });
  });

  describe('typed errors', function () {
    it('names a server error with no text by its code, never undefined', function () {
      const body = Buffer.alloc(8 + 4 + 4 + 1);
      body.writeInt32BE(9, 0);
      body.writeInt32BE(-1, 8);
      body.writeInt32BE(-99999, 12);
      const reader = new PacketReader();
      reader.write(body);
      reader._parseInt();
      reader._parseBytes(4);
      reader._parseInt();
      const err = reader.readError(9);

      assert.ok(err instanceof CoraDB.CoraDBError);
      assert.strictEqual(err.message, 'CoraDB error -99999');
      assert.strictEqual(err.code, -99999);
      assert.strictEqual(err.casCode, -99999);
    });

    it('says which statements of a batch failed, and what the others changed', function () {
      const sqls = ['update a set x = 1', 'insert into b values (1)', 'delete from c'];
      const packet = new BatchExecuteNoQueryPacket({ casInfo: Buffer.alloc(4), protocolVersion: 9, sqls });
      const reader = new PacketReader();
      reader.write(batchReply([{ count: 3 }, { error: { code: -670, message: 'Unique key violated' } }, { count: 0 }], 9));

      assert.strictEqual(packet.parse(reader), undefined);
      assert.deepStrictEqual(packet.counts, [3, null, 0]);
      const [err] = packet.errors;
      assert.ok(err instanceof CoraDB.CoraDBError);
      assert.deepStrictEqual([err.code, err.casCode, err.statementIndex, err.statement, err.message],
        [-670, -1, 1, 'insert into b values (1)', 'Unique key violated']);

      const batch = new CoraDB.CoraDBBatchError(packet.errors, '1 statement(s) in the batch failed', packet.counts);
      assert.ok(batch instanceof AggregateError);
      assert.strictEqual(batch.name, 'CoraDBBatchError');
      assert.deepStrictEqual(batch.results, [3, null, 0]);
    });

    it('marks deadlocks and lock timeouts retryable, and nothing else by default', function () {
      assert.strictEqual(CoraDB.isRetryable(new CoraDB.CoraDBError('deadlock', { code: -72 })), true);
      assert.strictEqual(CoraDB.isRetryable(new CoraDB.CoraDBError('syntax', { code: -493 })), false);
      assert.strictEqual(CoraDB.isRetryable(new Error('plain')), false);
    });
  });

  describe('the exported surface', function () {
    it('exports the constants, the errors and the helpers', function () {
      assert.strictEqual(CoraDB.DbParam.ISOLATION_LEVEL, 1);
      assert.strictEqual(CoraDB.DbParam.LOCK_TIMEOUT, 2);
      assert.strictEqual(CoraDB.IsolationLevel.READ_COMMITTED, 4);
      assert.strictEqual(CoraDB.isolationLevelName(6), 'SERIALIZABLE');
      assert.strictEqual(CoraDB.SchemaType.CCI_SCH_CLASS, 1);
      assert.strictEqual(typeof CoraDB.CASConstants.CASFunctionCode.CAS_FC_FETCH, 'number');
      assert.ok(CoraDB.BINDABLE_TYPES.includes('numeric'));
      assert.strictEqual(typeof CoraDB.CoraDBConnection, 'function');
    });

    it('takes a database parameter in any of the usual spellings', async function () {
      const conn = CoraDB.createConnection('localhost', 33000, 'dba', '', 'demodb');
      conn._queue.push = (item) => item(() => undefined);
      conn.connect = () => Promise.resolve();

      for (const name of ['ISOLATION_LEVEL', 'isolation_level', 'isolationLevel', 'CCI_PARAM_ISOLATION_LEVEL']) {
        // Reaching the socket means the name was understood.
        await assert.rejects(conn.getDatabaseParameter(name), (err) => !(err && err.code === 'INVALID_PARAMETER'));
      }
    });

    it('does not add anything to Number.prototype', function () {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(Number.prototype, 'formatAsMoney'), false);
    });
  });

  describe('order', function () {
    it('enqueues sql() at once, so a commit written after it runs after it', async function () {
      const cas = await fakeCas({ onQuery: () => ({ affected: 1 }) });
      const conn = CoraDB.createConnection({ host: `127.0.0.1:${cas.port}`, user: 'dba', password: '', database: 'demodb' });

      try {
        await conn.setAutoCommitMode(false);
        const write = conn.sql('update t set a = 1');
        const commit = conn.commit();
        await Promise.all([write, commit]);

        const FC = CoraDB.CASConstants.CASFunctionCode;
        assert.deepStrictEqual(cas.log.map((e) => e.fc), [FC.CAS_FC_PREPARE_AND_EXECUTE, FC.CAS_FC_CLOSE_REQ_HANDLE, FC.CAS_FC_END_TRAN]);
      } finally {
        conn.abort();
        await cas.close();
      }
    });
  });
});
