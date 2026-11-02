'use strict';

// End-to-end scenario: connect to a live CoraDB broker, fetch the schema
// (attribute/column definition) of a table, print it as a table, then
// disconnect. Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const CAS = require('../../src/constants/CASConstants');
const { CONFIG, toError, log, printTable } = require('./helpers');

const TABLE_NAME = 'athlete';
// Column/attribute definitions of a table.
const SCHEMA_TYPE = CAS.CoraDBSchemaType.CCI_SCH_ATTRIBUTE;

// Display "Precision" as "Prec." and omit the numeric "Type" column.
const TABLE_OPTIONS = { headerLabels: { Precision: 'Prec.' }, hiddenColumns: ['Type'] };

describe('e2e: BasicTableSchema (with CoraDB)', function () {
  // Connecting to a real broker and fetching schema can take a moment.
  this.timeout(20000);

  it('connects, fetches the table schema, prints it as a table, then disconnects', function () {
    const client = CoraDB.createConnection(CONFIG);

    return client
      .connect()
      .then(function () {
        log('Connected.');

        // Step 2: get the schema definition for the table.
        return client.getSchema(SCHEMA_TYPE, TABLE_NAME);
      })
      .then(function (schema) {
        // Step 3: display the schema in a table format.
        log('Schema for table [' + TABLE_NAME + ']:');
        printTable(schema, TABLE_OPTIONS);

        // Sanity checks.
        expect(schema).to.be.an('array');
        expect(schema.length).to.be.above(0);
        expect(schema[0]).to.have.property('Name');
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
