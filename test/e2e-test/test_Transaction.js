'use strict';

// End-to-end scenario: exercise transaction semantics with auto-commit OFF.
// A committed INSERT survives a later ROLLBACK, while an uncommitted INSERT is
// undone by it. Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, toError, log, resultRows, printTable } = require('./helpers');

const TABLE = 'test1';

describe('e2e: Transaction (with CoraDB)', function () {
  this.timeout(20000);

  it('commits one row, then rolls back a second, leaving only the committed row', function () {
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
        // Step 1: turn auto-commit OFF so COMMIT/ROLLBACK are under our control.
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
        // Step 5: commit, persisting the row with id = 1.
        return client.commit();
      })
      .then(function () {
        log('Committed.');
        // Step 6: after COMMIT there should be exactly 1 row.
        return selectAll(1, 'Rows after COMMIT:');
      })
      .then(function () {
        // Step 7: insert a second row (id = 2) WITHOUT committing.
        return client.execute('INSERT INTO ' + TABLE + ' (id) VALUES (?)', [2]);
      })
      .then(function () {
        log('Inserted a row with id = 2 (not committed).');
        // Step 8: the uncommitted row is visible within this transaction: 2 rows.
        return selectAll(2, 'Rows after the second (uncommitted) insert:');
      })
      .then(function () {
        // Step 9: roll back, discarding the uncommitted row with id = 2.
        return client.rollback();
      })
      .then(function () {
        log('Rolled back.');
        // Step 10: only the committed row (id = 1) remains: 1 row.
        return selectAll(1, 'Rows after ROLLBACK:');
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
