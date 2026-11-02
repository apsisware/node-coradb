const Helpers = require('../utils/Helpers');

module.exports = Query;

/**
 * The (sql, params, callback) arguments of a request, sorted out.
 *
 *   (sql, callback)            no parameters
 *   (sql, params, callback)    the values bound to the `?` placeholders
 *
 * `sql` is a string or an array of statements. For an array, the values go to
 * the placeholders left to right across the statements. An array used to keep
 * `params` as the callback: `execute([...], params, cb)` never called `cb`,
 * sent the `?`s unbound, and swallowed the rejection.
 */
function Query(sql, params, cb) {
  if (typeof sql === 'function') {
    cb = sql;
  } else {
    if (typeof params === 'function') {
      cb = params;
      params = undefined;
    }

    if (Array.isArray(sql)) {
      this.sql = params === undefined ? sql : Helpers._sqlFormatBatch(sql, params);
    } else if (typeof sql === 'string') {
      // Only when there is something to bind. Formatting with no parameters
      // replaced the first `?` in the text with NULL — so `SELECT '?'` came
      // back as 'NULL', and a question mark in any literal was silently lost.
      this.sql = params === undefined ? sql : Helpers._sqlFormat(sql, params);
    } else {
      // Not SQL: passed on as it is, for the request to refuse by name.
      this.sql = sql;
    }
  }

  this.callback = cb;
}
