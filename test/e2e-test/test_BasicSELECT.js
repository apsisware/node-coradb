'use strict';

// End-to-end scenario: connect to a live CoraDB broker, run a SELECT query,
// print the rows as a table, then disconnect. Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, toError, log, resultRows, printTable } = require('./helpers');

const SQL = 'SELECT * FROM [athlete] LIMIT 0,5';

describe('e2e: BasicSELECT (with CoraDB)', function () {
  // Connecting to a real broker and querying can take a moment.
  this.timeout(20000);

  it('connects, runs a SELECT, prints the rows as a table, then disconnects', function () {
    const client = CoraDB.createConnection(CONFIG);
    let queryHandle;

    return client
      .connect()
      .then(function () {
        log('Connected.');

        // Step 2: execute the SELECT query.
        return client.query(SQL);
      })
      .then(function (response) {
        queryHandle = response.queryHandle;
        const result = response.result;

        // Step 3: print the results in a table format.
        log('Query: ' + SQL);
        printTable(resultRows(result));

        // Sanity checks.
        expect(result).to.be.an('object');
        expect(result).to.have.property('RowsCount').that.is.a('number');
        expect(result).to.have.property('ColumnValues').that.is.an('array');
        expect(result.ColumnValues.length).to.be.at.most(5);

        // Release the server-side query handle before closing.
        return client.closeQuery(queryHandle);
      })
      .then(function () {
        // Step 4: disconnect.
        return client.close();
      })
      .then(function () {
        log('Disconnected.');

        expect(client.connectionOpened).to.equal(false);
      })
      .catch(function (err) {
        // Best-effort cleanup, then re-throw so Mocha reports the original error.
        return Promise.resolve()
          .then(function () {
            return client.close();
          })
          .catch(function () { /* ignore close errors during cleanup */ })
          .then(function () {
            throw toError(err);
          });
      });
  });
});
