'use strict';

// End-to-end scenario: connect to a live CoraDB broker, print the connection
// properties, then disconnect. Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, INDENT, toError, log } = require('./helpers');

describe('e2e: BasicConnectDisconnect (with CoraDB)', function () {
  // Connecting to a real broker can take a moment; allow generous time.
  this.timeout(20000);

  it('connects, prints the connection properties, then disconnects', function () {
    const client = CoraDB.createConnection(CONFIG);

    return client
      .connect()
      .then(function () {
        log('Connected.');

        // Step 2: print the connection properties.
        const properties = {
          hosts: client.hosts,
          activeHostIndex: client.currentHostIndex,
          user: client.user,
          database: client.database,
          connectionTimeout: client.connectionTimeout,
          maxConnectionRetryCount: client.maxConnectionRetryCount,
          autoCommitMode: client.autoCommitMode,
          sessionId: client.sessionId,
          // Port the broker assigned for the dedicated CAS (application server)
          // session — distinct from the listener port used to connect.
          'brokerAssignedPort (CAS)': client.connectionBrokerPort,
          // Broker/protocol info negotiated at connect (incl. protocolVersion).
          brokerInfo: client.brokerInfo,
          connectionOpened: client.connectionOpened,
        };

        const rendered = 'CoraDB connection properties: ' + JSON.stringify(properties, null, 2);
        console.log(INDENT + rendered.replaceAll('\n', '\n' + INDENT));

        // Sanity checks that the connection is actually established.
        expect(client.connectionOpened).to.equal(true);
        expect(client.database).to.equal(CONFIG.database);
        expect(client.user).to.equal(CONFIG.user);
      })
      .then(function () {
        // Step 3: disconnect.
        return client.close();
      })
      .then(function () {
        log('Disconnected.');

        expect(client.connectionOpened).to.equal(false);
      })
      .catch(function (err) {
        // Ensure we always attempt to release the socket, even on failure,
        // then re-throw so Mocha reports the original error.
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
