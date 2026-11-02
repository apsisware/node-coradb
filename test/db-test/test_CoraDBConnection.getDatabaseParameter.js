'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');
const CAS = require('../../src/constants/CASConstants');
const ErrorMessages = require('../../src/constants/ErrorMessages');

describe('CoraDBConnection', function () {
  describe('getDatabaseParameter', function () {
    it(`should succeed to set and get the database parameter`, function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      const isolationLevel = CAS.CCIDbParam.CCI_PARAM_ISOLATION_LEVEL;
      const tranRepClassCommitInstance = CAS.CoraDBIsolationLevel.TRAN_REP_CLASS_COMMIT_INSTANCE;

      return client
        .setDatabaseParameter(isolationLevel, tranRepClassCommitInstance)
        .then(() => {
          return client.getDatabaseParameter(isolationLevel);
        })
        .then(value => {
          expect(value).to.equal(tranRepClassCommitInstance);

          return client.close();
        });
    });

    it(`should succeed to get MAX_STRING_LENGTH, which can be read but not set`, function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      const paramName = CAS.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH;

      return client
        .getDatabaseParameter(paramName)
        .then(value => {
          expect(value).to.be.a('number');

          return client.close();
        });
    });

    it(`should fail to set MAX_STRING_LENGTH`, function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      const paramName = CAS.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH;

      return client
        .setDatabaseParameter(paramName, 0)
        .then(() => {
          throw new Error('Should have failed to set the database parameter.');
        }, err => {
          expect(err).to.be.an.instanceOf(Error);
          expect(err.code).to.equal(-10011);
          expect(err.message).to.equal(ErrorMessages.CASErrorMsgId[err.code]);

          return client.close();
        });
    });
  });
});
