'use strict';

// End-to-end scenario: exercise SAVEPOINT semantics with auto-commit OFF.
// A row inserted after a SAVEPOINT is undone by ROLLBACK TO that savepoint,
// while rows inserted before it survive. Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, toError, log, resultRows, printTable } = require('./helpers');

const TABLE = 'test1';
const SAVEPOINT = 'sp';

describe('e2e: Savepoint (with CoraDB)', function () {
  this.timeout(20000);

  it('rolls back to a savepoint, undoing only the rows inserted after it', function () {
    const client = CoraDB.createConnection(CONFIG);

    // Select every row and assert the expected row count; returns the rows.
    const selectAll = function (expectedCount, label) {
      return client
        .query('SELECT * FROM ' + TABLE)
        .then(function (response) {
          const rows = resultRows(response.result);
          log(label);
          printTable(rows);
          expect(rows).to.have.length(expectedCount);
          return rows;
        });
    };

    return client
      .connect()
      .then(function () {
        log('Connected.');
        // Step 1: turn auto-commit OFF so the savepoint lives in one transaction.
        return client.setAutoCommitMode(false);
      })
      .then(function () {
        log('Auto-commit set to OFF.');
        // Step 2: ensure a clean environment.
        return client.execute('DROP TABLE IF EXISTS ' + TABLE);
      })
      .then(function () {
        log('Ensured a clean environment (dropped ' + TABLE + ' if it existed).');
        // Step 3: create the table.
        return client.execute('CREATE TABLE ' + TABLE + ' (id INT)');
      })
      .then(function () {
        log('Created table ' + TABLE + ' (id INT).');
        // Step 4: insert a row with id = 1.
        return client.execute('INSERT INTO ' + TABLE + ' (id) VALUES (?)', [1]);
      })
      .then(function () {
        log('Inserted a row with id = 1.');
        // Step 5: one row so far.
        return selectAll(1, 'Rows before the savepoint:');
      })
      .then(function () {
        // Step 6: mark a savepoint.
        return client.execute('SAVEPOINT ' + SAVEPOINT);
      })
      .then(function () {
        log('Created savepoint "' + SAVEPOINT + '".');
        // Step 7: insert a second row (id = 2) after the savepoint.
        return client.execute('INSERT INTO ' + TABLE + ' (id) VALUES (?)', [2]);
      })
      .then(function () {
        log('Inserted a row with id = 2 (after the savepoint).');
        // Step 8: both rows are visible within the transaction: 2 rows.
        return selectAll(2, 'Rows after the post-savepoint insert:');
      })
      .then(function () {
        // Step 9: roll back to the savepoint, discarding the row with id = 2.
        return client.execute('ROLLBACK TO ' + SAVEPOINT);
      })
      .then(function () {
        log('Rolled back to savepoint "' + SAVEPOINT + '".');
        // Step 10: only the pre-savepoint row (id = 1) remains: 1 row.
        return selectAll(1, 'Rows after ROLLBACK TO ' + SAVEPOINT + ':');
      })
      .then(function () {
        // Step 11: clean up.
        return client.execute('DROP TABLE IF EXISTS ' + TABLE);
      })
      .then(function () {
        log('Dropped table ' + TABLE + '.');
        // Step 12: disconnect.
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
