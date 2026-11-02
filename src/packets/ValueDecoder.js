'use strict';

const CAS = require('../constants/CASConstants');
const ColumnMetaData = require('../resultset/ColumnMetaData');
const DATA_TYPES = require('../constants/DataTypes');

/*
 * One decoder for every reply that carries rows: PREPARE_AND_EXECUTE
 * (ExecuteQueryPacket), EXECUTE (PrepareExecutePacket) and FETCH (which reads
 * through whichever of the two owns the handle).
 *
 * Each packet used to carry its own copy of the value switch, and the copies
 * had drifted apart: the EXECUTE one did not know the time-zone types, so the
 * same column read correctly through `query()` and wrongly through `sql()` with
 * parameters. Both also answered an unknown type with an Error object *as the
 * cell value* and did not skip its bytes, so every column after it, in every
 * row after it, was read from the wrong place.
 *
 * The rule here is that a value is always exactly `size` bytes: whatever is
 * decoded, the reader ends up at the start of the next value. A type this
 * driver cannot decode comes back as `{ type, typeCode, raw }`, never as an
 * Error, and never at the cost of the rest of the row.
 */

const T = CAS.CoraDBDataType;

const MASK = CAS.ColumnTypeMask;

/**
 * Read a type as the CAS sends it: one byte, or two when the first has the
 * high bit set (protocol V7 and later). The bits of the first byte name the
 * collection, if the value is one, and — of two bytes — the charset of a
 * string; the second byte is the type, or a collection's element type. A
 * collection keeps both halves: the column is a SET (or MULTISET, SEQUENCE)
 * and `elementType` is what it holds. The second byte used to overwrite the
 * first, so a SET OF INT column was read as a plain INT.
 *
 * A single byte (protocols before V7) carries the collection bits too, with
 * the type in its low five bits.
 *
 * @return {{ type: number, elementType: (number|undefined), charset: (string|null), length: number }}
 */
function readType(parser) {
  const first = parser._parseByte();
  const twoBytes = (first & MASK.HAS_2_BYTES) !== 0;
  const base = twoBytes ? parser._parseByte() : first & MASK.TYPE;
  const resolved = CAS.confirmColumnType(first & MASK.COLLECTION, base);
  const collection = (first & MASK.COLLECTION) !== 0;

  return {
    type: resolved.columnType,
    elementType: collection ? resolved.elementType : undefined,
    charset: twoBytes ? CAS.getCharsetEncoding(first & MASK.CHARSET) : null,
    length: twoBytes ? 2 : 1,
  };
}

/** Put what `readType` read on a column's description. */
function applyType(info, t) {
  info.ColumnType = t.type;
  if (t.elementType !== undefined) {
    info.CollectionElementType = t.elementType;
  }
  info.Charset = t.charset;
}

/** One column's description, as PREPARE and include_column_info send it. */
function readColumnInfo(parser) {
  const info = new ColumnMetaData();
  let len;

  applyType(info, readType(parser));
  info.scale = parser._parseShort(); // Scale
  info.precision = parser._parseInt(); // Precision
  len = parser._parseInt();
  info.Name = parser._parseNullTerminatedString(len); // Column name
  len = parser._parseInt();
  info.RealName = parser._parseNullTerminatedString(len); // Column real name
  len = parser._parseInt();
  info.TableName = parser._parseNullTerminatedString(len); // Table name
  info.IsNullable = (parser._parseByte() === 1); // Nullable?
  len = parser._parseInt();
  info.DefaultValue = parser._parseNullTerminatedString(len); // Default value
  info.IsAutoIncrement = (parser._parseByte() === 1); // Auto-increment?
  info.IsUniqueKey = (parser._parseByte() === 1); // Unique key?
  info.IsPrimaryKey = (parser._parseByte() === 1); // Primary key?
  info.IsReverseIndex = (parser._parseByte() === 1); // Reverse index?
  info.IsReverseUnique = (parser._parseByte() === 1); // Reverse unique?
  info.IsForeignKey = (parser._parseByte() === 1); // Foreign key?
  info.IsShared = (parser._parseByte() === 1); // Shared?

  return info;
}

/**
 * The short description GET_GENERATED_KEYS sends for each column: its type,
 * scale, precision and name, and nothing else.
 */
function readShortColumnInfo(parser) {
  const info = new ColumnMetaData();

  applyType(info, readType(parser));
  info.scale = parser._parseShort();
  info.precision = parser._parseInt();
  info.Name = parser._parseNullTerminatedString(parser._parseInt());

  return info;
}

function readColumnInfos(parser, count) {
  const infos = new Array(count);

  for (let i = 0; i < count; ++i) {
    infos[i] = readColumnInfo(parser);
  }

  return infos;
}

/**
 * The part of an EXECUTE reply that follows the result infos: the
 * include_column_info flag (protocol V2+), with the statement's description
 * when it is 1, and the shard id (V5+).
 *
 * The flag is 1 when the server only learnt the result's shape at execute
 * time — a CALL, or a `?` in the select list. The description was ignored, and
 * everything after it (shard id, fetch code, the rows) was read from inside it.
 */
function readExecuteTail(packet, parser, protocolVersion) {
  if (protocolVersion > 1) {
    const includesColumnInfo = parser._parseByte();

    if (includesColumnInfo === 1) {
      packet.resultCacheLifetime = parser._parseInt();
      packet.statementType = parser._parseByte();
      packet.bindCount = parser._parseInt();
      packet.isUpdatable = (parser._parseByte() === 1);
      packet.columnCount = parser._parseInt();
      packet.infoArray = readColumnInfos(parser, packet.columnCount);
    }
  }

  if (protocolVersion > 4) {
    packet.shardId = parser._parseInt();
  }
}

// --- numbers that do not fit a JavaScript number ---------------------------------

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * A BIGINT: a number when it is one exactly, its decimal text otherwise. A
 * BIGINT key above 2^53 used to come back rounded, so the row it named could
 * not be found again.
 */
function bigintValue(big) {
  return big >= MIN_SAFE && big <= MAX_SAFE ? Number(big) : big.toString();
}

/** `n` written out without an exponent, the way the server writes a NUMERIC. */
function plainNumberText(n) {
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);

  if (!m) {
    return s;
  }

  const digits = m[2] + (m[3] || '');
  const point = m[2].length + Number(m[4]);

  if (point <= 0) {
    return `${m[1]}0.${'0'.repeat(-point)}${digits}`;
  }

  if (point >= digits.length) {
    return m[1] + digits + '0'.repeat(point - digits.length);
  }

  return `${m[1]}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Decimal text with the zeros that do not change its value removed. */
function canonicalDecimal(text) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);

  if (!m) {
    return null;
  }

  const int = m[2].replace(/^0+/, '');
  const frac = (m[3] || '').replace(/0+$/, '');

  if (!int && !frac) {
    return '0';
  }

  return (m[1] === '-' ? '-' : '') + (int || '0') + (frac ? `.${frac}` : '');
}

/**
 * A NUMERIC: a number when `Number()` keeps its value exactly, its text
 * otherwise. `123.40` is the number 123.4; `12345678901234567890` and
 * `0.1000000000000000055` stay strings, because as numbers they would be
 * different values.
 */
function numericValue(text) {
  const t = String(text).trim();
  const n = Number(t);

  if (t === '' || !Number.isFinite(n)) {
    return t;
  }

  const canonical = canonicalDecimal(t);

  return canonical !== null && canonical === canonicalDecimal(plainNumberText(n)) ? n : t;
}

// --- values ------------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A GRAPH_OBJECT (a vertex or an edge). CoraDB does not document its layout,
 * so it is not guessed at: one that is text (the server's JSON rendering) is
 * returned as that text, anything else as its bytes.
 */
function graphValue(bytes) {
  let end = bytes.length;

  if (end > 0 && bytes[end - 1] === 0) {
    end -= 1;
  }

  const body = bytes.subarray(0, end);

  if (!body.includes(0)) {
    try {
      return utf8.decode(body);
    } catch (err) {
      void err; // not text
    }
  }

  return { type: 'GraphObject', raw: Buffer.from(bytes) };
}

function unknownValue(type, bytes) {
  const name = CAS.getCoraDBDataTypeName(type);

  return {
    type: name === 'UNKNOWN' ? 'Unknown' : name,
    typeCode: type,
    raw: Buffer.from(bytes),
  };
}

/**
 * A SET, MULTISET or SEQUENCE: element type, count, then (size, value) each.
 * String elements are decoded in the column's charset.
 */
function readCollection(parser, end, charset) {
  const elementType = parser._parseByte();
  const count = parser._parseInt();
  const values = [];

  for (let i = 0; i < count; ++i) {
    if (parser._offset + DATA_TYPES.INT_SIZEOF > end) {
      throw new RangeError('A collection runs past the end of its value.');
    }

    const size = parser._parseInt();

    if (size <= 0) {
      values.push(null);
      continue;
    }

    if (parser._offset + size > end) {
      throw new RangeError('A collection element runs past the end of its value.');
    }

    values.push(readValue(parser, elementType, size, charset));
  }

  return values;
}

function decode(parser, type, size, start, end, charset) {
  const buffer = parser._buffer;

  switch (type) {
    case T.CCI_U_TYPE_CHAR:
    case T.CCI_U_TYPE_NCHAR:
    case T.CCI_U_TYPE_STRING:
    case T.CCI_U_TYPE_VARNCHAR:
    case T.CCI_U_TYPE_ENUM:
    case T.CCI_U_TYPE_JSON:
      return parser._parseNullTerminatedString(size, charset);

    case T.CCI_U_TYPE_SHORT:
      // Signed. It was read as unsigned, so -1 came back as 65535.
      return buffer.readInt16BE(start);

    case T.CCI_U_TYPE_INT:
      return buffer.readInt32BE(start);

    case T.CCI_U_TYPE_BIGINT:
      return bigintValue(buffer.readBigInt64BE(start));

    case T.CCI_U_TYPE_FLOAT:
      return buffer.readFloatBE(start);

    case T.CCI_U_TYPE_DOUBLE:
    case T.CCI_U_TYPE_MONETARY:
      return buffer.readDoubleBE(start);

    case T.CCI_U_TYPE_NUMERIC:
      return numericValue(parser._parseNullTerminatedString(size));

    case T.CCI_U_TYPE_DATE:
      return parser._parseDate();

    case T.CCI_U_TYPE_TIME:
      return parser._parseTime();

    case T.CCI_U_TYPE_DATETIME:
      return parser._parseDateTime();

    case T.CCI_U_TYPE_TIMESTAMP:
      return parser._parseTimeStamp();

    case T.CCI_U_TYPE_TIMESTAMPTZ:
    case T.CCI_U_TYPE_TIMESTAMPLTZ:
      return parser._parseTimeStampTz(size);

    case T.CCI_U_TYPE_DATETIMETZ:
    case T.CCI_U_TYPE_DATETIMELTZ:
      return parser._parseDateTimeTz(size);

    case T.CCI_U_TYPE_OBJECT:
      return parser._parseObject();

    case T.CCI_U_TYPE_BIT:
    case T.CCI_U_TYPE_VARBIT:
      // A copy: a view would keep the whole reply alive for as long as the
      // caller keeps this one value.
      return Buffer.from(buffer.subarray(start, end));

    case T.CCI_U_TYPE_SET:
    case T.CCI_U_TYPE_MULTISET:
    case T.CCI_U_TYPE_SEQUENCE:
      return readCollection(parser, end, charset);

    case T.CCI_U_TYPE_BLOB:
      return parser.readBlob(size);

    case T.CCI_U_TYPE_CLOB:
      return parser.readClob(size);

    case T.CCI_U_TYPE_RESULTSET:
      return null; // Not supported; skipped by its size below.

    case T.CCI_U_TYPE_NULL:
      return null;

    case T.CCI_U_TYPE_GRAPH_OBJECT:
      return graphValue(buffer.subarray(start, end));

    default:
      return unknownValue(type, buffer.subarray(start, end));
  }
}

/**
 * Read one value of `type` that is `size` bytes long, and leave the reader at
 * the byte after it whatever happens.
 *
 * A value that claims to run past the end of the reply throws: the reply is
 * broken, and the connection has to go (see `_parseBuffer`). A value that fits
 * but cannot be decoded is returned as its bytes.
 *
 * `charset` is the Node.js encoding strings are decoded with (UTF-8 when it is
 * not given): the column's, from its type (see `readType`).
 */
function readValue(parser, type, size, charset) {
  const start = parser._offset;
  const end = start + size;

  if (!(size >= 0) || end > parser._buffer.length) {
    throw new RangeError(`A value of ${size} bytes runs past the end of the reply.`);
  }

  try {
    return decode(parser, type, size, start, end, charset);
  } catch (err) {
    void err;
    return unknownValue(type, parser._buffer.subarray(start, end));
  } finally {
    parser._offset = end;
  }
}

/**
 * Read `tupleCount` rows for `packet` (whose `infoArray`, `columnCount` and
 * `statementType` describe them), and count them as read.
 */
function readRows(packet, parser, tupleCount) {
  const rows = new Array(tupleCount);
  const columns = packet.infoArray;
  const columnCount = packet.columnCount;
  const statementType = packet.statementType;
  // The result of a CALL or EVALUATE has no column types of its own: each
  // value carries one.
  const valuesCarryType =
    statementType === CAS.CoraDBStatementType.CORADB_STMT_CALL ||
    statementType === CAS.CoraDBStatementType.CORADB_STMT_EVALUATE ||
    statementType === CAS.CoraDBStatementType.CORADB_STMT_CALL_SP;

  for (let i = 0; i < tupleCount; ++i) {
    // Row index, then the row's OID: neither is needed.
    parser._parseInt();
    parser._offset += DATA_TYPES.OID_SIZEOF;

    const row = rows[i] = new Array(columnCount);

    for (let j = 0; j < columnCount; ++j) {
      let size = parser._parseInt();

      if (size <= 0) {
        row[j] = null;
        continue;
      }

      let type = columns[j].ColumnType;
      let charset = columns[j].Charset;

      if (valuesCarryType || type === T.CCI_U_TYPE_NULL) {
        const t = readType(parser);

        type = t.type;
        charset = t.charset;
        size -= t.length;
      }

      row[j] = size > 0 ? readValue(parser, type, size, charset) : null;
    }
  }

  packet.currentTupleCount = (packet.currentTupleCount || 0) + tupleCount;

  return rows;
}

/**
 * The statement types whose execution leaves a result to fetch. Not only a
 * SELECT: a CALL's return value, an EVALUATE's value and GET STATISTICS come
 * back as one-row results too, as the JDBC driver reads them. They were taken
 * for statements without rows, so `queryAll()` failed on them with a
 * TypeError, and `sql()` lost the value.
 */
const ROW_STATEMENT_TYPES = new Set([
  CAS.CoraDBStatementType.CORADB_STMT_SELECT,
  CAS.CoraDBStatementType.CORADB_STMT_CALL,
  CAS.CoraDBStatementType.CORADB_STMT_EVALUATE,
  CAS.CoraDBStatementType.CORADB_STMT_GET_STATS,
  CAS.CoraDBStatementType.CORADB_STMT_CALL_SP,
]);

function returnsRows(statementType) {
  return ROW_STATEMENT_TYPES.has(statementType);
}

/**
 * The rows that come with an EXECUTE reply, after its tail: a fetch code, a
 * row count and the rows. A SELECT always has them. The other row-returning
 * statements may not (the CAS sends them only for a fetch request), so for
 * those they are read only when the reply goes on past the tail — `end` is
 * where the reply ends — and otherwise the first batch is empty and the rows
 * are fetched.
 */
function readFirstBatch(packet, parser, end) {
  packet.currentTupleCount = 0;

  if (packet.statementType !== CAS.CoraDBStatementType.CORADB_STMT_SELECT &&
      parser._offset + 2 * DATA_TYPES.INT_SIZEOF > end) {
    packet.tupleCount = 0;
    return [];
  }

  parser._parseInt(); // Fetch code
  packet.tupleCount = parser._parseInt(); // Tuple count

  return readRows(packet, parser, packet.tupleCount);
}

/** The result set the original API hands out, around the first batch. */
function resultSetOf(packet, columnValues) {
  const columnNames = new Array(packet.columnCount);
  const columnDataTypes = new Array(packet.columnCount);

  for (let i = 0; i < packet.columnCount; i++) {
    columnNames[i] = packet.infoArray[i].Name;
    columnDataTypes[i] = CAS.getCoraDBDataTypeName(packet.infoArray[i].ColumnType);
  }

  return {
    ColumnDataTypes: columnDataTypes,
    ColumnNames: columnNames,
    ColumnValues: columnValues,
    RowsCount: packet.totalTupleCount,
  };
}

module.exports = {
  bigintValue,
  numericValue,
  readColumnInfo,
  readColumnInfos,
  readExecuteTail,
  readFirstBatch,
  readRows,
  readShortColumnInfo,
  readType,
  readValue,
  resultSetOf,
  returnsRows,
};
