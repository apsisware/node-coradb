'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');
const CAS = require('../../src/constants/CASConstants');
const ErrorMessages = require('../../src/constants/ErrorMessages');

describe('CoraDBConnection', function () {
  describe('setDatabaseParameter', function () {
    it(`should fail to set the database parameter`, function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      const paramName = CAS.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH;

      return client
        .setDatabaseParameter(paramName, 0)
        .then(() => {
          throw new Error('Should have failed to set the database parameter.');
        })
        .catch(err => {
          expect(err).to.be.an.instanceOf(Error);
          expect(err.code).to.equal(-10011);
          expect(err.message).to.equal(ErrorMessages.CASErrorMsgId[err.code]);

          return client.close();
        });
    });

    it(`should succeed to set the isolation level parameter`, function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      const paramName = CAS.CCIDbParam.CCI_PARAM_ISOLATION_LEVEL;

      return client
        .setDatabaseParameter(paramName, CAS.CoraDBIsolationLevel.TRAN_REP_CLASS_COMMIT_INSTANCE)
        .then(() => {
          return client.close();
        });
    });
  });
});
