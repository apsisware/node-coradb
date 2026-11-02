'use strict';

const CAS = require('../constants/CASConstants');
const ColumnMetaData = require('../resultset/ColumnMetaData');
const DATA_TYPES = require('../constants/DataTypes');
const NoopLogger = require('../NoopLogger');
const { readType } = require('./ValueDecoder');
const { driverError } = require('../errors');
const ErrorMessages = require('../constants/ErrorMessages');

module.exports = GetSchemaPacket;

/**
 * The schema types whose rows this packet knows how to read. A reply for any
 * other type was read with no field taken off the stream, so every row after
 * the first came from the wrong offset and the result was an array of
 * `undefined` (see `getSchema()`, which refuses the others before sending).
 */
GetSchemaPacket.SUPPORTED_TYPES = new Set([
  CAS.CoraDBSchemaType.CCI_SCH_CLASS,
  CAS.CoraDBSchemaType.CCI_SCH_VCLASS,
  CAS.CoraDBSchemaType.CCI_SCH_ATTRIBUTE,
  CAS.CoraDBSchemaType.CCI_SCH_CONSTRAINT,
  CAS.CoraDBSchemaType.CCI_SCH_CLASS_PRIVILEGE,
  CAS.CoraDBSchemaType.CCI_SCH_PRIMARY_KEY,
  CAS.CoraDBSchemaType.CCI_SCH_IMPORTED_KEYS,
  CAS.CoraDBSchemaType.CCI_SCH_EXPORTED_KEYS,
]);

/**
 * Whether the table name (and the column name) is a LIKE pattern or an exact
 * name, as the JDBC driver's DatabaseMetaData asks:
 *
 *  - CONSTRAINT (getIndexInfo()): the exact table name — `_` in a name such as
 *    athlete_result is not a wildcard there;
 *  - ATTRIBUTE (getColumns()): the table name is a pattern only when it is
 *    missing or holds `%` or `_`;
 *  - the others: both are patterns.
 */
GetSchemaPacket.patternFlag = function (schemaType, tableName) {
  const CLASS = CAS.CCISchemaPatternMatchFlag.CCI_CLASS_NAME_PATTERN_MATCH;
  const ATTR = CAS.CCISchemaPatternMatchFlag.CCI_ATTR_NAME_PATTERN_MATCH;

  switch (schemaType) {
    case CAS.CoraDBSchemaType.CCI_SCH_CONSTRAINT:
      return ATTR;
    case CAS.CoraDBSchemaType.CCI_SCH_ATTRIBUTE:
      return (!tableName || /[%_]/.test(tableName) ? CLASS : 0) | ATTR;
    default:
      return CLASS | ATTR;
  }
};

/**
 * Constructor
 * @param options
 * @constructor
 */
function GetSchemaPacket(options) {
  this.options = options;

  typeof options.shardId === 'undefined' && (options.shardId = 0);
  typeof options.logger === 'undefined' && (options.logger = new NoopLogger());
}

/**
 * Write request schema data
 * @param writer
 */
GetSchemaPacket.prototype.writeRequestSchema = function (writer) {
  const options = this.options;

  writer._writeInt(this.getRequestSchemaBufferLength() - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE);
  writer._writeBytes(options.casInfo);
  writer._writeByte(CAS.CASFunctionCode.CAS_FC_SCHEMA_INFO);

  writer.addInt(options.schemaType);

  if (options.tableNamePattern) {
    // arg1: Table name pattern
    writer._writeNullTerminatedString(options.tableNamePattern);
  } else {
    // Null; this is where restrictions should go - arg1: tableNamePattern
    writer.addNull();
  }

  // arg2:
  writer.addNull();

  // Pattern match flag, per type as the JDBC driver sends it.
  writer.addByte(GetSchemaPacket.patternFlag(options.schemaType, options.tableNamePattern));

  if (options.protocolVersion > 4) {
    writer.addInt(options.shardId);
  }

  return writer;
};

/**
 * Write fetch schema data
 * @param writer
 */
GetSchemaPacket.prototype.writeFetchSchema = function (writer) {
  const options = this.options;

  writer._writeInt(this.getFetchSchemaBufferLength() - DATA_TYPES.DATA_LENGTH_SIZEOF - DATA_TYPES.CAS_INFO_SIZE);
  writer._writeBytes(options.casInfo);

  writer._writeByte(CAS.CASFunctionCode.CAS_FC_FETCH);
  writer.addInt(this.responseCode); // ServerHandler
  // From the first row not read yet: a CAS may send fewer rows than asked
  // for, and the rest are then fetched (see `needsMoreRows()`).
  writer.addInt(this.rowsRead() + 1); // Start position
  writer.addInt(Math.max(0, this.resultTuple - this.rowsRead()));
  writer.addByte(0); // Is case sensitive
  writer.addInt(0); // Is the ResultSet index...?

  return writer;
};

/**
 * Read request schema data
 * @param parser
 */
GetSchemaPacket.prototype.parseRequestSchema = function (parser) {
  const responseLength = parser._parseInt();

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);
  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }

  // The server handle the result lives under. It has to be closed once the
  // rows are read (see `_getSchema`); it used to be left open, one per call.
  this.queryHandle = this.responseCode;
  this.resultTuple = parser._parseInt(); // Result tuple
  const numColInfo = parser._parseInt(); // Number of columns

  this.infoArray = [];

  for (let i = 0; i < numColInfo; ++i) {
    let info = new ColumnMetaData();

    // One byte, or two (a collection and its element type kept apart).
    const t = readType(parser);

    info.ColumnType = t.type;
    if (t.elementType !== undefined) {
      info.CollectionElementType = t.elementType;
    }
    info.scale = parser._parseShort(); // Scale
    info.precision = parser._parseInt(); // Precision

    const len = parser._parseInt();
    info.Name = parser._parseNullTerminatedString(len); // Column name

    this.infoArray.push(info);
  }
};

/** A schema row's number, at the size it is sent at; null for NULL. */
function readSchemaNumber(parser) {
  const length = parser._parseInt();

  switch (length) {
    case DATA_TYPES.SHORT_SIZEOF:
      return parser._parseShort();
    case DATA_TYPES.INT_SIZEOF:
      return parser._parseInt();
    default:
      parser._offset += Math.max(length, 0);
      return null;
  }
}

/** A schema row's string; null for NULL. */
function readSchemaString(parser) {
  const length = parser._parseInt();

  return length > 0 ? parser._parseNullTerminatedString(length) : null;
}

/** A schema row's value the driver does not use. */
function skipSchemaValue(parser) {
  const length = parser._parseInt();

  parser._offset += Math.max(length, 0);
}

/**
 * Read fetch schema data
 * @param parser
 */
GetSchemaPacket.prototype.parseFetchSchema = function (parser) {
  const options = this.options;
  const responseLength = parser._parseInt();

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);

  this.responseCode = parser._parseInt();

  if (this.responseCode !== 0) {
    return parser.readError(responseLength);
  }

  this.tupleCount = parser._parseInt();

  let length;
  let SchemaInfo = new Array(this.tupleCount);

  for (let i = 0; i < this.tupleCount; ++i) {
    // Column index.
    parser._parseInt();

    // OID
    parser._parseBytes(DATA_TYPES.OID_SIZEOF);

    switch (options.schemaType) {
      case CAS.CoraDBSchemaType.CCI_SCH_CLASS: {
        length = parser._parseInt();
        // Table name
        const Name = parser._parseNullTerminatedString(length);
        // Always = 2 - Indicates that Table type is a short value
        parser._parseInt(); // the length of the value after it, which is a fixed size
        // Table type
        const Type = parser._parseShort();
        const TypeName = CAS.getCoraDBClassTypeName(Type);

        // CoraDB appends a comment/remarks field to the class schema result.
        length = parser._parseInt();
        parser._parseNullTerminatedString(length); // Class comment

        options.logger.debug(`Class Name: ${Name}, Type: ${Type}, TypeName: ${TypeName}`);

        SchemaInfo[i] = { Name, Type, TypeName };

        break;
      }
      case CAS.CoraDBSchemaType.CCI_SCH_VCLASS: {
        length = parser._parseInt();
        // View name
        const Name = parser._parseNullTerminatedString(length);
        parser._parseInt(); // the length of the value after it, which is a fixed size
        // View type
        const Type = parser._parseShort();
        const TypeName = CAS.getCoraDBClassTypeName(Type);

        // CoraDB appends a comment/remarks field to the vclass schema result.
        length = parser._parseInt();
        parser._parseNullTerminatedString(length); // View comment

        SchemaInfo[i] = { Name, Type, TypeName };

        break;
      }
      case CAS.CoraDBSchemaType.CCI_SCH_ATTRIBUTE: {
        length = parser._parseInt();
        // Column name
        const Name = parser._parseNullTerminatedString(length);
        parser._parseInt(); // the length of the value after it, which is a fixed size
        // sch_attribute_domain: the column data type. The low byte holds the
        // CoraDB data-type code (the high bit is a flag).
        const Type = parser._parseShort() & 0xFF;
        const TypeName = CAS.getCoraDBDataTypeName(Type);
        parser._parseInt(); // the length of the value after it, which is a fixed size
        const Scale = parser._parseShort();
        parser._parseInt(); // the length of the value after it, which is a fixed size
        const Precision = parser._parseInt();
        parser._parseInt(); // the length of the value after it, which is a fixed size
        // sch_attribute_indexed
        parser._parseShort();
        parser._parseInt(); // the length of the value after it, which is a fixed size
        const NonNull = (parser._parseShort() === 1);
        parser._parseInt(); // the length of the value after it, which is a fixed size
        // sch_attribute_shared
        parser._parseShort();
        parser._parseInt(); // the length of the value after it, which is a fixed size
        const Unique = (parser._parseShort() === 1);
        length = parser._parseInt();

        // If `length > 0` the column has a default value
        if (length) {
          parser._parseNullTerminatedString(length); // Default value
        }

        parser._parseInt(); // the length of the value after it, which is a fixed size
        // sch_attribute_attr_order
        parser._parseInt();
        length = parser._parseInt();
        const ClassName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const SourceClass = parser._parseNullTerminatedString(length);
        parser._parseInt(); // the length of the value after it, which is a fixed size
        const IsKey = (parser._parseShort() === 1);

        // CoraDB appends a per-column comment/remarks field to the attribute schema result.
        length = parser._parseInt();
        parser._parseNullTerminatedString(length); // Column comment

        SchemaInfo[i] = {
          Name,
          Type,
          TypeName,
          Scale,
          Precision,
          NonNull,
          Unique,
          ClassName,
          SourceClass,
          IsKey
        };

        break;
      }
      case CAS.CoraDBSchemaType.CCI_SCH_CONSTRAINT: {
        // TYPE, NAME, ATTR_NAME, NUM_PAGES, NUM_KEYS, PRIMARY_KEY, KEY_ORDER,
        // then whatever the server adds (ASC_DESC...), as the column list of
        // the reply says. Each number is read at the size it is sent at:
        // NUM_PAGES and NUM_KEYS are ints, and reading them as shorts put
        // every field after them out of step (a table with any index broke
        // the reply). The JDBC driver reads them the same way, by type.
        const Type = readSchemaNumber(parser);
        const ConstraintName = readSchemaString(parser);
        const AttributeName = readSchemaString(parser);
        const NumPages = readSchemaNumber(parser);
        const NumKeys = readSchemaNumber(parser);
        const PrimaryKey = readSchemaNumber(parser) === 1;
        const KeyOrder = readSchemaNumber(parser);

        for (let k = 7; k < this.infoArray.length; ++k) {
          skipSchemaValue(parser);
        }

        SchemaInfo[i] = {
          ConstraintName,
          AttributeName,
          Type,
          PrimaryKey,
          NumPages,
          NumKeys,
          KeyOrder,
        };
        break;
      }
      case CAS.CoraDBSchemaType.CCI_SCH_EXPORTED_KEYS: {
        length = parser._parseInt();
        const PkTableName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const PkColumnName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const FkTableName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const FkColumnName = parser._parseNullTerminatedString(length);
        parser._parseInt(); // the length of the value after it, which is a fixed size
        // Sequence type: sch_exported_keys_keySeq
        parser._parseShort();
        parser._parseInt(); // the length of the value after it, which is a fixed size
        const UpdateAction = parser._parseShort();
        parser._parseInt(); // the length of the value after it, which is a fixed size
        const DeleteAction = parser._parseShort();
        length = parser._parseInt();
        const FkName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const PkName = parser._parseNullTerminatedString(length);

        SchemaInfo[i] = {
          FkName,
          PkName,
          FkTableName,
          PkTableName,
          FkColumnName,
          PkColumnName,
          UpdateAction,
          DeleteAction
        };

        break;
      }
      case CAS.CoraDBSchemaType.CCI_SCH_IMPORTED_KEYS: {
        length = parser._parseInt();
        const PkTableName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const PkColumnName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const FkTableName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const FkColumnName = parser._parseNullTerminatedString(length);
        parser._parseInt(); // the length of the value after it, which is a fixed size
        // Sequence type: sch_imported_keys_keySeq
        parser._parseShort();
        parser._parseInt(); // the length of the value after it, which is a fixed size
        const UpdateAction = parser._parseShort();
        parser._parseInt(); // the length of the value after it, which is a fixed size
        const DeleteAction = parser._parseShort();
        length = parser._parseInt();
        const FkName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const PkName = parser._parseNullTerminatedString(length);

        SchemaInfo[i] = {
          FkName,
          PkName,
          FkTableName,
          PkTableName,
          FkColumnName,
          PkColumnName,
          UpdateAction,
          DeleteAction
        };
        break;
      }
      case CAS.CoraDBSchemaType.CCI_SCH_PRIMARY_KEY: {
        length = parser._parseInt();
        const TableName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const ColumnName = parser._parseNullTerminatedString(length);
        parser._parseInt(); // the length of the value after it, which is a fixed size
        // Sequence type: sch_primary_key_keySeq
        parser._parseInt();
        length = parser._parseInt();
        const KeyName = parser._parseNullTerminatedString(length);

        SchemaInfo[i] = {
          TableName,
          ColumnName,
          KeyName
        };

        break;
      }
      case CAS.CoraDBSchemaType.CCI_SCH_CLASS_PRIVILEGE: {
        length = parser._parseInt();
        const TableName = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        const Privilege = parser._parseNullTerminatedString(length);
        length = parser._parseInt();
        // Grantable ('YES' or 'NO')
        const Grantable = (parser._parseNullTerminatedString(length) === 'YES');

        SchemaInfo[i] = {
          TableName,
          Privilege,
          Grantable
        };
      }
        break;
      default:
        // Not readable: stop rather than read the rest from the wrong offset.
        return driverError('INVALID_SCHEMA_TYPE', `${ErrorMessages.ERROR_INVALID_SCHEMA_TYPE} ${options.schemaType} cannot be read.`);
    }
  }

  // Added to the rows of the fetches before. A reply with fewer rows than
  // the result has is followed by another fetch: there used to be only one,
  // and a CAS that limits a reply's size cut the schema short without a word.
  this.schemaInfo = (this.schemaInfo || []).concat(SchemaInfo);
};

/** How many of the result's rows have been read. */
GetSchemaPacket.prototype.rowsRead = function () {
  return this.schemaInfo ? this.schemaInfo.length : 0;
};

/**
 * Whether to fetch again: rows are missing, and the last fetch brought some
 * (one that brings none means the server has no more, whatever it counted).
 */
GetSchemaPacket.prototype.needsMoreRows = function () {
  return this.tupleCount > 0 && this.rowsRead() < this.resultTuple;
};

GetSchemaPacket.prototype.getRequestSchemaBufferLength = function () {
  const options = this.options;

  let bufferLength =
        // Total length of the request without itself and CAS info.
        DATA_TYPES.DATA_LENGTH_SIZEOF +
        // CAS info.
        DATA_TYPES.CAS_INFO_SIZE +
        // CAS function.
        DATA_TYPES.BYTE_SIZEOF +
        // The length of the next part.
        DATA_TYPES.INT_SIZEOF +
        // Schema type.
        DATA_TYPES.INT_SIZEOF +
        // The length of the next part.
        DATA_TYPES.INT_SIZEOF +
        // arg1: the pattern in UTF-8 bytes, and its NUL — or nothing, when
        // the writer sends a NULL for it (an empty or missing pattern). The
        // length used to be counted in UTF-16 units, so a pattern with a
        // non-ASCII letter sent a wrong total and the server read the rest
        // of the request out of step.
        (options.tableNamePattern ? Buffer.byteLength(String(options.tableNamePattern)) + 1 : 0) +
        // The length of the next part.
        // arg2: is null.
        DATA_TYPES.INT_SIZEOF +
        // The length of the next part.
        DATA_TYPES.INT_SIZEOF +
        // Pattern match flag.
        DATA_TYPES.BYTE_SIZEOF;

  if (options.protocolVersion > 4) {
    bufferLength +=
            // The length of the next part.
            DATA_TYPES.INT_SIZEOF +
            // ShardId.
            DATA_TYPES.INT_SIZEOF;
  }

  return bufferLength;
};

GetSchemaPacket.prototype.getFetchSchemaBufferLength = function () {
  const bufferLength =
        // Total length of the request without itself and CAS info.
        DATA_TYPES.DATA_LENGTH_SIZEOF +
        // CAS info.
        DATA_TYPES.CAS_INFO_SIZE +
        // CAS function.
        DATA_TYPES.BYTE_SIZEOF +
        // The length of the next part.
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.BYTE_SIZEOF +
        DATA_TYPES.INT_SIZEOF +
        DATA_TYPES.INT_SIZEOF;

  return bufferLength;
};
