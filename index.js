'use strict';

const CoraDBConnection = require('./src/CoraDBConnection');
const Helpers = require('./src/utils/Helpers');
const CASConstants = require('./src/constants/CASConstants');
const errors = require('./src/errors');
const params = require('./src/params');

/**
 * Helper functions
 * @type {*}
 */
exports.Helpers = Helpers;

/**
 * Creates a new CoraDB connection. This function creates a new instance of
 * CoraDBConnection, however doesn't establish actual connection with the
 * broker: the first request does.
 *
 * Takes either the positional arguments below, or one object:
 *
 *   createConnection({ host: 'localhost:33000', user: 'dba', password: '',
 *                      database: 'demodb', connectionTimeout: 5000,
 *                      requestTimeoutMs: 30000, queryTimeout: 60000 })
 *
 * @alias createClient, createConnection
 * @param hosts
 * @param port
 * @param user
 * @param password
 * @param database
 * @param connectionTimeout
 * @param maxConnectionRetryCount
 * @param logger
 * @param requestTimeoutMs default timeout of sql(), stream(), cursor(), prepare()
 * @param queryTimeout server-side statement timeout, in milliseconds (0: none)
 * @return {CoraDBConnection}
 */
exports.createConnection = exports.createCoraDBConnection = function (hosts, port, user, password, database, connectionTimeout, maxConnectionRetryCount, logger, requestTimeoutMs, queryTimeout) {
  return new CoraDBConnection(hosts, port, user, password, database, connectionTimeout, maxConnectionRetryCount, logger, requestTimeoutMs, queryTimeout);
};

/** The connection class, for `instanceof` and for extending. */
exports.CoraDBConnection = CoraDBConnection;

/**
 * What `cursor()` and `prepare()` resolve with, for `instanceof`. Declared in
 * index.d.ts as exports, they were only reachable as
 * `CoraDBConnection.Cursor` / `.PreparedStatement`.
 */
exports.Cursor = CoraDBConnection.Cursor;
exports.PreparedStatement = CoraDBConnection.PreparedStatement;

/** What `executeMulti()` resolves with, for `instanceof`. */
exports.MultiResult = CoraDBConnection.MultiResult;

/** Every protocol constant the driver uses. */
exports.CASConstants = CASConstants;

/** Database parameter ids, for `getDatabaseParameter` / `setDatabaseParameter`. */
exports.DbParam = CoraDBConnection.DB_PARAMS;

/** Schema types, for `getSchema`. */
exports.SchemaType = CASConstants.CoraDBSchemaType;

/**
 * Transaction isolation levels, as `getDatabaseParameter('ISOLATION_LEVEL')`
 * reports them. The three CoraDB uses have names of their own; the raw CAS
 * names are there too.
 */
exports.IsolationLevel = Object.freeze(Object.assign({}, CASConstants.CoraDBIsolationLevel, {
  READ_COMMITTED: CASConstants.CoraDBIsolationLevel.TRAN_REP_CLASS_COMMIT_INSTANCE,
  REPEATABLE_READ: CASConstants.CoraDBIsolationLevel.TRAN_REP_CLASS_REP_INSTANCE,
  SERIALIZABLE: CASConstants.CoraDBIsolationLevel.TRAN_SERIALIZABLE,
}));

const ISOLATION_NAMES = {
  [CASConstants.CoraDBIsolationLevel.TRAN_REP_CLASS_COMMIT_INSTANCE]: 'READ COMMITTED',
  [CASConstants.CoraDBIsolationLevel.TRAN_REP_CLASS_REP_INSTANCE]: 'REPEATABLE READ',
  [CASConstants.CoraDBIsolationLevel.TRAN_SERIALIZABLE]: 'SERIALIZABLE',
};

/** The name of an isolation level number, or undefined for one CoraDB does not use. */
exports.isolationLevelName = function (level) {
  return ISOLATION_NAMES[level];
};

/** CAS data types (CCI_U_TYPE_*). */
exports.DataType = CASConstants.CoraDBDataType;

/** The type names a parameter can be bound as, with `{ type, value }`. */
exports.BINDABLE_TYPES = [...params.BINDABLE_TYPES];

/** Errors: see README, "Errors". */
exports.CoraDBError = errors.CoraDBError;
exports.CoraDBBatchError = errors.CoraDBBatchError;
exports.isRetryable = errors.isRetryable;
