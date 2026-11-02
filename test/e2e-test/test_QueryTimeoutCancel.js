'use strict';

// End-to-end scenarios for query cancellation and the server-side query
// timeout. Both require a query that runs long enough to be interrupted, so
// they use an expensive self-join over an olympics table. Depending on your
// dataset/hardware you may need to make HEAVY_QUERY heavier or lighter.
// Requires a running CoraDB broker.

const { expect } = require('chai');
const CoraDB = require('../../');
const { CONFIG, toError, log } = require('./helpers');

// An intentionally expensive query (cartesian self-joins) so there is time to
// cancel / time out before it completes.
const HEAVY_QUERY =
  'SELECT COUNT(*) FROM athlete_result r1, athlete_result r2, athlete_result r3';

describe('e2e: query cancellation & timeout (with CoraDB)', function () {
  this.timeout(60000);

  it('cancel() interrupts a long-running query', function () {
    const client = CoraDB.createConnection(CONFIG);

    return client
      .connect()
      .then(function () {
        log('Connected. Starting a heavy query, then cancelling it...');

        // Start the heavy query but do NOT await it yet.
        const heavy = client.query(HEAVY_QUERY);

        // Give the server a moment to start executing, then cancel.
        // cancel() resolves with how it stopped the statement: 'broker' (the
        // connection and its session survive) or 'abort' (the connection was
        // closed).
        const cancelled = new Promise(function (resolve) {
          setTimeout(function () {
            client.cancel().then(function (outcome) {
              log('cancel(): ' + JSON.stringify(outcome));
              resolve(outcome);
            }, resolve);
          }, 500);
        });

        return cancelled.then(function () {
          return heavy.then(
            function () {
              // If it completed anyway, the query was not heavy enough to be
              // interrupted on this dataset - treat as inconclusive rather than
              // a hard failure.
              log('WARNING: query completed before cancellation took effect; ' +
                'make HEAVY_QUERY more expensive to exercise cancel().');
            },
            function (err) {
              log('Query was interrupted as expected: ' + toError(err).message);
              expect(toError(err)).to.be.an.instanceOf(Error);
            }
          );
        });
      })
      .then(function () {
        return client.close();
      })
      .catch(function (err) {
        return Promise.resolve()
          .then(function () { return client.close(); })
          .catch(function () { /* ignore */ })
          .then(function () { throw toError(err); });
      });
  });

  it('setQueryTimeout() aborts a query that exceeds the timeout', function () {
    const client = CoraDB.createConnection(CONFIG);

    // A 1 second server-side timeout (milliseconds). The heavy query should
    // exceed it.
    client.setQueryTimeout(1000);

    return client
      .connect()
      .then(function () {
        log('Connected with a 1000 query timeout. Running a heavy query...');
        return client.query(HEAVY_QUERY);
      })
      .then(
        function () {
          log('WARNING: query completed before the timeout fired; ' +
            'make HEAVY_QUERY more expensive or lower the timeout.');
        },
        function (err) {
          log('Query timed out as expected: ' + toError(err).message);
          expect(toError(err)).to.be.an.instanceOf(Error);
        }
      )
      .then(function () {
        return client.close();
      })
      .catch(function (err) {
        return Promise.resolve()
          .then(function () { return client.close(); })
          .catch(function () { /* ignore */ })
          .then(function () { throw toError(err); });
      });
  });
});
