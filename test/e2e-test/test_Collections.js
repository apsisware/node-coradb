'use strict';

// End-to-end scenario: read SET, MULTISET and LIST (SEQUENCE) collection
// columns back from a SELECT and verify they decode to JS arrays.
// Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, toError, log, resultRows, printTable } = require('./helpers');

const TABLE = 'test_coll';

describe('e2e: Collections - SET / MULTISET / LIST (with CoraDB)', function () {
  this.timeout(20000);

  it('decodes SET, MULTISET and LIST columns into JS arrays', function () {
    const client = CoraDB.createConnection(CONFIG);

    return client
      .connect()
      .then(function () {
        log('Connected.');
        return client.execute('DROP TABLE IF EXISTS ' + TABLE);
      })
      .then(function () {
        log('Ensured a clean environment (dropped ' + TABLE + ' if it existed).');
        // s = SET(INT) (unordered, de-duplicated),
        // m = MULTISET(INT) (unordered, duplicates allowed),
        // l = LIST/SEQUENCE(VARCHAR) (ordered, duplicates allowed).
        return client.execute(
          'CREATE TABLE ' + TABLE + ' (id INT, s SET(INT), m MULTISET(INT), l LIST(VARCHAR(10)))'
        );
      })
      .then(function () {
        log('Created table ' + TABLE + ' (id INT, s SET(INT), m MULTISET(INT), l LIST(VARCHAR(10))).');
        // CoraDB collection literals use { ... } syntax.
        return client.execute(
          'INSERT INTO ' + TABLE + " VALUES (1, {1, 2, 3}, {5, 5, 6}, {'x', 'yy', 'zzz'})"
        );
      })
      .then(function () {
        log('Inserted a row with SET {1,2,3}, MULTISET {5,5,6}, LIST {\'x\',\'yy\',\'zzz\'}.');
        return client.query('SELECT id, s, m, l FROM ' + TABLE + ' WHERE id = 1');
      })
      .then(function (response) {
        const rows = resultRows(response.result);
        log('Row read back:');
        printTable(rows);

        expect(rows).to.have.length(1);
        const row = rows[0];

        // SET: unordered + de-duplicated -> compare as a sorted set.
        expect(row.s).to.be.an('array');
        expect(row.s.slice().sort()).to.deep.equal([1, 2, 3]);

        // MULTISET: unordered, duplicates preserved -> compare sorted.
        expect(row.m).to.be.an('array');
        expect(row.m.slice().sort()).to.deep.equal([5, 5, 6]);

        // LIST / SEQUENCE: order preserved.
        expect(row.l).to.be.an('array');
        expect(row.l).to.deep.equal(['x', 'yy', 'zzz']);

        return client.execute('DROP TABLE IF EXISTS ' + TABLE);
      })
      .then(function () {
        log('Dropped table ' + TABLE + '.');
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

  it('binds a collection parameter (SEQUENCE) and reads it back', function () {
    const client = CoraDB.createConnection(CONFIG);

    return client
      .connect()
      .then(function () {
        log('Connected.');
        return client.execute('DROP TABLE IF EXISTS ' + TABLE);
      })
      .then(function () {
        return client.execute('CREATE TABLE ' + TABLE + ' (id INT, l LIST(INT))');
      })
      .then(function () {
        log('Created table ' + TABLE + ' (id INT, l LIST(INT)).');
        // Bind the collection as a typed parameter (element type is inferred
        // from the array values).
        return client.executeWithTypedParams(
          'INSERT INTO ' + TABLE + ' (id, l) VALUES (?, ?)',
          [1, [10, 20, 30]],
          ['int', 'sequence']
        );
      })
      .then(function () {
        log('Inserted a row binding LIST {10,20,30} as a parameter.');
        // The same through sql(), with the element type given.
        return client.sql('INSERT INTO ' + TABLE + ' (id, l) VALUES (?, ?)', [2, { type: 'list of int', value: [7, null, 9] }]);
      })
      .then(function () {
        log('Inserted a row binding LIST {7,NULL,9} through sql().');
        return client.query('SELECT l FROM ' + TABLE + ' ORDER BY id');
      })
      .then(function (response) {
        const rows = resultRows(response.result);
        log('Rows read back:');
        printTable(rows);

        expect(rows).to.have.length(2);
        expect(rows[0].l).to.be.an('array').that.deep.equals([10, 20, 30]);
        expect(rows[1].l).to.be.an('array').that.deep.equals([7, null, 9]);

        return client.execute('DROP TABLE IF EXISTS ' + TABLE);
      })
      .then(function () {
        log('Dropped table ' + TABLE + '.');
        return client.close();
      })
      .then(function () {
        log('Disconnected.');
        expect(client.connectionOpened).to.equal(false);
      })
      .catch(function (err) {
        return Promise.resolve()
          .then(function () { return client.execute('DROP TABLE IF EXISTS ' + TABLE); })
          .catch(function () { /* ignore */ })
          .then(function () { return client.close(); })
          .catch(function () { /* ignore */ })
          .then(function () { throw toError(err); });
      });
  });
});
