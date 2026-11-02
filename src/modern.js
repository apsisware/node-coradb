'use strict';

const CAS = require('./constants/CASConstants');
const { bind } = require('./params');
const ErrorMessages = require('./constants/ErrorMessages');
const { abortError, driverError, timeoutError, withStatement } = require('./errors');

/*
 * The everyday API, added beside the original methods (which are unchanged):
 *
 *   const { rows } = await conn.sql('select id, name from t where id > ?', [10]);
 *   for await (const row of conn.stream('select * from huge')) write(row);
 *   const cursor = await conn.cursor('select * from t');   // paging
 *   const stmt = await conn.prepare('insert into t (a, b) values (?, ?)');
 *   await conn.transaction(async () => { ... });
 *
 * Every call reads its rows as objects (or arrays, with `rowsAs: 'arrays'`),
 * binds `?` values on the server with types worked out from the values, closes
 * the query handle when it is done with it, and accepts `{ timeoutMs, signal }`.
 */

const DEFAULTS = Object.freeze({});

/** `{ type, value }`: a parameter with its type given, not an options object. */
function isTypedParam(value) {
  return value !== null && typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'type') &&
    Object.prototype.hasOwnProperty.call(value, 'value');
}

/**
 * `(params, options)`, `(options)` or `(value)`: the parameters as an array or
 * undefined, and the options as an object.
 */
function normalize(params, options) {
  if (params === undefined || params === null) {
    return { params: undefined, options: options || DEFAULTS };
  }

  if (Array.isArray(params)) {
    return { params, options: options || DEFAULTS };
  }

  if (typeof params === 'object' && !isTypedParam(params) && !(params instanceof Date) &&
      !Buffer.isBuffer(params) && !(params instanceof Uint8Array)) {
    return { params: undefined, options: params };
  }

  return { params: [params], options: options || DEFAULTS };
}

/** What a caller can know about each column of a result. */
function columnsOf(packet) {
  return (packet.infoArray || []).map((info) => {
    const column = {
      name: info.Name,
      type: CAS.getCoraDBDataTypeName(info.ColumnType),
      table: info.TableName || undefined,
      nullable: info.IsNullable,
      precision: info.precision,
      scale: info.scale,
    };

    // For a SET, MULTISET or SEQUENCE: what it holds.
    if (info.CollectionElementType) {
      column.elementType = CAS.getCoraDBDataTypeName(info.CollectionElementType);
    }

    return column;
  });
}

function rowsOf(values, columns, rowsAs) {
  if (rowsAs === 'arrays') {
    return values;
  }

  const names = columns.map((c) => c.name);
  const out = new Array(values.length);

  for (let i = 0; i < values.length; ++i) {
    const v = values[i];
    const row = {};

    for (let j = 0; j < names.length; ++j) {
      row[names[j]] = v[j];
    }

    out[i] = row;
  }

  return out;
}

/** The shape every read and write resolves with. */
function resultOf(packet, values, options) {
  const isRows = Boolean(packet.resultSet);
  const columns = isRows ? columnsOf(packet) : [];
  const rows = isRows ? rowsOf(values, columns, options.rowsAs) : [];
  const affected = !isRows && typeof packet.totalTupleCount === 'number' && packet.totalTupleCount > 0
    ? packet.totalTupleCount
    : 0;

  return { rows, columns, rowCount: rows.length, affectedRows: affected };
}

/** Whether every row of the result has arrived. */
function exhausted(packet) {
  return !packet.resultSet ||
    typeof packet.totalTupleCount !== 'number' ||
    packet.currentTupleCount >= packet.totalTupleCount;
}

/** Run `fn` with every request it enqueues marked as belonging to `ctx`. */
function inContext(conn, ctx, fn) {
  const queue = conn._queue;
  const previous = queue.context;

  queue.context = ctx;

  try {
    return fn();
  } finally {
    queue.context = previous;
  }
}

function timeoutOf(conn, options) {
  const ms = options.timeoutMs !== undefined ? options.timeoutMs : conn.requestTimeoutMs;

  if (ms === undefined || ms === null || ms === 0) {
    return 0;
  }

  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw driverError('INVALID_PARAMETER', `timeoutMs must be a number of milliseconds, not ${JSON.stringify(ms)}.`);
  }

  return ms;
}

/**
 * Run `work(ctx)` under the caller's `timeoutMs` and `signal`.
 *
 * Every request the work enqueues is marked with `ctx` (see `inContext`). When
 * the time runs out or the signal fires, the call fails at once with a TIMEOUT
 * or AbortError, and:
 *
 *   - its requests still waiting in the queue are removed, so they never run;
 *   - if its request is the one running, `cancel()` stops it — through the
 *     broker when it can, which keeps the connection; otherwise by aborting
 *     the connection, which fails every request on it.
 *
 * A request belonging to someone else is never touched: waiting behind
 * another caller's statement times out without cancelling that statement.
 */
function limited(conn, options, statement, work) {
  let ms;

  try {
    ms = timeoutOf(conn, options);
  } catch (err) {
    return Promise.reject(err);
  }

  const signal = options.signal;
  const ctx = { stopped: null };

  if (signal && signal.aborted) {
    return Promise.reject(abortError(signal.reason, statement));
  }

  if (!ms && !signal) {
    return start(work, ctx).catch((err) => {
      throw withStatement(err, statement);
    });
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    let timer = null;

    const finish = (fn, value) => {
      if (finished) {
        return;
      }

      finished = true;

      if (timer) {
        clearTimeout(timer);
      }

      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }

      fn(value);
    };

    const stop = (err) => {
      if (finished) {
        return;
      }

      ctx.stopped = err;
      conn._queue.drop(ctx, err);

      // Only our own request, and only while it still is: the test is made
      // again just before the broker is asked and again before any abort,
      // because the broker can take seconds to answer, and by then this
      // request may have finished and the next caller's started.
      const ours = () => conn._queue.isRunning(ctx);

      if (ours()) {
        conn.cancel({ onlyWhile: ours }).catch(() => undefined);
      }

      finish(reject, err);
    };

    const onAbort = () => stop(abortError(signal.reason, statement));

    if (ms) {
      timer = setTimeout(() => stop(timeoutError(ms, statement)), ms);
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    start(work, ctx)
      .then(
        (value) => finish(resolve, value),
        (err) => finish(reject, ctx.stopped || withStatement(err, statement))
      );
  });
}

/**
 * Start the work now, not on a later turn: its first request is enqueued
 * before the caller's next line runs, so `conn.sql(insert); conn.commit();`
 * keeps its order.
 */
function start(work, ctx) {
  try {
    return Promise.resolve(work(ctx));
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Read every remaining row of `handle`, a batch per request. Only from the
 * session `packet` came from (see `_generation`).
 */
async function readRest(conn, ctx, handle, packet, values) {
  while (!exhausted(packet)) {
    if (ctx.stopped) {
      throw ctx.stopped;
    }

    const response = await inContext(conn, ctx, () => conn._fetchFor(handle, false, packet._generation));
    const batch = response && response.result && response.result.ColumnValues;

    if (!batch || batch.length === 0) {
      break;
    }

    for (let i = 0; i < batch.length; ++i) {
      values.push(batch[i]);
    }
  }

  return values;
}

/**
 * Close a handle, never failing: the handle is gone either way. Only in the
 * session it came from (login `generation`): after a reconnect the same number
 * may name another caller's statement, which used to be closed in its place.
 */
function release(conn, handle, generation) {
  if (handle === undefined || handle === null) {
    return Promise.resolve();
  }

  return conn._releaseHandle(handle, generation);
}

function bindOrReject(params, statement) {
  try {
    return { bound: params ? bind(params) : null };
  } catch (err) {
    return { error: withStatement(err, statement) };
  }
}

/**
 * A query whose rows are read a batch at a time.
 *
 * `next()` resolves with the next batch — the first one has already arrived
 * with the query — and with an empty array once there are no more. The
 * handle is closed by itself when the last row has been read; call `close()`
 * to stop early. A cursor is also an async iterable of rows.
 */
class Cursor {
  constructor(conn, sql, handle, packet, options) {
    this._conn = conn;
    this._handle = handle;
    this._packet = packet;
    // The login the handle belongs to: next() and close() act on it only
    // while the connection is still on that login.
    this._generation = packet._generation;
    this._options = options;
    this._pending = packet.resultSet ? packet.resultSet.ColumnValues.slice() : null;
    // A CALL's result comes with no rows: they are fetched. An empty first
    // batch handed out as such would read as "no more rows".
    if (this._pending && this._pending.length === 0 && !exhausted(packet)) {
      this._pending = null;
    }
    this._closed = false;

    /** The statement. */
    this.sql = sql;
    /** The result's columns; empty for a statement that returns no rows. */
    this.columns = packet.resultSet ? columnsOf(packet) : [];
    /** How many rows the result has in all, as the server counted them. */
    this.total = packet.resultSet && typeof packet.totalTupleCount === 'number' ? packet.totalTupleCount : 0;
    /** For a statement that returns no rows, how many it changed. */
    this.affectedRows = packet.resultSet ? 0 : Math.max(0, packet.totalTupleCount || 0);
    /** True once every row has been handed out (or the cursor was closed). */
    this.done = !packet.resultSet;

    if (this.done) {
      this._closed = true;
      release(conn, handle, this._generation);
    }
  }

  async next(options) {
    if (this._pending) {
      const batch = this._pending;

      this._pending = null;

      if (exhausted(this._packet)) {
        await this.close();
      }

      return rowsOf(batch, this.columns, this._options.rowsAs);
    }

    if (this.done) {
      return [];
    }

    const merged = Object.assign({}, this._options, options || {});

    // The batch of a fetch that was stopped (timeoutMs, signal) but finished
    // anyway — the cancel came too late, or was not ours to make. Its rows
    // count as read on the handle: the next fetch starts after them. They
    // used to be thrown away, so a batch went missing without a word.
    if (this._late) {
      const late = await limited(this._conn, merged, this.sql, () => this._late);

      this._late = null;

      if (late && late.length > 0) {
        if (exhausted(this._packet)) {
          await this.close();
        }

        return rowsOf(late, this.columns, this._options.rowsAs);
      }

      if (this.done) {
        return [];
      }
    }

    let fetching;
    const response = await limited(this._conn, merged, this.sql, (ctx) => {
      fetching = inContext(this._conn, ctx, () => this._conn._fetchFor(this._handle, false, this._generation));
      return fetching;
    }).catch((err) => {
      if (fetching) {
        this._late = fetching.then(
          (r) => (r && r.result && r.result.ColumnValues) || null,
          () => null
        );
      }

      throw err;
    });
    const batch = response && response.result && response.result.ColumnValues;

    if (!batch || batch.length === 0) {
      await this.close();
      return [];
    }

    if (exhausted(this._packet)) {
      await this.close();
    }

    return rowsOf(batch, this.columns, this._options.rowsAs);
  }

  async close() {
    this.done = true;

    if (this._closed) {
      return;
    }

    this._closed = true;
    await release(this._conn, this._handle, this._generation);
  }

  async *[Symbol.asyncIterator]() {
    try {
      for (;;) {
        const batch = await this.next();

        for (const row of batch) {
          yield row;
        }

        if (batch.length === 0 && this.done) {
          return;
        }
      }
    } finally {
      await this.close();
    }
  }
}

if (typeof Symbol.asyncDispose === 'symbol') {
  Cursor.prototype[Symbol.asyncDispose] = Cursor.prototype.close;
}

/**
 * A statement compiled once on the server and run as often as wanted with
 * different values. `run()` resolves like `sql()`. Close it when done: it
 * holds a handle on the server until then (or until the connection closes).
 */
class PreparedStatement {
  constructor(conn, sql, packet, options) {
    this._conn = conn;
    this._prepared = packet;
    this._options = options;
    this._closed = false;

    /** The statement. */
    this.sql = sql;
    /** How many `?` values each run takes. */
    this.paramCount = packet.bindCount;
  }

  run(params, options) {
    const n = normalize(params, options);
    const merged = Object.assign({}, this._options, n.options);

    if (this._closed) {
      return Promise.reject(driverError('STATEMENT_CLOSED', 'The prepared statement is closed.', { statement: this.sql }));
    }

    const { bound, error } = bindOrReject(n.params || [], this.sql);

    if (error) {
      return Promise.reject(error);
    }

    if (bound.values.length !== this.paramCount) {
      return Promise.reject(driverError(
        'INVALID_PARAMETER',
        `The statement takes ${this.paramCount} parameter(s); ${bound.values.length} given.`,
        { statement: this.sql }
      ));
    }

    const conn = this._conn;

    return limited(conn, merged, this.sql, async (ctx) => {
      const packet = await inContext(conn, ctx, () => conn._runPrepared(this._prepared, bound));
      const values = packet.resultSet ? packet.resultSet.ColumnValues.slice() : [];

      await readRest(conn, ctx, packet.queryHandle, packet, values);

      return resultOf(packet, values, merged);
    });
  }

  async close() {
    if (this._closed) {
      return;
    }

    this._closed = true;
    await release(this._conn, this._prepared.queryHandle, this._prepared._generation);
  }
}

if (typeof Symbol.asyncDispose === 'symbol') {
  PreparedStatement.prototype[Symbol.asyncDispose] = PreparedStatement.prototype.close;
}

/**
 * The statement types whose result is a result set; the others report a
 * count of rows changed. The JDBC driver's `UResultInfo.isResultSet()` list.
 */
const RESULT_SET_TYPES = new Set([
  CAS.CoraDBStatementType.CORADB_STMT_SELECT,
  CAS.CoraDBStatementType.CORADB_STMT_CALL,
  CAS.CoraDBStatementType.CORADB_STMT_GET_STATS,
  CAS.CoraDBStatementType.CORADB_STMT_EVALUATE,
]);

/**
 * The results of several statements run together (`executeMulti()`), read
 * one after another the way a JDBC Statement reads them after `execute()`:
 *
 *   const r = await conn.executeMulti('update t set a = 1; select * from t');
 *   do {
 *     if (r.isResultSet) use(r.getResultSet().rows);
 *     else console.log(r.getUpdateCount(), 'rows changed');
 *   } while (await r.getMoreResults() || r.getUpdateCount() !== -1);
 *
 * or, closing it at the end (or on break):
 *
 *   for await (const result of await conn.executeMulti(sql)) { ... }
 *
 * The server runs every statement at once (EXECUTE with CCI_EXEC_QUERY_ALL)
 * and answers with one entry per statement: its type and its count. The first
 * result is current from the start; `getMoreResults()` moves on with
 * NEXT_RESULT (and FETCH for the rows of a result set). Once past the last one
 * the handle is closed, and — in auto-commit mode — the work committed, as
 * the JDBC driver does by itself for a statement with several results.
 */
class MultiResult {
  constructor(conn, sql, handle, packet, options) {
    this._conn = conn;
    this._handle = handle;
    this._packet = packet;
    this._generation = packet._generation;
    this._options = options;
    // One entry per statement, from the EXECUTE reply (JDBC: result_info).
    this._infos = Array.isArray(packet.resultInfos) && packet.resultInfos.length > 0
      ? packet.resultInfos.map((info) => ({ statementType: info.StmtType, count: info.ResultCount }))
      : [{ statementType: packet.statementType, count: packet.totalTupleCount }];
    this._index = 0;
    this._completed = false;
    this._current = null;
    this._updateCount = -1;
    // JDBC's turnOnAutoCommitBySelf(): more than one result in auto-commit
    // mode, so the driver commits when they have all been read.
    this._commitBySelf = conn.autoCommitMode === true && this._infos.length > 1;

    /** The statements. */
    this.sql = sql;
    /** How many results there are: one per statement. */
    this.resultCount = this._infos.length;
  }

  /** Whether the current result is a result set (JDBC: `execute()`'s answer). */
  get isResultSet() {
    return this._current !== null;
  }

  /**
   * The current result's rows, as `sql()` gives them, or null when the
   * current result is a count (or there is none left).
   */
  getResultSet() {
    return this._current;
  }

  /**
   * The current result's count of rows changed; -1 when it is a result set,
   * or when there are no more results.
   */
  getUpdateCount() {
    return this._updateCount;
  }

  /**
   * Move on to the next result. Resolves true when it is a result set, false
   * when it is a count — or when there are no more (then `getUpdateCount()`
   * is -1). Options: `timeoutMs`, `signal`. On failure the handle is closed.
   */
  getMoreResults(options) {
    const merged = Object.assign({}, this._options, options || {});

    return limited(this._conn, merged, this.sql, (ctx) => this._move(ctx));
  }

  /** Close the handle without reading the rest (JDBC: `complete()`). */
  async close() {
    this._current = null;
    this._updateCount = -1;
    await this._complete();
  }

  async *[Symbol.asyncIterator]() {
    try {
      // JDBC's loop: until there is neither a result set nor a count.
      for (;;) {
        if (this._current === null && this._updateCount === -1) {
          return;
        }

        yield this._current
          ? Object.assign({ isResultSet: true }, this._current)
          : { isResultSet: false, rows: [], columns: [], rowCount: 0, affectedRows: this._updateCount };

        await this.getMoreResults();
      }
    } finally {
      await this.close();
    }
  }

  /**
   * JDBC's `getMoreResults()`: the result at `_index` becomes current.
   * @private
   */
  async _move(ctx) {
    this._current = null;

    if (this._completed) {
      this._updateCount = -1;
      return false;
    }

    try {
      if (this._index === this._infos.length) {
        this._updateCount = -1;
        await this._complete(ctx);
        return false;
      }

      const conn = this._conn;
      let packet = this._packet;

      // The first result came with the EXECUTE reply; each later one is asked
      // for, whether it has rows or not.
      if (this._index !== 0) {
        packet = this._packet = await inContext(conn, ctx, () => conn._nextResultFor(this._handle, this._generation));
      }

      const info = this._infos[this._index];
      const isResultSet = RESULT_SET_TYPES.has(info.statementType);

      if (isResultSet) {
        const values = packet.resultSet && packet.resultSet.ColumnValues ? packet.resultSet.ColumnValues.slice() : [];

        await readRest(conn, ctx, this._handle, packet, values);

        const columns = columnsOf(packet);
        const rows = rowsOf(values, columns, this._options.rowsAs);

        this._current = { rows, columns, rowCount: rows.length, affectedRows: 0 };
        this._updateCount = -1;
      } else {
        this._updateCount = typeof info.count === 'number' && info.count > 0 ? info.count : 0;
      }

      this._index += 1;

      return isResultSet;
    } catch (err) {
      this._current = null;
      this._updateCount = -1;
      await this._complete(ctx).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Close the handle, then commit if the driver is to do it itself (see
   * `_commitBySelf`) and the connection is still in auto-commit mode on the
   * same session.
   * @private
   */
  async _complete(ctx) {
    if (this._completed) {
      return;
    }

    this._completed = true;

    const conn = this._conn;

    await release(conn, this._handle, this._generation);

    if (this._commitBySelf && conn.autoCommitMode === true &&
        conn.connectionOpened && conn._generation === this._generation) {
      await inContext(conn, ctx || undefined, () => conn._commitBySelf(this._generation));
    }
  }
}

if (typeof Symbol.asyncDispose === 'symbol') {
  MultiResult.prototype[Symbol.asyncDispose] = MultiResult.prototype.close;
}

/**
 * The classic methods that send requests. With a `requestTimeoutMs` set on
 * the connection, each is limited by it the way `sql()` is: on time out it
 * fails with TIMEOUT, its waiting requests leave the queue and its running
 * one is cancelled. They used to have no limit at all: a CAS that took a
 * request and never answered held the connection's queue for ever. With no
 * `requestTimeoutMs` (the default) they are as they were.
 */
const CLASSIC_TIMED = [
  'query', 'queryAll', 'queryAsObjects', 'queryAllAsObjects',
  'execute', 'executeWithTypedParams', 'batchExecuteNoQuery', 'getQueryPlan',
  'fetch', 'closeQuery', 'getGeneratedKeys',
  'commit', 'rollback', 'setAutoCommitMode', 'beginTransaction', 'endTransaction',
  'getSchema', 'getDatabaseParameter', 'setDatabaseParameter', 'getEngineVersion',
  'lobNew', 'lobWrite', 'lobRead',
];

/** The methods of CLASSIC_TIMED whose first argument is the SQL. */
const CLASSIC_WITH_SQL = new Set([
  'query', 'queryAll', 'queryAsObjects', 'queryAllAsObjects',
  'execute', 'executeWithTypedParams', 'batchExecuteNoQuery', 'getQueryPlan',
]);

function timeClassicMethods(P) {
  CLASSIC_TIMED.forEach((name) => {
    const untimed = P[name];

    P[name] = function (...args) {
      // No limit set; or called by the driver itself inside a limited call
      // (queryAll's query(), beginTransaction's setAutoCommitMode()), which
      // the outer limit already covers.
      if (!(this.requestTimeoutMs > 0) || this._queue.context !== undefined) {
        return untimed.apply(this, args);
      }

      // The callback is answered once: by the method as usual, or with the
      // TIMEOUT when the time runs out first (a late answer is then dropped,
      // like the promise's).
      let at = -1;

      for (let i = args.length - 1; i >= 0; --i) {
        if (typeof args[i] === 'function') {
          at = i;
          break;
        }
      }

      const callback = at >= 0 ? args[at] : undefined;
      let answered = false;

      if (callback) {
        args[at] = function (...result) {
          if (!answered) {
            answered = true;
            callback.apply(this, result);
          }
        };
      }

      const sql = CLASSIC_WITH_SQL.has(name) && (typeof args[0] === 'string' || Array.isArray(args[0])) ? args[0] : undefined;
      const promise = limited(this, {}, sql, (ctx) => inContext(this, ctx, () => untimed.apply(this, args)));

      if (callback) {
        promise.catch((err) => {
          if (!answered) {
            answered = true;

            try {
              callback(err);
            } catch (thrown) {
              process.nextTick(() => {
                throw thrown;
              });
            }
          }
        });
      }

      return promise;
    };
  });
}

/**
 * `err.code`, for anything thrown: `transaction()`'s function may throw
 * null, undefined or a string, and reading `.code` off those raised a
 * TypeError in place of the real failure.
 */
function codeOf(err) {
  return err !== null && (typeof err === 'object' || typeof err === 'function') ? err.code : undefined;
}

function install(CoraDBConnection, internal) {
  const P = CoraDBConnection.prototype;
  const {
    settle, dropped, prepareExecute, queryNewProtocol, prepareOnly, executePrepared,
    executeWithReconnect, reprepare, withStmtPoolingRetry,
  } = internal;

  /**
   * One queued request: connect if needed, run the statement — bound on the
   * server when there are values, as text otherwise — and hand back its
   * handle and packet.
   * @private
   */
  P._execute = function (sql, bound, options) {
    return new Promise((resolve, reject) => {
      this._queue.push((done) => {
        const { fulfil, fail } = settle(resolve, reject, undefined, done);

        // Run again on a new connection after an error the JDBC driver
        // reconnects after, when nothing was pending (see
        // _executeWithReconnect).
        executeWithReconnect.call(this, () => this._ensureConnected()
          .then(() => {
            if (bound && bound.values.length > 0) {
              return prepareExecute.call(this, sql, bound.values, bound.types, options);
            }

            return this.shouldUseOldQueryProtocol()
              ? prepareExecute.call(this, sql, undefined, undefined, options)
              : queryNewProtocol.call(this, sql, options);
          }))
          // The packet itself, not a lookup: the table is cleared if the
          // session is lost in between.
          .then((r) => fulfil({ handle: r.queryHandle, packet: r.packet }))
          .catch((err) => fail(withStatement(err, sql)));
      }, dropped(reject));
    });
  };

  /** @private */
  P._prepare = function (sql) {
    return new Promise((resolve, reject) => {
      this._queue.push((done) => {
        const { fulfil, fail } = settle(resolve, reject, undefined, done);

        this._ensureConnected()
          .then(() => prepareOnly.call(this, sql))
          .then((packet) => fulfil(packet))
          .catch((err) => fail(withStatement(err, sql)));
      }, dropped(reject));
    });
  };

  /** @private */
  P._runPrepared = function (prepared, bound) {
    return new Promise((resolve, reject) => {
      this._queue.push((done) => {
        const { fulfil, fail } = settle(resolve, reject, undefined, done);

        // A handle lives as long as the session that prepared it. After a
        // reconnect it names nothing — or something else: a new session hands
        // out numbers from 1 again, so the number alone proves nothing. The
        // login it was prepared on has to be the one the connection is on,
        // and the handle registered under the number has to be from it.
        const stillOpen = () => {
          const current = this._queryResultSets[prepared.queryHandle];

          return this.connectionOpened &&
            prepared._generation === this._generation &&
            Boolean(current) && current._generation === prepared._generation;
        };

        // As the JDBC driver does (UStatement.execute()): on a broker with
        // statement pooling, a statement whose session has gone is prepared
        // again on the new one; elsewhere it fails STATEMENT_CLOSED.
        const pooling = () => Boolean(this.brokerInfo) && this.brokerInfo.statementPolling === 1;

        const run = () => this._ensureConnected().then(() => {
          if (!stillOpen()) {
            if (!pooling()) {
              throw driverError('STATEMENT_CLOSED', ErrorMessages.ERROR_STATEMENT_SESSION_ENDED, { statement: prepared.options.sql });
            }

            return reprepare.call(this, prepared, false);
          }

          return undefined;
        }).then(() => withStmtPoolingRetry.call(this, (prepareFlag) => (prepareFlag
          // CAS_ER_STMT_POOLING: the server dropped the handle — prepared
          // again, the plan pinned from protocol V7 (see _withStmtPoolingRetry).
          ? reprepare.call(this, prepared, true)
          : Promise.resolve()).then(() => executePrepared.call(this, prepared, bound.values, bound.types))));

        // A session lost before the statement ran keeps STATEMENT_CLOSED
        // (unless the broker pools statements, above); one lost while it ran
        // is reconnected, and the statement prepared again there, as JDBC's
        // reset() does — when nothing was pending.
        if (!pooling() && !stillOpen()) {
          return fail(driverError(
            'STATEMENT_CLOSED',
            ErrorMessages.ERROR_STATEMENT_SESSION_ENDED,
            { statement: prepared.options.sql }
          ));
        }

        executeWithReconnect.call(this, run, () => this._ensureConnected().then(() => reprepare.call(this, prepared, false)))
          .then((packet) => fulfil(packet))
          .catch((err) => fail(withStatement(err, prepared.options.sql)));
      }, dropped(reject));
    });
  };

  /**
   * @private A queued connect, so it never races another request's. Resolves
   * with the login the connection is then on.
   */
  P._connectQueued = function () {
    return new Promise((resolve, reject) => {
      this._queue.push((done) => {
        const { fulfil, fail } = settle(resolve, reject, undefined, done);

        this._ensureConnected().then(() => fulfil(this._generation), fail);
      }, dropped(reject));
    });
  };

  /**
   * Run one statement and read all of its result.
   *
   *   const { rows, columns, rowCount, affectedRows } =
   *     await conn.sql('select * from t where id > ? and name = ?', [10, 'x']);
   *
   * Values are bound on the server, typed from the JavaScript value (see
   * README); `{ type, value }` gives a type explicitly. The handle is always
   * closed. Options: `timeoutMs`, `signal`, `rowsAs: 'objects' | 'arrays'`.
   */
  P.sql = function (sql, params, options) {
    const n = normalize(params, options);
    const { bound, error } = bindOrReject(n.params, sql);

    if (error) {
      return Promise.reject(error);
    }

    return limited(this, n.options, sql, async (ctx) => {
      const { handle, packet } = await inContext(this, ctx, () => this._execute(sql, bound));

      try {
        const values = packet && packet.resultSet ? packet.resultSet.ColumnValues.slice() : [];

        await readRest(this, ctx, handle, packet, values);

        return resultOf(packet, values, n.options);
      } finally {
        await release(this, handle, packet && packet._generation);
      }
    });
  };

  /**
   * Run several statements, separated by semicolons, in one request, and
   * read their results one after another — a JDBC Statement's `execute()`.
   * Resolves with a MultiResult whose first result is current.
   *
   *   const r = await conn.executeMulti('insert into t values (?); select * from t', [1]);
   *
   * `?` values are bound on the server across the statements, left to
   * right. Options: `timeoutMs`, `signal` (for this call and each
   * `getMoreResults()`), `rowsAs`. Close it (or read past the last result)
   * to release the handle.
   */
  P.executeMulti = function (sql, params, options) {
    const n = normalize(params, options);
    const { bound, error } = bindOrReject(n.params, sql);

    if (error) {
      return Promise.reject(error);
    }

    return limited(this, n.options, sql, async (ctx) => {
      const { handle, packet } = await inContext(this, ctx, () => this._execute(sql, bound, { queryAll: true }));
      const multi = new MultiResult(this, sql, handle, packet, n.options);

      if (ctx.stopped) {
        await multi._complete(ctx).catch(() => undefined);
        throw ctx.stopped;
      }

      await multi._move(ctx);

      return multi;
    });
  };

  /**
   * Run a query and hand back a Cursor over its rows. `timeoutMs` and
   * `signal` apply to each request: the query, and every `next()`.
   */
  P.cursor = function (sql, params, options) {
    const n = normalize(params, options);
    const { bound, error } = bindOrReject(n.params, sql);

    if (error) {
      return Promise.reject(error);
    }

    return limited(this, n.options, sql, async (ctx) => {
      const { handle, packet } = await inContext(this, ctx, () => this._execute(sql, bound));

      if (ctx.stopped) {
        await release(this, handle, packet && packet._generation);
        throw ctx.stopped;
      }

      // The signal goes on to every next(); the timeout too.
      return new Cursor(this, sql, handle, packet, n.options);
    });
  };

  /**
   * The rows of a query, one at a time, read a batch at a time.
   *
   *   for await (const row of conn.stream('select * from huge')) write(row);
   *
   * Leaving the loop early (break, return, throw) closes the handle.
   */
  P.stream = async function* (sql, params, options) {
    const cursor = await this.cursor(sql, params, options);

    try {
      yield* cursor;
    } finally {
      await cursor.close();
    }
  };

  /**
   * Compile a statement once, to run it many times.
   *
   *   const stmt = await conn.prepare('insert into t (a, b) values (?, ?)');
   *   for (const r of rows) await stmt.run([r.a, r.b]);
   *   await stmt.close();
   */
  P.prepare = function (sql, options) {
    const opts = options || DEFAULTS;

    return limited(this, opts, sql, async (ctx) => {
      const packet = await inContext(this, ctx, () => this._prepare(sql));

      if (ctx.stopped) {
        await release(this, packet.queryHandle, packet._generation);
        throw ctx.stopped;
      }

      return new PreparedStatement(this, sql, packet, opts);
    });
  };

  /**
   * Run `fn` in a transaction: auto-commit off, then commit when `fn`
   * resolves, or roll back when it throws. Auto-commit is put back as it was
   * either way. Resolves with what `fn` resolved with.
   *
   *   await conn.transaction(async (c) => {
   *     await c.sql('update a set n = n - 1 where id = ?', [1]);
   *     await c.sql('update b set n = n + 1 where id = ?', [2]);
   *   });
   *
   * The connection is shared: anything else run on it meanwhile is part of
   * the same transaction. Anything queued *before* the call is not: the
   * auto-commit change takes its place in the queue.
   *
   * It fails, and commits nothing, when:
   *   - the session is lost part-way (code TRANSACTION_LOST). The server has
   *     rolled back what ran before; nothing after it is sent on a new
   *     session, and the commit is refused. It used to reconnect silently and
   *     commit only the statements after the drop;
   *   - a statement in it was chosen as a deadlock victim (-72), even if `fn`
   *     caught that error and went on (code TRANSACTION_ROLLED_BACK,
   *     retryable: run the whole transaction again). The server rolled back
   *     everything before it, so committing the rest would commit half;
   *   - another transaction() is still running on the connection (code
   *     TRANSACTION_IN_PROGRESS; nothing is run). A connection has one
   *     transaction: two at once shared it, so one's COMMIT committed the
   *     other's work, and the first to finish turned auto-commit back on
   *     under the other;
   *   - `fn` failed and the rollback could not be done on a session that is
   *     still open (code ROLLBACK_FAILED, `cause` what `fn` threw,
   *     `rollbackError` why the rollback failed). Auto-commit is then left
   *     off: turning it back on would commit the work with the next
   *     statement. Call rollback() before going on. The failure used to be
   *     swallowed.
   */
  P.transaction = async function (fn) {
    if (typeof fn !== 'function') {
      throw driverError('INVALID_PARAMETER', 'transaction() takes a function to run.');
    }

    // Checked and taken before the first await, so of two calls made in the
    // same turn only the first runs.
    if (this._transactionActive) {
      throw driverError('TRANSACTION_IN_PROGRESS', ErrorMessages.ERROR_TRANSACTION_IN_PROGRESS);
    }

    this._transactionActive = true;

    let previous;

    try {
      // Queued, like everything else, so what was asked for before this call
      // runs in the mode it was asked in. `previous` is the mode as of that
      // point in the queue.
      previous = await this._swapAutoCommit(false);
    } catch (err) {
      this._transactionActive = false;
      throw err;
    }

    const rollbacksAtStart = this._rollbacks;
    let generation;
    // Whether the transaction has ended: committed, or rolled back (by us or
    // with its session). Only then is auto-commit put back.
    let ended = true;

    const rolledBack = () => this._rollbacks !== rollbacksAtStart;
    const lost = () => generation !== undefined &&
      (this._transactionLost || !this.connectionOpened || this._generation !== generation);

    try {
      generation = await this._connectQueued();

      const value = await fn(this);

      if (rolledBack()) {
        throw driverError('TRANSACTION_ROLLED_BACK', ErrorMessages.ERROR_TRANSACTION_ROLLED_BACK, {
          retryable: true,
          casCode: this._lastRollbackError && this._lastRollbackError.casCode,
          cause: this._lastRollbackError,
        });
      }

      // Refused unless the connection is still on the session the
      // transaction began in.
      await this._commitIn(generation);

      return value;
    } catch (err) {
      const wasLost = lost();
      const wasRolledBack = rolledBack();

      // On a lost session there is nothing to roll back: rollback() then
      // only clears the record of the loss.
      let rollbackError;

      await this.rollback().catch((e) => {
        rollbackError = e;
      });

      if (rollbackError && !lost() && this.connectionOpened) {
        ended = false;

        const failure = driverError('ROLLBACK_FAILED', ErrorMessages.ERROR_TRANSACTION_ROLLBACK_FAILED, { cause: err });

        failure.rollbackError = rollbackError;
        throw failure;
      }

      if (wasRolledBack && codeOf(err) !== 'TRANSACTION_ROLLED_BACK') {
        throw driverError('TRANSACTION_ROLLED_BACK', ErrorMessages.ERROR_TRANSACTION_ROLLED_BACK, {
          retryable: true,
          casCode: this._lastRollbackError && this._lastRollbackError.casCode,
          cause: err,
        });
      }

      if (wasLost && codeOf(err) !== 'TRANSACTION_LOST') {
        throw driverError('TRANSACTION_LOST', ErrorMessages.ERROR_TRANSACTION_LOST, { cause: err });
      }

      throw err;
    } finally {
      try {
        if (ended) {
          await this._swapAutoCommit(previous).catch(() => undefined);
        }
      } finally {
        this._transactionActive = false;
      }
    }
  };

  /**
   * The default `timeoutMs` for sql(), stream(), cursor() and prepare(), and
   * the time limit of the classic methods (see `CLASSIC_TIMED`).
   */
  P.setRequestTimeout = function (ms) {
    this.requestTimeoutMs = typeof ms === 'number' && ms > 0 ? Math.min(ms, 2147483647) : 0;
  };

  timeClassicMethods(P);

  CoraDBConnection.Cursor = Cursor;
  CoraDBConnection.PreparedStatement = PreparedStatement;
  CoraDBConnection.MultiResult = MultiResult;
}

module.exports = { install, Cursor, MultiResult, PreparedStatement, normalize };
