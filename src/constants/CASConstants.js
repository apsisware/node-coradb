'use strict';
/**
 * Define CoraDB Function codes constants
 */
exports.CASFunctionCode = {
  CAS_FC_END_TRAN: 1,
  CAS_FC_PREPARE: 2,
  CAS_FC_EXECUTE: 3,
  CAS_FC_GET_DB_PARAMETER: 4,
  CAS_FC_SET_DB_PARAMETER: 5,
  CAS_FC_CLOSE_REQ_HANDLE: 6,
  CAS_FC_CURSOR: 7,
  CAS_FC_FETCH: 8,
  CAS_FC_SCHEMA_INFO: 9,
  CAS_FC_OID_GET: 10,
  CAS_FC_OID_PUT: 11,
  CAS_FC_DEPRECATED1: 12,
  CAS_FC_DEPRECATED2: 13,
  CAS_FC_DEPRECATED3: 14,
  CAS_FC_GET_DB_VERSION: 15,
  CAS_FC_GET_CLASS_NUM_OBJS: 16,
  CAS_FC_OID_CMD: 17,
  CAS_FC_COLLECTION: 18,
  CAS_FC_NEXT_RESULT: 19,
  CAS_FC_EXECUTE_BATCH: 20,
  CAS_FC_EXECUTE_ARRAY: 21,
  CAS_FC_CURSOR_UPDATE: 22,
  CAS_FC_GET_ATTR_TYPE_STR: 23,
  CAS_FC_GET_QUERY_INFO: 24,
  CAS_FC_DEPRECATED4: 25,
  CAS_FC_SAVEPOINT: 26,
  CAS_FC_PARAMETER_INFO: 27,
  CAS_FC_XA_PREPARE: 28,
  CAS_FC_XA_RECOVER: 29,
  CAS_FC_XA_END_TRAN: 30,
  CAS_FC_CON_CLOSE: 31,
  CAS_FC_CHECK_CAS: 32,
  CAS_FC_MAKE_OUT_RS: 33,
  CAS_FC_GET_GENERATED_KEYS: 34,
  CAS_FC_LOB_NEW: 35,
  CAS_FC_LOB_WRITE: 36,
  CAS_FC_LOB_READ: 37,
  CAS_FC_END_SESSION: 38,
  CAS_FC_GET_ROW_COUNT: 39,
  CAS_FC_GET_LAST_INSERT_ID: 40,
  CAS_FC_PREPARE_AND_EXECUTE: 41,
  CAS_FC_CURSOR_CLOSE: 42,
  CAS_FC_GET_SHARD_INFO: 43,
  CAS_FC_CAS_CHANGE_MODE: 44,
  CAS_FC_MAX: 45,
  // function code list of protocol version V2
  CAS_FC_CURSOR_CLOSE_FOR_PROTO_V2: 41,
  CAS_FC_PREPARE_AND_EXECUTE_FOR_PROTO_V2: 42
};

/**
 * Define CoraDB Statement types constants
 */
exports.CoraDBStatementType = {
  CORADB_STMT_ALTER_CLASS: 0,
  CORADB_STMT_ALTER_SERIAL: 1,
  CORADB_STMT_COMMIT_WORK: 2,
  CORADB_STMT_REGISTER_DATABASE: 3,
  CORADB_STMT_CREATE_CLASS: 4,
  CORADB_STMT_CREATE_INDEX: 5,
  CORADB_STMT_CREATE_TRIGGER: 6,
  CORADB_STMT_CREATE_SERIAL: 7,
  CORADB_STMT_DROP_DATABASE: 8,
  CORADB_STMT_DROP_CLASS: 9,
  CORADB_STMT_DROP_INDEX: 10,
  CORADB_STMT_DROP_LABEL: 11,
  CORADB_STMT_DROP_TRIGGER: 12,
  CORADB_STMT_DROP_SERIAL: 13,
  CORADB_STMT_EVALUATE: 14,
  CORADB_STMT_RENAME_CLASS: 15,
  CORADB_STMT_ROLLBACK_WORK: 16,
  CORADB_STMT_GRANT: 17,
  CORADB_STMT_REVOKE: 18,
  CORADB_STMT_STATISTICS: 19,
  CORADB_STMT_INSERT: 20,
  CORADB_STMT_SELECT: 21,
  CORADB_STMT_UPDATE: 22,
  CORADB_STMT_DELETE: 23,
  CORADB_STMT_CALL: 24,
  CORADB_STMT_GET_ISO_LVL: 25,
  CORADB_STMT_GET_TIMEOUT: 26,
  CORADB_STMT_GET_OPT_LVL: 27,
  CORADB_STMT_SET_OPT_LVL: 28,
  CORADB_STMT_SCOPE: 29,
  CORADB_STMT_GET_TRIGGER: 30,
  CORADB_STMT_SET_TRIGGER: 31,
  CORADB_STMT_SAVEPOINT: 32,
  CORADB_STMT_PREPARE: 33,
  CORADB_STMT_ATTACH: 34,
  CORADB_STMT_USE: 35,
  CORADB_STMT_REMOVE_TRIGGER: 36,
  CORADB_STMT_RENAME_TRIGGER: 37,
  CORADB_STMT_ON_LDB: 38,
  CORADB_STMT_GET_LDB: 39,
  CORADB_STMT_SET_LDB: 40,
  CORADB_STMT_GET_STATS: 41,
  CORADB_STMT_CREATE_USER: 42,
  CORADB_STMT_DROP_USER: 43,
  CORADB_STMT_ALTER_USER: 44,
  CORADB_STMT_CALL_SP: 0x7e,
  CORADB_STMT_UNKNOWN: 0x7f
};

/**
 * Define CoraDB Isolation levels constants
 */
exports.CoraDBIsolationLevel = {
  TRAN_UNKNOWN_ISOLATION: 0x00,
  TRAN_COMMIT_CLASS_UNCOMMIT_INSTANCE: 0x01,
  TRAN_COMMIT_CLASS_COMMIT_INSTANCE: 0x02,
  TRAN_REP_CLASS_UNCOMMIT_INSTANCE: 0x03,
  TRAN_REP_CLASS_COMMIT_INSTANCE: 0x04,
  TRAN_REP_CLASS_REP_INSTANCE: 0x05,
  TRAN_SERIALIZABLE: 0x06,
  TRAN_DEFAULT_ISOLATION: 0x01
};

/**
 * Define CoraDB Data types constants
 */
exports.CoraDBDataType = {
  CCI_U_TYPE_UNKNOWN: 0,
  CCI_U_TYPE_NULL: 0,
  CCI_U_TYPE_CHAR: 1,
  CCI_U_TYPE_STRING: 2,
  CCI_U_TYPE_NCHAR: 3,
  CCI_U_TYPE_VARNCHAR: 4,
  CCI_U_TYPE_BIT: 5,
  CCI_U_TYPE_VARBIT: 6,
  CCI_U_TYPE_NUMERIC: 7,
  CCI_U_TYPE_INT: 8,
  CCI_U_TYPE_SHORT: 9,
  CCI_U_TYPE_MONETARY: 10,
  CCI_U_TYPE_FLOAT: 11,
  CCI_U_TYPE_DOUBLE: 12,
  CCI_U_TYPE_DATE: 13,
  CCI_U_TYPE_TIME: 14,
  CCI_U_TYPE_TIMESTAMP: 15,
  CCI_U_TYPE_SET: 16,
  CCI_U_TYPE_MULTISET: 17,
  CCI_U_TYPE_SEQUENCE: 18,
  CCI_U_TYPE_OBJECT: 19,
  CCI_U_TYPE_RESULTSET: 20,
  CCI_U_TYPE_BIGINT: 21,
  CCI_U_TYPE_DATETIME: 22,
  CCI_U_TYPE_BLOB: 23,
  CCI_U_TYPE_CLOB: 24,
  CCI_U_TYPE_ENUM: 25,
  CCI_U_TYPE_TIMESTAMPTZ: 29,
  CCI_U_TYPE_TIMESTAMPLTZ: 30,
  CCI_U_TYPE_DATETIMETZ: 31,
  CCI_U_TYPE_DATETIMELTZ: 32,

  // Disabled type: CCI_U_TYPE_TIMETZ; internal use only - RESERVED
  CCI_U_TYPE_TIMETZ: 33,

  CCI_U_TYPE_JSON: 34,
  CCI_U_TYPE_GRAPH_OBJECT: 35
};

/**
 * The bits of a column's type byte, as the CAS sends it.
 *
 * Protocol V7 and later send two bytes when the first has HAS_2_BYTES set: the
 * first carries the collection kind (bits 6-5) and the charset of a string
 * column (bits 2-0), the second the type — or, for a collection, the type of
 * its elements. Earlier protocols send one byte: the collection kind in bits
 * 6-5 and the type in bits 4-0, the way the JDBC driver reads it.
 */
exports.ColumnTypeMask = {
  HAS_2_BYTES: 0x80,
  COLLECTION: 0x60,
  CHARSET: 0x07,
  TYPE: 0x1F,
};

/** The collection kinds (the type byte masked with `ColumnTypeMask.COLLECTION`). */
exports.CollectionFlag = {
  SET: 0x20,
  MULTISET: 0x40,
  SEQUENCE: 0x60,
};

/** The server's charset ids (the low 3 bits of a two-byte type). */
exports.CharsetId = {
  ASCII: 0,
  RAW_BITS: 1,
  BINARY: 2,
  ISO8859_1: 3,
  EUC_KR: 4,
  UTF8: 5,
};

/**
 * The Node.js encoding a string of this charset is decoded with.
 *
 * ISO-8859-1 and BINARY are decoded as Latin-1, one character per byte (a
 * BINARY value comes back whole with `Buffer.from(value, 'latin1')`). ASCII is
 * decoded as UTF-8, which reads true ASCII identically and does not mangle the
 * UTF-8 bytes a server may label ASCII. EUC-KR has no decoder built into
 * Node.js and is read as UTF-8; so is anything unknown.
 *
 * @param charsetId
 * @returns {string} a `Buffer.toString()` encoding
 */
exports.getCharsetEncoding = function (charsetId) {
  switch (charsetId) {
    case exports.CharsetId.BINARY:
    case exports.CharsetId.ISO8859_1:
      return 'latin1';
    default:
      return 'utf8';
  }
};

/**
 * A column's type and, for a SET, MULTISET or SEQUENCE, the type of its
 * elements, from the collection bits and the type the CAS sent.
 *
 * @param collectionFlag the type byte masked with `ColumnTypeMask.COLLECTION`
 * @param baseType the type (or element type)
 * @returns {{columnType: number, elementType: number}}
 */
exports.confirmColumnType = function (collectionFlag, baseType) {
  switch (collectionFlag) {
    case exports.CollectionFlag.SET:
      return { columnType: exports.CoraDBDataType.CCI_U_TYPE_SET, elementType: baseType };
    case exports.CollectionFlag.MULTISET:
      return { columnType: exports.CoraDBDataType.CCI_U_TYPE_MULTISET, elementType: baseType };
    case exports.CollectionFlag.SEQUENCE:
      return { columnType: exports.CoraDBDataType.CCI_U_TYPE_SEQUENCE, elementType: baseType };
    default:
      return { columnType: baseType, elementType: exports.CoraDBDataType.CCI_U_TYPE_UNKNOWN };
  }
};

/**
 * Convert data type number to data type name
 */
exports.getCoraDBDataTypeName = function (type) {
  switch (type) {
    case exports.CoraDBDataType.CCI_U_TYPE_CHAR:
      return 'Char';
    case exports.CoraDBDataType.CCI_U_TYPE_NCHAR:
      return 'NChar';
    case exports.CoraDBDataType.CCI_U_TYPE_STRING:
      return 'String';
    case exports.CoraDBDataType.CCI_U_TYPE_VARNCHAR:
      return 'VarNchar';
    case exports.CoraDBDataType.CCI_U_TYPE_SHORT:
      return 'Short';
    case exports.CoraDBDataType.CCI_U_TYPE_INT:
      return 'Int';
    case exports.CoraDBDataType.CCI_U_TYPE_BIGINT:
      return 'Bigint';
    case exports.CoraDBDataType.CCI_U_TYPE_FLOAT:
      return 'Float';
    case exports.CoraDBDataType.CCI_U_TYPE_DOUBLE:
      return 'Double';
    case exports.CoraDBDataType.CCI_U_TYPE_MONETARY:
      return 'Monetary';
    case exports.CoraDBDataType.CCI_U_TYPE_NUMERIC:
      return 'Numeric';
    case exports.CoraDBDataType.CCI_U_TYPE_DATE:
      return 'Date';
    case exports.CoraDBDataType.CCI_U_TYPE_TIME:
      return 'Time';
    case exports.CoraDBDataType.CCI_U_TYPE_DATETIME:
      return 'DateTime';
    case exports.CoraDBDataType.CCI_U_TYPE_TIMESTAMP:
      return 'Timestamp';
    case exports.CoraDBDataType.CCI_U_TYPE_OBJECT:
      return 'Object';
    case exports.CoraDBDataType.CCI_U_TYPE_BIT:
      return 'Bit';
    case exports.CoraDBDataType.CCI_U_TYPE_VARBIT:
      return 'Varbit';
    case exports.CoraDBDataType.CCI_U_TYPE_SET:
      return 'Set';
    case exports.CoraDBDataType.CCI_U_TYPE_MULTISET:
      return 'Multiset';
    case exports.CoraDBDataType.CCI_U_TYPE_SEQUENCE:
      return 'Sequence';
    case exports.CoraDBDataType.CCI_U_TYPE_BLOB:
      return 'Blob';
    case exports.CoraDBDataType.CCI_U_TYPE_CLOB:
      return 'Clob';
    case exports.CoraDBDataType.CCI_U_TYPE_ENUM:
      return 'ENUM';
    case exports.CoraDBDataType.CCI_U_TYPE_RESULTSET:
      return 'Resultset';
    case exports.CoraDBDataType.CCI_U_TYPE_TIMESTAMPTZ:
      return 'TimestampTz';
    case exports.CoraDBDataType.CCI_U_TYPE_TIMESTAMPLTZ:
      return 'TimestampLtz';
    case exports.CoraDBDataType.CCI_U_TYPE_DATETIMETZ:
      return 'DateTimeTz';
    case exports.CoraDBDataType.CCI_U_TYPE_DATETIMELTZ:
      return 'DateTimeLtz';
    case exports.CoraDBDataType.CCI_U_TYPE_JSON:
      return 'Json';
    case exports.CoraDBDataType.CCI_U_TYPE_GRAPH_OBJECT:
      return 'GraphObject';
    default:
      return 'UNKNOWN';
  }
};

/**
 * Convert data type name to data type number
 */
exports.getCoraDBDataTypeNumber = function (type) {
  // A type number is taken as it is, when it is one; anything that is not a
  // string or a known number is unknown rather than a TypeError.
  if (typeof type === 'number') {
    return Object.values(this.CoraDBDataType).includes(type) ? type : exports.CoraDBDataType.CCI_U_TYPE_UNKNOWN;
  }

  if (typeof type !== 'string') {
    return exports.CoraDBDataType.CCI_U_TYPE_UNKNOWN;
  }

  type = type.toLowerCase();
  switch (type) {
    case 'char':
      return exports.CoraDBDataType.CCI_U_TYPE_CHAR;
    case 'varchar':
      return exports.CoraDBDataType.CCI_U_TYPE_STRING;
    case 'nchar':
      return exports.CoraDBDataType.CCI_U_TYPE_NCHAR;
    case 'string':
      return exports.CoraDBDataType.CCI_U_TYPE_STRING;
    case 'varnchar':
      return exports.CoraDBDataType.CCI_U_TYPE_VARNCHAR;
    case 'short':
      return exports.CoraDBDataType.CCI_U_TYPE_SHORT;
    case 'int':
      return exports.CoraDBDataType.CCI_U_TYPE_INT;
    case 'bigint':
      return exports.CoraDBDataType.CCI_U_TYPE_BIGINT;
    case 'float':
      return exports.CoraDBDataType.CCI_U_TYPE_FLOAT;
    case 'double':
      return exports.CoraDBDataType.CCI_U_TYPE_DOUBLE;
    case 'monetary':
      return exports.CoraDBDataType.CCI_U_TYPE_MONETARY;
    case 'numeric':
      return exports.CoraDBDataType.CCI_U_TYPE_NUMERIC;
    case 'date':
      return exports.CoraDBDataType.CCI_U_TYPE_DATE;
    case 'time':
      return exports.CoraDBDataType.CCI_U_TYPE_TIME;
    case 'datetime':
      return exports.CoraDBDataType.CCI_U_TYPE_DATETIME;
    case 'timestamp':
      return exports.CoraDBDataType.CCI_U_TYPE_TIMESTAMP;
    case 'object':
      return exports.CoraDBDataType.CCI_U_TYPE_OBJECT;
    case 'bit':
      return exports.CoraDBDataType.CCI_U_TYPE_BIT;
    case 'varbit':
      return exports.CoraDBDataType.CCI_U_TYPE_VARBIT;
    case 'set':
      return exports.CoraDBDataType.CCI_U_TYPE_SET;
    case 'multiset':
      return exports.CoraDBDataType.CCI_U_TYPE_MULTISET;
    case 'sequence':
      return exports.CoraDBDataType.CCI_U_TYPE_SEQUENCE;
    case 'blob':
      return exports.CoraDBDataType.CCI_U_TYPE_BLOB;
    case 'clob':
      return exports.CoraDBDataType.CCI_U_TYPE_CLOB;
    case 'resultset':
      return exports.CoraDBDataType.CCI_U_TYPE_RESULTSET;
    case 'timestamptz':
      return exports.CoraDBDataType.CCI_U_TYPE_TIMESTAMPTZ;
    case 'timestampltz':
      return exports.CoraDBDataType.CCI_U_TYPE_TIMESTAMPLTZ;
    case 'datetimetz':
      return exports.CoraDBDataType.CCI_U_TYPE_DATETIMETZ;
    case 'datetimeltz':
      return exports.CoraDBDataType.CCI_U_TYPE_DATETIMELTZ;
    case 'json':
      return exports.CoraDBDataType.CCI_U_TYPE_JSON;
    case 'graphobject':
      return exports.CoraDBDataType.CCI_U_TYPE_GRAPH_OBJECT;
    default:
      return exports.CoraDBDataType.CCI_U_TYPE_UNKNOWN;
  }
};

/**
 * Define CoraDB Schema type constants
 */
exports.CoraDBSchemaType = {
  CCI_SCH_CLASS: 1,
  CCI_SCH_VCLASS: 2,
  CCI_SCH_QUERY_SPEC: 3,
  CCI_SCH_ATTRIBUTE: 4,
  CCI_SCH_CLASS_ATTRIBUTE: 5,
  CCI_SCH_METHOD: 6,
  CCI_SCH_CLASS_METHOD: 7,
  CCI_SCH_METHOD_FILE: 8,
  CCI_SCH_SUPERCLASS: 9,
  CCI_SCH_SUBCLASS: 10,
  CCI_SCH_CONSTRAINT: 11,
  CCI_SCH_TRIGGER: 12,
  CCI_SCH_CLASS_PRIVILEGE: 13,
  CCI_SCH_ATTR_PRIVILEGE: 14,
  CCI_SCH_DIRECT_SUPER_CLASS: 15,
  CCI_SCH_PRIMARY_KEY: 16,
  CCI_SCH_IMPORTED_KEYS: 17,
  CCI_SCH_EXPORTED_KEYS: 18,
  CCI_SCH_CROSS_REFERENCE: 19
};

/**
 * Decode a CoraDBSchemaType value (e.g. 4) into its constant name
 * (e.g. 'CCI_SCH_ATTRIBUTE').
 * @param schemaType
 * @returns {string}
 */
exports.getCoraDBSchemaTypeName = function (schemaType) {
  const names = Object.keys(exports.CoraDBSchemaType);

  for (let i = 0; i < names.length; ++i) {
    if (exports.CoraDBSchemaType[names[i]] === schemaType) {
      return names[i];
    }
  }

  return 'Unknown (' + schemaType + ')';
};

/**
 * Decode the `type` value returned for a class in a CCI_SCH_CLASS /
 * CCI_SCH_VCLASS schema result into a human-readable name.
 * @param type
 * @returns {string}
 */
exports.getCoraDBClassTypeName = function (type) {
  // As the JDBC driver reads them (getTables): 0 system table or view,
  // 1 view, 2 table. A view used to be named 'Unknown (1)'.
  switch (type) {
    case 0:
      return 'System class/view';
    case 1:
      return 'User view';
    case 2:
      return 'User class/view';
    default:
      return 'Unknown (' + type + ')';
  }
};

/**
 * Define CoraDB Prepare statement constants
 */
exports.CCIPrepareOption = {
  CCI_PREPARE_NORMAL: 0x00,
  CCI_PREPARE_INCLUDE_OID: 0x01,
  CCI_PREPARE_UPDATABLE: 0x02,
  CCI_PREPARE_QUERY_INFO: 0x04,
  CCI_PREPARE_HOLDABLE: 0x08,
  // Prepare again after CAS_ER_STMT_POOLING with the plan pinned in the cache
  // (protocol V7 and later), as the JDBC driver does.
  CCI_PREPARE_XASL_CACHE_PINNED: 0x10,
  CCI_PREPARE_CALL: 0x40
};

/**
 * Define CoraDB OID commands constants
 */
exports.OidCommand = {
  DROP_BY_OID: 1,
  IS_INSTANCE: 2,
  GET_READ_LOCK_BY_OID: 3,
  GET_WRITE_LOCK_BY_OID: 4,
  GET_CLASS_NAME_BY_OID: 5
};

/**
 * Define CoraDB Transaction type constants
 */
exports.CCITransactionType = {
  CCI_TRAN_COMMIT: 1,
  CCI_TRAN_ROLLBACK: 2
};

/**
 * Define CoraDB Database parameters constants
 */
exports.CCIDbParam = {
  CCI_PARAM_ISOLATION_LEVEL: 1,
  CCI_PARAM_LOCK_TIMEOUT: 2,
  CCI_PARAM_MAX_STRING_LENGTH: 3,
  CCI_PARAM_AUTO_COMMIT: 4
};

/**
 * Define CoraDB Collection-related commands constants
 */
exports.CoraDBCollectionCommand = {
  GET_COLLECTION_VALUE: 1,
  GET_SIZE_OF_COLLECTION: 2,
  DROP_ELEMENT_IN_SET: 3,
  ADD_ELEMENT_TO_SET: 4,
  DROP_ELEMENT_IN_SEQUENCE: 5,
  INSERT_ELEMENT_INTO_SEQUENCE: 6,
  PUT_ELEMENT_ON_SEQUENCE: 7
};

/**
 * Define CoraDB Connection status constants
 */
exports.ConnectionStatus = {
  CON_STATUS_OUT_TRAN: 0,
  CON_STATUS_IN_TRAN: 1,
  CON_STATUS_CLOSE: 2,
  CON_STATUS_CLOSE_AND_CONNECT: 3
};

/**
 * Define CoraDB Cursor position constants
 */
exports.CCICursorPosition = {
  CCI_CURSOR_FIRST: 0,
  CCI_CURSOR_CURRENT: 1,
  CCI_CURSOR_LAST: 2
};

/**
 * Define CoraDB Statement execution type constants
 */
exports.StmtType = {
  NORMAL: 0,
  GET_BY_OID: 1,
  GET_SCHEMA_INFO: 2,
  GET_AUTOINCREMENT_KEYS: 3
};

/**
 * Define CoraDB Query execution constants
 */
exports.QueryExecutionMode = {
  SYNC_EXEC: 0,
  ASYNC_EXEC: 1
};

/**
 * Define CoraDB Statement execution constants
 */
exports.CCIExecutionOption = {
  CCI_EXEC_NORMAL: 0x00,
  CCI_EXEC_ASYNC: 0x01,
  CCI_EXEC_QUERY_ALL: 0x02,
  CCI_EXEC_QUERY_INFO: 0x04,
  CCI_EXEC_ONLY_QUERY_PLAN: 0x08,
  CCI_EXEC_THREAD: 0x10,
  CCI_EXEC_HOLDABLE: 0x20,
  // Keep the keys an INSERT generates, for a GET_GENERATED_KEYS request.
  CCI_EXEC_GET_GENERATED_KEYS: 0x40
};

/**
 * Define CoraDB Schema pattern match flags
 */
exports.CCISchemaPatternMatchFlag = {
  CCI_CLASS_NAME_PATTERN_MATCH: 0X01,
  CCI_ATTR_NAME_PATTERN_MATCH: 0X02
};

/**
 * Define CoraDB LOB types
 */
exports.CCILOBType = {
  CCI_LOB_TYPE_BLOB: 33,
  CCI_LOB_TYPE_CLOB: 34
};


/* CAS Protocol constants */
/**
 * Define the supported protocol version.
 * The protocol version is validated by the CoraDB broker,
 * to assess the compatibility level with the CoraDB engine.
 */
const CAS_PROTO_INDICATOR = 0x40;

exports.CAS_PROTOCOL_VERSION = (function getProtocolVersion() {
  const CAS_PROTOCOL_VERSION_9 = 9;

  return CAS_PROTOCOL_VERSION_9;
})();

exports.CAS_PROTO_INDICATOR = CAS_PROTO_INDICATOR;
exports.CAS_VERSION = CAS_PROTO_INDICATOR | exports.CAS_PROTOCOL_VERSION;

/*
 * What the driver tells the broker it supports, in the client-info exchange,
 * and what the broker answers it supports, in its broker info (as the JDBC
 * driver's UConnection defines them).
 */
// Errors with the codes of the current numbering (-10000 and below for CAS
// errors), not the old one.
exports.CAS_RENEWED_ERROR_CODE = 0x80;
// Result sets that stay open across a commit.
exports.CAS_SUPPORT_HOLDABLE_RESULT = 0x40;
// The broker reconnects to a database server that went down; error replies
// may then end with a new session id.
exports.CAS_RECONNECT_WHEN_SERVER_DOWN = 0x20;

/*
 * The CAS info, the four bytes at the head of every reply, which the driver
 * sends back with its next request (UConnection's CAS_INFO_*).
 */
exports.CAS_INFO_STATUS = 0;
exports.CAS_INFO_STATUS_INACTIVE = 0;
exports.CAS_INFO_STATUS_ACTIVE = 1;
exports.CAS_INFO_ADDITIONAL_FLAG = 3;
exports.CAS_INFO_FLAG_MASK_NEW_SESSION_ID = 0x04;

// Use JDBC client type; there is no CAS specific value defined for Noda.js client.
exports.CAS_CLIENT_JDBC = 3;

// These values are defined in `broker/cas_protocol.h`; inherited from CoraDB.
exports.CAS_MAGIC_STRING = 'CUBRK';
exports.CAS_MAGIC_STRING_SSL = 'CUBRS';

exports.getProtocolVersion = function (version) {
  // At this moment `node-coradb` supports at most protocol version 7.
  for (let protocolVersion = 0; protocolVersion <= 9; ++protocolVersion) {
    if ((CAS_PROTO_INDICATOR | protocolVersion) === version) {
      return protocolVersion;
    }
  }

  // By default fall back to the latest version we support.
  return exports.CAS_PROTOCOL_VERSION;
};
