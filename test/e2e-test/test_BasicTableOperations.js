'use strict';

// End-to-end scenario: create a table, insert rows, select, delete, select
// again, drop the table, then disconnect. Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, toError, log, resultRows, printTable } = require('./helpers');

const TABLE = 'test1';

describe('e2e: BasicTableOperations (with CoraDB)', function () {
  this.timeout(20000);

  it('creates a table, inserts/selects/deletes rows, then drops it', function () {
    const client = CoraDB.createConnection(CONFIG);

    return client
      .connect()
      .then(function () {
        log('Connected.');
        // Step 2: ensure a clean environment.
        return client.execute('DROP TABLE IF EXISTS ' + TABLE);
      })
      .then(function () {
        log('Ensured a clean environment (dropped ' + TABLE + ' if it existed).');
        // Step 3: create the table.
        return client.execute('CREATE TABLE ' + TABLE + ' (id INT, VAL VARCHAR(16))');
      })
      .then(function () {
        log('Created table ' + TABLE + ' (id INT, VAL VARCHAR(16)).');
        // Step 3: insert the first row.
        return client.execute('INSERT INTO ' + TABLE + ' (id, VAL) VALUES (?, ?)', [1, 'TEST1']);
      })
      .then(function () {
        log('Inserted a row with the following values: 1, \'TEST1\'.');
        // Step 4: insert the second row.
        return client.execute('INSERT INTO ' + TABLE + ' (id, VAL) VALUES (?, ?)', [2, 'TEST2']);
      })
      .then(function () {
        log('Inserted a row with the following values: 2, \'TEST2\'.');
        // Step 5: select all rows.
        return client.query('SELECT * FROM ' + TABLE);
      })
      .then(function (response) {
        log('Rows in ' + TABLE + ' after inserts:');
        const rows = resultRows(response.result);
        printTable(rows);
        expect(rows).to.have.length(2);

        // Step 6: delete the row with id = 1.
        return client.execute('DELETE FROM ' + TABLE + ' WHERE id = 1');
      })
      .then(function () {
        log('Deleted the row with id = 1.');
        // Step 7: select all rows again.
        return client.query('SELECT * FROM ' + TABLE);
      })
      .then(function (response) {
        log('Rows in ' + TABLE + ' after delete:');
        const rows = resultRows(response.result);
        printTable(rows);
        expect(rows).to.have.length(1);

        // Step 8: drop the table.
        return client.execute('DROP TABLE ' + TABLE);
      })
      .then(function () {
        log('Dropped table ' + TABLE + '.');
        // Step 9: disconnect.
        return client.close();
      })
      .then(function () {
        log('Disconnected.');
        expect(client.connectionOpened).to.equal(false);
      })
      .catch(function (err) {
        // Best-effort cleanup (drop leftover table + close), then re-throw.
        return Promise.resolve()
          .then(function () { return client.execute('DROP TABLE IF EXISTS ' + TABLE); })
          .catch(function () { /* ignore */ })
          .then(function () { return client.close(); })
          .catch(function () { /* ignore */ })
          .then(function () { throw toError(err); });
      });
  });
});
