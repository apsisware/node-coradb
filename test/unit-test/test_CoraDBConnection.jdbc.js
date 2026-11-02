'use strict';

const assert = require('node:assert');

const CoraDB = require('../../index');
const PacketWriter = require('../../src/packets/PacketWriter');
const PacketReader = require('../../src/packets/PacketReader');
const ClientInfoExchangePacket = require('../../src/packets/ClientInfoExchangePacket');
const OpenDatabasePacket = require('../../src/packets/OpenDatabasePacket');
const GetSchemaPacket = require('../../src/packets/GetSchemaPacket');
const { fakeCas, Out, errorReply } = require('./helpers/fakeCas');

/*
 * The driver against the JDBC driver (coradb-jdbc): what it does the same way,
 * checked on the wire with the pretend CAS. The JDBC source each test follows
 * is named in its describe().
 */

const CAS = CoraDB.CASConstants;
const FC = CAS.CASFunctionCode;
const T = CAS.CoraDBDataType;
const COMMIT = CAS.CCITransactionType.CCI_TRAN_COMMIT;
const ROLLBACK = CAS.CCITransactionType.CCI_TRAN_ROLLBACK;

const ROWS = { columns: [['a', 'int']], rows: [[1], [2], [3], [4], [5]] };

function answer(sql) {
  if (/\bfrom t\b/i.test(sql)) return ROWS;
  return { affected: 1 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(test, ms = 1000) {
  const until = Date.now() + ms;

  while (!test()) {
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await sleep(5);
  }
}

describe('test_CoraDBConnection.jdbc: as the JDBC driver does it', function () {
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

  const ends = () => cas.log.filter((e) => e.fc === FC.CAS_FC_END_TRAN).map((e) => e.type);

  afterEach(async function () {
    if (conn) conn.abort();
    conn = undefined;
    if (cas) await cas.close();
    cas = undefined;
  });

  describe('login (UConnection driverInfo, UClientSideConnection.connectDB)', function () {
    it('tells the broker it takes renewed error codes and holdable results', function () {
      const writer = new PacketWriter(new ClientInfoExchangePacket().getBufferLength());

      new ClientInfoExchangePacket().write(writer);

      const bytes = writer._toBuffer();

      assert.strictEqual(bytes.toString('latin1', 0, 5), 'CUBRK');
      assert.strictEqual(bytes[5], CAS.CAS_CLIENT_JDBC);
      assert.strictEqual(bytes[7], 0xc0);
    });

    it('reads the CAS id and the 20-byte session id, and sends "0" before any login', function () {
      const session = Buffer.alloc(20, 7);
      const reply = Buffer.concat([
        Buffer.from([0, 0, 0, 36, 1, 0xff, 0xff, 0xff]),
        Buffer.from([0, 0, 0x10, 0x92]), // the CAS process id
        Buffer.from([1, 1, 1, 0, CAS.CAS_PROTO_INDICATOR | 9, 0xc0, 0, 0]),
        Buffer.from([0, 0, 0, 5]), // the CAS id
        session,
      ]);
      const packet = new OpenDatabasePacket({ logger: { debug() {} } });
      const reader = new PacketReader();

      reader.write(reply);
      packet.parse(reader);

      assert.strictEqual(packet.responseCode, 4242);
      assert.strictEqual(packet.casId, 5);
      assert.strictEqual(packet.sessionId, 5);
      assert.deepStrictEqual(packet.session, session);
      assert.strictEqual(packet.brokerInfo.functionFlag, 0xc0);

      const fresh = new OpenDatabasePacket({ database: 'db', user: 'dba', password: '' });
      const writer = new PacketWriter(fresh.getBufferLength());

      fresh.write(writer);
      assert.strictEqual(writer._toBuffer().subarray(608).toString('latin1').replace(/\0+$/, ''), '0');

      const again = new OpenDatabasePacket({ database: 'db', user: 'dba', password: '', session });
      const writer2 = new PacketWriter(again.getBufferLength());

      again.write(writer2);
      assert.deepStrictEqual(writer2._toBuffer().subarray(608), session);
    });

    it('resumes its session after a reconnect, and starts a new one after close()', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await conn.sql('update t set a = 1');
      assert.strictEqual(cas.connectionLog.find((e) => e.clientInfo).flags, 0xc0);

      cas.dropAll();
      await waitFor(() => !conn.connectionOpened);
      await conn.sql('update t set a = 2');

      const logins = cas.connectionLog.filter((e) => e.login);

      assert.strictEqual(logins.length, 2);
      assert.strictEqual(logins[0].resumed, false);
      assert.strictEqual(logins[1].resumed, true);

      await conn.close();
      await conn.sql('update t set a = 3');

      const third = cas.connectionLog.filter((e) => e.login)[2];

      assert.strictEqual(third.resumed, false);
      assert.strictEqual(third.session.toString('latin1').replace(/\0+$/, ''), '0');
    });

    it('moves the old CAS error numbering to the new one when the broker does not renew it', async function () {
      cas = await fakeCas({
        brokerFlags: 0,
        onQuery: (sql) => (/bad/.test(sql) ? { error: { code: -1007, message: '' } } : answer(sql)),
      });
      open();

      await assert.rejects(conn.sql('update bad'), (err) => err.code === -10007);
    });

    it('keeps the codes as they are when the broker sends the renewed ones', async function () {
      cas = await fakeCas({
        onQuery: (sql) => (/bad/.test(sql) ? { error: { code: -10007, message: '' } } : answer(sql)),
      });
      open();

      await assert.rejects(conn.sql('update bad'), (err) => err.code === -10007);
    });

    it('takes the new session id an error reply carries, when the broker reconnects to its server', async function () {
      const renewed = Buffer.alloc(20, 9);

      cas = await fakeCas({
        brokerFlags: 0xe0,
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_GET_DB_PARAMETER]: () => {
            const reply = Buffer.concat([errorReply({ code: -10000, message: 'x' }).subarray(0, 8), Buffer.alloc(0)]);
            const body = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xd8, 0xf0]), Buffer.from('x\0'), renewed]);

            reply.writeInt32BE(body.length, 0);
            reply[7] = CAS.CAS_INFO_FLAG_MASK_NEW_SESSION_ID;

            return Buffer.concat([reply, body]);
          },
        },
      });
      open();

      await assert.rejects(conn.getDatabaseParameter('ISOLATION_LEVEL'), (err) => err.code === -10000 && err.message === 'x');
      assert.deepStrictEqual(conn._session, renewed);
    });
  });

  describe('CAS info (UInputBuffer, UConnection.setCASInfo)', function () {
    it('sends back the CAS info of the last reply', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await conn.setAutoCommitMode(false);
      await conn.sql('update t set a = 1'); // the CAS now reports a transaction
      await conn.sql('update t set a = 2');

      const updates = cas.log.filter((e) => e.sql);

      assert.strictEqual(updates[1].casInfo[0], CAS.CAS_INFO_STATUS_ACTIVE);
      await conn.rollback();
    });
  });

  describe('commit and rollback (UClientSideConnection.endTransaction, CORADBConnection.commit/rollback)', function () {
    it('sends END_TRAN only when the CAS reports a transaction', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.connect();
      await conn.setAutoCommitMode(false);

      await conn.commit(); // nothing done yet
      assert.deepStrictEqual(ends(), []);

      await conn.sql('update t set a = 1');
      await conn.commit();
      assert.deepStrictEqual(ends(), [COMMIT]);

      await conn.rollback(); // nothing since the commit
      assert.deepStrictEqual(ends(), [COMMIT]);

      await conn.sql('update t set a = 2');
      await conn.rollback();
      assert.deepStrictEqual(ends(), [COMMIT, ROLLBACK]);
    });

    it('closes the open results before a rollback, but not the prepared statements', async function () {
      cas = await fakeCas({ onQuery: answer, columnsOf: () => ROWS.columns });
      open();
      await conn.setAutoCommitMode(false);

      const stmt = await conn.prepare('update t set a = ?');
      const r = await conn.query('select a from t');

      await conn.sql('update t set a = 1');
      await conn.rollback();

      assert.ok(!(r._handle in conn._queryResultSets), 'the result is closed');
      assert.ok(stmt._prepared.queryHandle in conn._queryResultSets, 'the prepared statement is not');
      // Closing it again is not an error, as closing a closed ResultSet is not.
      await conn.closeQuery(r.queryHandle);
      assert.strictEqual((await stmt.run([5])).affectedRows, 1);
      await conn.rollback();
      await stmt.close();
    });

    it('keeps results open across a commit when they are holdable', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();
      await conn.setAutoCommitMode(false);

      const cursor = await conn.cursor('select a from t');

      await conn.sql('update t set a = 1');
      await conn.commit();

      assert.deepStrictEqual((await cursor.next()).map((x) => x.a), [1, 2]);
      assert.deepStrictEqual((await cursor.next()).map((x) => x.a), [3, 4]);
      await cursor.close();
      await conn.setAutoCommitMode(true);
    });

    it('closes them before a commit when the broker cannot hold them', async function () {
      cas = await fakeCas({ brokerFlags: 0x80, onQuery: answer });
      open();
      await conn.setAutoCommitMode(false);

      const r = await conn.query('select a from t');

      await conn.sql('update t set a = 1');
      await conn.commit();

      assert.ok(!(r._handle in conn._queryResultSets));
      assert.ok(cas.log.some((e) => e.fc === FC.CAS_FC_CLOSE_REQ_HANDLE && e.handle === r._handle));
    });
  });

  describe('setAutoCommitMode() (CORADBConnection.setAutoCommit)', function () {
    it('commits the work done when the mode changes', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await conn.setAutoCommitMode(false);
      await conn.sql('update t set a = 1');
      await conn.setAutoCommitMode(true);

      assert.deepStrictEqual(ends(), [COMMIT]);
      assert.strictEqual(conn.getAutoCommitMode(), true);
    });

    it('sends nothing when nothing is pending, or the mode does not change', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await conn.connect();
      await conn.setAutoCommitMode(false);
      await conn.setAutoCommitMode(false);
      await conn.setAutoCommitMode(true);

      assert.deepStrictEqual(ends(), []);
    });

    it('keeps the mode when the commit fails', async function () {
      cas = await fakeCas({
        onQuery: answer,
        handlers: { [FC.CAS_FC_END_TRAN]: () => errorReply({ code: -72, message: 'deadlock' }) },
      });
      open();

      await conn.setAutoCommitMode(false);
      await conn.sql('update t set a = 1');
      await assert.rejects(conn.setAutoCommitMode(true), (err) => err.code === -72);
      assert.strictEqual(conn.getAutoCommitMode(), false);
    });
  });

  describe('holdable results (CORADBStatement prepare flags, UStatement.setExecuteOptions)', function () {
    it('asks for them when the broker supports them', async function () {
      cas = await fakeCas({ onQuery: answer });
      open();

      await conn.query('select a from t');
      await conn.sql('select a from t where a = ?', [1]);

      const direct = cas.log.find((e) => e.fc === FC.CAS_FC_PREPARE_AND_EXECUTE);
      const prepare = cas.log.find((e) => e.fc === FC.CAS_FC_PREPARE);
      const execute = cas.log.find((e) => e.fc === FC.CAS_FC_EXECUTE);

      assert.strictEqual(direct.prepareFlag & CAS.CCIPrepareOption.CCI_PREPARE_HOLDABLE, CAS.CCIPrepareOption.CCI_PREPARE_HOLDABLE);
      assert.strictEqual(direct.flag & CAS.CCIExecutionOption.CCI_EXEC_HOLDABLE, CAS.CCIExecutionOption.CCI_EXEC_HOLDABLE);
      assert.strictEqual(prepare.prepareFlag & CAS.CCIPrepareOption.CCI_PREPARE_HOLDABLE, CAS.CCIPrepareOption.CCI_PREPARE_HOLDABLE);
      assert.strictEqual(execute.flag & CAS.CCIExecutionOption.CCI_EXEC_HOLDABLE, CAS.CCIExecutionOption.CCI_EXEC_HOLDABLE);
    });

    it('does not when it does not', async function () {
      cas = await fakeCas({ brokerFlags: 0x80, onQuery: answer });
      open();

      await conn.query('select a from t');

      const direct = cas.log.find((e) => e.fc === FC.CAS_FC_PREPARE_AND_EXECUTE);

      assert.strictEqual(direct.prepareFlag, 0);
      assert.strictEqual(direct.flag & CAS.CCIExecutionOption.CCI_EXEC_HOLDABLE, 0);
    });
  });

  describe('statement pooling (UStatement.execute: CAS_ER_STMT_POOLING)', function () {
    function droppingOnce() {
      let dropped = false;

      return () => {
        if (dropped) return undefined;
        dropped = true;
        return errorReply({ code: -10024, message: '' });
      };
    }

    it('prepares a dropped statement again, the plan pinned, and runs it', async function () {
      // The first EXECUTE is refused: the broker dropped the handle.
      cas = await fakeCas({ statementPooling: 1, onQuery: answer, handlers: { [FC.CAS_FC_EXECUTE]: droppingOnce() } });
      open();

      const stmt = await conn.prepare('update t set a = ?');
      const first = stmt._prepared.queryHandle;

      assert.strictEqual((await stmt.run([5])).affectedRows, 1);

      const prepares = cas.log.filter((e) => e.fc === FC.CAS_FC_PREPARE);

      assert.strictEqual(prepares.length, 2);
      assert.strictEqual(prepares[0].prepareFlag & CAS.CCIPrepareOption.CCI_PREPARE_XASL_CACHE_PINNED, 0);
      assert.strictEqual(prepares[1].prepareFlag & CAS.CCIPrepareOption.CCI_PREPARE_XASL_CACHE_PINNED,
        CAS.CCIPrepareOption.CCI_PREPARE_XASL_CACHE_PINNED);
      // The same PreparedStatement, on its new handle.
      assert.notStrictEqual(stmt._prepared.queryHandle, first);
      assert.ok(stmt._prepared.queryHandle in conn._queryResultSets);
      assert.ok(!(first in conn._queryResultSets));
      assert.strictEqual((await stmt.run([6])).affectedRows, 1);
      await stmt.close();
    });

    it('fails with the error when the broker does not pool statements', async function () {
      cas = await fakeCas({ statementPooling: 0, onQuery: answer, handlers: { [FC.CAS_FC_EXECUTE]: droppingOnce() } });
      open();

      const stmt = await conn.prepare('update t set a = ?');

      await assert.rejects(stmt.run([5]), (err) => err.code === -10024);
      assert.strictEqual(cas.log.filter((e) => e.fc === FC.CAS_FC_PREPARE).length, 1);
    });

    it('prepares a statement again on the new session after a reconnect', async function () {
      cas = await fakeCas({ statementPooling: 1, handlesPerSession: true, onQuery: answer });
      open();

      const stmt = await conn.prepare('update t set a = ?');

      cas.dropAll();
      await waitFor(() => !conn.connectionOpened);

      assert.strictEqual((await stmt.run([5])).affectedRows, 1);
      assert.strictEqual(cas.log.filter((e) => e.fc === FC.CAS_FC_PREPARE && e.session === 2).length, 1);
      await stmt.close();
    });
  });

  describe('reconnect and run again (UStatement.execute: isErrorToReconnect)', function () {
    function failingOnce(code) {
      let failed = false;

      return (sql) => {
        if (/flaky/.test(sql) && !failed) {
          failed = true;
          return { error: { code, message: 'server down' } };
        }
        return answer(sql);
      };
    }

    for (const code of [-111, -199, -224, -677]) {
      it(`runs the first statement of a transaction again on a new connection after ${code}`, async function () {
        cas = await fakeCas({ onQuery: failingOnce(code) });
        open();

        const r = await conn.sql('update flaky set a = 1');

        assert.strictEqual(r.affectedRows, 1);
        assert.strictEqual(cas.logins(), 2);
        assert.strictEqual(cas.log.filter((e) => e.sql === 'update flaky set a = 1').length, 2);
      });
    }

    it('also with query() and executeWithTypedParams()', async function () {
      cas = await fakeCas({ onQuery: failingOnce(-677) });
      open();

      await conn.query('update flaky set a = 1');
      assert.strictEqual(cas.logins(), 2);
    });

    it('does not when a transaction was already open: its work would be lost', async function () {
      cas = await fakeCas({ onQuery: failingOnce(-677) });
      open();
      await conn.setAutoCommitMode(false);
      await conn.sql('update t set a = 1');

      await assert.rejects(conn.sql('update flaky set a = 2'), (err) => err.code === -677);
      assert.strictEqual(cas.logins(), 1);
      await conn.rollback();
    });

    it('does not for an error that is the statement\'s own', async function () {
      cas = await fakeCas({ onQuery: failingOnce(-493) });
      open();

      await assert.rejects(conn.sql('update flaky set a = 1'), (err) => err.code === -493);
      assert.strictEqual(cas.logins(), 1);
    });

    it('does not after the caller closed the connection', async function () {
      cas = await fakeCas({ onQuery: (sql) => (/slow/.test(sql) ? sleep(100).then(() => answer(sql)) : answer(sql)) });
      open();
      await conn.connect();

      const running = conn.sql('update slow set a = 1');

      await sleep(20);
      conn.abort();

      await assert.rejects(running, { code: 'ABORTED' });
      assert.strictEqual(cas.logins(), 1);
    });
  });

  describe('schema pattern flags (CORADBDatabaseMetaData)', function () {
    const S = CAS.CoraDBSchemaType;
    const CLASS = CAS.CCISchemaPatternMatchFlag.CCI_CLASS_NAME_PATTERN_MATCH;
    const ATTR = CAS.CCISchemaPatternMatchFlag.CCI_ATTR_NAME_PATTERN_MATCH;

    it('matches the table name exactly for CONSTRAINT (getIndexInfo)', function () {
      assert.strictEqual(GetSchemaPacket.patternFlag(S.CCI_SCH_CONSTRAINT, 'athlete_result'), ATTR);
    });

    it('as a pattern for ATTRIBUTE only when it is one (getColumns)', function () {
      assert.strictEqual(GetSchemaPacket.patternFlag(S.CCI_SCH_ATTRIBUTE, 'athlete'), ATTR);
      assert.strictEqual(GetSchemaPacket.patternFlag(S.CCI_SCH_ATTRIBUTE, 'athlete_result'), CLASS | ATTR);
      assert.strictEqual(GetSchemaPacket.patternFlag(S.CCI_SCH_ATTRIBUTE, 'ath%'), CLASS | ATTR);
      assert.strictEqual(GetSchemaPacket.patternFlag(S.CCI_SCH_ATTRIBUTE, undefined), CLASS | ATTR);
    });

    it('as a pattern for the others', function () {
      for (const type of [S.CCI_SCH_CLASS, S.CCI_SCH_VCLASS, S.CCI_SCH_CLASS_PRIVILEGE, S.CCI_SCH_PRIMARY_KEY,
        S.CCI_SCH_IMPORTED_KEYS, S.CCI_SCH_EXPORTED_KEYS]) {
        assert.strictEqual(GetSchemaPacket.patternFlag(type, 'athlete'), CLASS | ATTR);
      }
    });

    it('sends that flag', async function () {
      let flag;

      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_SCHEMA_INFO]: (body) => {
            // [4][type] [len][name\0] [0: NULL] [1][flag]
            const nameLength = body.readInt32BE(8);
            flag = body[8 + 4 + nameLength + 4 + 4];
            return new Out().int(7).int(0).int(0).reply();
          },
          [FC.CAS_FC_FETCH]: () => new Out().int(0).int(0).reply(),
        },
      });
      open();

      await conn.getSchema(S.CCI_SCH_CONSTRAINT, 'athlete_result');
      assert.strictEqual(flag, ATTR);
    });
  });

  describe('LOB size (CORADBLobHandle.setLobSize)', function () {
    it('writes the size into the packed handle after each write', async function () {
      cas = await fakeCas({
        onQuery: answer,
        handlers: {
          [FC.CAS_FC_LOB_WRITE]: (body) => {
            const handleLength = body.readInt32BE(0);
            const at = 4 + handleLength + 4 + 8;
            return new Out().int(body.readInt32BE(at)).reply();
          },
        },
      });
      open();

      const handle = Buffer.alloc(16 + 2);

      handle.writeInt32BE(CAS.CCILOBType.CCI_LOB_TYPE_CLOB, 0);
      handle.writeInt32BE(2, 12);

      const lob = { packedLobHandle: handle, lobLength: 0, lobType: T.CCI_U_TYPE_CLOB, fileLocator: 'x' };

      await conn.lobWrite(lob, 0, 'hello ');
      assert.strictEqual(handle.readBigInt64BE(4), 6n);

      await conn.lobWrite(lob, 6, 'world');
      assert.strictEqual(handle.readBigInt64BE(4), 11n);
      assert.strictEqual(lob.lobLength, 11);
    });
  });
});
