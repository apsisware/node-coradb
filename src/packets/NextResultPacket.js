'use strict';

const CAS = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');
const NoopLogger = require('../NoopLogger');
const { readColumnInfos, readRows, resultSetOf, returnsRows } = require('./ValueDecoder');

module.exports = NextResultPacket;

/**
 * NEXT_RESULT: move a handle on to the next result of the statements it
 * executed together (an EXECUTE with CCI_EXEC_QUERY_ALL), as the JDBC
 * driver's `UStatement.nextResult()` does.
 *
 * Request:  [int 4][handle][int 4][0]
 * Reply:    [result code][tuple count][byte statement type][byte updatable]
 *           [int column count][column infos, as PREPARE sends them]
 *
 * The reply carries no rows: they are fetched with FETCH on the same handle,
 * from position 1. After this packet is registered under the handle, the
 * driver's ordinary fetch reads them with it (see `getValues`).
 *
 * @param options `{ casInfo, queryHandle, logger }`
 * @constructor
 */
function NextResultPacket(options) {
  this.options = options;
  typeof options.logger === 'undefined' && (options.logger = new NoopLogger());

  this.queryHandle = options.queryHandle;
  this.responseCode = 0;
}

/**
 * Write data
 * @param writer
 */
NextResultPacket.prototype.write = function (writer) {
  const options = this.options;

  writer._writeInt(this.getBufferLength() - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE);
  writer._writeBytes(options.casInfo);
  writer._writeByte(CAS.CASFunctionCode.CAS_FC_NEXT_RESULT);
  writer.addInt(this.queryHandle); // Server handle
  writer.addInt(0); // As the JDBC driver sends it ("jci 3.0")

  return writer;
};

/**
 * Read data
 * @param parser
 */
NextResultPacket.prototype.parse = function (parser) {
  const start = parser._offset;
  const responseLength = parser._parseInt();
  const end = start + DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE + responseLength;

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);
  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }

  // The result's row count (a SELECT) or rows changed (the others).
  this.totalTupleCount = parser._parseInt();
  this.statementType = parser._parseByte();
  this.isUpdatable = parser._parseByte() === 1;
  this.columnCount = parser._parseInt();
  this.infoArray = readColumnInfos(parser, this.columnCount);

  // No rows have come with it: the first fetch starts at 1.
  this.currentTupleCount = 0;
  this.tupleCount = 0;

  if (returnsRows(this.statementType)) {
    this.resultSet = resultSetOf(this, []);
  }

  // Anything a newer server appends is not needed.
  if (parser._offset < end) {
    parser._offset = end;
  }

  this.options.logger.debug(
    `NextResultPacket.parse: statementType = ${this.statementType}, totalTupleCount = ${this.totalTupleCount}, columns = ${this.columnCount}`
  );

  return undefined;
};

/**
 * Read `tupleCount` rows with the shared decoder (a FETCH for this result).
 * @param parser
 * @param tupleCount
 */
NextResultPacket.prototype.getValues = function (parser, tupleCount) {
  return readRows(this, parser, tupleCount);
};

NextResultPacket.prototype.getBufferLength = function () {
  return DATA_TYPES.DATA_LENGTH_SIZEOF + // Length
    DATA_TYPES.CAS_INFO_SIZE + // CAS info
    DATA_TYPES.BYTE_SIZEOF + // Function code
    DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF + // Handle
    DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF; // 0
};
