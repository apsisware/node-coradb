'use strict';

const { expect } = require('chai');
const testSetup = require('./testSetup');

// Integration test: requires a running CoraDB broker (see test/testSetup).
// The original test exercised a removed delimiter-based identifier-interpolation
// feature; it has been rewritten to use current value-bound `?` parameters.
describe('test_QueryWithParams LIKE/LENGTH (with CoraDB)', function () {
  it('runs a parameterized LIKE/LENGTH query and returns a result set', function () {
    const client = testSetup.createDefaultCoraDBDemodbConnection();

    return client
      .connect()
      .then(() => client.query(
        'SELECT * FROM country WHERE iso3 LIKE ? AND CHAR_LENGTH(capital) > ?',
        ['A%', 5]))
      .then(response => {
        expect(response).to.be.an('object').with.property('result');

        const result = response.result;
        expect(result).to.have.property('RowsCount').that.is.a('number');
        expect(result).to.have.property('ColumnValues').that.is.an('array');
      })
      .then(() => client.close());
  });
});
