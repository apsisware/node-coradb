'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');
const ErrorMessages = require('../../src/constants/ErrorMessages');

/*
 * fetch() over the athlete_result table of olympics1988-2004 (1,935 rows, more
 * than the first reply carries). How many rows a batch holds is the server's
 * choice, so the tests check the first row, that every batch has rows, and
 * that the batches add up to the whole result ending with its last row.
 */
const SQL = 'SELECT * FROM athlete_result ORDER BY 1, 2, 4';
const TOTAL_ROWS = 1935;
const COLUMN_NAMES = ['year', 'event_id', 'stadium_id', 'athlete_id', 'score', 'unit', 'result_value', 'medal_code'];
const COLUMN_TYPES = ['Int', 'Int', 'Int', 'Int', 'String', 'String', 'Numeric', 'Char'];
const FIRST_ROW = [1988, 20005, 30055, 10829, '12.38', 'Time', 12.38, 'G'];
const LAST_ROW = [2004, 20344, 30123, 15362, '375', 'kg', 375, 'G'];

/** The first reply of query(SQL): the columns, and the first batch of rows. */
function verifyFirstBatch(client, response) {
  expect(response)
    .to.be.an('object')
    .to.have.property('queryHandle')
    .to.be.a('number')
    .to.be.above(0);

  expect(response)
    .to.have.property('result')
    .to.be.an('object');

  const result = response.result;

  expect(result)
    .to.be.an('object')
    .to.have.property('RowsCount')
    .to.be.a('number')
    .to.equal(TOTAL_ROWS);

  expect(client)
    .to.be.an('object')
    .to.have.property('_queryResultSets')
    .to.be.an('object')
    .to.have.all.keys(['' + response.queryHandle]);

  expect(result.ColumnNames).to.deep.equal(COLUMN_NAMES);
  expect(result.ColumnDataTypes).to.deep.equal(COLUMN_TYPES);

  // Not every row: the rest are fetched.
  expect(result)
    .to.have.property('ColumnValues')
    .to.be.an('array');

  expect(result.ColumnValues.length).to.be.above(0).and.below(TOTAL_ROWS);
  expect(result.ColumnValues[0]).to.deep.equal(FIRST_ROW);

  return result.ColumnValues.slice();
}

/** One fetch() reply with rows: the rows only, no column information. */
function verifyBatch(client, response, queryHandle) {
  expect(response)
    .to.be.an('object')
    .to.have.property('queryHandle')
    .to.be.a('number')
    .to.equal(queryHandle);

  expect(response).to.have.property('result');

  if (response.result === null) {
    return null;
  }

  const result = response.result;

  expect(result)
    .to.be.an('object')
    .to.not.have.property('RowsCount');

  expect(result).to.not.have.property('ColumnNames');
  expect(result).to.not.have.property('ColumnDataTypes');

  expect(client)
    .to.be.an('object')
    .to.have.property('_queryResultSets')
    .to.be.an('object')
    .to.have.all.keys(['' + response.queryHandle]);

  expect(result)
    .to.have.property('ColumnValues')
    .to.be.an('array')
    .with.length.above(0);

  return result.ColumnValues;
}

/** All the rows read: as many as the result has, ending with its last row. */
function verifyAllRows(rows) {
  expect(rows).to.have.length(TOTAL_ROWS);
  expect(rows[0]).to.deep.equal(FIRST_ROW);
  expect(rows[rows.length - 1]).to.deep.equal(LAST_ROW);
}

/** fetch() until it answers with no rows (a null result). */
function fetchAll(client, queryHandle, rows, withCallback) {
  const fetch = withCallback
    ? () => new Promise((resolve, reject) => {
      client.fetch(queryHandle, function (err, result, handle) {
        if (err) {
          return reject(err);
        }

        resolve({ queryHandle: handle, result });
      });
    })
    : () => client.fetch(queryHandle);

  return fetch().then(response => {
    const batch = verifyBatch(client, response, queryHandle);

    if (batch === null) {
      return response;
    }

    batch.forEach(row => rows.push(row));

    return fetchAll(client, queryHandle, rows, withCallback);
  });
}

function fetchTest(oldProtocol, withCallback) {
  return function () {
    const client = testSetup.createDefaultCoraDBDemodbConnection();
    let rows;

    if (oldProtocol) {
      client.setEnforceOldQueryProtocol(true);
    }

    this.timeout(10000);

    return client
      .query(SQL)
      .then(response => {
        rows = verifyFirstBatch(client, response);

        return fetchAll(client, response.queryHandle, rows, withCallback);
      })
      .then(response => {
        verifyAllRows(rows);

        expect(client)
          .to.be.an('object')
          .to.have.property('_queryResultSets')
          .to.be.an('object')
          .to.have.all.keys(['' + response.queryHandle]);

        return client.close();
      })
      .then(() => {
        expect(client)
          .to.be.an('object')
          .to.have.property('_queryResultSets')
          .to.be.an('object')
          .to.be.empty;
      });
  };
}

function invalidHandleTest(withCallback) {
  return function () {
    const client = testSetup.createDefaultCoraDBDemodbConnection();

    return client
      .query(SQL)
      .then(response => {
        verifyFirstBatch(client, response);

        if (!withCallback) {
          return client.fetch(-1234);
        }

        return new Promise((resolve, reject) => {
          client.fetch(-1234, function (err, result, queryHandle) {
            if (err) {
              return reject(err);
            }

            resolve({ queryHandle, result });
          });
        });
      })
      .then(() => {
        throw new Error('fetch() should have failed when providing an invalid queryHandle');
      }, err => {
        expect(err).to.be.an.instanceOf(Error);
        expect(err.code).to.equal('NO_ACTIVE_QUERY');
        expect(err.message).to.equal(ErrorMessages.ERROR_NO_ACTIVE_QUERY);

        return client.close();
      });
  };
}

describe('CoraDBConnection', function () {
  describe('fetch', function () {
    describe('when using the new protocol', function () {
      it('should succeed to execute fetch(queryHandle) after query(sql)', fetchTest(false, false));

      it('should succeed to execute fetch(queryHandle, callback) after query(sql)', fetchTest(false, true));

      it('should fail when fetch(queryHandle, callback) is given an invalid queryHandle', invalidHandleTest(true));

      it('should fail when fetch(queryHandle) is given an invalid queryHandle', invalidHandleTest(false));
    });

    describe('when using the old protocol', function () {
      it('should succeed to execute fetch(queryHandle) after query(sql)', fetchTest(true, false));

      it('should succeed to execute fetch(queryHandle, callback) after query(sql)', fetchTest(true, true));
    });
  });
});
