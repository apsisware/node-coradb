'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');
const ErrorMessages = require('../../src/constants/ErrorMessages');

describe('CoraDBConnection', function () {
  describe('getMetaData', function () {
    this.timeout(20000);

    const TABLE_NAME = 'tbl_test';

    const setupQueries = [
      `CREATE TABLE ${TABLE_NAME}(id INT, name VARCHAR(32))`,
      `INSERT INTO ${TABLE_NAME}(id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three')`,
    ];

    beforeEach(testSetup.cleanup(TABLE_NAME));
    after(testSetup.cleanup(TABLE_NAME));

    it('should return the result-set metadata for an open query handle using getMetaData(queryHandle)', function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      return client
        .batchExecuteNoQuery(setupQueries)
        .then(() => {
          return client.query(`SELECT id, name FROM ${TABLE_NAME} ORDER BY id`);
        })
        .then(response => {
          return client
            .getMetaData(response.queryHandle)
            .then(metaData => {
              // getMetaData() returns the same result-set object that query()
              // resolved for this handle.
              expect(metaData)
                .to.be.an('object')
                .to.deep.equal(response.result);

              expect(metaData)
                .to.have.property('ColumnValues')
                .to.be.an('array')
                .with.length(3);

              return client.close();
            });
        });
    });

    it('should return the result-set metadata using getMetaData(queryHandle, callback)', function (done) {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      client
        .batchExecuteNoQuery(setupQueries)
        .then(() => {
          return client.query(`SELECT id, name FROM ${TABLE_NAME} ORDER BY id`);
        })
        .then(response => {
          client.getMetaData(response.queryHandle, function (err, metaData) {
            if (err) {
              return done(err);
            }

            try {
              expect(metaData)
                .to.be.an('object')
                .to.deep.equal(response.result);
            } catch (assertionError) {
              return done(assertionError);
            }

            client.close(done);
          });
        })
        .catch(done);
    });

    it('should fail with getMetaData(queryHandle) when the query handle does not exist', function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      return client
        .connect()
        .then(() => {
          return client.getMetaData(999999);
        })
        .then(() => {
          throw new Error('getMetaData() should have failed for an unknown query handle.');
        })
        .catch(err => {
          expect(err).to.be.an.instanceOf(Error);
          expect(err.message).to.equal(ErrorMessages.ERROR_NO_ACTIVE_QUERY);

          return client.close();
        });
    });

    it('should fail with getMetaData(queryHandle, callback) when the query handle does not exist', function (done) {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      client
        .connect()
        .then(() => {
          client.getMetaData(999999, function (err) {
            try {
              expect(err).to.be.an.instanceOf(Error);
              expect(err.message).to.equal(ErrorMessages.ERROR_NO_ACTIVE_QUERY);
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
