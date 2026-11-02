'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

describe('CoraDBConnection', function () {
  describe('getConnectionTimeout', function () {
    it('should succeed to get the connection timeout value', function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();
      const newTimeoutValue = 0;

      expect(client.getConnectionTimeout()).to.equal(0);

      client.setConnectionTimeout(newTimeoutValue);

      expect(client.getConnectionTimeout()).to.equal(newTimeoutValue);
    });
  });
});
