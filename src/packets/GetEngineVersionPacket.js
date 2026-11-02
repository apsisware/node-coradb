const CAS = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');

module.exports = GetEngineVersionPacket;

/**
 * Constructor
 * @param options
 * @constructor
 */
function GetEngineVersionPacket(options) {
  options = options || {};

  this.casInfo = options.casInfo;
  // The connection's auto-commit mode. The CAS acts on it after answering:
  // with 1 it commits, so a version request (a ping) sent with 1 while
  // auto-commit was off committed the caller's open transaction. Left out, it
  // is 1, as this packet always sent.
  this.autoCommit = options.autoCommit === undefined ? true : Boolean(options.autoCommit);
  this.engineVersion = '';
  this.responseCode = 0;
}

/**
 * Write data
 * @param writer
 */
GetEngineVersionPacket.prototype.write = function (writer) {
  writer._writeInt(this.getBufferLength() - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE);
  writer._writeBytes(this.casInfo);
  writer._writeByte(CAS.CASFunctionCode.CAS_FC_GET_DB_VERSION);
  writer._writeInt(DATA_TYPES.BYTE_SIZEOF);
  writer._writeByte(this.autoCommit ? 1 : 0); // Auto-commit mode

  return writer;
};

/**
 * Read data
 * @param parser
 */
GetEngineVersionPacket.prototype.parse = function (parser) {
  const responseLength = parser._parseInt();

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);
  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }

  this.engineVersion = parser._parseNullTerminatedString(responseLength - DATA_TYPES.INT_SIZEOF);
};

GetEngineVersionPacket.prototype.getBufferLength = function () {
  return DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE +
        DATA_TYPES.BYTE_SIZEOF + DATA_TYPES.INT_SIZEOF + DATA_TYPES.BYTE_SIZEOF;
};
