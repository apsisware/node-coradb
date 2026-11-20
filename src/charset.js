'use strict';

const { driverError } = require('./errors');

/*
 * The charset the connection talks in, as the JDBC driver's `charSet`
 * connection property: SQL text, string parameters, schema patterns and CLOB
 * text go out in it; column names, default values, query plans and messages
 * are read in it. Column values are read in their column's own charset, which
 * the server sends with each column's type.
 *
 * The default is 'auto' (not in JDBC, whose default is the platform's
 * charset): the driver reads the database's own charset right after the first
 * login (charsetOfDatabase()) and uses it. UTF-8 text sent to an ISO-8859-1
 * database is stored byte for byte, so 'é' came back as 'Ã©' — and an
 * application cannot be expected to know each database's charset. 'utf-8' or
 * 'iso-8859-1' fixes it and skips the extra query.
 */

const NAMES = {
  utf8: 'utf8',
  'utf-8': 'utf8',
  latin1: 'latin1',
  'iso-8859-1': 'latin1',
  iso88591: 'latin1',
  'iso8859-1': 'latin1',
};

/** The charset a `charset` option names ('utf8', 'latin1' or 'auto', the default), or throws. */
function charsetOf(name) {
  if (name === undefined || name === null || name === '') {
    return 'auto';
  }

  const key = typeof name === 'string' ? name.trim().toLowerCase().replace(/_/g, '-') : undefined;

  if (key === 'auto') {
    return 'auto';
  }

  if (key !== undefined && Object.prototype.hasOwnProperty.call(NAMES, key)) {
    return NAMES[key];
  }

  throw driverError(
    'INVALID_PARAMETER',
    `Unknown charset ${JSON.stringify(name)}. Use 'utf-8', 'iso-8859-1' or 'auto'.`
  );
}

// What 'auto' asks the database: its charset (db_root.charset, an
// INTL_CODESET number: 3 ISO-8859-1, 5 UTF-8, 4 EUC-KR, 0 ASCII, 2 binary).
const DATABASE_CHARSET_SQL = 'SELECT charset FROM db_root';

/**
 * The connection charset for a database's charset number: 'latin1' for an
 * ISO-8859-1 database, 'utf8' for anything else (UTF-8 and ASCII take it as
 * they are; EUC-KR has no encoder in Node.js, as before).
 */
function charsetOfDatabase(code) {
  return Number(code) === 3 ? 'latin1' : 'utf8';
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
  // Not text: Node's own error, as before there was a charset.
  if (typeof text !== 'string') {
    return Buffer.byteLength(text);
  }

  if (charset === 'latin1') {
    return encode(text, charset).length;
  }

  return Buffer.byteLength(text, 'utf8');
}

// --- SQL text -------------------------------------------------------------------

// A string literal may name its own charset (corasql_lexer.l: _utf8'...',
// _iso88591'...', _euckr'...', _binary'...', the quote right after the name):
// the server reads its bytes in that charset, whatever the rest of the
// statement is in. So a statement is not all in one charset: on an
// ISO-8859-1 database, _utf8'이' in a UTF-8 column is UTF-8 bytes in an
// ISO-8859-1 statement.
//
// The pieces that matter, left to right: comments, literals with a charset
// name, plain literals and quoted names (so that a quote or a name inside
// them is not taken for one).
const SQL_PIECES = /--[^\n\r]*|\/\/[^\n\r]*|\/\*[\s\S]*?\*\/|_(utf8|iso88591)'(?:[^']|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/gi;

const UTF8_LITERAL = /_utf8'/i;
const ISO_LITERAL = /_iso88591'/i;

/**
 * SQL text as bytes: in `charset`, except a literal that names its charset
 * (_utf8'...' in UTF-8, _iso88591'...' in ISO-8859-1) and a comment the
 * charset cannot hold (sent as UTF-8: the server skips it, and no UTF-8 byte
 * of a non-ASCII character can end it). Throws as `encode()` does for
 * anything else the charset cannot hold.
 */
function encodeSql(text, charset) {
  if (typeof text !== 'string') {
    return Buffer.from(text);
  }

  if (cache.text === text && cache.charset === charset) {
    return cache.bytes;
  }

  const plain = charset === 'latin1'
    ? !UTF8_LITERAL.test(text) && !NOT_LATIN1.test(text)
    : !ISO_LITERAL.test(text);
  const bytes = plain ? encode(text, charset) : encodePieces(text, charset);

  cache.text = text;
  cache.charset = charset;
  cache.bytes = bytes;

  return bytes;
}

// The last statement encoded: a packet counts its bytes, then writes them.
const cache = { text: undefined, charset: undefined, bytes: undefined };

function encodePieces(text, charset) {
  const parts = [];
  let at = 0;

  const rest = (to) => {
    if (to > at) {
      parts.push(encodeAt(text.slice(at, to), charset, at));
    }
  };

  SQL_PIECES.lastIndex = 0;

  for (let m = SQL_PIECES.exec(text); m; m = SQL_PIECES.exec(text)) {
    const piece = m[0];

    rest(m.index);
    at = m.index + piece.length;

    if (m[1] && m[1].toLowerCase() === 'utf8') {
      parts.push(Buffer.from(piece, 'utf8'));
    } else if (m[1]) {
      parts.push(encodeAt(piece, 'latin1', m.index));
    } else if ((piece[0] === '-' || piece[0] === '/') && charset === 'latin1' && NOT_LATIN1.test(piece)) {
      parts.push(Buffer.from(piece, 'utf8'));
    } else {
      parts.push(encodeAt(piece, charset, m.index));
    }
  }

  rest(text.length);

  return Buffer.concat(parts);
}

/** `encode()`, with the position in the whole statement in its error. */
function encodeAt(piece, charset, offset) {
  try {
    return encode(piece, charset);
  } catch (err) {
    const bad = NOT_LATIN1.exec(piece);

    if (bad) {
      err.message = err.message.replace(/at \d+\)/, `at ${offset + bad.index})`);
    }

    throw err;
  }
}

/** How many bytes `encodeSql(text, charset)` makes. */
function sqlByteLength(text, charset) {
  if (typeof text !== 'string') {
    return Buffer.byteLength(text);
  }

  return encodeSql(text, charset).length;
}

module.exports = { charsetOf, charsetOfDatabase, DATABASE_CHARSET_SQL, encode, byteLength, encodeSql, sqlByteLength };
