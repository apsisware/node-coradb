'use strict';

const assert = require('node:assert');

const CoraDB = require('../../index');
const { fakeCas } = require('./helpers/fakeCas');

/*
 * sql(), cursor(), stream(), prepare(), transaction(), timeouts and signals,
 * typed errors and the callback adapter — against a pretend CAS on a local
 * port, so the requests really go over a socket and are parsed back.
 */

const FC = CoraDB.CASConstants.CASFunctionCode;

const PEOPLE = {
  columns: [['id', 'int'], ['name', 'string']],
  rows: [[1, 'Ann'], [2, 'Bob'], [3, 'Cid'], [4, 'Dan'], [5, null]],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function answer(sql) {
  if (/^\s*select\b.*\bfrom people\b/i.test(sql)) return PEOPLE;
  if (/^\s*select\s+1\b/i.test(sql)) return { columns: [['1', 'int']], rows: [[1]] };
  if (/^\s*update\b/i.test(sql)) return { affected: 3 };
  if (/^\s*insert\b/i.test(sql)) return { affected: 1 };
  if (/broken/i.test(sql)) return { error: { code: -493, message: 'Syntax: broken near here' } };
  if (/missing_table/i.test(sql)) return { error: { code: -1000, message: '' } };
  return { affected: 0 };
}

describe('test_CoraDBConnection.modern', function () {
  this.timeout(5000);

  let cas;
  let conn;
  let slow;

  beforeEach(async function () {
    slow = 0;
    cas = await fakeCas({
      fetchSize: 2,
      onQuery: async (sql) => {
        if (/sleep/i.test(sql)) await sleep(slow || 300);
        return answer(sql);
      },
      columnsOf: () => PEOPLE.columns,
    });
    conn = CoraDB.createConnection({ host: `127.0.0.1:${cas.port}`, user: 'dba', password: '', database: 'demodb' });
  });

  afterEach(async function () {
    conn.abort();
    await cas.close();
  });

  const fcs = () => cas.log.map((e) => e.fc);

  describe('sql()', function () {
    it('reads every row as objects, a batch at a time, and closes the handle', async function () {
      const r = await conn.sql('select * from people');

      assert.strictEqual(r.rowCount, 5);
      assert.deepStrictEqual(r.rows[0], { id: 1, name: 'Ann' });
      assert.deepStrictEqual(r.rows[4], { id: 5, name: null });
      assert.deepStrictEqual(r.columns.map((c) => [c.name, c.type]), [['id', 'Int'], ['name', 'String']]);
      assert.strictEqual(r.affectedRows, 0);
      // 2 + 2 + 1 rows: the first batch with the query, two fetches, a close.
      assert.deepStrictEqual(fcs(), [FC.CAS_FC_PREPARE_AND_EXECUTE, FC.CAS_FC_FETCH, FC.CAS_FC_FETCH, FC.CAS_FC_CLOSE_REQ_HANDLE]);
      assert.deepStrictEqual(Object.keys(conn._queryResultSets), []);
    });

    it('gives rows as arrays when asked', async function () {
      const r = await conn.sql('select * from people', { rowsAs: 'arrays' });

      assert.deepStrictEqual(r.rows[1], [2, 'Bob']);
    });

    it('reports the rows a write changed, and closes its handle too', async function () {
      const r = await conn.sql('update people set name = name');

      assert.deepStrictEqual([r.rows, r.rowCount, r.affectedRows], [[], 0, 3]);
      assert.deepStrictEqual(fcs(), [FC.CAS_FC_PREPARE_AND_EXECUTE, FC.CAS_FC_CLOSE_REQ_HANDLE]);
    });

    it('binds values on the server: PREPARE, EXECUTE, CLOSE', async function () {
      const r = await conn.sql('select * from people where id > ? and name <> ?', [1, "O'Brien"]);

      assert.strictEqual(r.rowCount, 5);
      assert.deepStrictEqual(fcs().slice(0, 2), [FC.CAS_FC_PREPARE, FC.CAS_FC_EXECUTE]);
      assert.strictEqual(fcs()[fcs().length - 1], FC.CAS_FC_CLOSE_REQ_HANDLE);
      // The text went as written: the value travelled separately.
      assert.strictEqual(cas.log[0].sql, 'select * from people where id > ? and name <> ?');
      assert.ok(cas.log[1].raw.includes(Buffer.from("O'Brien\0")));
    });

    it('refuses a value it cannot bind, before sending anything', async function () {
      await assert.rejects(conn.sql('select * from people where id = ?', [{ a: 1 }]), (err) => {
        assert.ok(err instanceof CoraDB.CoraDBError);
        assert.strictEqual(err.code, 'INVALID_PARAMETER');
        assert.match(err.message, /Parameter 1: a value of type Object cannot be bound/);
        assert.strictEqual(err.statement, 'select * from people where id = ?');
        return true;
      });
      assert.deepStrictEqual(cas.log, []);
    });

    it('fails with a CoraDBError that names the code and the statement', async function () {
      await assert.rejects(conn.sql('select broken'), (err) => {
        assert.ok(err instanceof CoraDB.CoraDBError);
        assert.strictEqual(err.name, 'CoraDBError');
        assert.strictEqual(err.code, -493);
        assert.strictEqual(err.message, 'Syntax: broken near here');
        assert.strictEqual(err.statement, 'select broken');
        assert.strictEqual(err.retryable, false);
        return true;
      });
    });

    it('never has an empty message: a code with no text is named', async function () {
      await assert.rejects(conn.sql('select * from missing_table'), (err) => {
        assert.strictEqual(err.message, 'CAS_ER_DBMS');
        return true;
      });
    });
  });

  describe('cursor() and stream()', function () {
    it('hands out batches, then an empty one, and closes itself at the end', async function () {
      const cursor = await conn.cursor('select * from people');

      assert.strictEqual(cursor.total, 5);
      assert.deepStrictEqual((await cursor.next()).map((r) => r.id), [1, 2]);
      assert.deepStrictEqual((await cursor.next()).map((r) => r.id), [3, 4]);
      assert.deepStrictEqual((await cursor.next()).map((r) => r.id), [5]);
      assert.strictEqual(cursor.done, true);
      assert.deepStrictEqual(await cursor.next(), []);
      assert.strictEqual(fcs().filter((f) => f === FC.CAS_FC_CLOSE_REQ_HANDLE).length, 1);
    });

    it('streams every row, and closes the handle when the loop is left early', async function () {
      const all = [];
      for await (const row of conn.stream('select * from people')) all.push(row.id);
      assert.deepStrictEqual(all, [1, 2, 3, 4, 5]);

      cas.log.length = 0;
      for await (const row of conn.stream('select * from people')) {
        if (row.id === 1) break;
      }
      assert.deepStrictEqual(fcs(), [FC.CAS_FC_PREPARE_AND_EXECUTE, FC.CAS_FC_CLOSE_REQ_HANDLE]);
    });
  });

  describe('prepare()', function () {
    it('compiles once and runs as often as asked, then closes', async function () {
      const stmt = await conn.prepare('insert into people (id, name) values (?, ?)');

      assert.strictEqual(stmt.paramCount, 2);
      assert.strictEqual((await stmt.run([6, 'Eve'])).affectedRows, 1);
      assert.strictEqual((await stmt.run([7, null])).affectedRows, 1);
      await assert.rejects(stmt.run([8]), /takes 2 parameter\(s\); 1 given/);
      await stmt.close();
      await assert.rejects(stmt.run([9, 'x']), (err) => err.code === 'STATEMENT_CLOSED');

      assert.deepStrictEqual(fcs(), [FC.CAS_FC_PREPARE, FC.CAS_FC_EXECUTE, FC.CAS_FC_EXECUTE, FC.CAS_FC_CLOSE_REQ_HANDLE]);
      assert.strictEqual(new Set(cas.log.slice(1, 3).map((e) => e.handle)).size, 1);
    });

    it('reads every row of a prepared query', async function () {
      const stmt = await conn.prepare('select * from people where id > ?');
      const r = await stmt.run([0]);

      assert.strictEqual(r.rowCount, 5);
      await stmt.close();
    });
  });

  describe('transaction()', function () {
    it('commits when the function resolves, with auto-commit off meanwhile', async function () {
      let during;
      const value = await conn.transaction(async (c) => {
        during = c.getAutoCommitMode();
        await c.sql('update people set name = name');
        return 'ok';
      });

      assert.strictEqual(value, 'ok');
      assert.strictEqual(during, false);
      assert.strictEqual(conn.getAutoCommitMode(), true);
      const end = cas.log.filter((e) => e.fc === FC.CAS_FC_END_TRAN);
      assert.deepStrictEqual(end.map((e) => e.type), [CoraDB.CASConstants.CCITransactionType.CCI_TRAN_COMMIT]);
    });

    it('rolls back and rethrows when the function throws', async function () {
      await assert.rejects(conn.transaction(async (c) => {
        await c.sql('update people set name = name');
        throw new Error('changed my mind');
      }), /changed my mind/);

      const end = cas.log.filter((e) => e.fc === FC.CAS_FC_END_TRAN);
      assert.deepStrictEqual(end.map((e) => e.type), [CoraDB.CASConstants.CCITransactionType.CCI_TRAN_ROLLBACK]);
    });
  });

  describe('timeoutMs and signal', function () {
    it('times out a slow statement and cancels it', async function () {
      let cancelled = 0;
      const cancel = conn.cancel.bind(conn);
      conn.cancel = (...a) => {
        cancelled += 1;
        return cancel(...a);
      };

      const started = Date.now();
      await assert.rejects(conn.sql('select sleep from people', { timeoutMs: 50 }), (err) => {
        assert.ok(err instanceof CoraDB.CoraDBError);
        assert.strictEqual(err.code, 'TIMEOUT');
        assert.strictEqual(err.statement, 'select sleep from people');
        return true;
      });
      assert.ok(Date.now() - started < 250);
      assert.strictEqual(cancelled, 1);
    });

    it('drops a request still waiting behind someone else, without cancelling theirs', async function () {
      let cancelled = 0;
      conn.cancel = () => {
        cancelled += 1;
        return Promise.resolve({ method: 'broker' });
      };

      const theirs = conn.sql('select sleep from people');
      await sleep(30);
      await assert.rejects(conn.sql('select 1', { timeoutMs: 40 }), (err) => err.code === 'TIMEOUT');
      const r = await theirs;

      assert.strictEqual(r.rowCount, 5);
      assert.strictEqual(cancelled, 0);
      assert.ok(!cas.log.some((e) => e.sql === 'select 1'));
    });

    it('stops at once on an AbortSignal, and refuses one already aborted', async function () {
      const controller = new AbortController();
      const p = conn.sql('select sleep from people', { signal: controller.signal });
      await sleep(20);
      controller.abort(new Error('user left'));

      await assert.rejects(p, (err) => {
        assert.strictEqual(err.name, 'AbortError');
        assert.strictEqual(err.code, 'ABORT_ERR');
        assert.strictEqual(err.cause.message, 'user left');
        return true;
      });
      await assert.rejects(conn.sql('select 1', { signal: controller.signal }), { name: 'AbortError' });
    });

    it('uses the connection default when the call gives none', async function () {
      conn.setRequestTimeout(40);
      await assert.rejects(conn.sql('select sleep from people'), { code: 'TIMEOUT' });
      conn.setRequestTimeout(0);
    });

    it('refuses a timeout that is not a number of milliseconds', async function () {
      await assert.rejects(conn.sql('select 1', { timeoutMs: -5 }), { code: 'INVALID_PARAMETER' });
    });
  });

  describe('the callback adapter', function () {
    it('answers the callback and the promise, both', async function () {
      let called;
      const promise = conn.query('select 1', (err, result) => {
        called = [err, result.ColumnValues];
      });

      const response = await promise;
      assert.deepStrictEqual(called, [undefined, [[1]]]);
      assert.deepStrictEqual(response.result.ColumnValues, [[1]]);
      await conn.closeQuery(response.queryHandle);
    });

    it('reports a failure to the callback without an unhandled rejection', async function () {
      const unhandled = [];
      const onUnhandled = (e) => unhandled.push(e);
      process.on('unhandledRejection', onUnhandled);

      const got = await new Promise((resolve) => conn.queryAll('select broken', (err) => resolve(err)));
      await sleep(20);
      process.off('unhandledRejection', onUnhandled);

      assert.strictEqual(got.code, -493);
      assert.deepStrictEqual(unhandled, []);
    });

    it('calls queryAsObjects back once, with the rows and the handle', async function () {
      const calls = [];
      await new Promise((resolve) => {
        conn.queryAsObjects('select * from people', (err, rows, handle) => {
          calls.push([err, rows.length, typeof handle]);
          resolve();
        });
      });
      await sleep(10);
      assert.deepStrictEqual(calls, [[undefined, 2, 'number']]);
    });
  });

  describe('naming', function () {
    it('takes a database parameter by name', async function () {
      assert.strictEqual(await conn.getDatabaseParameter('isolationLevel'), 4);
      assert.strictEqual(await conn.getDatabaseParameter(CoraDB.DbParam.ISOLATION_LEVEL), 4);
      assert.deepStrictEqual(cas.log.map((e) => e.parameter), [1, 1]);
      await assert.rejects(conn.getDatabaseParameter('isolation'), { code: 'INVALID_PARAMETER' });
    });

    it('keeps auto-commit off when it was turned off before connecting', async function () {
      await conn.beginTransaction();
      await conn.sql('update people set name = name');

      assert.strictEqual(conn.getAutoCommitMode(), false);
      await conn.rollback();
    });

    it('execute() resolves with the rows changed', async function () {
      // The pretend CAS has no batch request, so the old-protocol path: one
      // prepared statement, closed after it ran.
      conn.setEnforceOldQueryProtocol(true);
      assert.strictEqual(await conn.execute('update people set name = name'), 3);
      assert.deepStrictEqual(fcs(), [FC.CAS_FC_PREPARE, FC.CAS_FC_EXECUTE, FC.CAS_FC_CLOSE_REQ_HANDLE]);
    });

    it('says where it is connected without connecting, and counts its requests', async function () {
      assert.strictEqual(conn.getConnectedHost(), null);
      assert.strictEqual(conn.getQueueLength(), 0);

      const p = conn.sql('select 1');
      assert.strictEqual(conn.getQueueLength(), 1);
      assert.strictEqual(conn.getQueueDepth(), 1);
      await p;

      assert.deepStrictEqual(conn.getConnectedHost(), { host: '127.0.0.1', port: String(cas.port) });
      assert.strictEqual(conn.isQueueEmpty(), true);
    });
  });
});
