'use strict';

const DATA_TYPES = require('../constants/DataTypes');
const { driverError } = require('../errors');
// Default delimiter to wrap character strings in SQL queries.
const DEFAULT_DELIMITER = "'";

/**
 * Validate if the value is an accepted "boolean"-compatible input
 * @param val
 * @return {Boolean}
 */
exports._validateInputBoolean = function (val) {
  if (typeof val === 'boolean') {
    return true;
  } else {
    if (typeof val === 'number' && val % 1 === 0 && (val === 0 || val === 1)) {
      return true;
    }
  }

  return false;
};

/**
 * Validate if the value is an accepted "timeout" input
 * @param val
 * @return {Boolean}
 */
exports._validateInputTimeout = function (val) {
  if (typeof val === 'undefined' || val === null || !(typeof val === 'number' && val % 1 === 0 && val >= 0)) {
    return false;
  }

  return true;
};

/**
 * Validate if the value is a positive "number" input
 * @param val
 * @return {Boolean}
 */
exports._validateInputPositive = function (val) {
  if (typeof val === 'undefined' || val === null || !(typeof val === 'number' && val >= 0)) {
    return false;
  }

  return true;
};

/**
 * Validate if the value is an accepted function input string
 * @param str
 * @return {Boolean}
 */
exports._validateInputString = function (str) {
  if (typeof str === 'undefined' || str === null || typeof str !== 'string' || str.length === 0) {
    return false;
  }

  return true;
};

/**
 * Validate if the value is accepted as a SQL statement string
 * @param sql
 * @return {Boolean}
 */
exports._validateInputSQLString = function (sql) {
  if (typeof sql === 'undefined' || sql === null || typeof sql !== 'string' || sql.length <= 5) {
    return false;
  }

  return true;
};

/**
 * Format number values as 'money'
 * http://stackoverflow.com/questions/149055/how-can-i-format-numbers-as-money-in-javascript/149099#149099
 * @param decimals
 * @param decimal_sep
 * @param thousands_sep
 * @return {String}
 */
// Exported rather than added to Number.prototype: a library must not change a
// built-in as a side effect of being required.
exports.formatAsMoney = function (value, decimals, decimal_sep, thousands_sep) {
  return formatAsMoney.call(Number(value), decimals, decimal_sep, thousands_sep);
};

function formatAsMoney(decimals, decimal_sep, thousands_sep) {
  let n = this,
    c = isNaN(decimals) ? 2 : Math.abs(decimals), // If decimal is zero we must take it, it means user does not want to show any decimal
    d = decimal_sep || '.', // If no decimal separator is passed we use the dot as default decimal separator (we MUST use a decimal separator)
    t = (typeof thousands_sep === 'undefined') ? ',' : thousands_sep, // If you don't want to use a thousands separator you can pass empty string as thousands_sep value
    sign = (n < 0) ? '-' : '',
    i = Number.parseInt(n = Math.abs(n).toFixed(c)) + '',
    j;

  j = ((j = i.length) > 3) ? j % 3 : 0;

  return sign + (j ? i.slice(0, j) + t : '') + i.slice(j).replaceAll(/(\d{3})(?=\d)/g, "$1" + t) + (c ? d + Math.abs(n - i).toFixed(c).slice(2) : '');
}

/**
 * Escape a string for use inside a quoted SQL literal.
 *
 * Only the quote character is escaped, by doubling it: `it's` -> `it''s`.
 * Nothing else is touched. CoraDB, like CUBRID, runs with
 * `no_backslash_escapes=yes` by default, under which a backslash is an
 * ordinary character; the MySQL-style escapes this used to write (`\n`,
 * `\\`, `\0`) were therefore stored literally, so a newline came back as a
 * backslash and an `n`, and every backslash doubled on each save.
 *
 * A server configured with `no_backslash_escapes=no` reads backslashes as
 * escapes, and text formatted here is then not stored as given: bind values
 * on the server instead (`sql()`, `prepare()`, `executeWithTypedParams()`).
 *
 * @param val the text
 * @param delimiter the quote the literal is wrapped in: `'` (the default when
 *                  formatting) or `"`. Without one, both kinds are doubled.
 * @return {String}
 * @private
 */
const _escapeString = function (val, delimiter) {
  if (val.includes('\0')) {
    // The statement goes to the server as NUL-terminated text: a NUL inside a
    // value would end the statement there. Refused, rather than written as
    // something other than what was given.
    throw driverError(
      'INVALID_PARAMETER',
      'A string value formatted into SQL text cannot contain a NUL character; bind it on the server with sql() instead.'
    );
  }

  if (delimiter === "'" || delimiter === '"') {
    return val.replaceAll(delimiter, delimiter + delimiter);
  }

  return val.replaceAll("'", "''").replaceAll('"', '""');
};

exports._escapeString = _escapeString;

/**
 * Replaces '?' with values from an array; also, it performs string escaping.
 *
 * Each value is written as SQL text:
 *   - null and undefined as NULL;
 *   - a number or bigint bare, and a negative one in parentheses: `(-5)`. Bare,
 *     `bal-?` with -5 became `bal--5`, and `--` starts a comment, so the rest
 *     of the statement — its WHERE clause included — was dropped;
 *   - a boolean as 1 or 0;
 *   - a Date as a quoted UTC DATETIME, `'m/d/yyyy h:m:s.mmm'` (milliseconds
 *     always three digits: 7 ms is `.007`, not `.7`, which meant 700 ms);
 *   - anything else as a quoted string, with the quote doubled (see
 *     `_escapeString`; backslashes are left as they are).
 *
 * A `?` inside a quoted string, a quoted identifier (`"..."`, `` `...` `` or
 * `[...]`) or a comment (`--`, `//` or `/* ... *\/`) is text, not a
 * placeholder.
 *
 * Throws a CoraDBError with code 'INVALID_PARAMETER' for a number that is not
 * finite, and for a string that contains a NUL character.
 *
 * @param sql
 * @param arrValues
 * @param arrDelimiters
 * @return {*}
 * @private
 */
// A `?` placeholder, or a span in which a `?` is text: a quoted string, a
// quoted identifier or a comment (see `_sqlFormat`).
const PLACEHOLDER_OR_TEXT = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\?/g;

/** The number of `?` placeholders in `sql`, counted as `_sqlFormat` counts them. */
exports._countPlaceholders = function (sql) {
  let n = 0;

  for (const m of sql.matchAll(PLACEHOLDER_OR_TEXT)) {
    if (m[0] === '?') ++n;
  }

  return n;
};

/**
 * `_sqlFormat` over an array of statements: the values go to the placeholders
 * left to right across the whole batch, as they would in one string holding
 * the same statements. A statement with no placeholder is left as it is.
 */
exports._sqlFormatBatch = function (sqls, arrValues) {
  const values = Array.isArray(arrValues) ? arrValues : [arrValues];
  let next = 0;

  return sqls.map((sql) => {
    if (typeof sql !== 'string') {
      return sql;
    }

    const n = exports._countPlaceholders(sql);

    if (n === 0) {
      return sql;
    }

    const part = values.slice(next, next + n);

    next += n;

    return exports._sqlFormat(sql, part);
  });
};

exports._sqlFormat = function (sql, arrValues, arrDelimiters) {
  if (!Array.isArray(arrValues)) {
    arrValues = [arrValues];
  }

  if (!Array.isArray(arrDelimiters)) {
    arrDelimiters = [arrDelimiters];
  }

  const valCount = arrValues.length;
  const delimitersCount = arrDelimiters.length;

  let i = -1;

  // A `?` inside a quoted string, a quoted identifier or a comment is text,
  // not a placeholder: those spans are matched first and passed through.
  // `//` is a line comment in CoraDB as well as `--`; without it, a `'` or a
  // `?` in one shifted every parameter after it. `[name]` is a quoted
  // identifier too: an apostrophe in one was taken for the start of a
  // string, so the next value landed outside its quotes, in code position.
  return sql.replaceAll(PLACEHOLDER_OR_TEXT, function (match) {
    if (match !== '?') {
      return match;
    }

    // A placeholder with no value left is kept as written (every one of
    // them: with `===`, only the first was, and the rest became NULL), so
    // the server reports the missing value.
    if (++i >= valCount) {
      return match;
    }

    // Get the value for the current placeholder.
    // We iterate via `i` instead of shifting from the front of the
    // array because we do not want to alter the original array
    // received from the application. The application may
    // choose to reuse it in the loop.
    const val = arrValues[i];
    // And its delimiter. If not defined, use single quotes.
    let delimiter = (i >= delimitersCount ? DEFAULT_DELIMITER : arrDelimiters[i]);

    if (val === undefined || val === null) {
      return 'NULL';
    }

    // Send numbers as real numbers. Numbers wrapped in strings
    // are not considered as numbers. They are sent as strings.
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        throw driverError('INVALID_PARAMETER', `${val} cannot be written as an SQL number.`);
      }

      // In parentheses when negative, so that the minus sign can never join
      // a minus before the placeholder into `--`.
      return val < 0 ? `(${val})` : String(val);
    }

    // A boolean or bigint has no string methods; written as the number the
    // engine stores, rather than crashing the escape below.
    if (typeof val === 'boolean') {
      return val ? '1' : '0';
    }

    if (typeof val === 'bigint') {
      return val < 0n ? `(${val})` : val.toString();
    }

    // Delimiters must be specified as strings.
    if (typeof delimiter !== 'string') {
      delimiter = DEFAULT_DELIMITER;
    }

    // If the value is of Date type, convert it into
    // CoraDB compatible DATETIME format strings.
    if (val instanceof Date && Number.isNaN(val.getTime())) {
      throw driverError('INVALID_PARAMETER', 'An invalid Date cannot be written as an SQL value.');
    }

    // Bytes as a hexadecimal bit-string literal, X'0aff'. Turned into text,
    // they were decoded as UTF-8 and any byte that is not valid UTF-8 was lost.
    if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
      return `X'${Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('hex')}'`;
    }

    // A plain object has no SQL text form: it went out as '[object Object]'.
    if (typeof val === 'object' && !(val instanceof Date) && !Array.isArray(val) &&
        String(val) === '[object Object]') {
      throw driverError('INVALID_PARAMETER', 'An object cannot be written as an SQL value; pass a string, number, Date or Buffer, or JSON.stringify() it.');
    }

    if (val instanceof Date) {
      // CoraDB 8.4.1+ supports many formats of DATETIME value.
      // Refer to http://www.coradb.ai/manual
      // for more information.
      // In the communication between node-coradb and CoraDB
      // Broker we choose the
      // `'mm/dd[/yyyy] hh:mi[:ss[.ff]] [am|pm]'` format.

      // Month value in JavaScript is 0 based, i.e. 0-11,
      // but CoraDB is 1-12. The other fields need no padding, but the
      // milliseconds do: `.7` is a fraction of a second, 700 ms.
      const ms = String(val.getUTCMilliseconds()).padStart(3, '0');

      return `${delimiter}${val.getUTCMonth() + 1}/${val.getUTCDate()}/${val.getUTCFullYear()} ${val.getUTCHours()}:${val.getUTCMinutes()}:${val.getUTCSeconds()}.${ms}${delimiter}`;
    }

    // Otherwise, safely escape the string.
    return delimiter + _escapeString(String(val), delimiter) + delimiter;
  });
};

/**
 * Get expected response length from the server
 * @param buffer
 * @return {Number}
 */
exports._getExpectedResponseLength = function (buffer) {
  let value = 0;

  for (let i = 0; i < DATA_TYPES.INT_SIZEOF; i++) {
    value += buffer[i] * Math.pow(256, DATA_TYPES.INT_SIZEOF - i - 1);
  }

  return value + DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE;
};

exports.getBufferFromString = function (str, encoding) {
  return Buffer.from(str, encoding);
};
