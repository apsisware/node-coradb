'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

/*
 * stream() and getQueryPlan() against the live server (olympics1988-2004).
 */
describe('CoraDBConnection', function () {
  describe('stream', function () {
    // 1935 rows: more than one fetch batch.
    const ALL_RESULTS = 'SELECT * FROM athlete_result ORDER BY 1, 2, 4';
    const ROW_COUNT = 1935;

    this.timeout(20000);

    it('hands out every row of a query, in order', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const rows = [];

        for await (const row of client.stream(ALL_RESULTS, { rowsAs: 'arrays' })) {
          rows.push(row);
        }

        expect(rows).to.have.length(ROW_COUNT);
        expect(rows[0]).to.deep.equal([1988, 20005, 30055, 10829, '12.38', 'Time', 12.38, 'G']);
        expect(rows[ROW_COUNT - 1]).to.deep.equal([2004, 20344, 30123, 15362, '375', 'kg', 375, 'G']);

        // The handle closed itself after the last row.
        expect(Object.keys(client._queryResultSets)).to.have.length(0);
      } finally {
        await client.close();
      }
    });

    it('hands out rows as objects by default, with values bound on the server', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const names = [];
        const sql = 'SELECT c.name FROM country c, continent ct WHERE c.continent_id = ct.id AND ct.name = ? ORDER BY c.name';

        for await (const row of client.stream(sql, ['Asia'])) {
          expect(row).to.have.all.keys('name');
          names.push(row.name);
        }

        expect(names).to.have.length(16);
        expect(names).to.deep.equal(names.slice().sort());
      } finally {
        await client.close();
      }
    });

    it('closes the handle when the loop is left early', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        let seen = 0;

        for await (const row of client.stream(ALL_RESULTS, { rowsAs: 'arrays' })) {
          expect(row).to.have.length(8);
          seen += 1;

          if (seen === 5) {
            break;
          }
        }

        expect(seen).to.equal(5);
        expect(Object.keys(client._queryResultSets)).to.have.length(0);
        expect(client.isQueueEmpty()).to.equal(true);

        // The connection goes on.
        expect(Number((await client.sql('SELECT COUNT(*) AS n FROM athlete_result')).rows[0].n)).to.equal(ROW_COUNT);
      } finally {
        await client.close();
      }
    });

    it('closes the handle when the loop throws', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const thrown = new Error('stop here');
        const err = await (async () => {
          for await (const row of client.stream(ALL_RESULTS)) {
            expect(row).to.be.an('object');
            throw thrown;
          }
        })().then(() => null, (e) => e);

        expect(err).to.equal(thrown);
        expect(Object.keys(client._queryResultSets)).to.have.length(0);
      } finally {
        await client.close();
      }
    });

    it('fails on a statement the server refuses', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const err = await (async () => {
          // eslint-disable-next-line no-unused-vars
          for await (const row of client.stream('SELECT * FROM no_such_table_here')) {
            // nothing
          }
        })().then(() => null, (e) => e);

        expect(err).to.be.an.instanceOf(Error);
        expect(err.code).to.be.a('number').that.is.below(0);

        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
      } finally {
        await client.close();
      }
    });
  });

  describe('getQueryPlan', function () {
    const TABLE_NAME = 'tbl_test';

    this.timeout(20000);

    beforeEach(testSetup.cleanup(TABLE_NAME));
    after(testSetup.cleanup(TABLE_NAME));

    it('returns the plan of a SELECT as text', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const plan = await client.getQueryPlan('SELECT * FROM athlete WHERE id = 1');

        expect(plan).to.be.a('string');
        expect(plan.length).to.be.above(0);
        expect(plan, plan).to.match(/athlete/);
      } finally {
        await client.close();
      }
    });

    it('answers a callback too', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const plan = await new Promise((resolve, reject) => {
          client.getQueryPlan('SELECT * FROM country WHERE iso3 = \'ROU\'', (err, result) => (err ? reject(err) : resolve(result)));
        });

        expect(plan, plan).to.match(/country/);
      } finally {
        await client.close();
      }
    });

    it('plans a DELETE without running it', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.execute(`CREATE TABLE ${TABLE_NAME}(id INT PRIMARY KEY)`);
        await client.execute(`INSERT INTO ${TABLE_NAME} VALUES (1), (2)`);

        const plan = await client.getQueryPlan(`DELETE FROM ${TABLE_NAME}`);

        expect(plan).to.be.a('string');

        const { rows } = await client.sql(`SELECT COUNT(*) AS n FROM ${TABLE_NAME}`);

        expect(Number(rows[0].n)).to.equal(2);
      } finally {
        await client.close();
      }
    });

    it('fails on a statement the server cannot compile, and the connection goes on', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const err = await client.getQueryPlan('SELECT * FROM no_such_table_here').then(() => null, (e) => e);

        expect(err).to.be.an.instanceOf(Error);
        expect(err.code).to.be.a('number').that.is.below(0);

        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
      } finally {
        await client.close();
      }
    });
  });
});
