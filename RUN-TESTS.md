# Running the node-coradb tests

The test suite uses [Mocha](https://mochajs.org/) with [chai](https://www.chaijs.com/)
assertions.

## Prerequisites

- **Node.js 20.19 or newer** (`engines` requires 20+). chai 6 is an ES module
  that the CommonJS tests load with `require()`, which Node supports by default
  from 20.19 / 22.
- Install the dependencies from the committed lock file:

```bash
npm ci
```

There is no build step: the driver is plain JavaScript (CommonJS).

## Layout

Tests are split into three subfolders under `test/`:

| Folder | Contents | Needs a database? |
| --- | --- | --- |
| `test/unit-test/` | packets, values, and the whole driver against a pretend CAS on a local port (`helpers/fakeCas.js`), e.g. `test_CoraDBConnection.fixes.js`, `test_CoraDBConnection.jdbc.js` | No |
| `test/db-test/` | `test_CoraDB*.js` suites (the classic methods, and the everyday API: `prepare`/`transaction` in `test_CoraDBConnection.prepare.js`, `stream`/`getQueryPlan` in `.stream.js`, `cancel`/`abort`/timeouts/host/queue in `.cancel.js`, every column type written and read back in `.dataTypes.js`), the parameterized-query tests, and the shared `testSetup/` helper | Yes — a live CoraDB broker |
| `test/e2e-test/` | end-to-end scenarios (`test_*.js`), each self-contained (no `testSetup`) | Yes — a live CoraDB broker |

The db-tests connect using `test/db-test/testSetup/connection.json`; the e2e
tests use `CONFIG` in `test/e2e-test/helpers.js` (environment variables
`CORADB_HOST`, `CORADB_PORT`, `CORADB_USER`, `CORADB_PASSWORD` and
`CORADB_DATABASE` override it). Both connect to `localhost:33000`, database
`olympics1988-2004`. Without a
running broker they fail with `ECONNREFUSED`, and because the connection
retries, the run can appear to hang before failing.

> Note: `test_Timezone.js` lives in `test/unit-test/` but also contains a small
> `with CoraDB` block that needs a broker; the unit-test command below excludes it.

## Test counts

| Suite | Tests |
| --- | --- |
| Unit (no server) | 319 |
| Unit tests that need the server (time zones) | 4 |
| Database tests | 284 |
| End-to-end tests | 15 |
| **Total** (`npm test`) | **622** |

## Run everything

Runs the linter first, then every suite, with both suites' clean-up hooks:

```bash
npm test
```

This includes the database and end-to-end tests, so it only fully passes with
a broker running.

## Run only the unit tests (no database)

```bash
npm run test:unit
```

which is:

```bash
npx mocha "test/unit-test/test_*.js" --grep "with CoraDB" --invert
```

The `--grep "with CoraDB" --invert` flag skips the `with CoraDB` block in
`test_Timezone.js`. This should be fully green without any server running.

## Run only the database (integration) tests

```bash
npm run test:db
```

which is:

```bash
npx mocha --require test/db-test/testSetup/suiteHooks.js "test/db-test/test_*.js"
```

The suite cleans up after itself. `suiteHooks.js` drops the tables the
db-tests create (`tbl_test`, `test_tran`, `ces_temp`, `athletexresult`) before the first test
and after the last one, so a run starts on the official `olympics1988-2004`
schema even when an earlier run stopped half way, and leaves it as it was.

## Run only the end-to-end (e2e) tests

```bash
npm run test:e2e
```

which is:

```bash
npx mocha --require test/e2e-test/suiteHooks.js "test/e2e-test/test_*.js"
```

These are full scenarios (connect → inspect → disconnect, etc.), each
self-contained and requiring a live CoraDB broker. Like the db-tests, the suite
cleans up after itself: `test/e2e-test/suiteHooks.js` drops the scenarios'
tables (`test1`, `test_coll`, `test_genkeys`, `test_multi_results`) before the
first scenario and after the last one.

## Run a single test file

Pass the file path to Mocha (with its suite's hooks for a db-test or e2e file,
so its tables are cleaned up before and after):

```bash
npx mocha test/unit-test/test_FetchPacket.js
npx mocha --require test/db-test/testSetup/suiteHooks.js test/db-test/test_CoraDBConnection.query.js
npx mocha --require test/e2e-test/suiteHooks.js test/e2e-test/test_MultipleResults.js
```

## Run a group of files by name (glob)

Quote the glob so Mocha — not the shell — expands it (this also works on
Windows `cmd`/PowerShell).

All `CoraDB*` integration files:

```bash
npx mocha "test/db-test/test_CoraDB*.js"
```

All the `test_*` unit files:

```bash
npx mocha "test/unit-test/test_*.js"
```

## Run a single test (or subset) by name

`--grep` filters by the test title (the `describe` + `it` text). Add
`--invert` to exclude matches instead.

A single named test within a file:

```bash
npx mocha --require test/db-test/testSetup/suiteHooks.js test/db-test/test_CoraDBConnection.query.js --grep "SHOW TABLES"
```

Every test matching a pattern across a folder:

```bash
npx mocha "test/unit-test/**/*.js" --grep "Timezone"
```

## Run the database tests against a broker

Start a CoraDB broker reachable at `localhost:33000` with the
`olympics1988-2004` database (adjust `test/db-test/testSetup/connection.json`
for different connection parameters), then:

```bash
npm run test:db
```

## Code coverage

Coverage is collected with [c8](https://github.com/bcoe/c8):

```bash
npm run coverage
```

This writes an `lcov` report to `coverage/` (git-ignored) and prints a text
summary.

## Useful Mocha flags

- `--reporter <name>` — change output format, e.g. `--reporter dot` or `--reporter min`.
- `--bail` — stop at the first failing test.
- `--timeout <ms>` — adjust the per-test timeout (default 2000 ms).
- `--grep <pattern>` / `--invert` — include / exclude tests by title.
- `--recursive` — descend into subfolders (needed when pointing Mocha at `test`).

## Process exit

`.mocharc.json` sets `"exit": true`, so Mocha force-quits when a run finishes.
This prevents the process from hanging (needing Ctrl+C) when the CoraDB driver
leaves a socket or retry timer open — e.g. after a connection error or a test
that fails before `close()` runs. It applies to every invocation, including
ad-hoc `npx mocha <file>`.

## Notes

- `ECONNREFUSED` on `127.0.0.1:33000` means no CoraDB broker is running; the
  unit tests are unaffected.
- The repository uses CRLF line endings (`.gitattributes`: `* text=auto
  eol=crlf`).
