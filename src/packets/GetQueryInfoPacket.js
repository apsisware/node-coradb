'use strict';

const CAS = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');

/**
 * Ask the engine for the plan it would use for a statement.
 *
 * The plan is not a result set and never arrives as rows: it has a request of
 * its own, and this is it. Raising the session's optimization level makes the
 * engine *produce* a plan, which is a different thing from anyone receiving
 * one — that setting prints to the server's own output and nothing comes back
 * down the connection.
 *
 * Sent against query handle 0, with the SQL itself, the engine compiles the
 * statement and answers with the plan without preparing or executing anything.
 * The same request against a real handle returns the plan of a statement that
 * was prepared with the query-info flag, which this driver does not use.
 */
function GetQueryInfoPacket(options) {
  options = options || {};

  this.casInfo = options.casInfo;
  this.sql = options.sql || '';
  /** 0 means "this SQL", rather than a statement already prepared. */
  this.queryHandle = options.queryHandle || 0;
  this.plan = '';
  this.responseCode = 0;
}

/** The only kind of query information this driver asks for. */
GetQueryInfoPacket.QUERY_INFO_PLAN = 0x01;

/**
 * Write data
 * @param writer
 */
GetQueryInfoPacket.prototype.write = function (writer) {
  writer._writeInt(
    this.getBufferLength() - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE
  );
  writer._writeBytes(this.casInfo);
  writer._writeByte(CAS.CASFunctionCode.CAS_FC_GET_QUERY_INFO);

  // Three arguments, each its own length and value.
  writer.addInt(this.queryHandle);
  writer.addByte(GetQueryInfoPacket.QUERY_INFO_PLAN);
  writer._writeNullTerminatedString(this.sql);

  return writer;
};

/**
 * Read data
 * @param parser
 */
GetQueryInfoPacket.prototype.parse = function (parser) {
  const responseLength = parser._parseInt();

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);
  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }

  // Everything after the response code is the plan, as text.
  this.plan = parser._parseNullTerminatedString(responseLength - DATA_TYPES.INT_SIZEOF);
};

GetQueryInfoPacket.prototype.getBufferLength = function () {
  return (
    DATA_TYPES.DATA_LENGTH_SIZEOF +
    DATA_TYPES.CAS_INFO_SIZE +
    // The function code.
    DATA_TYPES.BYTE_SIZEOF +
    // Query handle: its length, then the integer.
    DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF +
    // What kind of information: its length, then the byte.
    DATA_TYPES.INT_SIZEOF + DATA_TYPES.BYTE_SIZEOF +
    // The statement: its length, the bytes, and the terminating null.
    DATA_TYPES.INT_SIZEOF + Buffer.byteLength(this.sql) + DATA_TYPES.BYTE_SIZEOF
  );
};

module.exports = GetQueryInfoPacket;
