'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

describe('CoraDBConnection', function () {
  describe('queryAsObjects', function () {
    this.timeout(20000);

    const TABLE_NAME = 'tbl_test';

    const setupQueries = [
      `CREATE TABLE ${TABLE_NAME}(id INT, name VARCHAR(32))`,
      `INSERT INTO ${TABLE_NAME}(id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three')`,
    ];

    beforeEach(testSetup.cleanup(TABLE_NAME));
    after(testSetup.cleanup(TABLE_NAME));

    function validateRows(rows) {
      expect(rows)
        .to.be.an('array')
        .with.length(3);

      // getObjects() maps every row to an object keyed by the column names.
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

    it('should succeed to map rows to objects using queryAsObjects(sql)', function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      return client
        .batchExecuteNoQuery(setupQueries)
        .then(() => {
          return client.queryAsObjects(`SELECT id, name FROM ${TABLE_NAME} ORDER BY id`);
        })
        .then(response => {
          expect(response)
            .to.be.an('object')
            .to.have.property('queryHandle')
            .to.be.a('number')
            .to.be.above(0);

          expect(response).to.have.property('result');
          validateRows(response.result);

          return client.close();
        });
    });

    it('should succeed to map rows to objects using queryAsObjects(sql, callback)', function (done) {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      client
        .batchExecuteNoQuery(setupQueries)
        .then(() => {
          client.queryAsObjects(`SELECT id, name FROM ${TABLE_NAME} ORDER BY id`, function (err, result, queryHandle) {
            if (err) {
              return done(err);
            }

            try {
              expect(queryHandle)
                .to.be.a('number')
                .to.be.above(0);

              validateRows(result);
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
