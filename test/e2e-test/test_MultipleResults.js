'use strict';

// End-to-end scenario: several statements in one request, read result by
// result with executeMulti() — the way a JDBC Statement reads them after
// execute(): an update count, a result set, another update count. Uses
// NEXT_RESULT on the server. Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, toError, log, printTable } = require('./helpers');

const TABLE = 'test_multi_results';

describe('e2e: Multiple results (with CoraDB)', function () {
  this.timeout(20000);

  let client;

  beforeEach(async function () {
    client = CoraDB.createConnection(CONFIG);
    await client.connect();
    log('Connected.');
    await client.execute('DROP TABLE IF EXISTS ' + TABLE);
    await client.execute('CREATE TABLE ' + TABLE + ' (id INT PRIMARY KEY, name VARCHAR(20))');
    log('Created table ' + TABLE + ' (id, name).');
  });

  afterEach(async function () {
    await client.execute('DROP TABLE IF EXISTS ' + TABLE).catch(() => undefined);
    await client.close().catch(() => undefined);
    log('Dropped table ' + TABLE + ', disconnected.');
  });

  it('reads an update count, a result set and another update count, in order', async function () {
    try {
      const r = await client.executeMulti(
        "INSERT INTO " + TABLE + " VALUES (1, 'a'), (2, 'b'), (3, 'c');" +
        ' SELECT id, name FROM ' + TABLE + ' ORDER BY id;' +
        ' DELETE FROM ' + TABLE + ' WHERE id = 3'
      );

      expect(r).to.be.an.instanceOf(CoraDB.MultiResult);
      expect(r.resultCount).to.equal(3);

      // 1: the INSERT.
      expect(r.isResultSet).to.equal(false);
      expect(r.getUpdateCount()).to.equal(3);
      log('Result 1: ' + r.getUpdateCount() + ' rows inserted.');

      // 2: the SELECT.
      expect(await r.getMoreResults()).to.equal(true);
      const rows = r.getResultSet().rows;
      log('Result 2: ' + rows.length + ' rows:');
      printTable(rows);
      expect(rows).to.deep.equal([{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]);

      // 3: the DELETE.
      expect(await r.getMoreResults()).to.equal(false);
      expect(r.getUpdateCount()).to.equal(1);
      log('Result 3: ' + r.getUpdateCount() + ' row deleted.');

      // No more.
      expect(await r.getMoreResults()).to.equal(false);
      expect(r.getUpdateCount()).to.equal(-1);

      // Committed (auto-commit): a new connection sees the two rows left.
      const other = CoraDB.createConnection(CONFIG);
      const { rows: left } = await other.sql('SELECT COUNT(*) AS n FROM ' + TABLE);
      await other.close();
      expect(Number(left[0].n)).to.equal(2);
    } catch (err) {
      throw toError(err);
    }
  });

  it('is async iterable, with values bound across the statements', async function () {
    try {
      const seen = [];

      for await (const result of await client.executeMulti(
        'INSERT INTO ' + TABLE + ' VALUES (?, ?); SELECT name FROM ' + TABLE + ' WHERE id = ?',
        [7, 'seven', 7]
      )) {
        seen.push(result.isResultSet ? result.rows : result.affectedRows);
      }

      log('Results: ' + JSON.stringify(seen));
      expect(seen).to.deep.equal([1, [{ name: 'seven' }]]);
    } catch (err) {
      throw toError(err);
    }
  });

  it('several SELECTs: every result set, with more rows than one fetch', async function () {
    try {
      const values = [];
      for (let i = 1; i <= 250; ++i) values.push('(' + i + ", 'n" + i + "')");
      await client.execute('INSERT INTO ' + TABLE + ' VALUES ' + values.join(', '));

      const counts = [];

      for await (const result of await client.executeMulti(
        'SELECT * FROM ' + TABLE + '; SELECT * FROM ' + TABLE + ' WHERE id <= 10; SELECT COUNT(*) AS n FROM ' + TABLE
      )) {
        counts.push(result.rows.length);
      }

      log('Rows per result: ' + counts.join(', '));
      expect(counts).to.deep.equal([250, 10, 1]);
    } catch (err) {
      throw toError(err);
    }
  });
});
