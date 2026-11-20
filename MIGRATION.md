# Migrating an application from node-cubrid to node-coradb

node-coradb (`@coradb/node-coradb`) started as node-cubrid 11.0.0 and keeps its
API: the same methods, arguments and result objects. Moving an application over
is mostly a rename. What needs care is the short list of behaviours that changed
on purpose (section 4): check each one against how your code uses the driver.

The full list of differences is in
[COMPARISON WITH CUBRID DRIVER.md](COMPARISON%20WITH%20CUBRID%20DRIVER.md);
this guide is the practical path through it.

Contents:

1. [Replace the package](#1-replace-the-package)
2. [Change the imports and names](#2-change-the-imports-and-names)
3. [Remove your own type declarations](#3-remove-your-own-type-declarations)
4. [Check the behaviours that changed](#4-check-the-behaviours-that-changed)
5. [Optional: use the everyday API](#5-optional-use-the-everyday-api)
6. [Test](#6-test)
7. [Worked example: a Next.js application](#7-worked-example-a-nextjs-application)
8. [Checklist](#8-checklist)

---

## 1. Replace the package

```bash
npm uninstall node-cubrid
npm install @coradb/node-coradb
```

- **Node.js 20 or newer** is required (node-cubrid ran on Node 4+).
- The runtime dependency changes from `moment-timezone` to `luxon`. If your
  application used `moment-timezone` only because the driver brought it in,
  add it to your own dependencies or drop it.
- The package is scoped: its name is `@coradb/node-coradb`, everywhere — in
  `package.json`, in imports, in `require.resolve()` calls and in test mocks.

## 2. Change the imports and names

| node-cubrid | node-coradb |
| --- | --- |
| `require('node-cubrid')` / `import CUBRID from 'node-cubrid'` | `require('@coradb/node-coradb')` / `import CoraDB from '@coradb/node-coradb'` |
| `createCUBRIDConnection(host, port, user, password, database, …)` | `createCoraDBConnection(…)` with the same arguments, or `createConnection({ host, port, user, password, database })` |
| `CASConstants.CUBRIDDataType`, `CUBRIDSchemaType`, `CUBRIDIsolationLevel`, `CUBRIDStatementType`, `CUBRIDCollectionCommand` | `CoraDBDataType`, `CoraDBSchemaType`, `CoraDBIsolationLevel`, `CoraDBStatementType`, `CoraDBCollectionCommand` |
| `CUBRID_STMT_*` | `CORADB_STMT_*` (same numbers) |
| `getCUBRIDDataTypeName()`, `getCUBRIDDataTypeNumber()` | `getCoraDBDataTypeName()`, `getCoraDBDataTypeNumber()` |

`createConnection()` keeps its name. Named imports work too, and give you the
types:

```ts
import { createConnection, CoraDBError, type CoraDBConnection } from '@coradb/node-coradb'
```

## 3. Remove your own type declarations

node-cubrid shipped no types, so TypeScript projects usually carry a
`declare module 'node-cubrid' { … }` file. Delete it: node-coradb ships
`index.d.ts`, which describes every method (including the ones such shims
leave out, like `execute()`), the result shapes and the error classes.

If your application has its own type called `CoraDBConnection`, import the
driver's under another name:

```ts
import { type CoraDBConnection as DriverConnection } from '@coradb/node-coradb'
```

## 4. Check the behaviours that changed

Go through this list with your code open. Most applications are affected by
two or three items at most.

**Results**

- `execute()`, `batchExecuteNoQuery()` and `executeWithTypedParams()` resolve
  with the number of rows changed (an array, one per statement, for several
  statements). They resolved with nothing.
- `queryAll()` / `queryAllAsObjects()` of a statement that returns no rows
  (an UPDATE, a DDL) resolve with an empty result. In node-cubrid they never
  resolved.

**Values**

| | node-cubrid | node-coradb |
| --- | --- | --- |
| BIGINT beyond ±2<sup>53</sup> | a rounded number | its decimal text (a string) |
| NUMERIC a JavaScript number cannot hold exactly | a rounded number | its text (a string) |
| SMALLINT | read unsigned (-1 came back as 65535) | signed |
| zero date `0000-00-00` | a wrong date (`-000001-11-30`) | `null` |
| SET / MULTISET / LIST columns | not read correctly | arrays |
| strings | always decoded as UTF-8 | decoded in the column's charset |
| text sent (SQL, string parameters) | always UTF-8 | the database's own charset (UTF-8 or ISO-8859-1) |
| column `IsNullable` (metadata) | the wrong way round: NOT NULL columns came back nullable | `false` for NOT NULL and primary-key columns |
| `Timezone.valueOf()` | the wall-clock time read as UTC | the instant |

Code that does arithmetic on BIGINT or NUMERIC columns, or that sends values
to a UI as JSON, should expect a string for values outside the safe range.

Text now goes out in the database's own charset: from 1.1.0 the driver reads
it after the login, so nothing needs setting. node-cubrid always sent UTF-8,
so on an ISO-8859-1 database `'é'` was stored as two characters (`'Ã©'`). A
character the database cannot hold (`'€'` in ISO-8859-1) is refused instead of
mangled. The `charset` option (`'utf-8'`, `'iso-8859-1'`) fixes the charset
and skips the extra query.
Dates and times are still read and written in UTC, as before.

**Errors**

- Every rejection is an `Error` — a `CoraDBError` with `code` (the server's
  error number, or a driver code such as `'TIMEOUT'`), `statement` and
  `retryable`. A failed batch rejects with a `CoraDBBatchError`.
- CAS error codes use the current numbering: `-10007`, not `-1007`. Update
  any code that compares error numbers.
- Recognise errors by `code`, not by the text of the message. For example,
  the login errors are `-165` (unknown user) and `-171` (wrong or missing
  password).
- Network failures (server down, wrong port) still arrive as Node.js socket
  errors, such as `code: 'ECONNREFUSED'`.

**Callbacks and promises**

- A method given a callback also returns a promise that settles. In
  node-cubrid that promise stayed pending.

**Transactions and connection loss**

- `setAutoCommitMode()` (and so `beginTransaction()` / `endTransaction()`)
  **commits the pending work** when the mode changes, as the JDBC driver's
  `setAutoCommit()` does. In node-cubrid it only set a flag.
- After the connection is lost with auto-commit off, requests fail with
  `TRANSACTION_LOST` until you call `rollback()`, `setAutoCommitMode()`,
  `connect()` or `close()`. node-cubrid reconnected silently and carried on
  without the lost work.
- Requests run strictly in the order they were made: `commit()`,
  `rollback()` and `setAutoCommitMode()` no longer jump ahead of queued
  queries.

**Values written into the SQL text** (`query(sql, params)`, `execute(sql, params)`, …)

- Strings are escaped by doubling the quote only (CoraDB does not read
  backslash escapes by default). node-cubrid wrote backslash escapes, which
  were stored literally. If your data contains backslashes saved through
  node-cubrid, they may be doubled.
- Values the formatter cannot write safely (a NUL character, an invalid
  Date, a plain object, `NaN`) are refused instead of being sent.

**Schema**

- `getSchema()` refuses the schema types it cannot read
  (`INVALID_SCHEMA_TYPE`), and for `CCI_SCH_CONSTRAINT` matches the table
  name exactly. Views are typed `'User view'`.

## 5. Optional: use the everyday API

The original methods all work, so this step is not required. For new code, or
where you are already editing, node-coradb adds a promise-first API with
server-side value binding:

```ts
// Every row, as objects; values bound on the server; the handle is closed.
const { rows, columns } = await conn.sql('SELECT * FROM orders WHERE status = ?', ['open'])

// Many rows without holding them all in memory.
for await (const row of conn.stream('SELECT * FROM big_table')) { … }

// Commit when the function resolves, roll back when it throws.
await conn.transaction(async (c) => {
  await c.sql('UPDATE account SET balance = balance - ? WHERE id = ?', [10, 1])
  await c.sql('UPDATE account SET balance = balance + ? WHERE id = ?', [10, 2])
})

// A time limit for one call.
await conn.sql(sql, [], { timeoutMs: 30_000 })
```

Server-side binding (`sql()`, `prepare()`, `executeWithTypedParams()`) is safer
than writing values into the SQL text, and avoids the escaping questions above.
See the README section *The everyday API*.

## 6. Test

- Run your unit tests. Tests that mock the driver module must use the new
  name (`vi.mock('@coradb/node-coradb', …)`, `jest.mock(…)`).
- Run the parts of the application that use the database against a real
  server, paying attention to the items in section 4 that apply to you: large
  numbers, zero dates, collection columns, error handling and transactions.

---

## 7. Worked example: a Next.js application

This example comes from migrating a Next.js application (Node.js 20,
TypeScript, API routes on the Node.js runtime) that talks to CoraDB through
node-cubrid. Its database access is concentrated in one module, which makes it
a good shape for a migration: only that module and a type file change.

### What the application had

- `package.json`: `"node-cubrid": "^11.0.0"`.
- `src/types/node-cubrid.d.ts`: a hand-written `declare module 'node-cubrid'`
  with `connect`, `query`, `queryAll`, `closeQuery`, `close` and
  `createCUBRIDConnection` — but not `execute()`.
- `src/lib/db/coradb-client.ts`: a small wrapper (`createConnection`,
  `executeQuery`, `executeDml`, `releaseConnection`). Everything else in the
  application — API routes, a connection pool, the AI tools, the tests —
  calls this wrapper, never the driver. The tests mock the wrapper.

### What changes

1. **`package.json`** — replace the dependency:

   ```diff
   -    "node-cubrid": "^11.0.0",
   +    "@coradb/node-coradb": "^1.1.0",
   ```

   then `npm install`.

2. **`src/types/node-cubrid.d.ts`** — delete it.

3. **`src/lib/db/coradb-client.ts`** — before:

   ```ts
   import CUBRID from 'node-cubrid'

   export interface CoraDBConnection {
     credentials: CoraDBCredentials
     client: ReturnType<typeof CUBRID.createCUBRIDConnection>
   }

   export async function createConnection(creds: CoraDBCredentials): Promise<CoraDBConnection> {
     const client = CUBRID.createCUBRIDConnection(
       creds.host, creds.port, creds.username, creds.password, creds.database,
     )
     try {
       await client.connect()
     } catch (err) {
       const message = err instanceof Error ? err.message : String(err)
       const isAuthError =
         message.includes('invalid') ||
         message.includes('authentication') ||
         message.includes('login failed') ||
         message.includes('access denied')
       if (isAuthError) throw new Error(`CoraDB authentication failed: ${message}`)
       throw new Error(`CoraDB connection error: ${message}`)
     }
     return { credentials: creds, client }
   }

   export async function executeDml(conn: CoraDBConnection, sql: string): Promise<void> {
     // node-cubrid's types do not expose execute() but it exists at runtime for DML
     const client = conn.client as unknown as { execute: (sql: string) => Promise<unknown> }
     await client.execute(sql)
   }
   ```

   After:

   ```ts
   import {
     createConnection as createDriverConnection,
     CoraDBError,
     type CoraDBConnection as DriverConnection,
   } from '@coradb/node-coradb'

   export interface CoraDBConnection {
     credentials: CoraDBCredentials
     client: DriverConnection
   }

   // Login errors the server reports: -165 unknown user, -171 wrong or missing password.
   const AUTH_ERROR_CODES = new Set<number | string | undefined>([-165, -171])

   export async function createConnection(creds: CoraDBCredentials): Promise<CoraDBConnection> {
     const client = createDriverConnection({
       host: creds.host,
       port: creds.port,
       user: creds.username,
       password: creds.password,
       database: creds.database,
     })
     try {
       await client.connect()
     } catch (err) {
       const message = err instanceof Error ? err.message : String(err)
       if (err instanceof CoraDBError && AUTH_ERROR_CODES.has(err.code)) {
         throw new Error(`CoraDB authentication failed: ${message}`)
       }
       throw new Error(`CoraDB connection error: ${message}`)
     }
     return { credentials: creds, client }
   }

   // execute() is typed now, and resolves with the rows changed.
   export async function executeDml(conn: CoraDBConnection, sql: string): Promise<number> {
     return conn.client.execute(sql)
   }
   ```

   `executeQuery()` (which calls `queryAll()` and maps `ColumnNames` /
   `ColumnValues` to row objects) and `releaseConnection()` (which calls
   `close()`) need no change: those methods and their results are the same.

   The login check now uses the error code. The old check looked for words in
   the message, and the server's wrong-password message, *Incorrect or missing
   password.*, contains none of them — so a wrong password was reported as a
   connection error. That was already the case with node-cubrid; the error
   code makes it reliable.

4. **Comments and docs** — update the header comment of the wrapper and any
   README or setup notes that name node-cubrid. Release notes of earlier
   versions are history: leave them.

### What the application can drop or gain

- **Optional, step 5:** `executeQuery()` can become a thin call to `sql()`,
  which also lets it bind the `params` argument it currently ignores:

  ```ts
  import { type ParamValue } from '@coradb/node-coradb'

  export async function executeQuery(
    conn: CoraDBConnection,
    sql: string,
    params: ParamValue[] = [],
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    const { columns, rows } = await conn.client.sql(sql, params)
    return { columns: columns.map((c) => c.name), rows }
  }
  ```

  Only do this once no caller passes values that are already written into
  the SQL text.

### What to check in this application (section 4 applied)

- **Values sent to the UI as JSON:** BIGINT / NUMERIC values outside the safe
  range now arrive as strings, zero dates as `null`, and SET / MULTISET / LIST
  columns as arrays. The result grid should show each of these correctly.
- **`COMMIT` / `ROLLBACK` typed by the user** run through `executeDml()` as
  SQL text with auto-commit on — unchanged.
- **Server-only code:** the driver uses TCP sockets, so it must only be
  imported from code that runs on the Node.js runtime (API routes, server
  actions), never from client components or the Edge runtime. This is the
  same as with node-cubrid.
- **One connection shared by concurrent requests** (a pool keyed by user
  session): node-coradb runs the requests of one connection one at a time, in
  the order they were made, so concurrent API requests for the same session
  queue rather than collide.
- **Tests** mock the wrapper module, not the driver, so they do not change.
  Run them, then the database-backed features against a real server.

---

## 8. Checklist

- [ ] `node-cubrid` removed, `@coradb/node-coradb` added; Node.js 20+.
- [ ] Every import, `require`, `require.resolve` and test mock uses
      `@coradb/node-coradb`.
- [ ] `createCUBRIDConnection` → `createCoraDBConnection` or `createConnection`;
      `CUBRID*` constants and helpers renamed.
- [ ] Hand-written `declare module 'node-cubrid'` files deleted.
- [ ] Code that compares error numbers uses the current numbering, and
      recognises errors by `code`, not by message text.
- [ ] Code that uses the result of `execute()` / `batchExecuteNoQuery()`
      expects the rows changed.
- [ ] BIGINT / NUMERIC strings, `null` zero dates and collection arrays handled
      where values are used or displayed.
- [ ] Transactions: `setAutoCommitMode()` now commits on a mode change;
      `TRANSACTION_LOST` handled where auto-commit is off.
- [ ] A database created with ISO-8859-1: nothing to set from 1.1.0 (the
      driver reads the charset); code that relied on accented text being
      stored as UTF-8 bytes there will see it stored correctly instead.
- [ ] Docs and comments updated.
- [ ] Unit tests pass; database features checked against a real server.
