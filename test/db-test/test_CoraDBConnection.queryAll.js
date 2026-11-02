'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

describe('CoraDBConnection', function () {
  describe('queryAll', function () {
    // athlete_result of olympics1988-2004: 1,935 rows, read in several fetches.
    const SQL = 'SELECT * FROM athlete_result ORDER BY 1, 2, 4';

    function validateFetchResults(result) {
      expect(result)
        .to.be.an('object')
        .to.not.have.property('queryHandle');

      const TOTAL_ROWS = 1935;

      expect(result)
        .to.have.property('RowsCount')
        .to.be.a('number')
        .to.equal(TOTAL_ROWS);

      const COLUMNS_COUNT = 8;
      const COLUMN_NAMES = ['year', 'event_id', 'stadium_id', 'athlete_id', 'score', 'unit', 'result_value', 'medal_code'];
      const COLUMN_TYPES = ['Int', 'Int', 'Int', 'Int', 'String', 'String', 'Numeric', 'Char'];

      expect(result)
        .to.have.property('ColumnNames')
        .to.be.an('array')
        .with.length(COLUMNS_COUNT);

      expect(result.ColumnNames)
        .to.deep.equal(COLUMN_NAMES);

      expect(result)
        .to.have.property('ColumnDataTypes')
        .to.be.an('array')
        .with.length(COLUMNS_COUNT);

      expect(result.ColumnDataTypes)
        .to.deep.equal(COLUMN_TYPES);

      expect(result)
        .to.have.property('ColumnValues')
        .to.be.an('array')
        .with.length(TOTAL_ROWS);

      // The first row, and the last.
      expect(result.ColumnValues[0])
        .to.deep.equal([1988, 20005, 30055, 10829, '12.38', 'Time', 12.38, 'G']);

      expect(result.ColumnValues[result.ColumnValues.length - 1])
        .to.deep.equal([2004, 20344, 30123, 15362, '375', 'kg', 375, 'G']);
    }

    this.timeout(4000);

    describe('when using the new protocol', function () {
      it('should succeed to execute queryAll(sql)', function () {
        let client = testSetup.createDefaultCoraDBDemodbConnection();

        return client
          .queryAll(SQL)
          .then(result => {
            validateFetchResults(result);

            // The query should be closed automatically.
            expect(client)
              .to.be.an('object')
              .to.have.property('_queryResultSets')
              .to.be.an('object')
              .to.be.empty;

            return client.close();
          });
      });

      it('should succeed to execute queryAll(sql, callback)', function () {
        let client = testSetup.createDefaultCoraDBDemodbConnection();

        return new Promise((resolve, reject) => {
          client.queryAll(SQL, function (err, result) {
            if (err) {
              return reject(err);
            }

            resolve(result);
          })
        })
          .then(result => {
            validateFetchResults(result);

            // The query should be closed automatically.
            expect(client)
              .to.be.an('object')
              .to.have.property('_queryResultSets')
              .to.be.an('object')
              .to.be.empty;

            return client.close();
          });
      });
    });

    describe('when using the old protocol', function () {
      it('should succeed to execute queryAll(sql)', function () {
        let client = testSetup.createDefaultCoraDBDemodbConnection();

        client.setEnforceOldQueryProtocol(true);

        return client
          .queryAll(SQL)
          .then(result => {
            validateFetchResults(result);

            // The query should be closed automatically.
            expect(client)
              .to.be.an('object')
              .to.have.property('_queryResultSets')
              .to.be.an('object')
              .to.be.empty;

            return client.close();
          });
      });

      it('should succeed to execute queryAll(sql, callback)', function () {
        let client = testSetup.createDefaultCoraDBDemodbConnection();

        client.setEnforceOldQueryProtocol(true);

        return new Promise((resolve, reject) => {
          client.queryAll(SQL, function (err, result) {
            if (err) {
              return reject(err);
            }

            resolve(result);
          })
        })
          .then(result => {
            validateFetchResults(result);

            // The query should be closed automatically.
            expect(client)
              .to.be.an('object')
              .to.have.property('_queryResultSets')
              .to.be.an('object')
              .to.be.empty;

            return client.close();
          });
      });
    });
  });
});
