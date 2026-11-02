'use strict';

const expect = require('chai').expect;
const net = require('node:net');
const CoraDB = require('../../');
const ErrorMessages = require('../../src/constants/ErrorMessages');
const testSetup = require('./testSetup');
const config = testSetup.config;

describe('CoraDBConnection', function () {
  describe('connect', function () {
    describe('to a non-existing database', function () {
      const nonExistingDatabase = 'demodb_xyz';

      let nonExistingDatabaseError = new Error(`Failed to connect to database server, '${nonExistingDatabase}', on the following host(s): localhost:localhost`);
      let nonExistingDatabaseErrorShort = new Error(`Failed to connect to database server, '${nonExistingDatabase}', on the following host(s): localhost`);
      nonExistingDatabaseError.code = -677;

      // const errors = [
      //   // This is the correct message, CoraDB should return when a database is not found.
      //   "-677:Failed to connect to database server, 'demodb_xyz', on the following host(s): localhost:localhost",
      //   // When CoraDB is installed and started as a root, the following error is returned.
      //   // This may be a CoraDB bug or a spec. Need to keep these until we figure out
      //   // whether this is a bug or not.
      //   '-985:The hostname on the database connection string should be specified when multihost is set in "databases.txt".',
      //   On CoraDB the following error might also be returned.
      //   "-985:No error message available."];

      it('should fail to connect to a non-existing database using a callback', function (done) {
        const client = CoraDB.createConnection(config.hosts, config.port, config.user, config.password, nonExistingDatabase, 0, config.maxConnectionRetryCount, config.logger);

        client.connect(function (err) {
          if (err) {
            expect(err).to.be.an.instanceOf(Error);
            // Error `-191` is `ER_NET_CANT_CONNECT_SERVER`
            // Error `-677` is `ER_BO_CONNECT_FAILED`
            expect([-191, -677]).to.include(err.code);

            if (err.code === -191) {
              expect(err.message).to.equal(nonExistingDatabaseErrorShort.message);
            } else {
              expect(err.message).to.equal(nonExistingDatabaseError.message);
            }

            return done();
          }

          done(new Error('The connection should have failed to a non-existing database.'));
        });
      });

      it('should fail to connect to a non-existing database using a promise', function () {
        const client = CoraDB.createConnection(config.hosts, config.port, config.user, config.password, nonExistingDatabase, 0, config.maxConnectionRetryCount, config.logger);

        return client
          .connect()
          .then(() => {
            throw new Error('The connection should have failed due to a non-existing database.');
          })
          .catch(err => {
            expect(err).to.be.an.instanceOf(Error);
            // Error `-191` is `ER_NET_CANT_CONNECT_SERVER`
            // Error `-677` is `ER_BO_CONNECT_FAILED`
            expect([-191, -677]).to.include(err.code);

            if (err.code === -191) {
              expect(err.message).to.equal(nonExistingDatabaseErrorShort.message);
            } else {
              expect(err.message).to.equal(nonExistingDatabaseError.message);
            }
          });
      });
    });

    describe('to a wrong port', function () {
      const connectionTimeout = 5000;
      // Resolved in before() to a port that is guaranteed to be closed.
      let port;

      this.timeout(connectionTimeout * 5);

      before(function (done) {
        // Reserve an ephemeral port and immediately release it. The port is
        // then guaranteed to be closed, so a connection attempt is refused
        // (ECONNREFUSED) - regardless of what may be listening on well-known
        // ports such as 80 on the host machine.
        const server = net.createServer();

        // Bind to loopback only (127.0.0.1). Listening on all interfaces would
        // trigger a Windows Firewall prompt; loopback-only does not.
        server.listen(0, '127.0.0.1', function () {
          port = server.address().port;
          server.close(done);
        });
      });

      it('should fail to connect to an incorrect port using a callback', function (done) {
        const client = CoraDB.createConnection(config.hosts, port, config.user, config.password, config.database, connectionTimeout, config.maxConnectionRetryCount, config.logger);

        client.connect(function (err) {
          expect(err).to.be.an.instanceOf(Error);
          // On multi-address hosts (e.g. 'localhost' -> ::1 and 127.0.0.1),
          // Node wraps the failures in an AggregateError with an empty message
          // but a populated `code`, so assert on the code rather than message.
          expect(err.code).to.equal('ECONNREFUSED');

          done();
        });
      });

      it('should fail to connect to an incorrect port using a promise', function () {
        const client = CoraDB.createConnection(config.hosts, port, config.user, config.password, config.database, connectionTimeout, config.maxConnectionRetryCount, config.logger);

        return client
          .connect()
          .then(() => {
            throw new Error('The connection should have failed.');
          })
          .catch(err => {
            expect(err).to.be.an.instanceOf(Error);
            // See the note above: assert on `code` to also cover AggregateError.
            expect(err.code).to.equal('ECONNREFUSED');
          });
      });
    });

    describe('to a wrong host', function () {
      const host = '80.80.80.80';
      // Kept low so an unreachable host fails fast instead of sitting on a long
      // network timeout (which looks like the test suite is blocked).
      const connectionTimeout = 1500;

      this.timeout(connectionTimeout * 5);

      it('should fail to connect to an incorrect port using a callback', function (done) {
        const client = CoraDB.createConnection(host, config.port, config.user, config.password, config.database, connectionTimeout, config.maxConnectionRetryCount, config.logger);

        client.connect(function (err) {
          expect(err).to.be.an.instanceOf(Error);
          // expect(err.message).to.equal(`connect ECONNREFUSED ${host}:${config.port}`);
          expect(err.message).to.equal(`connect ETIMEDOUT`);
          done();
        });
      });

      it('should fail to connect to an incorrect port using a promise', function () {
        const client = CoraDB.createConnection(host, config.port, config.user, config.password, config.database, connectionTimeout, config.maxConnectionRetryCount, config.logger);

        return client
          .connect()
          .then(() => {
            throw new Error('The connection should have failed.');
          })
          .catch(err => {
            expect(err).to.be.an.instanceOf(Error);
            // expect(err.message).to.equal(`connect ECONNREFUSED ${host}:${config.port}`);
            expect(err.message).to.equal(`connect ETIMEDOUT`);
          });
      });

      it('should fail to connect to a valid but non-CoraDB host within 1.5 seconds', function () {
        const client = new CoraDB.createConnection('www.google.com');
        const newTimeoutValue = 1500;

        client.setConnectionTimeout(newTimeoutValue);
        expect(client.getConnectionTimeout()).to.equal(newTimeoutValue);

        // By default the client will retry the connection one more time
        // if it failed, so the timeout should be increased.
        this.timeout(newTimeoutValue * 3);

        return client
          .connect()
          .then(() => {
            throw new Error('Connection should have failed.');
          })
          .catch(err => {
            expect(err).to.be.an.instanceOf(Error);
            expect(err.message).to.equal(ErrorMessages.ERROR_CONNECTION_TIMEOUT);
            expect(client.connectionOpened).to.be.false;
          });
      });
    });

    describe('when a username is invalid', function () {
      const username = 'unknown_user';
      const connectionTimeout = 5000;
      const errors = [`User "${username}" is invalid.`, 'Your transaction has been aborted by the system due to server failure or mode change.'];

      this.timeout(connectionTimeout * 3);

      it('should fail to connect(callback) when a username is invalid', function (done) {
        const client = CoraDB.createConnection(config.hosts, config.port, username, config.password, config.database, connectionTimeout, config.maxConnectionRetryCount, config.logger);

        client.connect(function (err) {
          expect(err).to.be.an.instanceOf(Error);
          expect(err.code).to.equal(-165);
          expect(errors).to.include(err.message);

          done();
        });
      });

      it('should fail to connect() when a username is invalid', function () {
        const client = CoraDB.createConnection(config.hosts, config.port, username, config.password, config.database, connectionTimeout, config.maxConnectionRetryCount, config.logger);

        return client
          .connect()
          .then(() => {
            throw new Error('The connection should have failed.');
          })
          .catch(err => {
            expect(err).to.be.an.instanceOf(Error);
            expect(err.code).to.equal(-165);
            expect(errors).to.include(err.message);
          });
      });
    });

    describe('to a valid server', function () {
      it('should succeed to connect to a valid server using a callback', function (done) {
        const client = testSetup.createDefaultCoraDBDemodbConnection();

        client.connect(function (err) {
          if (err) {
            return done(err);
          }

          client.close(done);
        });
      });

      it('should succeed to connect to a valid server using a promise', function () {
        const client = testSetup.createDefaultCoraDBDemodbConnection();

        return client
          .connect()
          .then(() => {
            return client.close();
          });
      });

      // A second connect() while the first is in progress no longer fails
      // with CONNECTION_ALREADY_PENDING: it waits for the first and shares
      // its outcome (see CHANGELOG).
      it('should share the connection in progress when connect() is called a second time while the first is pending', function () {
        const client = testSetup.createDefaultCoraDBDemodbConnection();

        const first = client.connect();

        expect(client.connectionPending).to.be.true;

        return Promise.all([first, client.connect()])
          .then(() => {
            expect(client.connectionOpened).to.be.true;
            expect(client.connectionPending).to.be.false;

            return client.close();
          });
      });

      it('should share the connection in progress when connect(callback) is called a second time while the first is pending', function (done) {
        const client = testSetup.createDefaultCoraDBDemodbConnection();

        this.timeout(3000);

        client.connect();

        client.connect(function (err) {
          if (err) {
            return done(err);
          }

          try {
            expect(client.connectionOpened).to.be.true;
          } catch (assertionError) {
            return done(assertionError);
          }

          client.close(done);
        });
      });

      it('should succeed to call connect() as a promise second time if the first connection request is completed, i.e. opened', function () {
        const client = testSetup.createDefaultCoraDBDemodbConnection();

        return client
          .connect()
          .then(() => {
            return client.connect();
          });
      });

      it('should succeed to call connect(callback) second time if the first connection request is completed, i.e. opened', function (done) {
        const client = testSetup.createDefaultCoraDBDemodbConnection();

        client.connect(function (err) {
          if (err) {
            return done(err);
          }

          client.connect(done);
        });
      });
    });
  });
});
