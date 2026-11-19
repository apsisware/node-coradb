'use strict';

const { driverError } = require('./errors');

/*
 * The charset the connection talks in, as the JDBC driver's `charSet`
 * connection property: SQL text, string parameters, schema patterns and CLOB
 * text go out in it; column names, default values, query plans and messages
 * are read in it. Column values are read in their column's own charset, which
 * the server sends with each column's type.
 *
 * The default is UTF-8 (JDBC's default is the platform's, UTF-8 in practice).
 * On a database created with ISO-8859-1, use 'iso-8859-1': UTF-8 text sent to
 * it is stored byte for byte, so 'é' comes back as 'Ã©'.
 */

const NAMES = {
  utf8: 'utf8',
  'utf-8': 'utf8',
  latin1: 'latin1',
  'iso-8859-1': 'latin1',
  iso88591: 'latin1',
  'iso8859-1': 'latin1',
};

/** The charset a `charset` option names ('utf8' or 'latin1'), or throws. */
function charsetOf(name) {
  if (name === undefined || name === null || name === '') {
    return 'utf8';
  }

  const key = typeof name === 'string' ? name.trim().toLowerCase().replace(/_/g, '-') : undefined;

  if (key !== undefined && Object.prototype.hasOwnProperty.call(NAMES, key)) {
    return NAMES[key];
  }

  throw driverError(
    'INVALID_PARAMETER',
    `Unknown charset ${JSON.stringify(name)}. Use 'utf-8' or 'iso-8859-1'.`
  );
}

// A character ISO-8859-1 has no byte for.
const NOT_LATIN1 = /[\u0100-\u{10ffff}]/u;

/**
 * `text` as bytes in `charset`. Throws for a character the charset cannot
 * hold: Node.js would write the low byte of its code point ('€' as '¬'), and
 * the JDBC driver writes '?' — which in SQL text is a placeholder.
 */
function encode(text, charset) {
  if (charset === 'latin1') {
    const bad = NOT_LATIN1.exec(text);

    if (bad) {
      const code = bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

      throw driverError(
        'INVALID_PARAMETER',
        `The text has a character ISO-8859-1 cannot hold (U+${code}, at ${bad.index}); the connection's charset is 'iso-8859-1'.`
      );
    }

    return Buffer.from(text, 'latin1');
  }

  return Buffer.from(text, 'utf8');
}

/** How many bytes `encode(text, charset)` makes (and throws as it would). */
function byteLength(text, charset) {
  if (charset === 'latin1') {
    return encode(text, charset).length;
  }

  return Buffer.byteLength(text, 'utf8');
}

module.exports = { charsetOf, encode, byteLength };
