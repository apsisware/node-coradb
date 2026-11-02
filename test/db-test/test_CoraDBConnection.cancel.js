'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

/*
 * Stopping statements and the connection's own state, against the live server
 * (olympics1988-2004): cancel(), abort(), setQueryTimeout(), setRequestTimeout(),
 * canBrokerCancel(), getCasProcessId(), getConnectedHost(), getQueueLength().
 */

// Long enough to be stopped: 1935^3 rows to count.
const HEAVY_QUERY = 'SELECT COUNT(*) AS n FROM athlete_result r1, athlete_result r2, athlete_result r3';

// Set on every connection that runs HEAVY_QUERY, so that the server stops it
// by itself even if a test fails before it does.
const SERVER_BACKSTOP_MS = 15000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a promise settled with: { value } or { error }. */
function settled(promise) {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}

describe('CoraDBConnection', function () {
  this.timeout(60000);

  describe('the connection state', function () {
    it('getConnectedHost() is null until connected, the host after, and null again after close()', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        expect(client.getConnectedHost()).to.equal(null);

        await client.connect();

        const host = client.getConnectedHost();

        expect(host.host).to.equal(testSetup.config.hosts[0]);
        expect(Number(host.port)).to.equal(testSetup.config.port);
        // getActiveHost() names the same one.
        expect(await client.getActiveHost()).to.deep.include({ host: host.host });
      } finally {
        await client.close();
      }

      expect(client.getConnectedHost()).to.equal(null);
    });

    it('getCasProcessId() and canBrokerCancel() come with the login', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        expect(client.getCasProcessId()).to.equal(undefined);
        expect(client.canBrokerCancel()).to.equal(false);

        await client.connect();

        expect(client.getCasProcessId()).to.be.a('number').that.is.above(0);
        expect(client.canBrokerCancel()).to.equal(true);
      } finally {
        await client.close();
      }

      expect(client.canBrokerCancel()).to.equal(false);
    });

    it('getQueueLength() counts the request running and those waiting', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.connect();
        expect(client.getQueueLength()).to.equal(0);
        expect(client.isQueueEmpty()).to.equal(true);

        const requests = [
          client.sql('SELECT 1 AS v'),
          client.sql('SELECT 2 AS v'),
          client.query('SELECT 3 AS v'),
        ];

        expect(client.getQueueLength()).to.equal(3);
        expect(client.getQueueDepth()).to.equal(3);
        expect(client.isQueueEmpty()).to.equal(false);

        const [one, two, three] = await Promise.all(requests);

        expect(one.rows).to.deep.equal([{ v: 1 }]);
        expect(two.rows).to.deep.equal([{ v: 2 }]);
        expect(three.result.ColumnValues).to.deep.equal([[3]]);
        await client.closeQuery(three.queryHandle);

        expect(client.getQueueLength()).to.equal(0);
        expect(client.isQueueEmpty()).to.equal(true);
      } finally {
        await client.close();
      }
    });
  });

  describe('cancel', function () {
    it('stops the running statement through the broker and keeps the connection', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      client.setQueryTimeout(SERVER_BACKSTOP_MS);

      try {
        await client.connect();

        const generation = client._generation;
        const heavy = settled(client.sql(HEAVY_QUERY));

        await delay(500);

        const started = Date.now();
        const outcome = await client.cancel();
        const { error } = await heavy;

        expect(outcome).to.deep.equal({ method: 'broker' });
        expect(error, 'the query should have been stopped').to.be.an.instanceOf(Error);
        expect(Date.now() - started).to.be.below(SERVER_BACKSTOP_MS);

        // The same connection and session.
        expect(client._generation).to.equal(generation);
        expect(client.getConnectedHost()).to.not.equal(null);
        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
        expect(client._generation).to.equal(generation);
      } finally {
        await client.close();
      }
    });

    it('interrupts nothing when onlyWhile() says no', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.connect();

        const generation = client._generation;
        const outcome = await client.cancel({ onlyWhile: () => false });

        expect(outcome).to.deep.equal({ method: 'none' });
        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
        expect(client._generation).to.equal(generation);
      } finally {
        await client.close();
      }
    });

    it('with brokerCancel: false, aborts the connection; the next request reconnects', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      client.setQueryTimeout(SERVER_BACKSTOP_MS);

      try {
        await client.connect();

        const generation = client._generation;
        const heavy = settled(client.sql(HEAVY_QUERY));

        await delay(500);

        const outcome = await client.cancel({ brokerCancel: false });
        const { error } = await heavy;

        expect(outcome).to.deep.equal({ method: 'abort' });
        expect(error).to.be.an.instanceOf(Error);
        expect(error.code).to.equal('ABORTED');
        expect(client.getConnectedHost()).to.equal(null);

        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
        expect(client._generation).to.be.above(generation);
      } finally {
        await client.close();
      }
    });
  });

  describe('abort', function () {
    it('fails the running request and every waiting one with ABORTED; connect() opens it again', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      client.setQueryTimeout(SERVER_BACKSTOP_MS);

      try {
        await client.connect();

        const heavy = settled(client.sql(HEAVY_QUERY));
        const waiting = settled(client.sql('SELECT 1 AS v'));
        const waitingClassic = settled(client.query('SELECT 2 AS v'));

        await delay(500);
        await client.abort('stopped by the test');

        for (const [name, result] of [['running', heavy], ['waiting', waiting], ['waiting classic', waitingClassic]]) {
          const { error } = await result;

          expect(error, name).to.be.an.instanceOf(Error);
          expect(error.code, name).to.equal('ABORTED');
          expect(error.message, name).to.contain('stopped by the test');
        }

        expect(client.getConnectedHost()).to.equal(null);
        expect(client.isQueueEmpty()).to.equal(true);

        await client.connect();
        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
      } finally {
        await client.close();
      }
    });

    it('answers a callback', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.connect();
        await new Promise((resolve, reject) => client.abort((err) => (err ? reject(err) : resolve())));

        expect(client.getConnectedHost()).to.equal(null);
      } finally {
        await client.close();
      }
    });
  });

  describe('setQueryTimeout', function () {
    it('is 0 (none) by default and keeps what it is given in milliseconds', function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      expect(client.getQueryTimeout()).to.equal(0);

      client.setQueryTimeout(1500);
      expect(client.getQueryTimeout()).to.equal(1500);

      client.setQueryTimeout(-1);
      expect(client.getQueryTimeout()).to.equal(0);

      client.setQueryTimeout('soon');
      expect(client.getQueryTimeout()).to.equal(0);
    });

    it('has the server stop a statement that runs longer; the connection stays usable', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.connect();

        const generation = client._generation;

        client.setQueryTimeout(1000);

        const started = Date.now();
        const { error } = await settled(client.sql(HEAVY_QUERY));
        const elapsed = Date.now() - started;

        expect(error, 'the server should have stopped the query').to.be.an.instanceOf(Error);
        expect(error.code).to.be.a('number').that.is.below(0);
        expect(elapsed).to.be.at.least(900);
        expect(elapsed).to.be.below(SERVER_BACKSTOP_MS);

        client.setQueryTimeout(0);

        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
        expect(client._generation).to.equal(generation);
      } finally {
        await client.close();
      }
    });
  });

  describe('setRequestTimeout', function () {
    it('keeps what it is given; 0 or less for none', function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      expect(client.requestTimeoutMs).to.equal(0);

      client.setRequestTimeout(400);
      expect(client.requestTimeoutMs).to.equal(400);

      client.setRequestTimeout(-5);
      expect(client.requestTimeoutMs).to.equal(0);
    });

    it('fails sql() with TIMEOUT and cancels the statement; the connection stays usable', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      client.setQueryTimeout(SERVER_BACKSTOP_MS);

      try {
        await client.connect();

        const generation = client._generation;

        client.setRequestTimeout(500);

        const started = Date.now();
        const { error } = await settled(client.sql(HEAVY_QUERY));

        expect(error).to.be.an.instanceOf(Error);
        expect(error.code).to.equal('TIMEOUT');
        expect(Date.now() - started).to.be.below(5000);

        client.setRequestTimeout(0);

        // Waits for the cancelled statement to end, then runs on the same session.
        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
        expect(client._generation).to.equal(generation);
      } finally {
        await client.close();
      }
    });

    it('limits the classic methods too', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      client.setQueryTimeout(SERVER_BACKSTOP_MS);

      try {
        await client.connect();
        client.setRequestTimeout(500);

        const { error } = await settled(client.query(HEAVY_QUERY));

        expect(error).to.be.an.instanceOf(Error);
        expect(error.code).to.equal('TIMEOUT');

        client.setRequestTimeout(0);

        const { result, queryHandle } = await client.query('SELECT 1 AS v');

        expect(result.ColumnValues).to.deep.equal([[1]]);
        await client.closeQuery(queryHandle);
      } finally {
        await client.close();
      }
    });

    it('a per-call timeoutMs wins over the connection\'s', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      client.setQueryTimeout(SERVER_BACKSTOP_MS);

      try {
        await client.connect();
        client.setRequestTimeout(60000);

        const started = Date.now();
        const { error } = await settled(client.sql(HEAVY_QUERY, { timeoutMs: 500 }));

        expect(error).to.be.an.instanceOf(Error);
        expect(error.code).to.equal('TIMEOUT');
        expect(Date.now() - started).to.be.below(5000);

        expect((await client.sql('SELECT 1 AS v')).rows).to.deep.equal([{ v: 1 }]);
      } finally {
        await client.close();
      }
    });
  });
});
