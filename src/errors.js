'use strict';

/*
 * The driver's errors.
 *
 * Every failure the driver produces is a CoraDBError (a batch of them is a
 * CoraDBBatchError), so a caller can tell one apart from a bug in its own code
 * with `instanceof`, and read what went wrong from fields rather than from the
 * message text:
 *
 *   code            the CAS or engine error code (a negative number) for a
 *                   failure the server reported, or a stable string for one
 *                   the driver decided on ('TIMEOUT', 'ABORTED', ...)
 *   casCode         the integer as it arrived on the wire, when there was one
 *   statement       the SQL the failure belongs to, when known
 *   statementIndex  its position in a batch
 *   retryable       true when the failure is transient and the statement did
 *                   not take effect: running it again may succeed
 *
 * `message` and `code` keep the values they had before this class existed, so
 * code that read them carries on working.
 *
 * Socket failures (ECONNRESET, ECONNREFUSED, ...) are passed through as Node
 * reports them; they are not CoraDBErrors.
 */

/**
 * Engine and CAS codes after which the statement did not take effect and
 * running it again is reasonable.
 *
 * The engine codes are the CUBRID-family lock codes (deadlock victim, lock wait
 * timed out); confirm them against CoraDB's own list before relying on them.
 */
const RETRYABLE_CODES = new Set([
  -72, // ER_LK_UNILATERALLY_ABORTED: chosen as a deadlock victim, rolled back
  -73, // ER_LK_OBJECT_TIMEOUT_SIMPLE_MSG: lock wait timed out
  -74, // ER_LK_OBJECT_TIMEOUT_CLASSOF_MSG
  -75, // ER_LK_OBJECT_TIMEOUT_CLASS_MSG
  -76, // ER_LK_PAGE_TIMEOUT
  -1017, -10017, // CAS_ER_FREE_SERVER: no CAS was free to take the request
  -1101, -10101, // CAS_ER_MAX_CLIENT_EXCEEDED
]);

class CoraDBError extends Error {
  /**
   * @param message what went wrong
   * @param details optional `{ code, casCode, statement, statementIndex,
   *                retryable, cause }`
   */
  constructor(message, details) {
    const d = details || {};

    super(message === undefined || message === null ? '' : String(message), d.cause === undefined ? undefined : { cause: d.cause });

    this.name = 'CoraDBError';
    this.code = d.code;
    this.casCode = d.casCode;
    this.statement = d.statement;
    this.statementIndex = d.statementIndex;
    this.retryable = d.retryable !== undefined ? Boolean(d.retryable) : RETRYABLE_CODES.has(d.code);
  }
}

/**
 * A batch in which one or more statements failed.
 *
 * `errors` holds one CoraDBError per failed statement, each carrying its
 * `statement` and `statementIndex`. `results` has one entry per statement the
 * engine ran, in order: the number of rows it changed, or null where it failed.
 */
class CoraDBBatchError extends AggregateError {
  constructor(errors, message, results) {
    super(errors, message);

    this.name = 'CoraDBBatchError';
    this.code = 'BATCH_FAILED';
    this.results = results || [];
    this.retryable = errors.length > 0 && errors.every((e) => e && e.retryable === true);
  }
}

/** A failure the driver decided on, with a stable string code. */
function driverError(code, message, details) {
  return new CoraDBError(message, Object.assign({ code }, details));
}

/**
 * An error the server sent: a CAS or engine code and, usually, a message.
 * When the server sent no text, the CAS code's name is used; when the code is
 * not one the driver knows either, the message says so rather than being empty.
 */
function serverError(code, message, details) {
  // Required lazily: ErrorMessages is a plain table, but keeping this module
  // free of other requires lets anything load it.
  const ErrorMessages = require('./constants/ErrorMessages');
  let text = message;

  if (!text) {
    text = ErrorMessages.CASErrorMsgId[code] || `CoraDB error ${code}`;
  }

  return new CoraDBError(text, Object.assign({ code, casCode: code }, details));
}

/** Attach the statement to an error that does not name one yet. */
function withStatement(err, statement, statementIndex) {
  if (err && typeof err === 'object' && err.statement === undefined && statement !== undefined) {
    try {
      err.statement = Array.isArray(statement) ? statement.join(';\n') : statement;

      if (statementIndex !== undefined && err.statementIndex === undefined) {
        err.statementIndex = statementIndex;
      }
    } catch (e) {
      void e; // a frozen error stays as it is
    }
  }

  return err;
}

/** Whether running the failed statement again may succeed. */
function isRetryable(err) {
  return Boolean(err && err.retryable === true);
}

/** What a request stopped by its `timeoutMs` fails with. */
function timeoutError(ms, statement) {
  return driverError('TIMEOUT', `The request did not finish within ${ms} ms.`, { statement, retryable: false });
}

/** What a request stopped by its AbortSignal fails with. */
function abortError(reason, statement) {
  const err = driverError('ABORT_ERR', 'The request was aborted.', {
    statement,
    retryable: false,
    cause: reason,
  });

  // The name `fetch` and every other AbortSignal consumer uses, so
  // `err.name === 'AbortError'` works the same way here.
  err.name = 'AbortError';

  return err;
}

module.exports = {
  CoraDBError,
  CoraDBBatchError,
  RETRYABLE_CODES,
  abortError,
  driverError,
  isRetryable,
  serverError,
  timeoutError,
  withStatement,
};
