'use strict';

const CAS = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');
const NoopLogger = require('../NoopLogger');
const { readShortColumnInfo, readRows, resultSetOf } = require('./ValueDecoder');

module.exports = GeneratedKeysPacket;

/**
 * GET_GENERATED_KEYS: the keys (AUTO_INCREMENT values) an INSERT generated.
 * The INSERT has to have been executed with the generated-keys flag, which
 * makes the CAS keep them; the one argument is that INSERT's query handle.
 *
 * The reply is a result set whose columns are described in short — type,
 * scale, precision and name — followed by the rows, read as any other rows
 * (see ValueDecoder).
 *
 * @param options `{ casInfo, queryHandle, logger }`
 * @constructor
 */
function GeneratedKeysPacket(options) {
  this.options = options || {};
  typeof this.options.logger === 'undefined' && (this.options.logger = new NoopLogger());

  this.casInfo = this.options.casInfo;
  this.queryHandle = this.options.queryHandle;
  this.responseCode = 0;
}

/**
 * Write data
 * @param writer
 */
GeneratedKeysPacket.prototype.write = function (writer) {
  writer._writeInt(this.getBufferLength() - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE);
  writer._writeBytes(this.casInfo);
  writer._writeByte(CAS.CASFunctionCode.CAS_FC_GET_GENERATED_KEYS);
  writer.addInt(this.queryHandle);

  return writer;
};

/**
 * Read data
 * @param parser
 */
GeneratedKeysPacket.prototype.parse = function (parser) {
  const responseLength = parser._parseInt();

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);
  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }

  parser._parseByte(); // Statement type (not used)
  this.totalTupleCount = parser._parseInt(); // Total tuple count
  parser._parseByte(); // Is updatable (not used)
  this.columnCount = parser._parseInt(); // Column count
  this.infoArray = [];

  for (let i = 0; i < this.columnCount; ++i) {
    this.infoArray.push(readShortColumnInfo(parser));
  }

  const tupleCount = parser._parseInt();

  this.resultSet = resultSetOf(this, readRows(this, parser, tupleCount));
};

GeneratedKeysPacket.prototype.getBufferLength = function () {
  // Length, CAS info, the function code, and the query handle (length + int).
  return DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE +
        DATA_TYPES.BYTE_SIZEOF + DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF;
};
