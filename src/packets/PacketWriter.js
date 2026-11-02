'use strict';
const DATA_TYPES = require('./../constants/DataTypes');
const CAS = require('../constants/CASConstants');

module.exports = PacketWriter;

/**
 * Create a new instance
 * @constructor
 */
function PacketWriter(length) {
  this._buffer = Buffer.alloc(length || 0);
  this._offset = 0;
}

/**
 * Write the current buffer content
 * @return {*}
 */
PacketWriter.prototype._toBuffer = function () {
  return this._buffer.subarray(0, this._offset);
};

/**
 * Write a byte value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addByte = function (value) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself 
        DATA_TYPES.BYTE_SIZEOF
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.BYTE_SIZEOF);
  // The actual value.
  this._buffer[this._offset++] = value & 0xFF;
};

/**
 * Write a bytes array to the internal buffer
 * @param bytesCount
 * @param value
 */
PacketWriter.prototype.addBytes = function (value) {
  const bytesCount = value.length;

  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself
        bytesCount
  );

  // The length of the value.
  this._writeInt(bytesCount);
  // The actual value.
  this._writeBytes(value);
};

/**
 * Write a date value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addDate = function (year, month, day) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself
        DATA_TYPES.DATE_SIZEOF
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.DATE_SIZEOF);
  // The actual value.
  this._writeDate(year, month, day);
};

/**
 * Write a datetime value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addDateTime = function (year, month, day, hour, minute, second, millisecond) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself
        DATA_TYPES.DATETIME_SIZEOF
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.DATETIME_SIZEOF);
  // The actual value.
  this._writeDateTime(year, month, day, hour, minute, second, millisecond);
};

/**
 * Write a datetime value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addTimestamp = function (year, month, day, hour, minute, second) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself
        DATA_TYPES.TIMESTAMP_SIZEOF
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.TIMESTAMP_SIZEOF);
  // The actual value.
  this._writeTimestamp(year, month, day, hour, minute, second);
};

/**
 * Write a double value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addDouble = function (value) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself
        DATA_TYPES.DOUBLE_SIZEOF
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.DOUBLE_SIZEOF);
  // The actual value.
  this._writeDouble(value);
};

/**
 * Write a float value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addFloat = function (value) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself
        DATA_TYPES.FLOAT_SIZEOF
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.FLOAT_SIZEOF);
  // The actual value.
  this._writeFloat(value);
};

/**
 * Write a integer value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addInt = function (value) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF * 2
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.INT_SIZEOF);
  // The actual value.
  this._writeInt(value);
};

/**
 * Write a short value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addShort = function (value) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself
        DATA_TYPES.SHORT_SIZEOF
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.SHORT_SIZEOF);
  // The actual value.
  this._writeShort(value);
};

/**
 * Write a time value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addTime = function (hour, minute, second) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself
        DATA_TYPES.TIME_SIZEOF
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.TIME_SIZEOF);
  // The actual value.
  this._writeTime(hour, minute, second);
};

/**
 * Write a long value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addLong = function (value) {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF +
        // the value itself
        DATA_TYPES.LONG_SIZEOF
  );

  // The length of the value.
  this._writeInt(DATA_TYPES.LONG_SIZEOF);
  // The actual value.
  this._writeLong(value);
};

/**
 * Write a NULL value to the internal buffer
 */
PacketWriter.prototype.addNull = function () {
  this._allocate(
    // size of any data is represented as an integer
    DATA_TYPES.INT_SIZEOF
  );

  // The actual value.
  this._writeInt(0);
};
/**
 * Write a integer value to the internal buffer
 * @param value
 */
PacketWriter.prototype.addCacheTime = function () {
  const length = /* size of any data is represented as an integer */ DATA_TYPES.INT_SIZEOF * 2;
  this._allocate(length);

  // The actual value.
  this._writeInt(length); /* length */
  this._writeInt(0); /* second */
  this._writeInt(0); /* millisecond */
};

/**
 * Write a byte value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeByte = function (value) {
  this._allocate(DATA_TYPES.BYTE_SIZEOF);

  this._buffer[this._offset++] = value & 0xFF;
};

/**
 * Write a char value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeChar = function (value) {
  this._allocate(DATA_TYPES.BYTE_SIZEOF);

  this._buffer[this._offset++] = value.codePointAt(0);
};

/**
 * Write a bytes array to the internal buffer
 * @param bytesCount
 * @param value
 */
PacketWriter.prototype._writeBytes = function (value) {
  const bytesCount = value.length;

  this._allocate(bytesCount);

  value.copy(this._buffer, this._offset, 0, bytesCount);

  this._offset += bytesCount;
};

/**
 * Write a short value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeShort = function (value) {
  this._allocate(DATA_TYPES.SHORT_SIZEOF);

  this._writeByte((value >> 8) & 0xFF);
  this._writeByte((value >> 0) & 0xFF);
};

/**
 * Write a integer value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeInt = function (value) {
  this._allocate(DATA_TYPES.INT_SIZEOF);

  this._writeByte((value >> 24) & 0xFF);
  this._writeByte((value >> 16) & 0xFF);
  this._writeByte((value >> 8) & 0xFF);
  this._writeByte((value >> 0) & 0xFF);
};

/**
 * Write a Long value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeLong = function (value) {
  // 64-bit signed, big-endian, through BigInt: splitting a Number into two
  // 32-bit halves by arithmetic got negative values wrong (-1 went out as
  // 4294967295) and threw on a BigInt argument.
  let big;

  if (typeof value === 'bigint') {
    big = value;
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    big = BigInt(value.trim());
  } else {
    // Anything that is not a number goes out as 0, as it always did.
    const n = Number(value);

    big = Number.isFinite(n) ? BigInt(Math.trunc(n)) : 0n;
  }

  this._allocate(DATA_TYPES.LONG_SIZEOF);
  this._buffer.writeBigInt64BE(BigInt.asIntN(64, big), this._offset);
  this._offset += DATA_TYPES.LONG_SIZEOF;
};

/**
 * Write a Floating point value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeFloat = function (value) {
  this._allocate(DATA_TYPES.FLOAT_SIZEOF);
  this._buffer.writeFloatBE(value, this._offset);
  this._offset += DATA_TYPES.FLOAT_SIZEOF;
};

/**
 * Write a Double precision value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeDouble = function (value) {
  this._allocate(DATA_TYPES.DOUBLE_SIZEOF);
  this._buffer.writeDoubleBE(value, this._offset);
  this._offset += DATA_TYPES.DOUBLE_SIZEOF;
};

/**
 * Write a Numeric value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeNumeric = function (value) {
  this._writeNullTerminatedString(value.toString(10));
};

/**
 * Write the specified value to the internal buffer
 * @param bytesCount
 * @param fillerValue
 */
PacketWriter.prototype._writeFiller = function (bytesCount, fillerValue) {
  let fillerVal;

  this._allocate(bytesCount);

  fillerValue = typeof fillerValue !== 'undefined' ? fillerValue : 0x00;

  if (typeof fillerValue === 'string') {
    fillerVal = fillerValue.codePointAt(0);
  } else {
    fillerVal = fillerValue & 0xFF;
  }

  for (let i = 0; i < bytesCount; i++) {
    this._buffer[this._offset++] = fillerVal;
  }
};

/**
 * Write a null-terminate string to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeNullTerminatedString = function (value) {
  // Typecast undefined into '' and numbers into strings.
  value = value ? '' + value : '';

  const stringLengthInBytes = Buffer.byteLength(value);
  this._allocate(
    // the length of the string
    DATA_TYPES.INT_SIZEOF +
        // the actual string
        stringLengthInBytes +
        // the terminating null of 1 byte length
        DATA_TYPES.BYTE_SIZEOF
  );

  // Write length in bytes.
  this._writeInt(stringLengthInBytes + /* `null` */ 1);

  this._buffer.write(value, this._offset, stringLengthInBytes);
  this._offset += stringLengthInBytes;

  //Write null-terminate
  this._buffer[this._offset++] = 0;
};

/**
 * Write a fixed-length string to the internal buffer
 * @param value
 * @param fillerValue
 * @param fixedLength
 */
PacketWriter.prototype._writeFixedLengthString = function (value, fillerValue, fixedLength) {
  let fillerVal;
  // Typecast undefined into '' and numbers into strings
  value = value || '';
  value = value + '';

  // UTF-8, as the server reads it. Each character used to be written as one
  // byte of its code point, so 'ä' went out as Latin-1 and anything beyond
  // U+00FF was mangled; and every character was written however long the
  // value was, so one longer than the field ran into the next field and the
  // packet came out longer than its own length said. Now the bytes are cut at
  // the field; OpenDatabasePacket refuses a value that does not fit at all.
  const bytes = Buffer.from(value, 'utf8');
  const count = Math.min(bytes.length, fixedLength);

  this._allocate(fixedLength);

  bytes.copy(this._buffer, this._offset, 0, count);
  this._offset += count;

  if (typeof fillerValue === 'string') {
    fillerVal = fillerValue.codePointAt(0);
  } else {
    fillerVal = fillerValue & 0xFF;
  }

  for (let j = 1; j <= fixedLength - count; j++) {
    this._buffer[this._offset++] = fillerVal;
  }
};

/**
 * Write a Date value to the internal buffer
 * @param year
 * @param month
 * @param day
 */
PacketWriter.prototype._writeDate = function (year, month, day) {
  this._writeDateTime(year, month, day, 0, 0, 0, 0);
};

/**
 * Write a DateTime value to the internal buffer
 * @param year
 * @param month
 * @param day
 * @param hour
 * @param min
 * @param sec
 * @param msec
 */
PacketWriter.prototype._writeDateTime = function (year, month, day, hour, min, sec, msec) {
  this._allocate(DATA_TYPES.DATETIME_SIZEOF);

  this._writeShort(year);
  // `month` in JS is `0` based; `9` is for October.
  // But in CoraDB we need to store the actual value.
  this._writeShort(month + 1);
  this._writeShort(day);
  this._writeShort(hour);
  this._writeShort(min);
  this._writeShort(sec);
  this._writeShort(msec);
};

/**
 * Write a Time value to the internal buffer
 * @param hour
 * @param minute
 * @param second
 */
PacketWriter.prototype._writeTime = function (hour, minute, second) {
  this._writeDateTime(0, /* month: `_writeDateTime` will do `+1` */-1, 0, hour, minute, second, 0);
};

/**
 * Write a Timestamp value to the internal buffer
 * @param year
 * @param month
 * @param day
 * @param hour
 * @param min
 * @param sec
 */
PacketWriter.prototype._writeTimestamp = function (year, month, day, hour, min, sec) {
  this._writeDateTime(year, month, day, hour, min, sec, 0);
};

/**
 * Write a Blob object value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeBlob = function (value) {
  writeLobHandle(this, value, CAS.CCILOBType.CCI_LOB_TYPE_BLOB);
};

/**
 * A LOB parameter: its packed handle, sent as received with only the LOB type
 * and the current size written in. The locator is copied byte for byte: it was
 * decoded as UTF-8 and encoded again, and a locator that is not valid UTF-8
 * changed length on the way while the declared length stayed the same, which
 * desynchronised the stream.
 */
function writeLobHandle(writer, value, lobType) {
  const handle = Buffer.from(value.packedLobHandle);

  handle.writeInt32BE(lobType, 0);
  handle.writeBigInt64BE(BigInt(value.lobLength), DATA_TYPES.INT_SIZEOF);

  writer._writeInt(handle.length);
  writer._writeBytes(handle);
}


/**
 * Write a Clob object value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeClob = function (value) {
  writeLobHandle(this, value, CAS.CCILOBType.CCI_LOB_TYPE_CLOB);
};

/**
 * Write a generic object value to the internal buffer
 * @param value
 */
PacketWriter.prototype._writeBuffer = function (value) {
  const count = value.length;

  this._allocate(count);
  value.copy(this._buffer, this._offset);
  this._offset += count;
};

//TODO Optimize the performance of this function
/**
 * Allocate space to the internal buffer
 * @param count
 * @private
 */
PacketWriter.prototype._allocate = function (count) {
  // Verify if we need to allocate more space
  const bytesRemaining = this._buffer.length - this._offset;

  if (bytesRemaining < count) {
    let oldBuffer = this._buffer;

    this._buffer = Buffer.alloc(oldBuffer.length + (count - bytesRemaining));

    oldBuffer.copy(this._buffer);
  }
};
