'use strict';

/*
 * Root hooks of the db-test suite (loaded with `mocha --require`, see the
 * `test:db` script): before the first test and after the last one, every table
 * the db-tests create for themselves is dropped. The suite starts on the
 * official olympics1988-2004 schema and leaves it as it found it, whatever an
 * earlier run that stopped half way left behind.
 */

const testSetup = require('./index');

function dropTestTables() {
  return testSetup.dropLeftoverTestTables.call(this);
}

exports.mochaHooks = {
  beforeAll: dropTestTables,
  afterAll: dropTestTables,
};
