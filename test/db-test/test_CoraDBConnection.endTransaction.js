'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

describe('CoraDBConnection', function () {
  describe('endTransaction', function () {
    this.timeout(20000);

    it('should turn auto-commit back on using endTransaction()', function () {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      return client
        .connect()
        .then(() => {
          // beginTransaction() turns auto-commit OFF.
          return client.beginTransaction();
        })
        .then(() => {
          expect(client.getAutoCommitMode()).to.equal(client.AUTOCOMMIT_OFF);

          return client.endTransaction();
        })
        .then(() => {
          expect(client.getAutoCommitMode()).to.equal(client.AUTOCOMMIT_ON);

          return client.close();
        });
    });

    it('should turn auto-commit back on using endTransaction(callback)', function (done) {
      let client = testSetup.createDefaultCoraDBDemodbConnection();

      client
        .connect()
        .then(() => {
          return client.beginTransaction();
        })
        .then(() => {
          expect(client.getAutoCommitMode()).to.equal(client.AUTOCOMMIT_OFF);

          client.endTransaction(function (err) {
            if (err) {
              return done(err);
            }

            try {
              expect(client.getAutoCommitMode()).to.equal(client.AUTOCOMMIT_ON);
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
