'use strict';

// Shared helpers for the e2e scenarios. This file is NOT a test file (it has no
// `describe`/`it`); the Mocha specs only pick up files named `test_*.js`.

// The live CoraDB every e2e scenario connects to: one place for all of them.
// Each value can be overridden with an environment variable, e.g.
//   CORADB_HOST=dbserver CORADB_DATABASE=other npm run test:e2e
const CONFIG = Object.freeze({
  hosts: [process.env.CORADB_HOST || 'localhost'],
  port: Number(process.env.CORADB_PORT) || 33000,
  user: process.env.CORADB_USER || 'dba',
  password: process.env.CORADB_PASSWORD || '',
  database: process.env.CORADB_DATABASE || 'olympics1988-2004',
});

// Indent applied to console output so it aligns under Mocha's output.
const INDENT_WIDTH = 8;
const INDENT = ' '.repeat(INDENT_WIDTH);

// Normalize a thrown value into a real Error. The driver may reject with an
// array of message strings rather than an Error object.
function toError(err) {
  if (err instanceof Error) {
    return err;
  }
  if (Array.isArray(err)) {
    return new Error(err.join('; '));
  }
  return new Error(typeof err === 'string' ? err : JSON.stringify(err));
}

// 8-space indented status message (e2e convention for non-table output).
function log(message) {
  console.log(INDENT + message);
}

// Convert a CoraDB query result ({ ColumnNames, ColumnValues }) into row objects.
function resultRows(result) {
  const columns = result.ColumnNames || [];
  return (result.ColumnValues || []).map(function (row) {
    const obj = {};
    columns.forEach(function (name, i) { obj[name] = row[i]; });
    return obj;
  });
}

// Compact table renderer: a leading (header-less) row-index column, columns only
// as wide as their content, and type-based colors on a TTY (numbers/booleans
// yellow, strings green, null/undefined grey).
//
// options:
//   headerLabels  - map of dataKey -> display header (e.g. { Precision: 'Prec.' })
//   hiddenColumns - array of data keys to omit from the display
function printTable(rows, options) {
  options = options || {};
  const headerLabels = options.headerLabels || {};
  const hiddenColumns = options.hiddenColumns || [];

  if (!rows.length) {
    console.log(INDENT + '(no rows)');
    return;
  }

  const keys = Object.keys(rows[0]).filter(function (k) {
    return !hiddenColumns.includes(k);
  });
  const cell = function (v) { return (v === null || v === undefined) ? '' : String(v); };

  // First column is the row index (a number) with an empty header.
  const headers = [''].concat(keys.map(function (k) { return headerLabels[k] || k; }));
  const rawMatrix = rows.map(function (r, idx) {
    return [idx].concat(keys.map(function (k) { return r[k]; }));
  });
  const textMatrix = rawMatrix.map(function (row) { return row.map(cell); });

  const widths = headers.map(function (h, c) {
    return textMatrix.reduce(function (max, row) { return Math.max(max, row[c].length); }, h.length);
  });

  const useColor = !!process.stdout.isTTY;
  const paint = function (text, value) {
    if (!useColor) {
      return text;
    }
    let code;
    if (value === null || value === undefined) {
      code = 90;                              // grey
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      code = 33;                              // yellow
    } else if (typeof value === 'string') {
      code = 32;                              // green
    }
    return code ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;
  };

  const border = function (l, m, r) {
    return l + widths.map(function (w) { return '─'.repeat(w); }).join(m) + r;
  };
  const headerRow = '│' + headers.map(function (h, i) { return h.padEnd(widths[i]); }).join('│') + '│';
  const dataRow = function (raw, text) {
    return '│' + text.map(function (t, i) { return paint(t.padEnd(widths[i]), raw[i]); }).join('│') + '│';
  };

  const lines = [border('┌', '┬', '┐'), headerRow, border('├', '┼', '┤')];
  rawMatrix.forEach(function (raw, ri) { lines.push(dataRow(raw, textMatrix[ri])); });
  lines.push(border('└', '┴', '┘'));

  // Indent every line so the table aligns with the other (non-table) output.
  console.log(lines.map(function (line) { return INDENT + line; }).join('\n'));
}

module.exports = { CONFIG, INDENT, toError, log, resultRows, printTable };
