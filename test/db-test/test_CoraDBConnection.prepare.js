'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

/*
 * prepare() and PreparedStatement.run() / close() against the live server
 * (olympics1988-2004). The wire details are unit-tested against the pretend
 * CAS; these check that the real server agrees.
 */
describe('CoraDBConnection', function () {
  describe('prepare', function () {
    const TABLE_NAME = 'tbl_test';
    const COUNTRIES_IN_CONTINENT =
      'SELECT c.iso3, c.name FROM country c, continent ct WHERE c.continent_id = ct.id AND ct.name = ? ORDER BY c.iso3';

    this.timeout(20000);

    beforeEach(testSetup.cleanup(TABLE_NAME));
    after(testSetup.cleanup(TABLE_NAME));

    it('runs one SELECT many times with different values', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const stmt = await client.prepare(COUNTRIES_IN_CONTINENT);

        expect(stmt.sql).to.equal(COUNTRIES_IN_CONTINENT);
        expect(stmt.paramCount).to.equal(1);

        const asia = await stmt.run(['Asia']);
        const europe = await stmt.run(['Europe']);
        const africa = await stmt.run(['Africa']);
        const oceania = await stmt.run(['Oceania']);

        expect(asia.rowCount).to.equal(16);
        expect(asia.rows).to.have.length(16);
        expect(europe.rows).to.have.length(40);
        expect(africa.rows).to.have.length(16);
        expect(oceania.rows).to.have.length(1);

        expect(asia.columns.map((c) => c.name)).to.deep.equal(['iso3', 'name']);
        expect(asia.rows[0]).to.have.all.keys('iso3', 'name');

        // In the order asked for.
        const codes = europe.rows.map((r) => r.iso3);

        expect(codes).to.deep.equal(codes.slice().sort());

        await stmt.close();
      } finally {
        await client.close();
      }
    });

    it('reads the rows as arrays when prepared with rowsAs: "arrays"', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const stmt = await client.prepare('SELECT host_city FROM olympic_games WHERE [year] = ?', { rowsAs: 'arrays' });

        expect((await stmt.run([2004])).rows).to.deep.equal([['Athens']]);
        expect((await stmt.run([1988])).rows).to.deep.equal([['Seoul']]);
        // A run's own options win.
        expect((await stmt.run([1992], { rowsAs: 'objects' })).rows).to.deep.equal([{ host_city: 'Barcelona' }]);

        await stmt.close();
      } finally {
        await client.close();
      }
    });

    it('binds typed values', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const stmt = await client.prepare(
          'SELECT host_city FROM olympic_games WHERE opening_date > ? ORDER BY [year]',
          { rowsAs: 'arrays' }
        );

        expect(stmt.paramCount).to.equal(1);
        expect((await stmt.run([{ type: 'date', value: '2000-01-01' }])).rows).to.deep.equal([['Sydney'], ['Athens']]);
        expect((await stmt.run([{ type: 'date', value: '1996-01-01' }])).rows)
          .to.deep.equal([['Atlanta'], ['Sydney'], ['Athens']]);

        await stmt.close();
      } finally {
        await client.close();
      }
    });

    it('runs an INSERT many times and reports the rows each run changed', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.execute(`CREATE TABLE ${TABLE_NAME}(id INT PRIMARY KEY, name VARCHAR(32))`);

        const stmt = await client.prepare(`INSERT INTO ${TABLE_NAME} VALUES (?, ?)`);

        expect(stmt.paramCount).to.equal(2);

        for (const [id, name] of [[1, 'one'], [2, 'two'], [3, 'three']]) {
          const result = await stmt.run([id, name]);

          expect(result.affectedRows, `row ${id}`).to.equal(1);
          expect(result.rows).to.deep.equal([]);
        }

        await stmt.close();

        // Auto-commit is on: another connection sees them.
        const other = testSetup.createDefaultCoraDBDemodbConnection();

        try {
          const { rows } = await other.sql(`SELECT id, name FROM ${TABLE_NAME} ORDER BY id`, { rowsAs: 'arrays' });

          expect(rows).to.deep.equal([[1, 'one'], [2, 'two'], [3, 'three']]);
        } finally {
          await other.close();
        }
      } finally {
        await client.close();
      }
    });

    it('refuses the wrong number of values without sending anything, and stays usable', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const stmt = await client.prepare(COUNTRIES_IN_CONTINENT);

        for (const params of [[], ['Asia', 'Europe']]) {
          const err = await stmt.run(params).then(() => null, (e) => e);

          expect(err, JSON.stringify(params)).to.be.an.instanceOf(Error);
          expect(err.code).to.equal('INVALID_PARAMETER');
        }

        expect((await stmt.run(['Asia'])).rows).to.have.length(16);
        await stmt.close();
      } finally {
        await client.close();
      }
    });

    it('fails a server error on run() and stays usable', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.execute(`CREATE TABLE ${TABLE_NAME}(id INT PRIMARY KEY)`);

        const stmt = await client.prepare(`INSERT INTO ${TABLE_NAME} VALUES (?)`);

        await stmt.run([1]);

        // The same key again: the server refuses it.
        const err = await stmt.run([1]).then(() => null, (e) => e);

        expect(err).to.be.an.instanceOf(Error);
        expect(err.code).to.be.a('number').that.is.below(0);

        expect((await stmt.run([2])).affectedRows).to.equal(1);
        await stmt.close();

        const { rows } = await client.sql(`SELECT COUNT(*) AS n FROM ${TABLE_NAME}`);

        expect(Number(rows[0].n)).to.equal(2);
      } finally {
        await client.close();
      }
    });

    it('refuses run() after close() (STATEMENT_CLOSED); close() twice is harmless', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const stmt = await client.prepare(COUNTRIES_IN_CONTINENT);

        await stmt.close();
        await stmt.close();

        const err = await stmt.run(['Asia']).then(() => null, (e) => e);

        expect(err).to.be.an.instanceOf(Error);
        expect(err.code).to.equal('STATEMENT_CLOSED');

        // The connection goes on.
        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
      } finally {
        await client.close();
      }
    });

    it('fails prepare() on a statement the server cannot compile', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const err = await client.prepare('SELECT * FROM no_such_table_here WHERE id = ?').then(() => null, (e) => e);

        expect(err).to.be.an.instanceOf(Error);
        expect(err.code).to.be.a('number').that.is.below(0);

        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
      } finally {
        await client.close();
      }
    });

    it('runs a statement prepared before the connection was lost (statement pooling) or refuses it (STATEMENT_CLOSED)', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const stmt = await client.prepare(COUNTRIES_IN_CONTINENT);

        expect((await stmt.run(['Asia'])).rows).to.have.length(16);

        const pooling = client.brokerInfo.statementPolling === 1;

        await new Promise((resolve) => {
          client._socket.once('close', resolve);
          client._socket.destroy();
        });

        const result = await stmt.run(['Europe']).then((r) => r, (e) => e);

        if (pooling) {
          // As the JDBC driver does: prepared again on the new session.
          expect(result).to.not.be.an.instanceOf(Error);
          expect(result.rows).to.have.length(40);
          expect((await stmt.run(['Africa'])).rows).to.have.length(16);
        } else {
          expect(result).to.be.an.instanceOf(Error);
          expect(result.code).to.equal('STATEMENT_CLOSED');
        }

        await stmt.close();
      } finally {
        await client.close();
      }
    });
  });

  describe('transaction', function () {
    const TABLE_NAME = 'tbl_test';

    this.timeout(20000);

    beforeEach(testSetup.cleanup(TABLE_NAME));
    after(testSetup.cleanup(TABLE_NAME));

    /** Rows of the test table, read on a connection of its own. */
    async function idsSeenByOthers() {
      const other = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const { rows } = await other.sql(`SELECT id FROM ${TABLE_NAME} ORDER BY id`, { rowsAs: 'arrays' });

        return rows.map((r) => r[0]);
      } finally {
        await other.close();
      }
    }

    async function createTable(client) {
      await client.execute(`CREATE TABLE ${TABLE_NAME}(id INT PRIMARY KEY)`);
    }

    it('commits when the function resolves, and resolves with its value', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await createTable(client);

        const value = await client.transaction(async (c) => {
          expect(c).to.equal(client);
          expect(client.getAutoCommitMode()).to.equal(false);

          await c.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [1]);
          await c.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [2]);

          return 'done';
        });

        expect(value).to.equal('done');
        expect(client.getAutoCommitMode()).to.equal(true);
        expect(await idsSeenByOthers()).to.deep.equal([1, 2]);
      } finally {
        await client.close();
      }
    });

    it('rolls back when the function throws, and rejects with its error', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await createTable(client);
        await client.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [1]);

        const thrown = new Error('changed my mind');
        const err = await client.transaction(async (c) => {
          await c.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [2]);
          await c.sql(`DELETE FROM ${TABLE_NAME} WHERE id = ?`, [1]);
          throw thrown;
        }).then(() => null, (e) => e);

        expect(err).to.equal(thrown);
        expect(client.getAutoCommitMode()).to.equal(true);
        expect(await idsSeenByOthers()).to.deep.equal([1]);
      } finally {
        await client.close();
      }
    });

    it('rolls back everything when a statement in it fails', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await createTable(client);

        const err = await client.transaction(async (c) => {
          await c.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [1]);
          // The same key again.
          await c.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [1]);
        }).then(() => null, (e) => e);

        expect(err).to.be.an.instanceOf(Error);
        expect(err.code).to.be.a('number').that.is.below(0);
        expect(await idsSeenByOthers()).to.deep.equal([]);

        // The connection goes on, auto-committing again.
        await client.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [3]);
        expect(await idsSeenByOthers()).to.deep.equal([3]);
      } finally {
        await client.close();
      }
    });

    it('runs prepared statements and the classic methods inside it', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await createTable(client);

        await client.transaction(async (c) => {
          const stmt = await c.prepare(`INSERT INTO ${TABLE_NAME} VALUES (?)`);

          await stmt.run([1]);
          await stmt.run([2]);
          await stmt.close();
          await c.execute(`INSERT INTO ${TABLE_NAME} VALUES (3)`);
        });

        expect(await idsSeenByOthers()).to.deep.equal([1, 2, 3]);
      } finally {
        await client.close();
      }
    });

    it('refuses a second transaction() while one runs (TRANSACTION_IN_PROGRESS), running nothing', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await createTable(client);

        let secondRan = false;
        const first = client.transaction(async (c) => {
          await c.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [1]);
        });
        const second = client.transaction(async () => {
          secondRan = true;
        });

        const [a, b] = await Promise.allSettled([first, second]);

        expect(a.status).to.equal('fulfilled');
        expect(b.status).to.equal('rejected');
        expect(b.reason.code).to.equal('TRANSACTION_IN_PROGRESS');
        expect(secondRan).to.equal(false);
        expect(await idsSeenByOthers()).to.deep.equal([1]);
      } finally {
        await client.close();
      }
    });

    it('leaves auto-commit off when it was off before', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await createTable(client);
        await client.setAutoCommitMode(false);

        await client.transaction(async (c) => {
          await c.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [1]);
        });

        expect(client.getAutoCommitMode()).to.equal(false);
        // Committed by the transaction all the same.
        expect(await idsSeenByOthers()).to.deep.equal([1]);

        await client.setAutoCommitMode(true);
      } finally {
        await client.close();
      }
    });

    it('fails with TRANSACTION_LOST when the session goes part-way, and commits nothing', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await createTable(client);

        let afterLoss = 'not run';
        const err = await client.transaction(async (c) => {
          await c.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [1]);

          await new Promise((resolve) => {
            client._socket.once('close', resolve);
            client._socket.destroy();
          });

          // Not sent on a new session.
          await c.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [2]).then(() => {
            afterLoss = 'sent';
          }, (e) => {
            afterLoss = e.code;
            throw e;
          });
        }).then(() => null, (e) => e);

        expect(afterLoss).to.equal('TRANSACTION_LOST');
        expect(err).to.be.an.instanceOf(Error);
        expect(err.code).to.equal('TRANSACTION_LOST');

        // The server rolled back the first INSERT with its session.
        expect(await idsSeenByOthers()).to.deep.equal([]);

        // The connection is usable again, auto-committing.
        expect(client.getAutoCommitMode()).to.equal(true);
        await client.sql(`INSERT INTO ${TABLE_NAME} VALUES (?)`, [3]);
        expect(await idsSeenByOthers()).to.deep.equal([3]);
      } finally {
        await client.close();
      }
    });
  });
});
