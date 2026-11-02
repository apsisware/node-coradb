'use strict';

const { expect } = require('chai');
const testSetup = require('./testSetup');

// Integration test: requires a running CoraDB broker (see test/testSetup).
describe('test_QueryWithTypedParams (with CoraDB)', function () {
  it('runs a parameterized query and returns a result set', function () {
    const client = testSetup.createDefaultCoraDBDemodbConnection();

    return client
      .connect()
      .then(() => client.query('SELECT c.* FROM country c, continent ct WHERE c.continent_id = ct.id AND ct.name = ?', ['Oceania']))
      .then(response => {
        expect(response).to.be.an('object').with.property('result');

        const result = response.result;
        expect(result).to.have.property('RowsCount').that.is.a('number');
        expect(result).to.have.property('ColumnValues').that.is.an('array');
      })
      .then(() => client.close());
  });
});
