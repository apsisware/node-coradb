'use strict';

const expect = require('chai').expect;
const CoraDB = require('../../');
const testSetup = require('./testSetup');

const CONNECTION_TIMEOUT = 20000;
const SECOND_HOST = '192.168.2.37';

describe('CoraDB', function () {
  describe('createConnection', function () {
    it('should succeed to create and close several client connections', function (done) {
      const config = testSetup.config;
      let closedCount = 0;

      // Create a connection by passing a list of parameters.
      const client1 = new CoraDB.createCoraDBConnection(config.hosts, config.port, config.user, config.password, config.database, undefined, undefined, config.logger);

      // Create a connection by passing an object of parameters.
      const client2 = new CoraDB.createCoraDBConnection({
        host: config.hosts,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database
      });

      // Now test the alias function.
      // Create a connection by passing a list of parameters.
      const client3 = new CoraDB.createConnection(config.hosts, config.port, config.user, config.password, config.database);

      // Create a connection by passing an object of parameters.
      const client4 = new CoraDB.createConnection({
        hosts: config.hosts,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database
      });

      // Default `host`, `port`, `user`, `password`, and `database`
      // values should be used when not provided.
      const client5 = new CoraDB.createConnection();

      // Create a connection by passing an object of parameters.
      const client6 = new CoraDB.createConnection({
        hosts: config.hosts,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectionTimeout: CONNECTION_TIMEOUT,
        maxConnectionRetryCount: 2,
      });

      // Ensure the options reached the client.
      expect(client6)
        .to.have.property('connectionTimeout')
        .to.equal(CONNECTION_TIMEOUT);

      expect(client6)
        .to.have.property('maxConnectionRetryCount')
        .to.equal(2);

      expect(client6)
        .to.have.property('hosts')
        .to.be.an('array')
        .with.length(1);

      const clients = [client1, client2, client3, client4, client5, client6];

      let promise = Promise.resolve();

      clients.forEach(client => {
        promise = promise.then(() => {
          return client
            .connect()
            .then(() => {
              return client.getEngineVersion();
            })
            .then(version => {
              client.logger.debug('Client version: ' + version);
              return client.close();
            })
            .catch(err => {
              if ((config.host === err.address) && (config.port === err.port) && (err.code === 'ECONNREFUSED')) {
                throw err;
              }
            })
            .then(() => {
              ++closedCount;
            });
        });
      });

      promise
        .then(() => {
          expect(closedCount).to.equal(clients.length);

          done();
        })
        .catch(done);
    });

    it('should auto connect to the second host when the first host is down', function () {
      const config = testSetup.config;

      const client = new CoraDB.createConnection({
        hosts: ['localhost'].concat(SECOND_HOST),
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectionTimeout: CONNECTION_TIMEOUT,
        maxConnectionRetryCount: 2,
      });

      // Ensure the options reached the client.
      expect(client)
        .to.have.property('connectionTimeout')
        .to.equal(CONNECTION_TIMEOUT);

      expect(client)
        .to.have.property('maxConnectionRetryCount')
        .to.equal(2);

      expect(client)
        .to.have.property('hosts')
        .to.be.an('array')
        .with.length(2);

      return client
        .connect()
        .then(() => {
          return client.getActiveHost();
        })
        .then(host => {
          expect(host)
            .to.be.an('object')
            .to.have.property('host')
            .to.be.a('string')
            .to.equal(config.hosts[0]);

          expect(host)
            .to.have.property('port')
            .to.be.a('number')
            .to.equal(config.port);

          return client.close();
        });
    });

    it('should auto connect to the second host when custom port is contained in hosts and first host is down', function () {
      const config = testSetup.config;
      // const hosts = `${config.hosts}:${config.port}`;

      const client = new CoraDB.createConnection({
        hosts: ['localhost'].concat(`${SECOND_HOST}:33000`),
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectionTimeout: CONNECTION_TIMEOUT,
        maxConnectionRetryCount: 2,
      });

      // Ensure the options reached the client.
      expect(client)
        .to.have.property('connectionTimeout')
        .to.equal(CONNECTION_TIMEOUT);

      expect(client)
        .to.have.property('maxConnectionRetryCount')
        .to.equal(2);

      expect(client)
        .to.have.property('hosts')
        .to.be.an('array')
        .with.length(2);

      return client
        .connect()
        .then(() => {
          return client.getActiveHost();
        })
        .then(host => {
          expect(host)
            .to.be.an('object')
            .to.have.property('host')
            .to.be.a('string')
            .to.equal(config.hosts[0]);

          expect(host)
            .to.have.property('port')
            .to.be.a('number')
            .to.equal(config.port);

          return client.close();
        });
    });
  });
});
