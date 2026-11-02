'use strict';

const path = require('node:path');
const rootDir = path.resolve(__dirname, '..', '..', '..');
const CoraDB = require(rootDir);
const IndentedLogger = require('./IndentedLogger');

// Connection parameters live in an external JSON file so they can be edited
// without touching any JavaScript. The logger is a live object, so it cannot
// be stored in JSON and is attached here.
const connectionParams = require('./connection.json');

const config = {
  ...connectionParams,
  logger: new IndentedLogger(),
};

exports.config = config;

/*
 * The olympics1988-2004 database (the official CoraDB dataset): 11 tables and
 * 4 views, so `SHOW TABLES` lists 15 names.
 */
exports.TABLE_COUNT = 15;

/*
 * The tables the db-tests create for themselves — not part of the official
 * schema. The suite drops them before it starts and after it ends
 * (suiteHooks.js), and the files that count the tables drop them again before
 * they start (dropLeftoverTestTables). The e2e suite cleans up its own.
 */
const TEST_TABLES = ['tbl_test', 'test_tran', 'ces_temp', 'athletexresult'];

exports.TEST_TABLES = TEST_TABLES;

function createDefaultCoraDBDemodbConnection() {
  return new CoraDB.createCoraDBConnection(config);
}

exports.cleanup = function (tableName) {
  return function cleanup() {
    let client = createDefaultCoraDBDemodbConnection();

    this.timeout(20000);

    return client
      .execute(`DROP TABLE IF EXISTS ${tableName}`)
      .then(() => {
        return client.close();
      });
  };
};

/**
 * Drop every table in TEST_TABLES: the suite hooks (suiteHooks.js) before and
 * after the run, and `before(testSetup.dropLeftoverTestTables)` inside the
 * describe() of the files that count the tables with SHOW TABLES or
 * getSchema(), so they start from the official schema even when run alone.
 */
exports.dropLeftoverTestTables = function dropLeftoverTestTables() {
  const client = createDefaultCoraDBDemodbConnection();

  this.timeout(20000);

  return client
    .execute(TEST_TABLES.map((name) => `DROP TABLE IF EXISTS ${name}`))
    .then(() => client.close());
};

exports.createDefaultCoraDBDemodbConnection = createDefaultCoraDBDemodbConnection;
