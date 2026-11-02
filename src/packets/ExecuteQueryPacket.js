'use strict';

const CAS = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');
const NoopLogger = require('../NoopLogger');
const ResultInfo = require('../resultset/ResultInfo');
const { readColumnInfos, readExecuteTail, readFirstBatch, readRows, resultSetOf, returnsRows } = require('./ValueDecoder');

module.exports = ExecuteQueryPacket;

/**
 * Constructor
 * @param options
 * @constructor
 */
function ExecuteQueryPacket(options) {
  this.options = options;
  typeof options.logger === 'undefined' && (options.logger = new NoopLogger());
}

/**
 * Write data
 * @param writer
 */
ExecuteQueryPacket.prototype.write = function (writer) {
  const options = this.options;
  // Set the length of this request. Don't include the first eight bytes
  // (`DATA_LENGTH_SIZEOF` and `CAS_INFO_SIZE`) because they are not
  // part of the query data.
  writer._writeInt(this.getBufferLength() - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE);
  // `this.casInfo` is already a buffer. Just write them as bytes.
  writer._writeBytes(options.casInfo);

  // Then tell which CAS function should CAS execute.
  // NOTE: Shouldn't CAS function by an integer of four bytes? Why write only one byte?
  writer._writeByte(options.protocolVersion === /* CoraDB 1.0.0 */2 ? CAS.CASFunctionCode.CAS_FC_PREPARE_AND_EXECUTE_FOR_PROTO_V2 : CAS.CASFunctionCode.CAS_FC_PREPARE_AND_EXECUTE);

  // Next, write how many arguments should the CAS
  // function accept. `CAS_FC_PREPARE_AND_EXECUTE`
  // accepts `3` arguments.
  writer.addInt(3);

  // Now goes the SQL query.
  writer._writeNullTerminatedString(options.sql);

  // The type of prepare CAS has to execute: with HOLDABLE, a result that stays
  // open across a commit — what the JDBC driver asks for by default
  // (HOLD_CURSORS_OVER_COMMIT) when the broker supports it.
  writer.addByte(options.holdable ? CAS.CCIPrepareOption.CCI_PREPARE_HOLDABLE : CAS.CCIPrepareOption.CCI_PREPARE_NORMAL);

  // Autocommit mode. Off when the generated keys are to be kept, as the JDBC
  // driver sends it: in auto-commit the CAS ends the transaction after the
  // INSERT and drops the keys, and GET_GENERATED_KEYS then fails. The driver
  // reads the keys and commits itself, before query() resolves (see
  // _completeGeneratedKeys in CoraDBConnection).
  writer.addByte(options.autoCommit && !options.getGeneratedKeys ? 1 : 0);

  // Execute info.

  // Execute flag; with GET_GENERATED_KEYS, the CAS keeps the keys an INSERT
  // generates for a GET_GENERATED_KEYS request (see getGeneratedKeys()).
  writer.addByte(CAS.CCIExecutionOption.CCI_EXEC_QUERY_ALL |
    (options.holdable ? CAS.CCIExecutionOption.CCI_EXEC_HOLDABLE : 0) |
    (options.getGeneratedKeys ? CAS.CCIExecutionOption.CCI_EXEC_GET_GENERATED_KEYS : 0));

  // `max_col_size`: The maximum length of a column in bytes to be fetched
  // when it is a string data type. If this value is 0, full length is fetched.
  writer.addInt(0);

  // Max row size.
  writer.addInt(0);

  // NULL.
  writer._writeInt(0);

  // Write cache time
  writer._writeInt(2 * DATA_TYPES.INT_SIZEOF);
  // Seconds.
  writer._writeInt(0);
  // Milliseconds.
  writer._writeInt(0);

  // Query timeout, in milliseconds; 0 for none (see setQueryTimeout()).
  writer.addInt(options.queryTimeout > 0 ? options.queryTimeout : 0);

  return writer;
};

/**
 * Read data
 * @param parser
 */
ExecuteQueryPacket.prototype.parse = function (parser) {
  const options = this.options;
  const start = parser._offset;
  const responseLength = parser._parseInt();
  // Where this reply ends: the length counts what follows the CAS info.
  const end = start + DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE + responseLength;
  const logger = options.logger;

  // No rows read yet. It used to be set only for a SELECT, and fetch() tested
  // it against the total — for anything else `undefined !== count`, and
  // queryAll() fetched for ever.
  this.currentTupleCount = 0;

  logger.debug(`ExecuteQueryPacket.parse: responseLength = ${responseLength}.`);

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);

  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }

  this.queryHandle = this.responseCode;
  this.resultCacheLifetime = parser._parseInt(); // Cache lifetime
  this.statementType = parser._parseByte(); // Statement type

  logger.debug(`ExecuteQueryPacket.parse: statementType = ${this.statementType}`);

  this.bindCount = parser._parseInt(); // Bind count
  this.isUpdatable = (parser._parseByte() === 1); // Is updatable? (1 = yes, as everywhere else; it was read the wrong way round)
  this.columnCount = parser._parseInt(); // Query result columns count
  // Column descriptions: read by the shared decoder, which keeps a
  // collection's type and its element type apart.
  this.infoArray = readColumnInfos(parser, this.columnCount);

  let i;

  logger.debug('ExecuteQueryPacket.parse: infoArray =', this.infoArray);

  // Tuples count.
  this.totalTupleCount = parser._parseInt();

  // Is cache reusable.
  parser._parseByte();

  // Results count.
  this.resultCount = parser._parseInt();

  logger.debug('ExecuteQueryPacket.parse: totalTupleCount =', this.totalTupleCount);
  logger.debug('ExecuteQueryPacket.parse: resultCount =', this.resultCount);

  // Read result info.
  let resultInfo;

  this.resultInfos = [];

  for (i = 0; i < this.resultCount; ++i) {
    resultInfo = new ResultInfo();
    resultInfo.StmtType = parser._parseByte(); // Statement type
    resultInfo.ResultCount = parser._parseInt(); // Result count
    resultInfo.Oid = parser._parseBytes(DATA_TYPES.OID_SIZEOF); // OID (a copy)
    resultInfo.CacheTimeSec = parser._parseInt(); // Cache time seconds
    resultInfo.CacheTimeUsec = parser._parseInt(); // Cache time milliseconds

    logger.debug(`ExecuteQueryPacket.parse: resultInfo (${i}) =`, resultInfo);

    this.resultInfos.push(resultInfo);
  }

  // include_column_info (and with it, when set, the statement's description
  // as the server knows it after executing), then the shard id.
  readExecuteTail(this, parser, options.protocolVersion);

  if (returnsRows(this.statementType)) {
    const columnValues = readFirstBatch(this, parser, end);

    logger.debug(`ExecuteQueryPacket.parse: tupleCount = ${this.tupleCount}`);
    // How many rows, not the rows: they can hold personal data.
    logger.debug('ExecuteQueryPacket.parse: rows in the first batch =', columnValues ? columnValues.length : 0);

    this.resultSet = resultSetOf(this, columnValues);
  }
};

/**
 * Read `tupleCount` rows with the shared decoder (see ValueDecoder).
 * @param parser
 * @param tupleCount
 */
ExecuteQueryPacket.prototype.getValues = function (parser, tupleCount) {
  return readRows(this, parser, tupleCount);
};

ExecuteQueryPacket.prototype.getBufferLength = function () {
  let bufferLength = // Total length of the request without itself and CAS info.
        DATA_TYPES.DATA_LENGTH_SIZEOF +
        // CAS info.
        DATA_TYPES.CAS_INFO_SIZE +
        // CAS function.
        DATA_TYPES.BYTE_SIZEOF +
        // The length of the next part.
        DATA_TYPES.INT_SIZEOF +
        // CAS arguments.
        DATA_TYPES.INT_SIZEOF +
        // The length of the next part.
        DATA_TYPES.INT_SIZEOF +
        // A NULL terminated SQL query string.
        Buffer.byteLength(this.options.sql) + 1 +
        // The length of the next part.
        DATA_TYPES.INT_SIZEOF +
        // The type of CCI prepare.
        DATA_TYPES.BYTE_SIZEOF +
        // The length of the next part.
        DATA_TYPES.INT_SIZEOF +
        // Autocommit mode
        DATA_TYPES.BYTE_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.BYTE_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF;

  return bufferLength;
};
