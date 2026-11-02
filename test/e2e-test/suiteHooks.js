'use strict';

/*
 * Root hooks of the e2e suite (loaded with `mocha --require`, see the
 * `test:e2e` script): before the first scenario and after the last one, every
 * table the scenarios create for themselves is dropped, so the suite starts on
 * the official olympics1988-2004 schema and leaves it as it found it, even after
 * a run that stopped half way. Self-contained, like the scenarios: it does not
 * use the db-tests' testSetup.
 */

const CoraDB = require('../../');
const { CONFIG } = require('./helpers');

// The tables the e2e scenarios create (test_*.js in this folder).
const E2E_TABLES = ['test1', 'test_coll', 'test_genkeys', 'test_multi_results'];

function dropE2eTables() {
  const client = CoraDB.createConnection(CONFIG);

  this.timeout(20000);

  return client
    .execute(E2E_TABLES.map((name) => `DROP TABLE IF EXISTS ${name}`))
    .then(() => client.close(), (err) => client.close().then(() => {
      throw err;
    }));
}

exports.E2E_TABLES = E2E_TABLES;

exports.mochaHooks = {
  beforeAll: dropE2eTables,
  afterAll: dropE2eTables,
};
