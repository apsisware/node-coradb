# node-coradb vs. node-cubrid

## Highlights

| | |
| --- | --- |
| **A new, promise-first API** | `sql()`, `stream()`, `cursor()`, `prepare()`, `executeMulti()` and `transaction()`, with per-request timeouts and `AbortSignal`. The original methods are all kept. |
| **Correct values** | BIGINT and NUMERIC are never rounded (text when a number would change them), SMALLINT is signed, collections and JSON are read and bound, strings are decoded in their column's charset, and time-zone values give the right instant, including the hour repeated when DST ends. |
| **Safe transactions** | Changing auto-commit commits the pending work, as JDBC does; a session lost with auto-commit off fails with `TRANSACTION_LOST` instead of silently reconnecting; COMMIT and ROLLBACK are sent only when a transaction is open; results stay open across a commit. |
| **Resilient connections** | A lost socket answers every waiting request; a statement interrupted by a lost connection is retried once on a new one when nothing was pending; dropped prepared statements are prepared again; `cancel()` stops a statement through the broker and keeps the connection. |
| **Real errors** | Every failure is a `CoraDBError` (`code`, `casCode`, `statement`, `retryable`); failed batches are a `CoraDBBatchError`. CAS errors use the current numbering (`-10007`, not `-1007`). |
| **Modern runtime** | Node.js 20+, luxon instead of moment-timezone, TypeScript definitions (`index.d.ts`), mocha 11 / chai 6 / eslint 10 / c8. |

## Contents

1. [Moving code over](#1-moving-code-over)
2. [Runtime, dependencies and package](#2-runtime-dependencies-and-package)
3. [New API](#3-new-api)
4. [The original methods: what behaves differently](#4-the-original-methods-what-behaves-differently)
5. [Transactions and sessions](#5-transactions-and-sessions)
6. [Values](#6-values)
7. [Errors](#7-errors)
8. [Connection loss, timeouts and cancelling](#8-connection-loss-timeouts-and-cancelling)
9. [Wire protocol](#9-wire-protocol)
10. [Tests and tooling](#10-tests-and-tooling)
11. [Not carried over](#11-not-carried-over)

---

## 1. Moving code over

The API keeps node-cubrid's shape: the same methods, arguments and result
objects. The names change from CUBRID to CoraDB.

| node-cubrid | node-coradb |
| --- | --- |
| `require('node-cubrid')` | `require('@coradb/node-coradb')` |
| `createCUBRIDConnection()` | `createCoraDBConnection()` (`createConnection()` is unchanged) |
| `CUBRIDConnection` (not exported) | `CoraDBConnection` (exported) |
| `CASConstants.CUBRIDDataType`, `CUBRIDSchemaType`, `CUBRIDIsolationLevel`, `CUBRIDStatementType`, `CUBRIDCollectionCommand` | `CoraDBDataType`, `CoraDBSchemaType`, `CoraDBIsolationLevel`, `CoraDBStatementType`, `CoraDBCollectionCommand` |
| `CUBRID_STMT_*` | `CORADB_STMT_*` (same numbers) |
| `getCUBRIDDataTypeName()`, `getCUBRIDDataTypeNumber()` | `getCoraDBDataTypeName()`, `getCoraDBDataTypeNumber()` |
| default user `public` | default user `PUBLIC` (user names are not case-sensitive) |

Things to check when moving code, because they behave differently (details in
the sections below):

- A method given a callback **also returns a promise that settles**. In
  node-cubrid that promise stayed pending for ever.
- `execute()`, `batchExecuteNoQuery()` and `executeWithTypedParams()` **resolve
  with the rows changed**; they resolved with nothing.
- Every rejection is a real `Error` (a `CoraDBError`); a failed batch is a
  `CoraDBBatchError` (an `AggregateError`), not an array.
- **`setAutoCommitMode()` commits** the pending work when the mode changes.
- BIGINT and NUMERIC values that do not fit a JavaScript number come back as
  **strings**; a zero date comes back as **null**; SMALLINT is signed.
- After a lost connection with auto-commit off, requests fail with
  `TRANSACTION_LOST` instead of silently reconnecting.
- The text formatter escapes strings by doubling the quote only (no backslash
  escapes), and refuses values it cannot write safely.

## 2. Runtime, dependencies and package

| | node-cubrid 11.0.0 | node-coradb |
| --- | --- | --- |
| Node.js | `>=4` | `>=20` |
| Runtime dependency | `moment-timezone` | `luxon` (time-zone values) |
| Test / lint tools | mocha 3, chai 3, eslint 3, istanbul, coveralls | mocha 11, chai 6, eslint 10 (flat config), c8 |
| Type definitions | none | `index.d.ts` |
| Published files | everything | `index.js`, `index.d.ts`, `src/`, `CHANGELOG.md`, `COMPARISON WITH CUBRID DRIVER.md` (`files` in package.json) |
| Protocol version sent | V7 | V9 |
| Package | `node-cubrid` 11.0.0 | `@coradb/node-coradb` 1.0.0 (public, scoped under the CoraDB npm organization) |

Source changes that apply throughout: `node:` prefixes on built-in modules,
`Buffer.alloc` / `Buffer.from` instead of `new Buffer`, `subarray` instead of
`slice`, strict equality, `const` / `let`, and BigInt reads for 64-bit values.

## 3. New API

None of these exist in node-cubrid. All are additions; nothing was renamed or
removed from the original methods.

**The everyday API** (README: *The everyday API*)

- `sql(sql, params, options)` → `{ rows, columns, rowCount, affectedRows }`:
  rows as objects (or arrays with `rowsAs: 'arrays'`), every row read, the
  handle always closed. Values are bound on the server.
- `stream(sql, params, options)`: an async iterable of rows.
- `cursor(sql, params, options)` → `Cursor`: batches under the caller's
  control (`next()`, `close()`).
- `prepare(sql)` → `PreparedStatement`: compile once, `run()` many times.
- `executeMulti(sql, params, options)` → `MultiResult`: several statements in
  one request, read result by result like a JDBC Statement
  (`getResultSet()`, `getUpdateCount()`, `getMoreResults()`), or iterated.
- `transaction(fn)`: commit when `fn` resolves, roll back when it throws,
  auto-commit restored.
- Per-request `timeoutMs` and `signal` (an `AbortSignal`), and a connection
  default: `requestTimeoutMs` / `setRequestTimeout()`. The default also limits
  the original methods.

**Connection and server**

- `isValid()`: is the session still there (CHECK_CAS); never rejects.
- `cancel()`: stop the running statement through the broker (out of band),
  falling back to `abort()`; `canBrokerCancel()`, `getCasProcessId()`.
- `abort()`: take the connection down and answer every waiting request.
- `getQueryPlan(sql)`: the optimizer's plan, without running the statement.
- `setQueryTimeout()` / `getQueryTimeout()` and the `queryTimeout` option: the
  server-side statement timeout.
- `getGeneratedKeys(queryHandle)` and `query(..., { getGeneratedKeys: true })`
  (the response also carries `generatedKeys`).
- `getConnectedHost()` (never connects), `getQueueLength()` (the new name of
  `getQueueDepth()`), `casId`.
- `getDatabaseParameter()` / `setDatabaseParameter()` take names
  (`'ISOLATION_LEVEL'`, `'isolationLevel'`) as well as numbers.

**Exports** (`require('@coradb/node-coradb')`)

`CoraDBConnection`, `Cursor`, `PreparedStatement`, `MultiResult`,
`CASConstants`, `DbParam`, `IsolationLevel` (with `READ_COMMITTED`,
`REPEATABLE_READ`, `SERIALIZABLE`), `isolationLevelName()`, `SchemaType`,
`DataType`, `BINDABLE_TYPES`, `CoraDBError`, `CoraDBBatchError`,
`isRetryable()`. node-cubrid exports only `Helpers` and `createConnection()`.

**Constants** (`CASConstants`): the data types `TIMETZ`, `JSON`,
`GRAPH_OBJECT`; `CCI_EXEC_GET_GENERATED_KEYS`; `CCI_PREPARE_XASL_CACHE_PINNED`;
the function codes up to `CAS_CHANGE_MODE`; `ColumnTypeMask`,
`CollectionFlag`, `CharsetId`, `getCharsetEncoding()`,
`confirmColumnType()`, `getCoraDBSchemaTypeName()`,
`getCoraDBClassTypeName()`; the client and CAS-info flags.

## 4. The original methods: what behaves differently

**Promises and callbacks**

- With a callback, the promise also settles (it hung in node-cubrid), and is
  marked handled so a failure is not also an unhandled rejection. Callbacks
  are called exactly once; one that throws does not get its own exception back
  as a second call.

**Results**

- `execute(sql)` resolves with the rows changed (an array for an array of
  statements); `batchExecuteNoQuery()` with one count per statement;
  `executeWithTypedParams()` with the rows changed.
- `queryAll()` / `queryAllAsObjects()` of a statement without rows resolve with
  an empty result; in node-cubrid they fetched for ever.
- `queryAsObjects()` of a statement without rows resolves with `[]` (it threw a
  TypeError).
- CALL, EVALUATE and GET STATISTICS return their value as a one-row result.
- `getSchema()` refuses the schema types it cannot read
  (`INVALID_SCHEMA_TYPE`), reads every row (in several fetches if needed),
  closes its server handle, and for `CCI_SCH_CONSTRAINT` matches the table
  name exactly. Views are typed `'User view'` (`'Unknown (1)'` before).
- `getDatabaseParameter('MAX_STRING_LENGTH')` reads the value; node-cubrid
  refused it.

**Handles**

- A handle belongs to the session that opened it. After a reconnect,
  `fetch()`, `closeQuery()`, `getMetaData()` and `getGeneratedKeys()` refuse
  an old handle (`NO_ACTIVE_QUERY`) instead of acting on whatever statement
  the new session put under the same number; handles from later logins carry
  their login in the number. `fetch()` and `closeQuery()` do not reconnect.
- `executeWithTypedParams()` closes the handle it opened (node-cubrid left one
  open per call); so does `getSchema()`.

**Requests and the queue**

- Requests run strictly in the order they were made: `commit()`,
  `rollback()` and `setAutoCommitMode()` no longer jump the queue. A handle's
  fetches and its close keep their order among themselves.
- `close()` waits for the request already running, closes every handle (a
  failure does not stop it), and answers queued requests with
  `CLOSED_WHILE_QUEUED`.
- A second `connect()` while one is in progress shares its outcome instead of
  failing with `CONNECTION_ALREADY_PENDING`.

**Arguments**

- `executeWithTypedParams()` checks its values against their types before
  sending; it binds NULL, SET / MULTISET / SEQUENCE (`'set of int'`), and
  BLOB / CLOB only as the objects `lobNew()` returns.
- `execute([...], params, callback)` binds the values across the statements
  and calls the callback (node-cubrid sent the `?` unbound and never called
  it).
- `createConnection(null)`, IPv6 hosts (`'[::1]:33000'`),
  `maxConnectionRetryCount: 0`, and timeouts given as strings of digits are
  accepted; invalid timeouts are treated as none instead of breaking every
  connect.
- Login fields are written as UTF-8 and refused when longer than the
  protocol's 31 bytes (node-cubrid wrote Latin-1 and overran the next field).

**The text formatter** (`query(sql, params)`, `execute(sql, params)`, …)

- Strings are escaped by doubling the quote only, as CoraDB reads them by
  default (`no_backslash_escapes=yes`); node-cubrid wrote backslash escapes,
  which were stored literally. NUL characters and non-finite numbers are
  refused.
- Negative numbers are written in parentheses (`bal-(-5)`, not the comment
  `bal--5`); milliseconds are zero-padded; Buffers are written as `X'…'`.
- `//` comments and `[bracket]` identifiers are recognised, so a `?` or `'` in
  them no longer shifts the parameters.
- Surplus `?` placeholders are left as they are; invalid Dates and plain
  objects are refused.

## 5. Transactions and sessions

- **Auto-commit choice survives the login**: `beginTransaction()` before the
  first request is no longer undone, and the choice is kept across reconnects.
- **Changing the mode commits**: `setAutoCommitMode()` (and so
  `beginTransaction()` / `endTransaction()`) commits the pending work when the
  mode changes, as JDBC's `setAutoCommit()` does. In node-cubrid it only set a
  flag.
- **COMMIT / ROLLBACK are sent only when the server reports a transaction
  open**; a rollback first closes the open results (prepared statements stay).
- **Results stay open across a commit** (holdable results, when the broker
  supports them).
- **A lost session with auto-commit off is not replaced silently**: requests
  fail with `TRANSACTION_LOST` until `rollback()`, `setAutoCommitMode()`,
  `connect()` or `close()`. `commit()` refuses to commit on a session other
  than the one the transaction began in.
- **Deadlocks**: a -72 inside a transaction is marked `transactionRolledBack`
  and not retryable; `transaction()` fails with `TRANSACTION_ROLLED_BACK`.
- **A reconnect asks for the same session**: the session id the server gave
  is sent back at the next login, as the JDBC driver does, so a server that
  still holds the session (session variables, `LAST_INSERT_ID()`) can resume
  it. node-cubrid sent an empty session id. (The CoraDB server answers a
  reconnect after an abrupt disconnect with a new session, so in practice
  session variables do not survive it.)
- A version request (`getEngineVersion()`) and a handle's close send the real
  auto-commit mode; node-cubrid's always-on version request committed an open
  manual transaction.

## 6. Values

| | node-cubrid | node-coradb |
| --- | --- | --- |
| BIGINT beyond ±2^53 | rounded number | decimal string |
| NUMERIC that `Number()` cannot hold exactly | rounded number | string |
| SMALLINT | read unsigned (-1 → 65535) | signed |
| zero date `0000-00-00` | `-000001-11-30` | `null` |
| SET / MULTISET / SEQUENCE | skipped by a guessed size | arrays, also bound as parameters |
| collection parameters on the wire | — | always a SEQUENCE, as the JDBC driver sends them; the server makes it the column's SET / MULTISET / LIST |
| unknown type | an `Error` as the cell value, then every later column out of step | `{ type, typeCode, raw }` |
| GRAPH_OBJECT, JSON, TIMETZ | unknown | text / string / time-zone value |
| strings | UTF-8 | in their column's charset (UTF-8, ISO-8859-1, binary as Latin-1) |
| `Timezone.valueOf()` | the wall-clock time read as UTC | the instant (through luxon) |
| the hour repeated when DST ends | — | the server's abbreviation (EDT / EST) picks which of the two instants |
| zone-less date strings bound as DATE/DATETIME | parsed in local time, sent in UTC | sent as written |
| numeric parameters given as strings | `''` → 0, `'0x10'` → 16 | decimal numbers only, else `INVALID_PARAMETER` |
| column metadata | `Scale`, `Precision`, `IsNullabe` left at defaults beside the real `scale`, `precision`, `IsNullable` | one field each; the old names are aliases |

Dates and times are written and read in UTC, as in node-cubrid (the JDBC
driver uses the JVM's local time zone).

LOBs: a LOB's size is written into its packed handle after each write, the
locator is sent byte for byte (it was decoded and re-encoded as UTF-8), and a
write at a non-zero offset no longer sends empty chunks for ever.

## 7. Errors

- Every failure is a `CoraDBError` with `code`, `casCode`, `statement`,
  `statementIndex` and `retryable`; `message` and `code` keep node-cubrid's
  values. A server error without text is named after its code instead of
  having `message === undefined`.
- A failed batch rejects with a `CoraDBBatchError` (an `AggregateError` with
  `errors` and `results`); node-cubrid rejected with an array.
- CAS errors are in the current numbering (`-10007`, not `-1007`): the driver
  asks the server for it and converts the old numbering a broker may send.
- New codes: `TIMEOUT`, `ABORTED`, `CONNECTION_CLOSED`, `CLOSED_WHILE_QUEUED`,
  `TRANSACTION_LOST`, `TRANSACTION_ROLLED_BACK`, `TRANSACTION_IN_PROGRESS`,
  `ROLLBACK_FAILED`, `PROTOCOL_ERROR`, `INVALID_PARAMETER`,
  `INVALID_SCHEMA_TYPE`, `STATEMENT_CLOSED`, `NO_ACTIVE_QUERY`,
  `LOB_WRITE_FAILED`, among others.

## 8. Connection loss, timeouts and cancelling

- **Losing the socket answers everyone**: an error, a clean close from the
  server, a timeout or an unreadable reply fails the request in flight and
  every queued request, and emits `disconnect`. In node-cubrid a clean close
  left them waiting for ever, and an unreadable reply threw an uncaught
  exception that ended the process.
- **Retry on a new connection**: a statement that failed because the
  connection was lost or the server went away (-111, -199, -224, -677) runs
  once more on a new connection when it was the first of its transaction, as
  the JDBC driver does. Not after `close()` or `abort()`.
- **Statement pooling**: a prepared statement whose handle the broker dropped
  (`CAS_ER_STMT_POOLING`), or whose session was lost, is prepared again.
- **Timeouts**: per request (`timeoutMs`), per connection
  (`requestTimeoutMs`), on the server (`queryTimeout`), and for connecting
  (`connectionTimeout`, now also for the login itself). A timed-out request is
  removed from the queue or cancelled — never another caller's.
- **Cancelling**: `cancel()` asks the broker to stop the statement (the request
  JDBC sends, to the port the connection is served on, naming the CAS
  process), keeping the connection and its transaction.
- After one failed `connect()`, later ones try every host again instead of
  throwing a TypeError.

## 9. Wire protocol

What goes over the socket differs from node-cubrid in these ways:

- The client announces protocol **V9** (node-cubrid: V7) and that it takes the
  renewed error codes and holdable results (node-cubrid: no flags).
- The login reply is read as the JDBC driver reads it: the CAS process id, the
  broker information (including its function flags), the CAS id and the
  20-byte session id, which the next login sends back.
- The 4-byte CAS info of each reply is kept and sent with the next request
  (node-cubrid sent the login's for ever).
- New requests: CHECK_CAS (`isValid()`), GET_QUERY_INFO (`getQueryPlan()`),
  GET_GENERATED_KEYS, NEXT_RESULT (`executeMulti()`), PREPARE on its own
  (`prepare()`), and the broker's out-of-band cancel.
- EXECUTE_BATCH carries the query timeout; PREPARE and EXECUTE ask for
  holdable results; EXECUTE carries QUERY_ALL for `executeMulti()` and
  GET_GENERATED_KEYS (with auto-commit off) for generated keys.
- Column types are read as one or two bytes (collection and element type kept
  apart); `include_column_info` on EXECUTE is parsed; CONSTRAINT schema rows
  are read field by field at their real sizes.
- Every reply is length-checked and read by one value decoder for all paths.

## 10. Tests and tooling

| | node-cubrid | node-coradb |
| --- | --- | --- |
| Layout | one `test/` folder, mixed styles | `test/unit-test/` (no server), `test/db-test/` (live server), `test/e2e-test/` (scenarios) |
| Without a server | packet tests only | the whole driver, against a pretend CAS over a real socket (`helpers/fakeCas.js`) |
| Database | `demodb` | the official `olympics1988-2004` dataset |
| Connection settings | in JavaScript | `test/db-test/testSetup/connection.json`; `test/e2e-test/helpers.js` (environment variables override it) |
| Clean-up | per test | each suite drops its own tables before it starts and after it ends |
| Scripts | `test`, `lint`, `coverage` | also `test:unit`, `test:db`, `test:e2e` |
| Coverage | istanbul + coveralls | c8 |

`RUN-TESTS.md` describes the setup.

## 11. Not carried over

- `moment-timezone` (replaced by luxon), istanbul, coveralls, the
  `.eslintrc.yml` / `.eslintignore` pair (replaced by `eslint.config.js`),
  `.travis.yml`, the Node 4 / Ruby / Chef `Dockerfile`, and the test
  provisioning script (`test/testSetup/solo.rb`).
- `test/perf/` (the performance scripts).
- The binding of `object`, `resultset` and untyped SET values in
  `executeWithTypedParams()`: their writer never worked and sent corrupt
  packets. SET / MULTISET / SEQUENCE are bound with an element type instead.
