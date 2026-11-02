'use strict';

const CAS = require('./constants/CASConstants');
const { driverError } = require('./errors');

/*
 * Values bound server-side to `?` placeholders.
 *
 * The type of each value is worked out from the JavaScript value, or given
 * explicitly as `{ type, value }`. Anything that cannot be bound is refused by
 * name, before a byte is sent: an unknown type name used to map to
 * CCI_U_TYPE_UNKNOWN and corrupt the packet instead of failing.
 */

/** The type names the packet writer knows how to send. */
const BINDABLE_TYPES = new Set([
  'char', 'varchar', 'string', 'nchar', 'varnchar', 'json',
  'short', 'int', 'bigint', 'float', 'double', 'monetary', 'numeric',
  'date', 'time', 'datetime', 'timestamp',
  'bit', 'varbit',
  'blob', 'clob',
  'set', 'multiset', 'sequence', 'list',
]);

/** The collection types; 'list' is CoraDB's name for a SEQUENCE. */
const COLLECTION_TYPES = new Set(['set', 'multiset', 'sequence', 'list']);

/** What a collection's elements can be. */
const ELEMENT_TYPES = new Set([
  'char', 'varchar', 'string', 'nchar', 'varnchar',
  'short', 'int', 'bigint', 'float', 'double', 'monetary', 'numeric',
  'date', 'time', 'datetime', 'timestamp',
  'bit', 'varbit',
]);

/**
 * A SET, MULTISET or SEQUENCE value made ready for the packet writer: the
 * type of its elements and the elements, each coerced to it.
 */
class CollectionValue {
  constructor(elementType, items) {
    this.elementType = elementType;
    this.items = items;
  }
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function invalid(index, message) {
  return driverError('INVALID_PARAMETER', `Parameter ${index + 1}: ${message}`);
}

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'Date';
  if (Buffer.isBuffer(value)) return 'Buffer';
  if (typeof value === 'object') return (value.constructor && value.constructor.name) || 'object';
  return typeof value;
}

/** `{ type, value }`: a parameter with its type given. */
function isTyped(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    !(value instanceof Date) && !Buffer.isBuffer(value) && !(value instanceof Uint8Array) &&
    Object.prototype.hasOwnProperty.call(value, 'type') &&
    Object.prototype.hasOwnProperty.call(value, 'value');
}

// 'set of int', 'list(varchar)', 'multiset<double>'.
const COLLECTION_OF = /^(set|multiset|sequence|list)\s*(?:\s+of\s+|\(\s*|<\s*)([a-z]+)\s*[)>]?$/;

/**
 * A collection type, with the element type when the name gives one:
 * `{ name: 'set', element: 'int' }`. Null when it is not a collection type.
 */
function collectionTypeName(type, index) {
  if (typeof type !== 'string') {
    return null;
  }

  const text = type.trim().toLowerCase();

  if (COLLECTION_TYPES.has(text)) {
    return { name: text === 'list' ? 'sequence' : text, element: undefined };
  }

  const m = COLLECTION_OF.exec(text);

  if (!m) {
    return null;
  }

  return { name: m[1] === 'list' ? 'sequence' : m[1], element: checkElementType(m[2], index) };
}

/** The canonical name of a collection's element type, or throws. */
function checkElementType(type, index) {
  const name = typeof type === 'number'
    ? String(CAS.getCoraDBDataTypeName(type)).toLowerCase()
    : (typeof type === 'string' ? type.trim().toLowerCase() : '');

  if (!ELEMENT_TYPES.has(name)) {
    throw invalid(index, `${JSON.stringify(type)} cannot be the type of a collection's elements. Use one of: ${[...ELEMENT_TYPES].join(', ')}.`);
  }

  return name;
}

/** The canonical, lower-case name of a type the writer can send, or throws. */
function checkTypeName(type, index) {
  if (typeof type === 'number') {
    const name = CAS.getCoraDBDataTypeName(type);
    const lower = typeof name === 'string' ? name.toLowerCase() : '';

    if (BINDABLE_TYPES.has(lower)) {
      return lower;
    }

    throw invalid(index, `type ${type} cannot be bound.`);
  }

  const collection = collectionTypeName(type, index);

  if (collection) {
    return collection.name;
  }

  const name = typeof type === 'string' ? type.trim().toLowerCase() : '';

  if (!BINDABLE_TYPES.has(name)) {
    throw invalid(index, `unknown type ${JSON.stringify(type)}. Use one of: ${[...BINDABLE_TYPES].join(', ')}.`);
  }

  return name;
}

// Decimal notation only: no hex (`0x10` bound as 16), binary or octal, and
// not blank (`''` and `'  '` bound as 0).
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * The number a value stands for, for a numeric type, or throws. A string has
 * to be a decimal number: `Number()` alone read `''` as 0 and `'0x10'` as 16.
 */
function numberOf(value, index) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);

  const text = typeof value === 'string' ? value.trim() : '';

  if (!DECIMAL.test(text)) {
    throw invalid(index, `${JSON.stringify(String(value))} is not a number.`);
  }

  return Number(text);
}

// A date and time written without a zone: '2026-01-31', '2026-01-31 23:30',
// '2026-01-31T23:30:00.250'.
const WALL_CLOCK = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/;
// A time of day: '10:00', '10:00:00', '10:00:00.5'.
const TIME_OF_DAY = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

/**
 * A Date whose UTC fields are the given wall-clock time — what the packet
 * writer sends — or null when a field is out of range (a February 31st).
 */
function wallClock(year, month, day, hour, minute, second, fraction) {
  const ms = fraction ? Math.floor(Number(`0.${fraction}`) * 1000) : 0;
  const d = new Date(Date.UTC(2000, 0, 1, hour, minute, second, ms));

  // setUTCFullYear, because Date.UTC reads a year below 100 as 19xx.
  d.setUTCFullYear(year, month - 1, day);

  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  return d;
}

/**
 * The Date to send for a DATE, TIME, DATETIME or TIMESTAMP parameter, or null
 * when the value is not one. A string with no zone is a wall-clock time, sent
 * as written: `new Date()` read it in the server's local zone, and the writer
 * then sent it in UTC, so '2026-01-31 10:00:00' arrived shifted by the
 * server's offset. For a TIME, '10:00:00' (which `new Date()` refused) is a
 * time of day. A string with a zone ('...Z', '...+02:00') is an instant, as
 * before, and so is a number.
 */
function dateOf(value, type) {
  if (value instanceof Date) return value;

  if (typeof value === 'string') {
    const text = value.trim();
    let m = WALL_CLOCK.exec(text);

    if (m) {
      return wallClock(Number(m[1]), Number(m[2]), Number(m[3]),
        Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0), m[7]);
    }

    m = type === 'time' ? TIME_OF_DAY.exec(text) : null;

    if (m) {
      return wallClock(1970, 1, 1, Number(m[1]), Number(m[2]), Number(m[3] || 0), m[4]);
    }

    return text === '' ? null : new Date(text);
  }

  if (typeof value === 'number') return new Date(value);

  return null;
}

/**
 * The element type of a collection given none: what its values are bound as
 * on their own (see `inferType`), the same for all of them. Whole numbers and
 * fractions together are DOUBLE; whole numbers some of which do not fit an INT
 * are BIGINT. Empty, or nothing but NULLs: NULL, which the server converts.
 */
function inferElementType(items, index) {
  const kinds = new Set();

  for (const item of items) {
    if (item === null || item === undefined) continue;
    if (Array.isArray(item)) throw invalid(index, 'a collection cannot hold a collection.');
    kinds.add(inferType(item, index));
  }

  if (kinds.size === 0) return 'null';
  if (kinds.size === 1) return [...kinds][0];

  const numeric = [...kinds].every((k) => k === 'int' || k === 'bigint' || k === 'double');

  if (numeric) return kinds.has('double') ? 'double' : 'bigint';

  throw invalid(index, `the elements of a collection have different types (${[...kinds].join(', ')}). Give the element type: { type: 'set', elementType: 'varchar', value: [...] }.`);
}

/** A collection value: an array, its elements coerced to one element type. */
function coerceCollection(value, element, index) {
  if (value instanceof CollectionValue) {
    return value;
  }

  if (!Array.isArray(value)) {
    throw invalid(index, `a SET, MULTISET or SEQUENCE value must be an array, not ${kindOf(value)}.`);
  }

  const elementType = element || inferElementType(value, index);
  const items = value.map((item) => (elementType === 'null' ? null : coerce(item, elementType, index)));

  return new CollectionValue(elementType, items);
}

// A packed LOB handle: 4-byte LOB type, 8-byte size, 4-byte locator size
// (counting its terminating NUL), then the locator.
const LOB_HANDLE_HEADER = 16;

/**
 * A BLOB or CLOB parameter: the LOB object `lobNew()` / `lobWrite()` returned,
 * or throws. Anything else used to reach the packet writer unchecked, fail
 * inside the socket handler and take the whole connection down with it.
 */
function coerceLob(value, type, index) {
  const handle = value !== null && typeof value === 'object' ? value.packedLobHandle : undefined;
  const wellFormed = Buffer.isBuffer(handle) && handle.length >= LOB_HANDLE_HEADER &&
    LOB_HANDLE_HEADER + handle.readInt32BE(12) === handle.length &&
    Number.isSafeInteger(value.lobLength) && value.lobLength >= 0;

  if (!wellFormed) {
    throw invalid(index, `a ${type.toUpperCase()} value must be the LOB object lobNew() or lobWrite() returned, not ${kindOf(value)}.`);
  }

  const expected = type === 'blob' ? CAS.CoraDBDataType.CCI_U_TYPE_BLOB : CAS.CoraDBDataType.CCI_U_TYPE_CLOB;

  if (value.lobType !== undefined && value.lobType !== expected) {
    throw invalid(index, `a ${type === 'blob' ? 'CLOB' : 'BLOB'} cannot be bound as a ${type.toUpperCase()}.`);
  }

  return value;
}

/** A value made ready for its declared type, or throws. */
function coerce(value, type, index, element) {
  if (value === null || value === undefined) {
    return null;
  }

  switch (type) {
    case 'set': case 'multiset': case 'sequence': case 'list':
      return coerceCollection(value, element, index);
    case 'char': case 'varchar': case 'string': case 'nchar': case 'varnchar':
      return typeof value === 'string' ? value : String(value);
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'short': case 'int': {
      const n = numberOf(value, index);

      if (!Number.isInteger(n)) throw invalid(index, `${JSON.stringify(String(value))} is not a whole number.`);
      if (type === 'short' && (n < -32768 || n > 32767)) throw invalid(index, `${n} does not fit a SHORT.`);
      if (n < INT32_MIN || n > INT32_MAX) throw invalid(index, `${n} does not fit an INT.`);

      return n;
    }
    case 'bigint': {
      let big;

      try {
        // A string of decimal digits only: BigInt() alone read '' as 0 and
        // '0x10' as 16.
        if (typeof value === 'string' && !/^[+-]?\d+$/.test(value.trim())) throw new RangeError();
        big = typeof value === 'bigint' ? value : BigInt(typeof value === 'string' ? value.trim().replace(/^\+/, '') : value);
      } catch {
        throw invalid(index, `${JSON.stringify(String(value))} is not a whole number.`);
      }

      if (big < INT64_MIN || big > INT64_MAX) throw invalid(index, `${big} does not fit a BIGINT.`);

      return big;
    }
    case 'float': case 'double': case 'monetary': {
      const n = numberOf(value, index);

      if (!Number.isFinite(n)) throw invalid(index, `${JSON.stringify(String(value))} is not a finite number.`);

      return n;
    }
    case 'numeric': {
      const text = typeof value === 'bigint' ? value.toString() : String(value).trim();

      if (!DECIMAL.test(text)) throw invalid(index, `${JSON.stringify(text)} is not a number.`);

      return text;
    }
    case 'date': case 'time': case 'datetime': case 'timestamp': {
      const d = dateOf(value, type);

      if (!d || Number.isNaN(d.getTime())) throw invalid(index, `${JSON.stringify(String(value))} is not a ${type === 'time' ? 'time' : 'date'}.`);

      return d;
    }
    case 'bit': case 'varbit':
      if (Buffer.isBuffer(value)) return value;
      if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      throw invalid(index, `a ${type.toUpperCase()} value must be a Buffer.`);
    case 'blob': case 'clob':
      return coerceLob(value, type, index);
    default:
      throw invalid(index, `type ${JSON.stringify(type)} cannot be bound.`);
  }
}

/** The type a JavaScript value is bound as, when none is given. */
function inferType(value, index) {
  switch (typeof value) {
    case 'string':
      return 'varchar';
    case 'boolean':
      // CoraDB has no BOOLEAN; 1 and 0, as the text formatter writes them.
      return 'short';
    case 'bigint':
      return 'bigint';
    case 'number':
      if (!Number.isFinite(value)) throw invalid(index, `${value} cannot be bound.`);
      if (Number.isInteger(value)) {
        return value >= INT32_MIN && value <= INT32_MAX ? 'int' : 'bigint';
      }
      return 'double';
    default:
      break;
  }

  if (value instanceof Date) return 'datetime';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return 'varbit';

  throw invalid(index, `a value of type ${kindOf(value)} cannot be bound. Pass { type, value } to say how to bind it.`);
}

/**
 * The element type a collection parameter is given, in its type name ('set of
 * int') or as `elementType`; undefined when neither gives one.
 */
function elementTypeOf(type, elementType, index) {
  if (elementType !== undefined && elementType !== null) {
    return checkElementType(elementType, index);
  }

  const collection = collectionTypeName(type, index);

  return collection ? collection.element : undefined;
}

/**
 * Values and types ready for the packet writer.
 *
 *   bind([1, 'a', null, new Date(), { type: 'numeric', value: '12.50' }])
 *
 * @param params an array of values, or a single value
 * @return {{ values: any[], types: string[] }}
 */
function bind(params) {
  const list = params === undefined ? [] : Array.isArray(params) ? params : [params];
  const values = new Array(list.length);
  const types = new Array(list.length);

  list.forEach((p, i) => {
    if (isTyped(p)) {
      types[i] = checkTypeName(p.type, i);
      values[i] = coerce(p.value, types[i], i, elementTypeOf(p.type, p.elementType, i));
    } else if (p === null || p === undefined) {
      // The type does not matter for NULL; it goes as the NULL type.
      types[i] = 'varchar';
      values[i] = null;
    } else {
      types[i] = inferType(p, i);
      values[i] = coerce(p, types[i], i);
    }
  });

  return { values, types };
}

/**
 * Check the arguments of `executeWithTypedParams()`: one known type per value.
 * A mismatch used to throw from deep in the packet writer, and a misspelt type
 * went out as UNKNOWN and corrupted the packet.
 *
 * @return {{ values: any[], types: string[] }}
 */
function checkTyped(params, dataTypes) {
  if (params === undefined || params === null) {
    return { values: undefined, types: undefined };
  }

  if (!Array.isArray(params)) {
    throw driverError('INVALID_PARAMETER', 'The parameters must be an array.');
  }

  if (!Array.isArray(dataTypes) || dataTypes.length !== params.length) {
    throw driverError(
      'INVALID_PARAMETER',
      `There are ${params.length} parameter(s) and ${Array.isArray(dataTypes) ? dataTypes.length : 0} data type(s); give one type per parameter.`
    );
  }

  const types = dataTypes.map((t, i) => checkTypeName(t, i));
  const values = params.map((v, i) => coerce(v, types[i], i, elementTypeOf(dataTypes[i], undefined, i)));

  return { values, types };
}

module.exports = {
  BINDABLE_TYPES,
  CollectionValue,
  ELEMENT_TYPES,
  bind,
  checkTyped,
  inferType,
};
