'use strict';

const CASConstants = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');

/**
 * Constructor
 * @constructor
 */
function ClientInfoExchangePacket() {
  this.newConnectionPort = 0;
}

/**
 * Write data
 * @param writer
 */
ClientInfoExchangePacket.prototype.write = function (writer) {
  // Write the driver info which consists of 10 bytes.
  writer._writeFixedLengthString(CASConstants.CAS_MAGIC_STRING, 0, CASConstants.CAS_MAGIC_STRING.length);
  writer._writeByte(CASConstants.CAS_CLIENT_JDBC);
  writer._writeByte(CASConstants.CAS_VERSION);
  // What the driver supports, as the JDBC driver sends it: errors with the
  // renewed codes, and result sets held across a commit. It used to be 0, so
  // a CAS answered with the old codes (-1007 for -10007...).
  writer._writeByte(CASConstants.CAS_RENEWED_ERROR_CODE | CASConstants.CAS_SUPPORT_HOLDABLE_RESULT);
  writer._writeByte(0); // Reserved by the protocol.
  writer._writeByte(0); // Reserved by the protocol.

  return writer;
};

/**
 * Read data
 * @param parser
 */
ClientInfoExchangePacket.prototype.parse = function (parser) {
  // (TCP/IP) Port value
  this.newConnectionPort = parser._parseInt();
};

ClientInfoExchangePacket.prototype.getBufferLength = function () {
  let bufferLength =
        // The length of "CUBRK" string.
        CASConstants.CAS_MAGIC_STRING.length +
        // JDBC client type + CAS version + 0 + 0 + 0. All bytes.
        DATA_TYPES.BYTE_SIZEOF * 5;

  return bufferLength;
};

module.exports = ClientInfoExchangePacket;
