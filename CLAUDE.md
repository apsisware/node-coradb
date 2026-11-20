# CLAUDE.md

Guidance for AI coding assistants (and humans) working in this repository.

## What this is

**node-coradb** (`@coradb/node-coradb`, 1.1.0) — the official Node.js driver
for [CoraDB](https://www.coradb.ai), a relational + graph database. Pure
JavaScript (CommonJS), no native code; it talks to the CoraDB broker / CAS over
raw TCP. One runtime dependency: `luxon` (time-zone values). Node.js >= 20.
TypeScript definitions are hand-written in `index.d.ts`.

On the wire it follows the **CoraDB JDBC driver**: when behaviour is in doubt,
read what JDBC does and do the same.

```
index.js                  # exports (createConnection, CoraDBConnection, Cursor, PreparedStatement, MultiResult, errors, constants)
index.d.ts                # the public types — keep in step with the code
src/
  CoraDBConnection.js     # connection, login, request queue, the original (classic) methods, transactions, reconnects
  modern.js               # sql(), stream(), cursor(), prepare(), executeMulti(), transaction(), timeouts (installed onto the prototype)
  params.js               # binding: values -> CCI types (bind(), checkTyped())
  errors.js               # CoraDBError, CoraDBBatchError, driverError(), serverError()
  constants/              # CASConstants (types, function codes, flags), DataTypes (sizes), ErrorMessages
  packets/                # one file per CAS request; PacketWriter / PacketReader; ValueDecoder (the one value decoder)
  query/Queue.js          # the per-connection request queue
  utils/                  # Helpers (text formatter for the classic API), Timezone (time-zone values, luxon)
test/
  unit-test/              # no server: packets, values, and the whole driver against helpers/fakeCas.js
  db-test/                # a live server (testSetup/connection.json)
  e2e-test/               # live-server scenarios, self-contained
```

## Critical invariants — read before changing data flow

- **One request at a time per connection.** Every request goes through the
  connection's queue (`src/query/Queue.js`) and runs in the order it was made;
  nothing writes to the socket beside it. `commit()`, `rollback()`,
  `setAutoCommitMode()` and closes do not jump the queue (a handle's own
  close/fetch may be `unshift`ed to keep its order). Never send a packet
  outside the queue.
- **A lost socket answers everyone**: the request in flight and every queued
  one fail; `disconnect` is emitted. Nothing may be left waiting.
- **Handles belong to their login.** Public handle =
  `(generation - 1) * 0x100000 + serverHandle`; packets carry `_generation`.
  After a reconnect an old handle is refused (`NO_ACTIVE_QUERY`), never used
  on the new session. The CAS hands a closed handle's number to the next
  statement, so each registered packet carries a `_stmtId` (kept from PREPARE
  to its EXECUTEs, `_inheritStatement`): fetch / next-result / close calls pass
  their owner packet and are refused when the number now belongs to another
  statement. `close()` / `abort()` bump `_closes`, so a retry started before
  them does not reconnect.
- **CAS info**: every reply's 4-byte CAS info is kept (`_parseBuffer`) and sent
  with the next request. Byte 0 is the transaction status: COMMIT / ROLLBACK
  are sent only when it says a transaction is open. The real CAS answers the
  login with ACTIVE (the fake CAS does too).
- **Transactions (as JDBC)**: `setAutoCommitMode()` commits when the mode
  changes; a session lost with auto-commit off **and** a transaction open (CAS
  info) fails later requests with `TRANSACTION_LOST` until `rollback()` /
  `setAutoCommitMode()` / `connect()` / `close()`; a reconnect-and-retry
  happens only for reconnectable errors (-111, -199, -224, -677, communication
  errors) when no transaction was open — never after `PROTOCOL_ERROR` (the
  server may have run the statement);
  a statement dropped by statement pooling (-10024) is prepared again (pinned
  from protocol V7).
- **Login**: client info flags `CAS_RENEWED_ERROR_CODE | CAS_SUPPORT_HOLDABLE_RESULT`;
  the reply's 20-byte session id is sent back at the next login. The CoraDB
  server does not resume a session after an abrupt disconnect — never rely on
  session variables surviving one.
- **Errors**: every rejection is an `Error`: a `CoraDBError` (or
  `CoraDBBatchError` for batches) built with `driverError()` / `serverError()`,
  except a socket error on the request in flight, which passes through as Node
  reports it (ECONNRESET, ...). CAS codes are in the renewed numbering
  (`-10007`, not `-1007`). Nothing may throw from a reply's parser for a
  reason the request could have been refused for before it was sent: there it
  becomes `PROTOCOL_ERROR` and closes the connection.
- **Values**: one decoder (`ValueDecoder.readValue`) for every reply; a value
  is always exactly `size` bytes, an undecodable one comes back as
  `{ type, typeCode, raw }`, never an Error. BIGINT / NUMERIC that a number
  would change come back as strings; dates and times are wall-clock values in
  the Date's UTC fields; strings are decoded in the column's charset. OBJECT
  and GRAPH_OBJECT are 8-byte OIDs (`'OID:@page|slot|volume'`).
- **Charset** (`src/charset.js`, JDBC's `charSet`): the `charset` option
  ('auto' default, 'utf8' or 'latin1') encodes SQL text, string parameters, schema
  patterns and CLOB text (`PacketWriter._writeNullTerminatedString(value,
  charset)`; lengths with `Text.byteLength`), and is the `PacketReader`'s
  default for text without a column charset (names, default values, plans).
  A character the charset cannot hold is refused, never replaced. 'auto' (not
  JDBC; the default, because applications cannot know each database's
  charset) reads `db_root.charset` once, during the first connect
  (`_readDatabaseCharset`, sent with `connecting: true` before the connection
  counts as open); a refused query keeps UTF-8 with a warning. Its close
  commits, so the connection starts with no transaction open. SQL text goes
  through `Text.encodeSql` (`isSql` in the writer): `_utf8'...'` /
  `_iso88591'...'` literals in their own charset, a comment the charset
  cannot hold as UTF-8. CLOB text is UTF-8 under 'auto' (`_clobCharset`). The fake CAS
  answers it itself (`dbCharset`, `charsetAsked()`), outside `cas.log`.
- **Binding**: values go through `params.js` (`bind()` / `checkTyped()`),
  which refuses anything it cannot send before a byte is written. Collection
  parameters always go on the wire as **SEQUENCE** (as JDBC's
  `bindCollection()`); the server converts to the column's SET / MULTISET /
  LIST (a bound MULTISET of strings is refused by the server, -454).
- **Time zones** (`Timezone.js`): `valueOf()` is the instant; in the hour
  repeated when DST ends, the abbreviation the server sends (EDT / EST) picks
  the reading.
- **Classic text formatter** (`Helpers._sqlFormat`, used when the classic
  methods get `params`): quotes are doubled, no backslash escapes
  (`no_backslash_escapes=yes`); negatives in parentheses; inside MATCH /
  PATH_COMP a `[` after `-` is an edge pattern (its `?` are placeholders),
  elsewhere `[...]` is a quoted name. Prefer server-side
  binding (`sql()`, `prepare()`, `executeWithTypedParams()`) in new code.

## Commands

```bash
npm install
npm run lint            # eslint (no errors, no warnings)
npm run test:unit       # no server needed (excludes tests named "with CoraDB")
npm run test:db         # live server, test/db-test (suite hooks drop the test tables)
npm run test:e2e        # live server, test/e2e-test
npm test                # lint + everything
npm run coverage        # c8 over everything (needs the server)
```

On Windows, capture a run with `> file.log 2>&1` (works in cmd and
PowerShell; `*>` is PowerShell-only). One file:
`npx mocha --require test/db-test/testSetup/suiteHooks.js test/db-test/test_X.js`.

## Tests

- **Live database**: the official `olympics1988-2004` dataset on
  `localhost:33000` (`test/db-test/testSetup/connection.json`;
  e2e: `test/e2e-test/helpers.js`, overridable with `CORADB_HOST`, `CORADB_PORT`,
  `CORADB_USER`, `CORADB_PASSWORD`, `CORADB_DATABASE`). It has 11 tables and 4
  views (`TABLE_COUNT = 15`) and is **ISO-8859-1** — keep test strings ASCII,
  except on a connection with `charset: 'iso-8859-1'`.
  Never change the dataset; tests read its rows (e.g. `athlete_result`: 1935 rows).
- **Test tables are not part of the schema.** Each suite creates its own tables
  and drops them before it starts and after it ends: db-tests through
  `TEST_TABLES` + `testSetup/suiteHooks.js` (and `testSetup.cleanup(name)` per
  file), e2e through `e2e-test/suiteHooks.js`. A new table name goes into the
  right list.
- **e2e tests are self-contained**: they do not use `db-test/testSetup`.
- **Unit tests** use `helpers/fakeCas.js`, a pretend CAS over a real socket
  (scripted replies, transaction status, session ids, a request log). Prefer it
  for protocol behaviour; add a live test when the server's own behaviour
  matters — the fake only knows what we taught it.
- Unit tests that need a server are named `... with CoraDB` (excluded from
  `test:unit`).
- A test that encoded old behaviour is updated with a comment saying why, not
  deleted.
- Mocha root hooks come from `--require .../suiteHooks.js`
  (`exports.mochaHooks`), never from a file-level `before`.

## Conventions

- **Line endings are CRLF** (`.gitattributes`: `eol=crlf`), 2-space indent,
  single quotes, `'use strict'`, CommonJS. After editing a file with a tool that
  writes LF, normalise it (`perl -i -pe 's/\r?\n/\r\n/g' file`).
- **Anything a test uses is not dead code.**
- Keep `LICENSE` (with its CUBRID attribution) and `.mocharc.json` as they are.
- The comparison with the CUBRID driver lives in
  `COMPARISON WITH CUBRID DRIVER.md`.
- Every change gets a line in `CHANGELOG.md` (`Fix:`, `Change:`, `New:`,
  `Test:`), and, when it changes the API or behaviour, in `README.md` and
  `index.d.ts`.
- Not committed (`.gitignore`): `node_modules`, `coverage`, `.vs`,
  `*.log`.

## Docs

- `README.md` — overview, the everyday API, the original API, transactions,
  timeouts, "As the JDBC driver does it", running tests.
- `CHANGELOG.md` — release history.
- `RUN-TESTS.md` — setup and running the tests.
- `COMPARISON WITH CUBRID DRIVER.md` — differences from node-cubrid 11.0.0.
