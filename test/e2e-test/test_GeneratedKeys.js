'use strict';

// End-to-end scenario: insert into an AUTO_INCREMENT table requesting generated
// keys, then fetch them with getGeneratedKeys(). Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, toError, log, resultRows, printTable } = require('./helpers');

const TABLE = 'test_genkeys';

describe('e2e: Generated keys (with CoraDB)', function () {
  this.timeout(20000);

  it('retrieves auto-increment keys via getGeneratedKeys()', function () {
    const client = CoraDB.createConnection(CONFIG);

    return client
      .connect()
      .then(function () {
        log('Connected.');
        return client.execute('DROP TABLE IF EXISTS ' + TABLE);
      })
      .then(function () {
        return client.execute('CREATE TABLE ' + TABLE + ' (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20))');
      })
      .then(function () {
        log('Created table ' + TABLE + ' (id AUTO_INCREMENT, name).');
        // Run the INSERT through query() with generated-keys retention so the
        // server keeps the keys for the follow-up fetch. query() returns the
        // query handle needed by getGeneratedKeys().
        return client.query(
          "INSERT INTO " + TABLE + " (name) VALUES ('alice')",
          undefined,
          undefined,
          { getGeneratedKeys: true }
        );
      })
      .then(function (response) {
        log('Inserted a row; query handle = ' + response.queryHandle);
        expect(response.queryHandle).to.be.a('number').above(0);
        return client.getGeneratedKeys(response.queryHandle).then(function (keys) {
          // The INSERT's handle stays open until it is closed.
          return client.closeQuery(response.queryHandle).then(function () { return keys; });
        });
      })
      .then(function (keys) {
        log('Generated keys:');
        const rows = resultRows(keys);
        printTable(rows);

        expect(rows).to.have.length(1);
        // The single generated key is the new auto-increment id.
        const firstKey = Object.values(rows[0])[0];
        expect(firstKey).to.be.a('number').that.is.above(0);

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
