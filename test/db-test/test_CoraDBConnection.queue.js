'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

// Coverage for the two synchronous request-queue accessors:
//   - isQueueEmpty()  -> boolean, whether the internal request queue is empty
//   - getQueueDepth() -> number, the number of queued requests
describe('CoraDBConnection', function () {
  describe('request queue accessors', function () {
    this.timeout(20000);

    const TABLE_NAME = 'tbl_test';

    const setupQueries = [
      `CREATE TABLE ${TABLE_NAME}(id INT)`,
      `INSERT INTO ${TABLE_NAME}(id) VALUES (1), (2), (3)`,
    ];

    beforeEach(testSetup.cleanup(TABLE_NAME));
    after(testSetup.cleanup(TABLE_NAME));

    // Log the current queue state through the client's logger so it shows up,
    // indented, in the test output.
    function logQueueState(client, label) {
      client.logger.debug(`Queue state (${label}): isEmpty = ${client.isQueueEmpty()}, depth = ${client.getQueueDepth()}`);
    }

    describe('isQueueEmpty', function () {
      it('should report an empty queue on a freshly connected, idle client', function () {
        let client = testSetup.createDefaultCoraDBDemodbConnection();

        return client
          .connect()
          .then(() => {
            logQueueState(client, 'after connect');

            expect(client.isQueueEmpty()).to.be.a('boolean').to.equal(true);

            return client.close();
          });
      });

      it('should report an empty queue again after a request has drained', function () {
        let client = testSetup.createDefaultCoraDBDemodbConnection();

        return client
          .batchExecuteNoQuery(setupQueries)
          .then(() => {
            return client.query(`SELECT id FROM ${TABLE_NAME} ORDER BY id`);
          })
          .then(response => {
            client.logger.debug('query() response.queryHandle =', response.queryHandle);
            client.logger.debug('query() response =', response);
            logQueueState(client, 'after query drained');

            expect(client.isQueueEmpty()).to.equal(true);

            return client.close();
          });
      });
    });

    describe('getQueueDepth', function () {
      it('should report a depth of 0 on a freshly connected, idle client', function () {
        let client = testSetup.createDefaultCoraDBDemodbConnection();

        return client
          .connect()
          .then(() => {
            logQueueState(client, 'after connect');

            expect(client.getQueueDepth()).to.be.a('number').to.equal(0);

            return client.close();
          });
      });

      it('should report a depth of 0 again after a request has drained', function () {
        let client = testSetup.createDefaultCoraDBDemodbConnection();

        return client
          .batchExecuteNoQuery(setupQueries)
          .then(() => {
            return client.query(`SELECT id FROM ${TABLE_NAME} ORDER BY id`);
          })
          .then(response => {
            client.logger.debug('query() response.queryHandle =', response.queryHandle);
            client.logger.debug('query() response =', response);
            logQueueState(client, 'after query drained');

            expect(client.getQueueDepth()).to.equal(0);

            return client.close();
          });
      });
    });
  });
});
