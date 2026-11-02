'use strict';

const CAS = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');

module.exports = CheckCasPacket;

/**
 * CHECK_CAS: is the session still there? The request is the function code and
 * nothing else; the reply is the usual length, CAS info and response code, and
 * a negative code is an error (the session is gone).
 *
 * @param options `{ casInfo }`
 * @constructor
 */
function CheckCasPacket(options) {
  options = options || {};
  this.casInfo = options.casInfo;
  this.responseCode = 0;
}

/**
 * Write data
 * @param writer
 */
CheckCasPacket.prototype.write = function (writer) {
  writer._writeInt(this.getBufferLength() - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE);
  writer._writeBytes(this.casInfo);
  writer._writeByte(CAS.CASFunctionCode.CAS_FC_CHECK_CAS);

  return writer;
};

/**
 * Read data
 * @param parser
 */
CheckCasPacket.prototype.parse = function (parser) {
  const responseLength = parser._parseInt();

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);
  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }
};

CheckCasPacket.prototype.getBufferLength = function () {
  // Length, CAS info, and the function code.
  return DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE + DATA_TYPES.BYTE_SIZEOF;
};
