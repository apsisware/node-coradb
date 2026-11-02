'use strict';

// End-to-end scenario: isValid() reports true on a live connection (via a
// CHECK_CAS round-trip) and false once the connection is closed.
// Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, toError, log } = require('./helpers');

describe('e2e: isValid / CHECK_CAS (with CoraDB)', function () {
  this.timeout(20000);

  it('returns true while connected and false after close', function () {
    const client = CoraDB.createConnection(CONFIG);

    return client
      .connect()
      .then(function () {
        log('Connected.');
        return client.isValid();
      })
      .then(function (valid) {
        log('isValid() while connected: ' + valid);
        expect(valid).to.equal(true);
        return client.close();
      })
      .then(function () {
        log('Closed.');
        return client.isValid();
      })
      .then(function (valid) {
        log('isValid() after close: ' + valid);
        expect(valid).to.equal(false);
      })
      .catch(function (err) {
        return Promise.resolve()
          .then(function () { return client.close(); })
          .catch(function () { /* ignore */ })
          .then(function () { throw toError(err); });
      });
  });
});
