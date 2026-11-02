'use strict';

const CAS = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');
const ErrorMessages = require('../constants/ErrorMessages');
const { driverError } = require('../errors');
const ResultInfo = require('../resultset/ResultInfo');
const PacketWriter = require('./PacketWriter');
const { readColumnInfos, readExecuteTail, readFirstBatch, readRows, resultSetOf, returnsRows } = require('./ValueDecoder');

/**
 * Constructor
 * @param options
 * @constructor
 */
function PrepareExecutePacket(options) {
  this.options = options;
}

/**
 * Write prepare data
 * @param writer
 */
PrepareExecutePacket.prototype.writePrepare = function (writer) {
  const options = this.options;

  writer._writeInt(this.getPrepareBufferLength() - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE);
  writer._writeBytes(options.casInfo);
  writer._writeByte(CAS.CASFunctionCode.CAS_FC_PREPARE);
  writer._writeNullTerminatedString(options.sql);
  // HOLDABLE: a result that stays open across a commit (see ExecuteQueryPacket);
  // `prepareFlag` adds XASL_CACHE_PINNED when preparing again after
  // CAS_ER_STMT_POOLING.
  writer.addByte((options.holdable ? CAS.CCIPrepareOption.CCI_PREPARE_HOLDABLE : CAS.CCIPrepareOption.CCI_PREPARE_NORMAL) |
    (options.prepareFlag || 0));
  writer.addByte(options.autoCommit ? 1 : 0);

  return writer;
};

/**
 * Write execute data
 * @param writer
 */
PrepareExecutePacket.prototype.writeExecute = function (writer) {
  const bufferLength = this.getExecuteBufferLength();
  const options = this.options;

  writer._writeInt(bufferLength - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE);
  writer._writeBytes(options.casInfo);
  writer._writeByte(CAS.CASFunctionCode.CAS_FC_EXECUTE);
  writer.addInt(this.queryHandle);
  // Execute flag; see ExecuteQueryPacket for GET_GENERATED_KEYS. QUERY_ALL
  // (`executeMulti()`) runs every statement of the text and keeps each one's
  // result for NEXT_RESULT, as the JDBC driver's `execute()` asks for.
  writer.addByte((options.queryAll ? CAS.CCIExecutionOption.CCI_EXEC_QUERY_ALL : CAS.CCIExecutionOption.CCI_EXEC_NORMAL) |
    (options.holdable ? CAS.CCIExecutionOption.CCI_EXEC_HOLDABLE : 0) |
    (options.getGeneratedKeys ? CAS.CCIExecutionOption.CCI_EXEC_GET_GENERATED_KEYS : 0));
  writer.addInt(0); // Max col size;
  writer.addInt(0); // Max row size;
  writer.addNull(); // NULL
  writer._writeInt(DATA_TYPES.BYTE_SIZEOF);

  // FetchFlag;
  if (this.statementType === CAS.CoraDBStatementType.CORADB_STMT_SELECT) {
    writer._writeByte(1);
  } else {
    writer._writeByte(0);
  }

  // Autocommit mode; off when the generated keys are to be kept (see
  // ExecuteQueryPacket).
  writer.addByte(options.autoCommit && !options.getGeneratedKeys ? 1 : 0);
  writer.addByte(1); // Forward only cursor
  writer.addCacheTime(); // Write cache time

  writer.addInt(options.queryTimeout > 0 ? options.queryTimeout : 0); // Query timeout, in milliseconds

  if (options.paramValues) {
    this._writeParamValue(writer);
  }

  return writer;
};

/**
 * Read prepare data
 * @param parser
 */
PrepareExecutePacket.prototype.parsePrepare = function (parser) {
  const responseLength = parser._parseInt();
  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);

  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }

  this.queryHandle = this.responseCode; // Query handle
  this.resultCacheLifetime = parser._parseInt(); // Cache lifetime
  this.statementType = parser._parseByte(); // Statement type
  this.bindCount = parser._parseInt(); // Bind count
  this.isUpdatable = parser._parseByte() === 1; // Updatable?
  this.columnCount = parser._parseInt(); // Column count
  // Column descriptions: read by the shared decoder, which keeps a
  // collection's type and its element type apart.
  this.infoArray = readColumnInfos(parser, this.columnCount);
};

/**
 * Read execute data
 * @param parser
 */
PrepareExecutePacket.prototype.parseExecute = function (parser) {
  const options = this.options;
  const start = parser._offset;
  const responseLength = parser._parseInt();
  // Where this reply ends: the length counts what follows the CAS info.
  const end = start + DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE + responseLength;

  // No rows read yet, whatever the statement (see ExecuteQueryPacket).
  this.currentTupleCount = 0;

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);

  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }

  this.totalTupleCount = this.responseCode;

  // Cache reusable.
  parser._parseByte();

  // Number of results executed.
  this.resultCount = parser._parseInt();

  this.resultInfos = [];

  // Read result info.
  for (let i = 0; i < this.resultCount; i++) {
    let resultInfo = new ResultInfo();

    resultInfo.StmtType = parser._parseByte(); // Statement type
    resultInfo.ResultCount = parser._parseInt(); // Result count

    resultInfo.Oid = parser._parseBytes(DATA_TYPES.OID_SIZEOF); // OID

    resultInfo.CacheTimeSec = parser._parseInt(); // Cache time seconds
    resultInfo.CacheTimeUsec = parser._parseInt(); // Cache time milliseconds

    this.resultInfos.push(resultInfo);
  }

  // include_column_info (and with it, when set, the statement's description
  // as the server knows it after executing), then the shard id. The
  // description used to be skipped over as if it were not there.
  readExecuteTail(this, parser, options.protocolVersion);

  // A SELECT, and a CALL, EVALUATE or GET STATISTICS too: their value is a
  // result to fetch (see `returnsRows`).
  if (returnsRows(this.statementType)) {
    const rs = resultSetOf(this, readFirstBatch(this, parser, end));

    // In the order this packet has always given them.
    this.resultSet = {
      ColumnNames: rs.ColumnNames,
      ColumnDataTypes: rs.ColumnDataTypes,
      RowsCount: rs.RowsCount,
      ColumnValues: rs.ColumnValues,
    };
  }
};

/**
 * Read `tupleCount` rows with the shared decoder (see ValueDecoder). This path
 * — `sql()` with parameters, `cursor()`, `prepare().run()` — used to have its
 * own value reader, which did not know the time-zone types.
 * @param parser
 * @param tupleCount
 */
PrepareExecutePacket.prototype.getValues = function (parser, tupleCount) {
  return readRows(this, parser, tupleCount);
};

/**
 * Write parameter value to stream
 * @param value
 * @param type
 * @param writer
 */
PrepareExecutePacket.prototype._writeParamValue = function (writer) {
  const options = this.options;

  for (let i = 0, l = options.paramValues.length; i < l; ++i) {
    const value = options.paramValues[i];

    // NULL goes as the NULL type with an empty value, whatever type the
    // parameter was declared with — the way the CCI and JDBC drivers send it.
    if (value === null || value === undefined) {
      writer.addByte(CAS.CoraDBDataType.CCI_U_TYPE_NULL);
      writer.addNull();
      continue;
    }

    const paramType = CAS.getCoraDBDataTypeNumber(options.paramTypes[i]);

    if (isCollectionType(paramType)) {
      // Every collection goes as a SEQUENCE, whatever it was declared as, as
      // the JDBC driver binds them (UStatement.bindCollection()): the server
      // makes it the column's SET, MULTISET or LIST. Sent as a MULTISET, a
      // collection of strings was refused (-454, "Invalid data type
      // referenced").
      writer.addByte(CAS.CoraDBDataType.CCI_U_TYPE_SEQUENCE);

      // [length][element type][each element, with its length].
      const payload = this._collectionPayload(i);

      writer._writeInt(payload.length);
      writer._writeBytes(payload);
      continue;
    }

    writer.addByte(paramType);
    writeScalar(writer, paramType, value);
  }
};

function isCollectionType(type) {
  return type === CAS.CoraDBDataType.CCI_U_TYPE_SET ||
    type === CAS.CoraDBDataType.CCI_U_TYPE_MULTISET ||
    type === CAS.CoraDBDataType.CCI_U_TYPE_SEQUENCE;
}

/**
 * One value, with its length, as `type`. Throws for a type that cannot be
 * sent.
 */
function writeScalar(writer, type, value) {
  switch (type) {
    case CAS.CoraDBDataType.CCI_U_TYPE_CHAR:
    case CAS.CoraDBDataType.CCI_U_TYPE_NCHAR:
    case CAS.CoraDBDataType.CCI_U_TYPE_STRING:
    case CAS.CoraDBDataType.CCI_U_TYPE_VARNCHAR:
    case CAS.CoraDBDataType.CCI_U_TYPE_ENUM:
    case CAS.CoraDBDataType.CCI_U_TYPE_JSON:
      writer._writeNullTerminatedString(value);
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_SHORT:
      writer.addShort(value);
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_INT:
      writer.addInt(value);
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_BIGINT:
      writer.addLong(value);
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_FLOAT:
      writer.addFloat(value);
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_DOUBLE:
    case CAS.CoraDBDataType.CCI_U_TYPE_MONETARY:
      writer.addDouble(value);
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_NUMERIC:
      writer._writeNumeric(value);
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_DATE:
      writer.addDate(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_TIME:
      writer.addTime(value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds());
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_DATETIME:
      writer.addDateTime(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(),
        value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds());
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_TIMESTAMP:
      writer.addTimestamp(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(),
        value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds());
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_BIT:
    case CAS.CoraDBDataType.CCI_U_TYPE_VARBIT:
      writer.addBytes(value);
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_BLOB:
      writer._writeBlob(value);
      break;

    case CAS.CoraDBDataType.CCI_U_TYPE_CLOB:
      writer._writeClob(value);
      break;

    default:
      throw cannotSend(type);
  }
}

/**
 * A type no parameter can be sent as. `bind()` refuses these before a packet
 * is made, so this is only a guard — but a loud one: the OBJECT and RESULTSET
 * branches that were here declared one length and wrote another, which would
 * have put the connection out of step with the server, and the errors that
 * were returned instead of thrown were ignored by `writeExecute`, or added to
 * the packet's length as a string.
 */
function cannotSend(type) {
  return driverError('INVALID_DATA_TYPE', `${type}: ${ErrorMessages.ERROR_INVALID_DATA_TYPE}`);
}

/**
 * The element type of a collection given as a plain array: what its first
 * value that is not NULL is (a whole number INT, or BIGINT when it does not
 * fit; a fraction DOUBLE; a string VARCHAR; a boolean SHORT; a Date DATETIME;
 * a Buffer VARBIT). Empty or all NULL: NULL.
 *
 * `executeWithTypedParams()` and `sql()` work the element type out before
 * this (see params.js) and pass a CollectionValue; this is for a packet made
 * directly.
 */
function inferElementType(items) {
  const T = CAS.CoraDBDataType;

  for (const v of items) {
    if (v === null || v === undefined) continue;

    switch (typeof v) {
      case 'number':
        if (!Number.isInteger(v)) return T.CCI_U_TYPE_DOUBLE;
        return v >= -2147483648 && v <= 2147483647 ? T.CCI_U_TYPE_INT : T.CCI_U_TYPE_BIGINT;
      case 'bigint':
        return T.CCI_U_TYPE_BIGINT;
      case 'boolean':
        return T.CCI_U_TYPE_SHORT;
      case 'object':
        if (Buffer.isBuffer(v)) return T.CCI_U_TYPE_VARBIT;
        if (v instanceof Date) return T.CCI_U_TYPE_DATETIME;
        return T.CCI_U_TYPE_STRING;
      default:
        return T.CCI_U_TYPE_STRING;
    }
  }

  return T.CCI_U_TYPE_NULL;
}

/**
 * Parameter `index`, a SET, MULTISET or SEQUENCE, as it goes after its length:
 * the element type in one byte, then each element with its length (a NULL
 * element as an empty one). Made once, so the length the request declares and
 * the bytes it carries cannot differ.
 */
PrepareExecutePacket.prototype._collectionPayload = function (index) {
  this._collectionPayloads = this._collectionPayloads || [];

  if (this._collectionPayloads[index]) {
    return this._collectionPayloads[index];
  }

  const T = CAS.CoraDBDataType;
  const value = this.options.paramValues[index];
  const given = value && Array.isArray(value.items);
  const items = given ? value.items : (Array.isArray(value) ? value : []);
  const elementType = given
    ? (value.elementType === 'null' ? T.CCI_U_TYPE_NULL : CAS.getCoraDBDataTypeNumber(value.elementType))
    : inferElementType(items);
  const w = new PacketWriter(0);

  w._writeByte(elementType);

  for (const item of items) {
    if (item === null || item === undefined || elementType === T.CCI_U_TYPE_NULL) {
      w.addNull();
      continue;
    }

    if (given) {
      writeScalar(w, elementType, item);
      continue;
    }

    // A plain array: its values as they are, made to fit the inferred type.
    switch (elementType) {
      case T.CCI_U_TYPE_SHORT:
        w.addShort(Number(item));
        break;
      case T.CCI_U_TYPE_DATETIME:
      case T.CCI_U_TYPE_VARBIT:
      case T.CCI_U_TYPE_INT:
      case T.CCI_U_TYPE_BIGINT:
      case T.CCI_U_TYPE_DOUBLE:
        writeScalar(w, elementType, item);
        break;
      default:
        w._writeNullTerminatedString(String(item));
        break;
    }
  }

  this._collectionPayloads[index] = Buffer.from(w._toBuffer());

  return this._collectionPayloads[index];
};

PrepareExecutePacket.prototype.getPrepareBufferLength = function () {
  const bufferLength =
        DATA_TYPES.DATA_LENGTH_SIZEOF +
        DATA_TYPES.CAS_INFO_SIZE +
        DATA_TYPES.BYTE_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        Buffer.byteLength(this.options.sql) + 1 +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.BYTE_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.BYTE_SIZEOF;

  return bufferLength;
};

PrepareExecutePacket.prototype.getExecuteBufferLength = function () {
  const bufferLength = DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE +
        DATA_TYPES.BYTE_SIZEOF + DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF + DATA_TYPES.BYTE_SIZEOF + DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.BYTE_SIZEOF + DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.BYTE_SIZEOF + DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF + DATA_TYPES.INT_SIZEOF + DATA_TYPES.BYTE_SIZEOF +
        this._getParamValuesBufferLength();

  return bufferLength;
};

PrepareExecutePacket.prototype._getParamValuesBufferLength = function () {
  const options = this.options;

  let paramValuesBufferLength = 0;

  if (options.paramValues) {
    for (let i = options.paramValues.length - 1; i > -1; --i) {
      const value = options.paramValues[i];
      const paramType = CAS.getCoraDBDataTypeNumber(options.paramTypes[i]);

      // First, determine the size of the param type.
      paramValuesBufferLength +=
                // The length of the data type.
                DATA_TYPES.INT_SIZEOF +
                // The size of the value.
                DATA_TYPES.BYTE_SIZEOF;

      if (value === null || value === undefined) {
        // An empty value: its length, zero, and nothing after it.
        paramValuesBufferLength += DATA_TYPES.INT_SIZEOF;
        continue;
      }

      switch (paramType) {
        case CAS.CoraDBDataType.CCI_U_TYPE_CHAR:
        case CAS.CoraDBDataType.CCI_U_TYPE_NCHAR:
        case CAS.CoraDBDataType.CCI_U_TYPE_STRING:
        case CAS.CoraDBDataType.CCI_U_TYPE_VARNCHAR:
        case CAS.CoraDBDataType.CCI_U_TYPE_ENUM:
        case CAS.CoraDBDataType.CCI_U_TYPE_JSON:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The bytes length of the value.
                        Buffer.byteLength(value) +
                        // null character size.
                        DATA_TYPES.BYTE_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_SHORT:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The size of the value.
                        DATA_TYPES.SHORT_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_INT:
          paramValuesBufferLength +=
                        // The length of this part +
                        // the size of the value.
                        DATA_TYPES.INT_SIZEOF * 2;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_BIGINT:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The size of the value.
                        DATA_TYPES.LONG_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_FLOAT:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The size of the value.
                        DATA_TYPES.FLOAT_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_DOUBLE:
        case CAS.CoraDBDataType.CCI_U_TYPE_MONETARY:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The size of the value.
                        DATA_TYPES.DOUBLE_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_NUMERIC:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The bytes length of the numeric value.
                        // See `_writeNumeric`.
                        Buffer.byteLength(value.toString(10)) +
                        // null character size.
                        DATA_TYPES.BYTE_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_DATE:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The size of the data type value.
                        DATA_TYPES.DATE_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_TIME:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The size of the value.
                        DATA_TYPES.TIME_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_DATETIME:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The size of the value.
                        DATA_TYPES.DATETIME_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_TIMESTAMP:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The size of the value.
                        DATA_TYPES.TIMESTAMP_SIZEOF;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_SET:
        case CAS.CoraDBDataType.CCI_U_TYPE_MULTISET:
        case CAS.CoraDBDataType.CCI_U_TYPE_SEQUENCE:
          paramValuesBufferLength +=
                        // The length of this part, and the collection.
                        DATA_TYPES.INT_SIZEOF + this._collectionPayload(i).length;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_BIT:
        case CAS.CoraDBDataType.CCI_U_TYPE_VARBIT:
          paramValuesBufferLength +=
                        // The length of this part.
                        DATA_TYPES.INT_SIZEOF +
                        // The size of the value.
                        value.length;
          break;

        case CAS.CoraDBDataType.CCI_U_TYPE_BLOB:
        case CAS.CoraDBDataType.CCI_U_TYPE_CLOB:
          paramValuesBufferLength +=
                        // The length of this part, then the packed LOB
                        // handle as it is (see `writeLobHandle`).
                        DATA_TYPES.INT_SIZEOF + value.packedLobHandle.length;
          break;

        default:
          throw cannotSend(paramType);
      }

    }
  }

  return paramValuesBufferLength;
};

module.exports = PrepareExecutePacket;
