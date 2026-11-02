'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

describe('CoraDBConnection', function () {
  describe('beginTransaction', function () {
    const TABLE_NAME = 'test_tran';

    beforeEach(testSetup.cleanup(TABLE_NAME));
    after(testSetup.cleanup(TABLE_NAME));

    it('should succeed to automatically rollback the changes when the connection has been abruptly disconnected without commit after using beginTransaction()', function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      return client
        .connect()
        .then(() => {
          return client.execute(`CREATE TABLE ${TABLE_NAME}(id INT)`);
        })
        .then(() => {
          return client.beginTransaction();
        })
        .then(() => {
          return client.execute(`INSERT INTO ${TABLE_NAME} VALUES(1)`);
        })
        .then(() => {
          // Abruptly close the connection to make sure the
          // changes are rolled back on the server side.
          return client.close();
        })
        .then(() => {
          return client.query(`SELECT * FROM ${TABLE_NAME}`);
        })
        .then(response => {
          // Calling `query` above reestablishes the connection, which keeps
          // the auto-commit mode the caller chose (off, by beginTransaction()).
          expect(client.getAutoCommitMode()).to.be.false;

          expect(response)
            .to.be.an('object')
            .to.have.property('queryHandle')
            .to.be.a('number')
            .to.be.above(0);

          expect(response)
            .to.have.property('result')
            .to.be.an('object');

          let result = response.result;

          expect(result)
            .to.be.an('object')
            .to.have.property('RowsCount')
            .to.be.a('number')
            .to.equal(0);

          // One open handle. Not compared by number: after the reconnect the
          // caller's handle carries the login it belongs to, while the table
          // is keyed by the server's number (see fetch()).
          expect(Object.keys(client._queryResultSets)).to.have.length(1);

          // Auto-commit back on, so the DROP below is committed.
          return client.setAutoCommitMode(true);
        })
        .then(() => {
          return client.execute(`DROP TABLE ${TABLE_NAME}`);
        })
        .then(() => {
          // Abruptly close the connection again to see if the
          // changes are persisted or not.
          return client.close();
        })
        .then(() => {
          return client.query(`SELECT COUNT(*) FROM db_class WHERE class_name = '${TABLE_NAME}'`);
        })
        .then(response => {
          expect(response)
            .to.be.an('object')
            .to.have.property('queryHandle')
            .to.be.a('number')
            .to.be.above(0);

          expect(response)
            .to.have.property('result')
            .to.be.an('object');

          let result = response.result;

          expect(result)
            .to.be.an('object')
            .to.have.property('RowsCount')
            .to.be.a('number')
            .to.equal(1);

          expect(result)
            .to.have.property('ColumnValues')
            .to.be.an('array')
            .with.length(1);

          expect(result.ColumnValues[0])
            .to.be.an('array')
            .with.length(1);

          expect(result.ColumnValues[0][0])
            .to.be.a('number')
          // No such table should exist.
            .to.equal(0);

          expect(result)
            .to.have.property('ColumnNames')
            .to.be.an('array')
            .with.length(1);

          expect(result.ColumnNames[0])
            .to.equal('count(*)');

          // One open handle. Not compared by number: after the reconnect the
          // caller's handle carries the login it belongs to, while the table
          // is keyed by the server's number (see fetch()).
          expect(Object.keys(client._queryResultSets)).to.have.length(1);

          return client.close();
        });
    });

    it('should succeed to automatically rollback the changes when the connection has been abruptly disconnected without commit after using beginTransaction(callback)', function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      return client
        .connect()
        .then(() => {
          return client.execute(`CREATE TABLE ${TABLE_NAME}(id INT)`);
        })
        .then(() => {
          return new Promise((resolve, reject) => {
            client.beginTransaction(function (err) {
              if (err) {
                return reject(err);
              }

              resolve();
            });
          });
        })
        .then(() => {
          return client.execute(`INSERT INTO ${TABLE_NAME} VALUES(1)`);
        })
        .then(() => {
          // Abruptly close the connection to make sure the
          // changes are rolled back on the server side.
          return client.close();
        })
        .then(() => {
          return client.query(`SELECT * FROM ${TABLE_NAME}`);
        })
        .then(response => {
          // Calling `query` above reestablishes the connection, which keeps
          // the auto-commit mode the caller chose (off, by beginTransaction()).
          expect(client.getAutoCommitMode()).to.be.false;

          expect(response)
            .to.be.an('object')
            .to.have.property('queryHandle')
            .to.be.a('number')
            .to.be.above(0);

          expect(response)
            .to.have.property('result')
            .to.be.an('object');

          let result = response.result;

          expect(result)
            .to.be.an('object')
            .to.have.property('RowsCount')
            .to.be.a('number')
            .to.equal(0);

          // One open handle. Not compared by number: after the reconnect the
          // caller's handle carries the login it belongs to, while the table
          // is keyed by the server's number (see fetch()).
          expect(Object.keys(client._queryResultSets)).to.have.length(1);

          // Auto-commit back on, so the DROP below is committed.
          return client.setAutoCommitMode(true);
        })
        .then(() => {
          return client.execute(`DROP TABLE ${TABLE_NAME}`);
        })
        .then(() => {
          // Abruptly close the connection again to see if the
          // changes are persisted or not.
          return client.close();
        })
        .then(() => {
          return client.query(`SELECT COUNT(*) FROM db_class WHERE class_name = '${TABLE_NAME}'`);
        })
        .then(response => {
          expect(response)
            .to.be.an('object')
            .to.have.property('queryHandle')
            .to.be.a('number')
            .to.be.above(0);

          expect(response)
            .to.have.property('result')
            .to.be.an('object');

          let result = response.result;

          expect(result)
            .to.be.an('object')
            .to.have.property('RowsCount')
            .to.be.a('number')
            .to.equal(1);

          expect(result)
            .to.have.property('ColumnValues')
            .to.be.an('array')
            .with.length(1);

          expect(result.ColumnValues[0])
            .to.be.an('array')
            .with.length(1);

          expect(result.ColumnValues[0][0])
            .to.be.a('number')
          // No such table should exist.
            .to.equal(0);

          expect(result)
            .to.have.property('ColumnNames')
            .to.be.an('array')
            .with.length(1);

          expect(result.ColumnNames[0])
            .to.equal('count(*)');

          // One open handle. Not compared by number: after the reconnect the
          // caller's handle carries the login it belongs to, while the table
          // is keyed by the server's number (see fetch()).
          expect(Object.keys(client._queryResultSets)).to.have.length(1);

          return client.close();
        });
    });
  });
});
