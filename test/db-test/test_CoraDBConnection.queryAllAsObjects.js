'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

describe('CoraDBConnection', function () {
  describe('queryAllAsObjects', function () {
    this.timeout(20000);

    const TABLE_NAME = 'tbl_test';

    const setupQueries = [
      `CREATE TABLE ${TABLE_NAME}(id INT, name VARCHAR(32))`,
      `INSERT INTO ${TABLE_NAME}(id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three')`,
    ];

    beforeEach(testSetup.cleanup(TABLE_NAME));
    after(testSetup.cleanup(TABLE_NAME));

    function validateRows(rows) {
      // Unlike queryAsObjects(), queryAllAsObjects() resolves the array of
      // objects directly, without a query handle wrapper.
      expect(rows)
        .to.be.an('array')
        .with.length(3);

      const keys = Object.keys(rows[0]);

      expect(keys).to.have.length(2);
      expect(keys.map(k => k.toLowerCase())).to.deep.equal(['id', 'name']);

      expect(rows[0][keys[0]]).to.equal(1);
      expect(rows[0][keys[1]]).to.equal('one');
      expect(rows[1][keys[0]]).to.equal(2);
      expect(rows[1][keys[1]]).to.equal('two');
      expect(rows[2][keys[0]]).to.equal(3);
      expect(rows[2][keys[1]]).to.equal('three');
    }

    it('should succeed to map rows to objects using queryAllAsObjects(sql)', function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      return client
        .batchExecuteNoQuery(setupQueries)
        .then(() => {
          return client.queryAllAsObjects(`SELECT id, name FROM ${TABLE_NAME} ORDER BY id`);
        })
        .then(rows => {
          validateRows(rows);

          return client.close();
        });
    });

    it('should succeed to map rows to objects using queryAllAsObjects(sql, callback)', function (done) {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      client
        .batchExecuteNoQuery(setupQueries)
        .then(() => {
          client.queryAllAsObjects(`SELECT id, name FROM ${TABLE_NAME} ORDER BY id`, function (err, rows) {
            if (err) {
              return done(err);
            }

            try {
              validateRows(rows);
            } catch (assertionError) {
              return done(assertionError);
            }

            client.close(done);
          });
        })
        .catch(done);
    });
  });
});
