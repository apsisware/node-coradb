'use strict';

const CAS = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');
const { serverError } = require('../errors');
const Timezone = require('../utils/Timezone');
const ValueDecoder = require('./ValueDecoder');

module.exports = PacketReader;

/**
 * PacketReader
 * @constructor
 */
function PacketReader() {
  this._buffer = null;
  this._offset = 0;
}

/** The size of a session id (see OpenDatabasePacket). */
const SESSION_ID_SIZE = 20;
/** The indicator of an error the CAS raised itself, not the database. */
const CAS_ERROR_INDICATOR = -1;
/** CAS_ER_NOT_AUTHORIZED_CLIENT in the old numbering. */
const CAS_ER_NOT_AUTHORIZED_CLIENT_OLD = -1018;

/**
 * Read an error code and message from the internal buffer.
 * @param responseLength
 */
PacketReader.prototype.readError = function (responseLength) {
  // The indicator (-1 a CAS error, -2 a DBMS error): the response code the
  // packet has just read.
  const indicator = this._buffer.readInt32BE(this._offset - DATA_TYPES.INT_SIZEOF);
  let code = this._parseInt();
  let messageLength = responseLength - 2 * DATA_TYPES.INT_SIZEOF;

  // A new session id at the end of the message (see CoraDBConnection
  // _readErrorsAsJdbc).
  if (this.sessionIdInError && messageLength >= SESSION_ID_SIZE) {
    messageLength -= SESSION_ID_SIZE;
  }

  const message = this._parseNullTerminatedString(messageLength);

  if (this.sessionIdInError && this._buffer.length - this._offset >= SESSION_ID_SIZE) {
    const session = this._parseBytes(SESSION_ID_SIZE);

    if (typeof this.onNewSessionId === 'function') {
      this.onNewSessionId(session);
    }
  }

  // The old numbering of the CAS errors, moved to the new one as the JDBC
  // driver moves it (-1007 is -10007).
  if (this.errorCodes === 'login') {
    if ((indicator === CAS_ERROR_INDICATOR && code > -10000) || code === CAS_ER_NOT_AUTHORIZED_CLIENT_OLD) {
      code -= 9000;
    }
  } else if (this.errorCodes === 'old') {
    if (indicator === CAS_ERROR_INDICATOR || code === CAS_ER_NOT_AUTHORIZED_CLIENT_OLD) {
      code -= 9000;
    }
  }

  // With no text, the CAS code's name; with a code the driver does not know
  // either, a message that says which code it was — never `undefined`.
  return serverError(code, message);
};

/**
 * Write a buffer value to the internal buffer
 * @param buffer
 */
PacketReader.prototype.write = function (buffer) {
  this._append(buffer);
};

//TODO Optimize the performance of this function
/**
 * Append a buffer value to the internal buffer
 * @param newBuffer
 */
PacketReader.prototype._append = function (newBuffer) {
  let oldBuffer = this._buffer;

  if (!oldBuffer) {
    this._buffer = newBuffer;
    return;
  }

  let bytesRemaining = this._bytesRemaining();
  let newLength = bytesRemaining + newBuffer.length;

  let combinedBuffer = (this._offset > newLength) ? oldBuffer.subarray(0, newLength) : Buffer.alloc(newLength);

  oldBuffer.copy(combinedBuffer, 0, this._offset);
  newBuffer.copy(combinedBuffer, bytesRemaining);

  this._buffer = combinedBuffer;
  this._offset = 0;
};

function parseNum(length) {
  let value = 0;
  let i = this._offset;
  const b = this._buffer;
  const endIndex = i + length;

  for (; i < endIndex; ++i) {
    value <<= 8;
    value |= (b[i] & 0xff);
  }

  this._offset = endIndex;

  return value;
}

/**
 * Returns an short value from the internal buffer
 * @return {Number}
 */
PacketReader.prototype._parseShort = function () {
  // Signed, as the protocol defines it. Read through the byte accumulator it
  // came out unsigned, so a SMALLINT of -1 arrived as 65535.
  const value = this._buffer.readInt16BE(this._offset);

  this._offset += DATA_TYPES.SHORT_SIZEOF;

  return value;
};

/**
 * Returns an integer value from the internal buffer
 * @return {Number}
 */
PacketReader.prototype._parseInt = function () {
  return parseNum.call(this, DATA_TYPES.INT_SIZEOF);
};

/**
 * Returns a byte value from the internal buffer
 * @return {Number}
 */
PacketReader.prototype._parseByte = function () {
  return this._buffer[this._offset++];
};

/**
 * Returns a copy of the next `bytesCount` bytes.
 *
 * A copy, not a view: what is read this way is small and kept — the CAS info,
 * OIDs, LOB handles, BIT values — and a view into the reply keeps the whole
 * reply alive for as long as any one of them is. `_viewBytes` is the view, for
 * bytes that are copied again straight away.
 * @param bytesCount
 * @return {Buffer}
 */
PacketReader.prototype._parseBytes = function (bytesCount) {
  const buffer = Buffer.from(this._buffer.subarray(this._offset, this._offset + bytesCount));

  this._offset += bytesCount;

  return buffer;
};

/**
 * Returns a view of the next `bytesCount` bytes, sharing the reply's memory.
 * Only for bytes that are copied again at once (LOB chunks, which are
 * concatenated).
 * @param bytesCount
 * @return {Buffer}
 */
PacketReader.prototype._viewBytes = function (bytesCount) {
  const buffer = this._buffer.subarray(this._offset, this._offset + bytesCount);

  this._offset += bytesCount;

  return buffer;
};

/**
 * Returns a buffer object from the internal buffer
 * @param bytesCount
 * @return {*}
 */
PacketReader.prototype._parseBuffer = function (bytesCount) {
  let buffer = Buffer.from(this._buffer.subarray(this._offset, this._offset + bytesCount));

  this._offset += bytesCount;

  return buffer;
};

/**
 * Returns a string value from the internal buffer
 * @return {String}
 */
PacketReader.prototype._parseNullTerminatedString = function (length, encoding) {
  if (length <= 0) {
    return '';
  }

  let valueLen = length - 1; // Get the actual null-terminated string length
  let buffer = this._buffer.subarray(this._offset, this._offset + valueLen);
  // In the column's charset (see CAS.getCharsetEncoding); UTF-8 by default.
  let value = buffer.toString(encoding || 'utf8');

  this._offset += valueLen;
  this._parseByte(); // Read also the null-terminate

  return value;
};

/**
 * The zero date (0000-00-00), which the engine stores for a DATE, DATETIME or
 * TIMESTAMP of zero. It has no Date: built as one, it came back as
 * -000001-11-30. It is read as null.
 * @param year
 * @param month zero based, as read
 * @param day
 */
function isZeroDate(year, month, day) {
  return year === 0 && month === -1 && day === 0;
}

/**
 * Returns a date value from the internal buffer
 * @return {Date}
 */
PacketReader.prototype._parseDate = function () {
  const year = this._parseShort();
  // `month` in `Date` is zero based where `0` represents January.
  const month = this._parseShort() - 1;
  const day = this._parseShort();

  if (isZeroDate(year, month, day)) {
    return null;
  }

  const hour = 0;
  const min = 0;
  const sec = 0;
  const msec = 0;

  let date = new Date();

  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, min, sec, msec);

  return date;
};

/**
 * Returns a datetime value from the internal buffer
 * @return {Date}
 */
PacketReader.prototype._parseDateTime = function () {
  const year = this._parseShort();
  // `month` in `Date` is zero based where `0` represents January.
  const month = this._parseShort() - 1;
  const day = this._parseShort();
  const hour = this._parseShort();
  const min = this._parseShort();
  const sec = this._parseShort();
  const msec = this._parseShort();

  if (isZeroDate(year, month, day)) {
    return null;
  }

  let date = new Date();

  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, min, sec, msec);

  return date;
};

/**
 * Returns a time value from the internal buffer
 * @return {Date}
 */
PacketReader.prototype._parseTime = function () {
  const hour = this._parseShort();
  const min = this._parseShort();
  const sec = this._parseShort();

  let date = new Date();

  // `January 1, 1970` is the beginning of the Unix Epoch.
  // When `TIME` data is returned by CoraDB, we receive
  // only the time part of the date, so, the date is set
  // to the beginning of the epoch.
  date.setUTCFullYear(1970, 0, 1);
  date.setUTCHours(hour, min, sec, 0);

  return date;
};

/**
 * Returns a timestamp value from the internal buffer
 * @return {Date}
 */
PacketReader.prototype._parseTimeStamp = function () {
  const year = this._parseShort();
  const month = this._parseShort() - 1;
  const day = this._parseShort();
  const hour = this._parseShort();
  const min = this._parseShort();
  const sec = this._parseShort();
  const msec = 0;

  if (isZeroDate(year, month, day)) {
    return null;
  }

  let date = new Date();

  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, min, sec, msec);

  return date;
};

/**
 * Returns a timestamptz value from the internal buffer
 * @param size
 * @returns {Timezone}
 */
PacketReader.prototype._parseTimeStampTz = function (size) {
  const tmp_position = this._offset;
  const timestamp = this._parseTimeStamp.call(this);
  const timestamp_size = this._offset - tmp_position;
  let timezone;

  if (timestamp_size > 0) {
    const timezoneLength = size - timestamp_size - 1;
    timezone = this._buffer.subarray(this._offset, this._offset + timezoneLength);
    this._offset += size - timestamp_size;
  } else {
    timezone = '';
    this._offset++;
  }

  return timestamp === null ? null : new Timezone(timestamp, timezone);
};

/**
 * Returns a datetimetz value from the internal buffer
 * @param size
 * @returns {Timezone}
 */
PacketReader.prototype._parseDateTimeTz = function (size) {
  const tmp_position = this._offset;
  const datetime = this._parseDateTime.call(this);
  const datetime_size = this._offset - tmp_position;
  let timezone;

  if (datetime_size > 0) {
    const timezoneLength = size - datetime_size - 1;
    timezone = this._buffer.subarray(this._offset, this._offset + timezoneLength);
    this._offset += size - datetime_size;
  } else {
    timezone = '';
    this._offset++;
  }

  return datetime === null ? null : new Timezone(datetime, timezone);
};

/**
 * Returns a char value from the internal buffer
 * @return {String}
 */
PacketReader.prototype._parseChar = function () {
  return String.fromCharCode(this._parseByte());
};

/**
 * Returns a Long value from the internal buffer
 * @return {Number}
 */
PacketReader.prototype._parseLong = function () {
  // 64-bit signed big-endian value, read as a BigInt. A number when it fits
  // one exactly; outside Number.MIN_SAFE_INTEGER..MAX_SAFE_INTEGER, its
  // decimal text, because the nearest double is a different value.
  const value = ValueDecoder.bigintValue(this._buffer.readBigInt64BE(this._offset));

  this._offset += DATA_TYPES.LONG_SIZEOF;

  return value;
};

/**
 * Returns a double value from the internal buffer
 * @return {Number}
 */
PacketReader.prototype._parseDouble = function () {
  let value = this._buffer.readDoubleBE(this._offset);

  this._offset += DATA_TYPES.DOUBLE_SIZEOF;

  return value;
};

/**
 * Returns a floating point value from the internal buffer
 * @return {Number}
 */
PacketReader.prototype._parseFloat = function () {
  let value = this._buffer.readFloatBE(this._offset);
  this._offset += DATA_TYPES.FLOAT_SIZEOF;

  return value;
};

/**
 * Returns a Numeric value from the internal buffer
 * @return {Number}
 */
PacketReader.prototype._parseNumeric = function (size) {
  // NUMERIC/DECIMAL values arrive as exact decimal text. A number when
  // `Number()` keeps that value exactly, the text otherwise (see
  // `ValueDecoder.numericValue`).
  return ValueDecoder.numericValue(this._parseNullTerminatedString(size));
};

/**
 * Returns a Object value from the internal buffer
 * @return {String}
 */
PacketReader.prototype._parseObject = function () {
  return 'OID:@' + this._parseInt() + '|' + this._parseShort() + '|' + this._parseShort();
};

/**
 * Returns a LOB object from the internal buffer
 * @return {Object}
 */
function readLob(size) {
  /*
    * |----4 bytes----|----8 bytes----|----4 bytes----|---------------------locator size bytes-------------------|
    * |    db_type    |   LOB size   | locator size  | the absolute file path on the server where LOB is stored |
    * |---------------|---------------|---------------|----------------------------------------------------------|
    *
    * */
  // `_parseBytes` copies: the handle outlives the reply it came in.
  const packedLobHandle = this._parseBytes(size);
  let locatorSize = 0;

  // BLOB size is a 64-bit long, stored right after the 4-byte `db_type`.
  // Read it as a BigInt to avoid the 32-bit overflow that a byte-by-byte
  // shift/or accumulation causes, then convert to a Number (exact up to
  // 2^53 - 1, which comfortably covers real LOB sizes).
  const lobLength = Number(packedLobHandle.readBigInt64BE(DATA_TYPES.INT_SIZEOF));

  // Continue right after db_type (4 bytes) + long size (8 bytes).
  let start = DATA_TYPES.INT_SIZEOF + DATA_TYPES.LONG_SIZEOF;
  let end = start + DATA_TYPES.INT_SIZEOF;

  for (; start < end; ++start) {
    locatorSize <<= 8;
    locatorSize |= (packedLobHandle[start] & 0xff);
  }

  let fileLocator = packedLobHandle.toString('utf8', start, start + locatorSize - 1);

  return {
    fileLocator,
    lobLength,
    packedLobHandle,
  };
}

/**
 * Returns a BLOB object from the internal buffer
 * @return {Object}
 */
PacketReader.prototype.readBlob = function (size) {
  let lob = readLob.call(this, size);
  lob.lobType = CAS.CoraDBDataType.CCI_U_TYPE_BLOB;

  return lob;
};

/**
 * Returns a CLOB object from the internal buffer
 * @return {Object}
 */
PacketReader.prototype.readClob = function (size) {
  let lob = readLob.call(this, size);
  lob.lobType = CAS.CoraDBDataType.CCI_U_TYPE_CLOB;

  return lob;
};

/**
 * Return the number of bytes remaining unparsed/unread in the buffer
 * @return {Number}
 */
PacketReader.prototype._bytesRemaining = function () {
  return this._buffer.length - this._offset;
};

/**
 * Return the internal buffer length
 * @return {Number}
 */
PacketReader.prototype._packetLength = function () {
  return this._buffer.length;
};

