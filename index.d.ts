// Type definitions for node-coradb.
//
// Every async method returns a promise, and also takes an optional node-style
// callback as its last argument; with a callback, both are answered.

/// <reference types="node" />

import { EventEmitter } from 'node:events';

export type Callback<T = void> = (err: Error | undefined | null, result?: T) => void;

// --- connecting ----------------------------------------------------------------

export interface ConnectionOptions {
  /**
   * One host, optionally with its own port: 'db1', 'db1:33000', or an IPv6
   * address — bare ('::1') or in brackets ('[::1]', '[::1]:33000').
   */
  host?: string;
  /** Several hosts, tried in order (and again, `maxConnectionRetryCount` times). */
  hosts?: string[];
  /** Broker port for hosts that do not name one. Default 33000. */
  port?: number;
  /** Default 'PUBLIC'. */
  user?: string;
  password?: string;
  /** Default 'demodb'. */
  database?: string;
  /** Milliseconds to wait for the connection to open; 0 waits as long as the OS does. */
  connectionTimeout?: number;
  /** How many more times to go through the hosts; 0 for none. Default 1. */
  maxConnectionRetryCount?: number;
  logger?: Logger;
  /**
   * Default `timeoutMs` for sql(), stream(), cursor() and prepare(), and the
   * time limit of the classic methods (query(), execute(), commit(), ...);
   * 0 for none.
   */
  requestTimeoutMs?: number;
  /** How long the server lets a statement run, in milliseconds; 0 (default) for none. */
  queryTimeout?: number;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createConnection(options: ConnectionOptions): CoraDBConnection;
export function createConnection(
  hosts?: string | string[],
  port?: number,
  user?: string,
  password?: string,
  database?: string,
  connectionTimeout?: number,
  maxConnectionRetryCount?: number,
  logger?: Logger,
  requestTimeoutMs?: number,
  queryTimeout?: number,
): CoraDBConnection;
export const createCoraDBConnection: typeof createConnection;

// --- the everyday API ------------------------------------------------------------

/**
 * A value for a `?` placeholder. Its type is worked out from the value —
 * string → VARCHAR, whole number → INT (BIGINT beyond 32 bits), other number →
 * DOUBLE, bigint → BIGINT, boolean → SHORT 1/0, Date → DATETIME, Buffer →
 * VARBIT, null/undefined → NULL — or given explicitly as `{ type, value }`.
 */
export type ParamValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
  | Uint8Array
  | null
  | undefined
  | TypedParam;

export interface TypedParam {
  /** One of `BINDABLE_TYPES`, case-insensitive: 'numeric', 'date', 'json', ... */
  type: BindableType | CollectionTypeName | number;
  /**
   * For a numeric type, a string must be a decimal number ('' and '0x10' are
   * refused). For 'date', 'time', 'datetime' and 'timestamp', a string with no
   * zone ('2026-01-31 10:00:00'; for 'time', '10:00:00') is sent as written;
   * one with a zone ('...Z', '...+02:00') and a number are instants.
   * For 'set', 'multiset', 'sequence' and 'list', an array.
   */
  value: unknown;
  /**
   * A collection's element type. Without it (and without one in the type
   * name, 'set of int'), it is worked out from the elements.
   */
  elementType?: ElementType | number;
}

/** What the elements of a SET, MULTISET or SEQUENCE can be bound as. */
export type ElementType =
  | 'char' | 'varchar' | 'string' | 'nchar' | 'varnchar'
  | 'short' | 'int' | 'bigint' | 'float' | 'double' | 'monetary' | 'numeric'
  | 'date' | 'time' | 'datetime' | 'timestamp'
  | 'bit' | 'varbit';

/** A collection type with its element type: 'set of int', 'list(varchar)', 'multiset<date>'. */
export type CollectionTypeName = `${'set' | 'multiset' | 'sequence' | 'list'}${' of ' | '(' | '<'}${string}`;

export type BindableType =
  | 'char' | 'varchar' | 'string' | 'nchar' | 'varnchar' | 'json'
  | 'short' | 'int' | 'bigint' | 'float' | 'double' | 'monetary' | 'numeric'
  | 'date' | 'time' | 'datetime' | 'timestamp'
  | 'bit' | 'varbit' | 'blob' | 'clob'
  | 'set' | 'multiset' | 'sequence' | 'list';

export interface RequestOptions {
  /**
   * Milliseconds the request may take. When it runs out, the call fails with a
   * CoraDBError whose code is 'TIMEOUT'; requests of this call still waiting
   * are dropped, and the one running (if it is this call's) is cancelled —
   * through the broker when possible, otherwise by aborting the connection.
   */
  timeoutMs?: number;
  /** Stops the call the same way, failing it with an AbortError. */
  signal?: AbortSignal;
}

export interface ReadOptions extends RequestOptions {
  /** 'objects' (default): `{ column: value }`; 'arrays': values in column order. */
  rowsAs?: 'objects' | 'arrays';
}

export interface Column {
  name: string;
  /** 'Int', 'String', 'DateTime', ... (`CASConstants.getCoraDBDataTypeName`). */
  type: string;
  /** For a 'Set', 'Multiset' or 'Sequence' column: the type of its elements. */
  elementType?: string;
  table?: string;
  nullable: boolean;
  precision: number;
  scale: number;
}

/**
 * What a cell can hold, by column type:
 *
 * - SHORT, INT, FLOAT, DOUBLE, MONETARY: number.
 * - BIGINT: number, or the decimal text when the value lies outside
 *   Number.MIN_SAFE_INTEGER..MAX_SAFE_INTEGER (a number would be a different value).
 * - NUMERIC: number when `Number()` keeps the value exactly, its text otherwise.
 * - CHAR, VARCHAR, NCHAR, ENUM, JSON: string.
 * - DATE, TIME, DATETIME, TIMESTAMP: Date; the time-zone types: a Timezone object.
 *   The zero date (0000-00-00) is null.
 * - BIT, VARBIT: Buffer (a copy).
 * - SET, MULTISET, SEQUENCE: an array of element values.
 * - BLOB, CLOB: LobObject.
 * - GRAPH_OBJECT: its text when the server sends text, else `{ type: 'GraphObject', raw }`.
 * - A type the driver cannot decode: `{ type, typeCode, raw }` — never an Error.
 * - NULL: null.
 */
export type CellValue =
  | number
  | string
  | boolean
  | Date
  | Buffer
  | null
  | CellValue[]
  | LobObject
  | Timezone
  | RawValue
  | { [key: string]: unknown };

/** A value of one of the time-zone types (DATETIMETZ, TIMESTAMPLTZ, ...). */
export interface Timezone {
  /** The wall-clock time in the value's zone, in the Date's UTC fields. */
  datetime: Date;
  /** The zone as the server sent it ('Asia/Seoul KST'); '' when none. */
  timezone: string;
  region?: string;
  tzd: string;
  tzh: string;
  tzm: string;
  /** 'YYYY-MM-DD HH24:MI:SS.FF' and the zone. */
  toString(): string;
  /** Formatted like CoraDB's TO_CHAR date-time formats. */
  format(format: string): string;
  /** The instant, in milliseconds since 1970-01-01 UTC. */
  valueOf(): number;
  /** The zone's offset, in milliseconds (minutes to add to reach UTC). */
  getOffset(): number;
}

/** A value the driver returns as its bytes. */
export interface RawValue {
  type: string;
  typeCode?: number;
  raw: Buffer;
}

export type Row = Record<string, unknown>;

export interface SqlResult<R = Row> {
  /** Every row; empty for a statement that returns none. */
  rows: R[];
  columns: Column[];
  rowCount: number;
  /** For INSERT, UPDATE, DELETE and the like: how many rows changed. */
  affectedRows: number;
}

export declare class Cursor<R = Row> implements AsyncIterable<R> {
  readonly sql: string;
  readonly columns: Column[];
  /** Rows in the whole result, as the server counted them. */
  readonly total: number;
  readonly affectedRows: number;
  /** True once every row has been handed out, or after close(). */
  readonly done: boolean;
  /** The next batch; the first was read with the query. Empty once done. */
  next(options?: RequestOptions): Promise<R[]>;
  /** Close the handle early. The last next() closes it by itself. */
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<R>;
}

/** One result of `executeMulti()`, as its async iterator hands it out. */
export interface MultiResultItem<R = Row> extends SqlResult<R> {
  /** True for a result set; false for a count of rows changed (`affectedRows`). */
  isResultSet: boolean;
}

/**
 * The results of several statements run together, read like a JDBC Statement
 * after `execute()`: the first result is current; `getMoreResults()` moves on.
 */
export declare class MultiResult<R = Row> implements AsyncIterable<MultiResultItem<R>> {
  readonly sql: string;
  /** One per statement. */
  readonly resultCount: number;
  /** Whether the current result is a result set. */
  readonly isResultSet: boolean;
  /** The current result's rows; null for a count, or when there are no more. */
  getResultSet(): SqlResult<R> | null;
  /** The current result's rows changed; -1 for a result set, or when there are no more. */
  getUpdateCount(): number;
  /** Next result: true for a result set, false for a count or when there are no more. */
  getMoreResults(options?: RequestOptions): Promise<boolean>;
  /** Release the handle (and, in auto-commit mode, commit). */
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<MultiResultItem<R>>;
}

export declare class PreparedStatement<R = Row> {
  readonly sql: string;
  /** How many `?` values each run takes. */
  readonly paramCount: number;
  run(params?: ParamValue[], options?: ReadOptions): Promise<SqlResult<R>>;
  run(options: ReadOptions): Promise<SqlResult<R>>;
  /** Release the handle on the server. */
  close(): Promise<void>;
}

// --- the original API --------------------------------------------------------------

/** A result as the original methods return it: parallel arrays. */
export interface ResultSet {
  ColumnNames: string[];
  ColumnDataTypes: string[];
  ColumnValues: unknown[][];
  RowsCount: number;
}

export interface QueryResponse {
  queryHandle: number;
  /** Undefined for a statement that returns no rows. */
  result: ResultSet | undefined;
  /**
   * With `{ getGeneratedKeys: true }`, for an INSERT: the keys it generated,
   * read before query() resolved (the handle is then already closed and, in
   * auto-commit mode, the INSERT committed — as JDBC's executeUpdate(sql,
   * RETURN_GENERATED_KEYS)).
   */
  generatedKeys?: ResultSet;
}

export interface HostInfo {
  host: string;
  port: number | string;
}

export interface LobObject {
  lobType: number;
  packedLobHandle: Buffer;
  fileLocator: string;
  lobLength: number;
}

export declare class CoraDBConnection extends EventEmitter {
  /**
   * Emitted when the socket closes. A request in flight fails (with the socket
   * error, or code 'CONNECTION_CLOSED'), and so does every queued one. The next
   * request reconnects — unless auto-commit was off: then requests fail with
   * 'TRANSACTION_LOST' until rollback(), setAutoCommitMode() or connect().
   */
  on(event: 'disconnect', listener: () => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;

  readonly AUTOCOMMIT_ON: true;
  readonly AUTOCOMMIT_OFF: false;
  /** The CAS id the login answered with (`sessionId` is the same number, under its older name). */
  readonly casId: number | undefined;
  /** @deprecated The CAS id (see casId); not the 20-byte session id the driver resumes on reconnect. */
  readonly sessionId: number;
  requestTimeoutMs: number;
  /** The server-side query timeout in milliseconds; see setQueryTimeout(). */
  queryTimeout: number;

  // Everyday API
  /**
   * Run one statement and read all of its result; the handle is always closed.
   * `?` values are bound on the server.
   */
  sql<R = Row>(sql: string, params?: ParamValue[] | ParamValue, options?: ReadOptions): Promise<SqlResult<R>>;
  sql<R = Row>(sql: string, options: ReadOptions): Promise<SqlResult<R>>;
  /** Several statements (`;`-separated) in one request, read result by result (JDBC `execute()`). */
  executeMulti<R = Row>(sql: string, params?: ParamValue[] | ParamValue, options?: ReadOptions): Promise<MultiResult<R>>;
  executeMulti<R = Row>(sql: string, options: ReadOptions): Promise<MultiResult<R>>;
  /** The rows of a query one at a time; leaving the loop early closes the handle. */
  stream<R = Row>(sql: string, params?: ParamValue[] | ParamValue, options?: ReadOptions): AsyncGenerator<R, void, undefined>;
  stream<R = Row>(sql: string, options: ReadOptions): AsyncGenerator<R, void, undefined>;
  /** A query read a batch at a time; timeoutMs/signal apply to each request. */
  cursor<R = Row>(sql: string, params?: ParamValue[] | ParamValue, options?: ReadOptions): Promise<Cursor<R>>;
  cursor<R = Row>(sql: string, options: ReadOptions): Promise<Cursor<R>>;
  /** Compile once, run many times. Close it when done. */
  prepare<R = Row>(sql: string, options?: ReadOptions): Promise<PreparedStatement<R>>;
  /**
   * Auto-commit off, run `fn`, then commit — or roll back if it throws.
   * Auto-commit is put back as it was either way. Requests queued before the
   * call are not part of it. Fails with 'TRANSACTION_LOST' if the session is
   * lost part-way (nothing is sent on a new session, nothing is committed), and
   * with 'TRANSACTION_ROLLED_BACK' (retryable) if a statement in it was a
   * deadlock victim, even one `fn` caught. One at a time per connection: a
   * call made while another is running fails with 'TRANSACTION_IN_PROGRESS'
   * and runs nothing. If `fn` fails and the rollback cannot be done on a
   * session that is still open, it fails with 'ROLLBACK_FAILED' (`cause`:
   * what `fn` threw; `rollbackError`) and leaves auto-commit off.
   */
  transaction<T>(fn: (conn: this) => Promise<T> | T): Promise<T>;
  /** The default `timeoutMs` for the everyday API; 0 for none. */
  setRequestTimeout(ms: number): void;

  // Connection
  connect(callback?: Callback): Promise<void>;
  close(callback?: Callback): Promise<void>;
  /** The same as close(). */
  end(callback?: Callback): Promise<void>;
  /** The host in use, connecting first if needed. See getConnectedHost(). */
  getActiveHost(callback?: Callback<HostInfo>): Promise<HostInfo>;
  /** The host in use, or null when not connected. Never connects. */
  getConnectedHost(): HostInfo | null;
  getEngineVersion(callback?: Callback<string>): Promise<string>;
  setConnectionTimeout(timeout: number): void;
  getConnectionTimeout(): number;
  /**
   * Whether the connection is open and its session answers (CHECK_CAS).
   * Never rejects; false at once when not connected (does not connect).
   */
  isValid(callback?: Callback<boolean>): Promise<boolean>;
  /**
   * How long the server lets each statement executed from now on run, in
   * milliseconds; 0 (or anything not positive) for none.
   */
  setQueryTimeout(queryTimeout: number): void;
  getQueryTimeout(): number;

  // Statements
  /** First batch of rows; the handle stays open for fetch() and must be closed. */
  query(sql: string, callback: (err: Error | undefined, result?: ResultSet, queryHandle?: number) => void): Promise<QueryResponse>;
  query(sql: string, params?: unknown[] | unknown, callback?: (err: Error | undefined, result?: ResultSet, queryHandle?: number) => void, options?: QueryOptions): Promise<QueryResponse>;
  query(sql: string, params: unknown[] | unknown, options: QueryOptions): Promise<QueryResponse>;
  /**
   * The keys an INSERT generated, by the handle of an INSERT run with
   * query(..., { getGeneratedKeys: true }): the keys read when it ran, without
   * a request, until closeQuery(queryHandle) or close(). Fails with
   * 'NO_ACTIVE_QUERY' for any other handle.
   */
  getGeneratedKeys(queryHandle: number, callback?: Callback<ResultSet>): Promise<ResultSet>;
  /**
   * Every row; the handle is closed. For a statement that returns no rows,
   * an empty ResultSet (no columns, no rows, RowsCount 0).
   */
  queryAll(sql: string, callback: Callback<ResultSet>): Promise<ResultSet>;
  queryAll(sql: string, params?: unknown[] | unknown, callback?: Callback<ResultSet>): Promise<ResultSet>;
  /** Like query(): the first batch only, and the handle left open. */
  queryAsObjects(sql: string, callback: (err: Error | undefined, rows?: Row[], queryHandle?: number) => void): Promise<{ queryHandle: number; result: Row[] }>;
  queryAsObjects(sql: string, params?: unknown[] | unknown, callback?: (err: Error | undefined, rows?: Row[], queryHandle?: number) => void): Promise<{ queryHandle: number; result: Row[] }>;
  /** Like queryAll(): every row, handle closed. */
  queryAllAsObjects(sql: string, callback: Callback<Row[]>): Promise<Row[]>;
  queryAllAsObjects(sql: string, params?: unknown[] | unknown, callback?: Callback<Row[]>): Promise<Row[]>;
  fetch(queryHandle: number, callback: (err: Error | undefined, result?: ResultSet | null, queryHandle?: number) => void): Promise<{ queryHandle: number; result: ResultSet | null }>;
  fetch(queryHandle: number, all?: boolean, callback?: (err: Error | undefined, result?: ResultSet | null, queryHandle?: number) => void): Promise<{ queryHandle: number; result: ResultSet | null }>;
  closeQuery(queryHandle: number, callback?: Callback): Promise<void>;
  /** The handle's columns; undefined for a statement that returns no rows. */
  getMetaData(queryHandle: number, callback?: Callback<ResultSet | undefined>): Promise<ResultSet | undefined>;
  /** Rows changed: a number for one statement, one per statement for an array. */
  execute(sql: string, callback: Callback<number>): Promise<number>;
  execute(sql: string, params?: unknown[] | unknown, callback?: Callback<number>): Promise<number>;
  execute(sql: string[], params?: unknown[] | unknown, callback?: Callback<number[]>): Promise<number[]>;
  /**
   * Statements in one batch. Resolves with the rows each changed. When any
   * fail it rejects with a CoraDBBatchError naming each one.
   */
  batchExecuteNoQuery(sqls: string | string[], callback?: Callback<number[]>): Promise<number[]>;
  /** A WRITE with values bound on the server; one type per value. Resolves with rows changed. */
  executeWithTypedParams(sql: string, params?: unknown[], dataTypes?: (BindableType | CollectionTypeName | number)[], callback?: Callback<number>): Promise<number>;
  /** The plan the engine would use; the statement is not run. */
  getQueryPlan(sql: string, callback?: Callback<string>): Promise<string>;

  // Stopping
  /**
   * Stop the running statement: via the broker, else by aborting the connection.
   * `onlyWhile` is tested again just before the broker is asked and before any
   * abort; when it returns false nothing is interrupted and `method` is 'none'.
   */
  cancel(callback: Callback<CancelOutcome>): Promise<CancelOutcome>;
  cancel(options?: CancelOptions, callback?: Callback<CancelOutcome>): Promise<CancelOutcome>;
  canBrokerCancel(): boolean;
  getCasProcessId(): number | undefined;
  /** Take the socket down; every waiting request fails with code 'ABORTED'. */
  abort(callback: Callback): Promise<void>;
  abort(reason?: string, callback?: Callback): Promise<void>;

  // Transactions
  /**
   * Takes effect in queue order — behind every request made before it — and
   * resolves once it has. When the mode changes, the work done so far is
   * committed first, as JDBC's setAutoCommit() does; if that commit fails, the
   * mode is unchanged.
   */
  setAutoCommitMode(autoCommitMode: boolean, callback?: Callback): Promise<void>;
  getAutoCommitMode(): boolean;
  /**
   * Fails with 'TRANSACTION_LOST' when the session the transaction ran in has
   * gone. COMMIT is sent only when the server reports a transaction open.
   */
  commit(callback?: Callback): Promise<void>;
  /**
   * Closes the open results (not prepared statements), then sends ROLLBACK when
   * the server reports a transaction open. With the session gone (and its
   * transaction rolled back by the server), resolves without sending anything.
   */
  rollback(callback?: Callback): Promise<void>;
  /**
   * Turns auto-commit off; sends nothing.
   * @deprecated Use transaction(fn), or setAutoCommitMode(false).
   */
  beginTransaction(callback?: Callback): Promise<void>;
  /**
   * Turns auto-commit on; neither commits nor rolls back.
   * @deprecated Use transaction(fn), or setAutoCommitMode(true).
   */
  endTransaction(callback?: Callback): Promise<void>;

  // Catalog and parameters
  getSchema(schemaType: number, callback: Callback<Record<string, unknown>[]>): Promise<Record<string, unknown>[]>;
  getSchema(schemaType: number, tableNameFilter?: string, callback?: Callback<Record<string, unknown>[]>): Promise<Record<string, unknown>[]>;
  /** A `DbParam` number or name: 'ISOLATION_LEVEL', 'isolationLevel', ... */
  getDatabaseParameter(parameter: DbParamName | number, callback?: Callback<number>): Promise<number>;
  setDatabaseParameter(parameter: DbParamName | number, value: number, callback?: Callback): Promise<void>;

  // LOBs
  lobNew(lobType: number, callback?: Callback<LobObject>): Promise<LobObject>;
  lobWrite(lobObject: LobObject, offset: number, data: string | Buffer, callback?: (err: Error | undefined, lobObject?: LobObject, length?: number) => void): Promise<{ lobObject: LobObject; length: number }>;
  lobRead(lobObject: LobObject, offset: number, length: number, callback?: (err: Error | undefined, data?: string | Buffer, length?: number) => void): Promise<{ data: string | Buffer; length: number }>;

  // Protocol and queue
  setEnforceOldQueryProtocol(enforceOldProtocol: boolean): void;
  shouldUseOldQueryProtocol(): boolean;
  /** True when nothing is running or waiting. */
  isQueueEmpty(): boolean;
  /** The running request (if any) plus every waiting one. */
  getQueueLength(): number;
  /** @deprecated The same as getQueueLength(). */
  getQueueDepth(): number;
}

export interface QueryOptions {
  /** Keep the keys the statement (an INSERT) generates, for getGeneratedKeys(). */
  getGeneratedKeys?: boolean;
}

export interface CancelOptions {
  /** false: go straight to abort(). */
  brokerCancel?: boolean;
  /** Milliseconds to wait for the broker (default 2000). */
  timeout?: number;
  /** Re-checked before the broker cancel and before any abort; false stops the cancel. */
  onlyWhile?: () => boolean;
}

export interface CancelOutcome {
  /** 'broker': statement stopped, connection kept. 'abort': connection closed. 'none': nothing was interrupted. */
  method: 'broker' | 'abort' | 'none';
}

// --- errors ----------------------------------------------------------------------

export interface CoraDBErrorDetails {
  code?: number | string;
  casCode?: number;
  statement?: string;
  statementIndex?: number;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * Every failure the driver produces. `code` is the CAS or engine code (a
 * negative number) for an error the server reported, or a stable string for
 * one the driver decided on: 'TIMEOUT', 'ABORT_ERR', 'ABORTED',
 * 'CLOSED_WHILE_QUEUED', 'CONNECTION_CLOSED', 'TRANSACTION_LOST',
 * 'TRANSACTION_ROLLED_BACK', 'TRANSACTION_IN_PROGRESS', 'ROLLBACK_FAILED',
 * 'PROTOCOL_ERROR', 'INVALID_PARAMETER',
 * 'STATEMENT_CLOSED', 'NO_ACTIVE_QUERY', 'LOB_WRITE_FAILED', ... Socket errors
 * (ECONNRESET, ...) on the request in flight pass through as Node reports them.
 */
export declare class CoraDBError extends Error {
  constructor(message: string, details?: CoraDBErrorDetails);
  code: number | string | undefined;
  /** The integer as it arrived on the wire, when there was one. */
  casCode: number | undefined;
  /** The SQL this failure belongs to, when known. */
  statement: string | undefined;
  /** Its position within a batch. */
  statementIndex: number | undefined;
  /**
   * Transient, and the statement did not take effect: running it again may
   * succeed. A deadlock victim (-72) with auto-commit off is not retryable on
   * its own: the whole transaction was rolled back (see `transactionRolledBack`).
   */
  retryable: boolean;
  /** True when the server rolled back the whole transaction the statement was in. */
  transactionRolledBack?: boolean;
  /** On 'ROLLBACK_FAILED': why the rollback failed. */
  rollbackError?: unknown;
}

/** A batch in which one or more statements failed. */
export declare class CoraDBBatchError extends AggregateError {
  constructor(errors: CoraDBError[], message: string, results?: (number | null)[]);
  errors: CoraDBError[];
  code: 'BATCH_FAILED';
  /** One entry per statement run: rows changed, or null where it failed. */
  results: (number | null)[];
  retryable: boolean;
}

export function isRetryable(err: unknown): boolean;

// --- constants ---------------------------------------------------------------------

export type DbParamName =
  | 'ISOLATION_LEVEL' | 'LOCK_TIMEOUT' | 'MAX_STRING_LENGTH' | 'AUTO_COMMIT'
  | 'isolationLevel' | 'lockTimeout' | 'maxStringLength' | 'autoCommit'
  | (string & {});

export const DbParam: Readonly<{
  ISOLATION_LEVEL: 1;
  LOCK_TIMEOUT: 2;
  MAX_STRING_LENGTH: 3;
  AUTO_COMMIT: 4;
}>;

export const IsolationLevel: Readonly<{
  READ_COMMITTED: 4;
  REPEATABLE_READ: 5;
  SERIALIZABLE: 6;
  TRAN_UNKNOWN_ISOLATION: 0;
  TRAN_COMMIT_CLASS_UNCOMMIT_INSTANCE: 1;
  TRAN_COMMIT_CLASS_COMMIT_INSTANCE: 2;
  TRAN_REP_CLASS_UNCOMMIT_INSTANCE: 3;
  TRAN_REP_CLASS_COMMIT_INSTANCE: 4;
  TRAN_REP_CLASS_REP_INSTANCE: 5;
  TRAN_SERIALIZABLE: 6;
  TRAN_DEFAULT_ISOLATION: 1;
}>;

/** 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE', or undefined. */
export function isolationLevelName(level: number): string | undefined;

/**
 * Every CAS schema type. `getSchema()` reads the ones named here; it refuses
 * the others with INVALID_SCHEMA_TYPE.
 */
export const SchemaType: Readonly<Record<string, number>> & {
  CCI_SCH_CLASS: 1;
  CCI_SCH_VCLASS: 2;
  CCI_SCH_ATTRIBUTE: 4;
  CCI_SCH_CONSTRAINT: 11;
  CCI_SCH_CLASS_PRIVILEGE: 13;
  CCI_SCH_PRIMARY_KEY: 16;
  CCI_SCH_IMPORTED_KEYS: 17;
  CCI_SCH_EXPORTED_KEYS: 18;
};

export const DataType: Readonly<Record<string, number>>;
export const BINDABLE_TYPES: BindableType[];

/** Every protocol constant table the driver uses. */
export const CASConstants: {
  CASFunctionCode: Readonly<Record<string, number>>;
  CoraDBStatementType: Readonly<Record<string, number>>;
  CoraDBIsolationLevel: Readonly<Record<string, number>>;
  CoraDBDataType: Readonly<Record<string, number>>;
  CoraDBSchemaType: Readonly<Record<string, number>>;
  CCIDbParam: Readonly<Record<string, number>>;
  CCILOBType: Readonly<{ CCI_LOB_TYPE_BLOB: 33; CCI_LOB_TYPE_CLOB: 34 }>;
  CCITransactionType: Readonly<Record<string, number>>;
  getCoraDBDataTypeName(type: number): string;
  getCoraDBDataTypeNumber(type: string | number): number;
  getCoraDBSchemaTypeName(schemaType: number): string;
  [name: string]: unknown;
};

export const Helpers: {
  formatAsMoney(value: number, decimals?: number, decimalSeparator?: string, thousandsSeparator?: string): string;
  getBufferFromString(str: string, encoding?: BufferEncoding): Buffer;
  [name: string]: unknown;
};
