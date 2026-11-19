'use strict';

const CASConstants = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');

/**
 * The out-of-band request to abandon a statement.
 *
 * Unlike every other packet in this driver, this one does not travel on the
 * connection's own socket. That socket belongs to a CAS process that is busy
 * executing a statement and is not reading from it, which is the whole reason
 * a cancel cannot be sent the ordinary way. It goes instead on a socket opened
 * for this one message, to the port the connection is served on; the CAS
 * process serving the connection is signalled, and the statement comes back to
 * its caller as CAS_ER_QUERY_CANCEL.
 *
 * Ten bytes out, and they are not a packet in the usual shape — no length
 * header, no casInfo:
 *
 *   'X'  '1'  CAS_VERSION  0  0  0  <process id, four bytes big-endian>
 *
 * 'X' and '1' are what the listener reads first to tell a cancel from a
 * connection request; the three zeroes are reserved. Four bytes back: a
 * negative integer if the cancel could not be performed, otherwise it was.
 */
function CancelRequestPacket(options) {
  this.options = options || {};
}

/** The two bytes the listener reads first to recognise a cancel. */
CancelRequestPacket.MAGIC = 'X1';

/** Bytes before the process id: the magic, the version, three reserved. */
CancelRequestPacket.HEADER_SIZE = 6;

/** Bytes out. Fixed, so the reply can be waited for without framing. */
CancelRequestPacket.REQUEST_SIZE =
  CancelRequestPacket.HEADER_SIZE + DATA_TYPES.INT_SIZEOF;

/** Bytes back: one integer. */
CancelRequestPacket.RESPONSE_SIZE = DATA_TYPES.INT_SIZEOF;

/**
 * Write data
 * @param writer
 */
CancelRequestPacket.prototype.write = function (writer) {
  writer._writeFixedLengthString(
    CancelRequestPacket.MAGIC,
    0,
    CancelRequestPacket.MAGIC.length
  );
  writer._writeByte(CASConstants.CAS_VERSION);
  // The client's feature flags, as in the client-info exchange (the JDBC
  // driver sends its driverInfo bytes here): the broker answers a refusal in
  // the renewed numbering only when the 0x80 flag is set
  // (broker.c send_error_to_driver). Then two reserved bytes; the listener
  // reads the fixed ten bytes either way, so they cannot be left out.
  writer._writeByte(CASConstants.CAS_RENEWED_ERROR_CODE | CASConstants.CAS_SUPPORT_HOLDABLE_RESULT);
  writer._writeFiller(2, 0);
  // No length prefix: a length header in front of the magic would be read as
  // the magic itself and the request rejected.
  writer._writeInt(this.options.processId | 0);

  return writer;
};

/**
 * Read data
 * @param parser
 */
CancelRequestPacket.prototype.parse = function (parser) {
  this.responseCode = parser._parseInt();

  return this.responseCode;
};

CancelRequestPacket.prototype.getBufferLength = function () {
  return CancelRequestPacket.REQUEST_SIZE;
};

module.exports = CancelRequestPacket;
