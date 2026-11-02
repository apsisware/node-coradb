const CAS = require('../constants/CASConstants');

/**
 * Column meta data
 * @constructor
 */
function ColumnMetaData() {
  this.ColumnType = null;
  this.CollectionElementType = CAS.CoraDBDataType.CCI_U_TYPE_UNKNOWN;
  // The Node.js encoding this column's strings are decoded with (null: UTF-8),
  // from the charset bits of its type.
  this.Charset = null;
  this.scale = -1;
  this.precision = -1;
  this.RealName = null;
  this.TableName = null;
  this.Name = null;
  this.IsNullable = false;
  this.DefaultValue = null;
  this.IsAutoIncrement = false;
  this.IsUniqueKey = false;
  this.IsPrimaryKey = false;
  this.IsForeignKey = false;
  this.IsReverseIndex = false;
  this.IsReverseUnique = false;
  this.IsShared = false;
}

/*
 * The names the fields were first given here — Scale, Precision, IsNullabe —
 * were not the ones the decoder filled in (scale, precision, IsNullable,
 * and DafaultValue for DefaultValue), so every column carried both: the
 * defaults under one name, the real values under the other. The fields are
 * now the decoder's names; the others stay as aliases of them (not
 * enumerable, so a column's keys list each field once).
 */
const ALIASES = { Scale: 'scale', Precision: 'precision', IsNullabe: 'IsNullable', DafaultValue: 'DefaultValue' };

Object.keys(ALIASES).forEach((alias) => {
  const field = ALIASES[alias];

  Object.defineProperty(ColumnMetaData.prototype, alias, {
    get() {
      return this[field];
    },
    set(value) {
      this[field] = value;
    },
    enumerable: false,
    configurable: true,
  });
});

module.exports = ColumnMetaData;
