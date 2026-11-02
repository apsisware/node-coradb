# node-coradb

This is a Node.js driver for [CoraDB](http://www.coradb.ai) open-source relational and graph database.
**node-coradb** is implemented in 100% JavaScript; its one runtime dependency is
[luxon](https://moment.github.io/luxon/), for time-zone values. Besides the database specific APIs, the module supplies several
*helper* APIs which are useful to sanitize and validate user input values, format and 
parametrize SQL statements, etc.

**Table of Contents**

* [Key features](#key-features)
* [CHANGELOG](#changelog)
* [Installation](#installation)
* [The everyday API](#the-everyday-api)
* [Request flow in node-coradb](#request-flow-in-node-coradb)
* [API Documentation](#api-documentation)
    * [Creating a CoraDB client](#creating-a-coradb-client)
    * [Establishing a connection](#establishing-a-connection)
    * [Connection configuration](#connection-configuration)
        * [Setting connection timeout](#setting-connection-timeout)
        * [Setting CoraDB Server Parameters](#setting-coradb-server-parameters)
    * [Executing SQL queries](#executing-sql-queries)
        * [READ queries](#read-queries)
        * [Close Query](#close-query)
        * [WRITE queries](#write-queries)
    * [Queueing](#queueing)
    * [Transactions](#transactions)
    * [Closing a connection](#closing-a-connection)
    * [Events by EventEmitter](#events-by-eventemitter)
* [More examples](#more-examples)
* [Running tests](#running-tests)
* [What's next](#whats-next)
* [Authors and Contributors](#authors-and-contributors)

## Key features

- Full compatibility with CoraDB 1.0 releases.
- Rich database support: Connect, Query, Fetch, Execute, Execute in batch, Commit, Rollback, etc.
- Support for queries queueing.
- Support for database schema.
- Support for database parameters and transactions.
- Support for [LOB](https://www.coradb.ai/manual/en/10.1/sql/datatype.html#blob-clob-data-types) (Binary and Character) objects.
- Support for [ENUM](https://www.coradb.ai/manual/en/10.1/sql/datatype.html#enum-data-type) data types.
- SET, MULTISET and SEQUENCE (LIST) values, read as arrays and bound as parameters.
- Strings decoded in their column's charset (UTF-8, ISO-8859-1, binary).
- Generated keys, a connection check (`isValid()`), a server-side query timeout, query plans and cancelling a running statement.
- Several results from one request (`executeMulti()`), read as the JDBC driver reads them.
- The JDBC driver's protocol behaviour: holdable results, statement-pooling and reconnect retries, session ids, current error codes (see [As the JDBC driver does it](#as-the-jdbc-driver-does-it)).
- Fully implements the event emitter.
- Promises and callbacks on every method; TypeScript definitions (`index.d.ts`).
- Unit tests that run without a server, against a pretend CAS over a real socket; database and end-to-end tests against a live server.

## CHANGELOG

See [CHANGELOG.md](CHANGELOG.md).

## Installation

The driver requires Node.js 20 or later.

    npm install @coradb/node-coradb

This will install the latest version available at https://www.npmjs.com/package/@coradb/node-coradb.
Once installed, the module can be accessed by requiring the `@coradb/node-coradb` module:

    const CoraDB = require('@coradb/node-coradb');

The node-coradb module exports the following properties and functions:

- `Helpers`: an object which provides a set of helper functions.
- `createConnection()` (*alias* `createCoraDBConnection()`): a function which returns a new client connection object to work with a user defined CoraDB host and database.
- `CoraDBConnection`: the connection class; `Cursor`, `PreparedStatement` and `MultiResult`, what `cursor()`, `prepare()` and `executeMulti()` resolve with.
- `CoraDBError`, `CoraDBBatchError`, `isRetryable()`: see [Errors](#errors).
- `CASConstants`: every protocol constant table; `DbParam`, `IsolationLevel`, `isolationLevelName()`, `SchemaType`, `DataType`, `BINDABLE_TYPES`.

## The everyday API

Added in 0.9.6, beside the original methods, which are unchanged. Every row
comes back as an object, values are bound on the server, handles are always
closed, and every call takes a `timeoutMs` and an `AbortSignal`.

    const CoraDB = require('@coradb/node-coradb');

    const conn = CoraDB.createConnection({
        host: 'localhost:33000', user: 'dba', password: '', database: 'demodb',
        requestTimeoutMs: 30000,          // optional default for every call below
    });

    const { rows, columns, rowCount } =
        await conn.sql('SELECT id, name FROM athlete WHERE nation_code = ? AND id > ?', ['KOR', 10]);

    const { affectedRows } = await conn.sql('UPDATE athlete SET name = ? WHERE id = ?', ['Kim', 12]);

    for await (const row of conn.stream('SELECT * FROM game')) {
        write(row);
    }

    await conn.close();

TypeScript definitions ship with the package (`index.d.ts`).

### sql(sql, [params], [options])

Runs one statement and reads all of its result. Resolves with:

| field | |
|---|---|
| `rows` | every row: `{ column: value }`, or arrays with `rowsAs: 'arrays'`. Empty for a statement that returns no rows. |
| `columns` | `{ name, type, table, nullable, precision, scale }` per column |
| `rowCount` | `rows.length` |
| `affectedRows` | rows changed by an INSERT, UPDATE, DELETE, ... |

The handle is closed whether the call succeeds or fails. Rows are read a batch
per request, so other requests on the connection can run in between.

Use `rowsAs: 'arrays'` when two columns share a name (`SELECT a.id, b.id ...`):
as objects, the later one wins.

### Binding values

With `params`, the statement is prepared on the server and the values are sent
separately, typed — never formatted into the SQL text. The type comes from the
value:

| JavaScript value | bound as |
|---|---|
| string | VARCHAR |
| whole number within 32 bits | INT |
| whole number beyond 32 bits, `bigint` | BIGINT |
| other number | DOUBLE |
| boolean | SHORT 1 / 0 (CoraDB has no BOOLEAN) |
| `Date` | DATETIME (UTC fields) |
| `Buffer`, `Uint8Array` | VARBIT |
| `null`, `undefined` | NULL |

An array is not bound on its own (too easily meant as an `IN` list). Bind a
SET, MULTISET or SEQUENCE (LIST) with `{ type, value }`, below.

Give the type yourself with `{ type, value }`:

    await conn.sql('INSERT INTO price VALUES (?, ?, ?)', [
        'widget',
        { type: 'numeric', value: '12.50' },     // exact, not a double
        { type: 'date', value: '2026-10-08' },
    ]);

Types: `char`, `varchar`, `string`, `nchar`, `varnchar`, `json`, `short`,
`int`, `bigint`, `float`, `double`, `monetary`, `numeric`, `date`, `time`,
`datetime`, `timestamp`, `bit`, `varbit`, `blob`, `clob`, `set`, `multiset`,
`sequence`, `list` (also exported as `CoraDB.BINDABLE_TYPES`). A value that
cannot be bound — an object, a plain array, `NaN`, an INT that does not fit —
is refused with code `INVALID_PARAMETER` before anything is sent.

#### Collections

A SET, MULTISET or SEQUENCE (`list` is the same as `sequence`) is an array.
On the wire every one goes as a SEQUENCE, as the JDBC driver sends them, and
the server makes it the column's type (a SET drops duplicates and sorts; the
name only matters for the element type). The element type is given with
`elementType`, or in the type name, or worked out from the elements:

    await conn.sql('INSERT INTO t (tags, scores, days) VALUES (?, ?, ?)', [
        { type: 'set', value: ['red', 'blue'] },              // SET of VARCHAR
        { type: 'list', value: [1, 2.5, null] },              // SEQUENCE of DOUBLE
        { type: 'multiset of date', value: ['2026-10-01'] },  // also 'multiset(date)'
    ]);

    await conn.sql('INSERT INTO t (codes) VALUES (?)', [
        { type: 'set', elementType: 'char', value: ['A', 'B'] },
    ]);

Worked out, every element has to be bound as the same type (see the table
above), except that whole numbers and fractions together are DOUBLE, and whole
numbers some of which do not fit 32 bits are BIGINT. An empty collection, or
one of NULLs only, goes with the NULL element type. Element types:
`char`, `varchar`, `string`, `nchar`, `varnchar`, `short`, `int`, `bigint`,
`float`, `double`, `monetary`, `numeric`, `date`, `time`, `datetime`,
`timestamp`, `bit`, `varbit`. Collection columns come back as arrays.

The original `query(sql, params)` and `execute(sql, params)` still format the
values into the text, as before.

### stream(sql, [params], [options])

The rows one at a time, read a batch at a time. Leaving the loop early
(`break`, `return`, a throw) closes the handle.

    for await (const row of conn.stream('SELECT * FROM huge WHERE kind = ?', ['a'])) {
        if (done(row)) break;
    }

### cursor(sql, [params], [options])

For paging: the rows a batch at a time, under your control.

    const cursor = await conn.cursor('SELECT * FROM game');

    cursor.total;                 // rows in the whole result
    let batch = await cursor.next();  // the first batch came with the query
    while (batch.length) {
        show(batch);
        batch = await cursor.next();
    }
    // The handle closed itself after the last row. To stop early:
    await cursor.close();

A cursor is also an async iterable of rows. `timeoutMs` and `signal` apply to
each request: the query, and every `next()`.

### prepare(sql, [options])

Compile once, run many times:

    const stmt = await conn.prepare('INSERT INTO tbl (a, b) VALUES (?, ?)');

    for (const r of rows) {
        await stmt.run([r.a, r.b]);       // resolves like sql()
    }

    await stmt.close();

`stmt.paramCount` is how many values each run takes; a different number is
refused. A prepared statement belongs to the session that prepared it. After a
reconnect, on a broker with statement pooling (CoraDB's default) `run()`
prepares it again on the new session, as the JDBC driver does; on one without,
`run()` fails with code `STATEMENT_CLOSED`, and it must be prepared again. When
statement pooling drops the handle (`CAS_ER_STMT_POOLING`), `run()` prepares
the statement again and runs it, too.

### executeMulti(sql, [params], [options])

Several statements, separated by semicolons, in one request, read result by
result the way a JDBC `Statement` reads them after `execute()`. `sql()`,
`query()` and the other methods hand back only the first statement's result.

    const r = await conn.executeMulti(
        'UPDATE t SET a = 1; SELECT * FROM t; DELETE FROM t WHERE a = 9');

    do {
        if (r.isResultSet) {
            console.log(r.getResultSet().rows);          // like sql()'s result
        } else {
            console.log(r.getUpdateCount(), 'rows changed');
        }
    } while (await r.getMoreResults() || r.getUpdateCount() !== -1);

Or as an async iterable, which closes it at the end or on `break`:

    for await (const result of await conn.executeMulti(sql)) {
        // result.isResultSet, result.rows / result.affectedRows
    }

The server runs every statement (EXECUTE with `CCI_EXEC_QUERY_ALL`) and
answers with each one's type and count. The first result is current from
the start; `getMoreResults()` asks for the next with NEXT_RESULT and reads a
result set's rows with FETCH. It resolves `true` for a result set and `false`
for a count, or when there are no more (`getUpdateCount()` is then -1).
`r.resultCount` is the number of results. `?` values are bound on the server,
left to right across the statements.

Read past the last result, or call `close()`, to release the handle. In
auto-commit mode the driver then commits, as the JDBC driver does by itself for
a statement with several results. `timeoutMs` and `signal` apply to the call
and to each `getMoreResults()`. On a failure the handle is closed.

### transaction(fn)

Turns auto-commit off, runs `fn`, and commits when it resolves or rolls back
when it throws. Auto-commit is put back as it was either way. Resolves with
what `fn` resolved with.

    await conn.transaction(async (c) => {
        await c.sql('UPDATE account SET balance = balance - ? WHERE id = ?', [100, 1]);
        await c.sql('UPDATE account SET balance = balance + ? WHERE id = ?', [100, 2]);
    });

The connection is shared: anything else run on it meanwhile is part of the
same transaction.

### Timeouts and cancelling

    await conn.sql(sql, params, { timeoutMs: 5000 });

    const controller = new AbortController();
    const p = conn.sql(sql, params, { signal: controller.signal });
    controller.abort();               // p rejects with an AbortError

When the time runs out, or the signal fires, the call fails at once — code
`TIMEOUT`, or `name === 'AbortError'` — and:

- its requests still waiting in the queue are removed and never run;
- if its request is the one running, `cancel()` stops it: through the broker
  when it can, which keeps the connection and its transaction; otherwise by
  aborting the connection, which fails every request on it.

A request waiting behind somebody else's statement times out without
cancelling that statement. `conn.setRequestTimeout(ms)` sets the default for
the connection (`requestTimeoutMs` when creating it); 0 means none.

That default limits the classic methods too — `query()`, `queryAll()`,
`execute()`, `executeWithTypedParams()`, `fetch()`, `closeQuery()`,
`commit()`, `rollback()`, `getSchema()`, the LOB methods and the rest — the
same way: TIMEOUT, waiting requests removed, the running one cancelled. They
take no per-call `timeoutMs`. With no `requestTimeoutMs` they have no limit.

#### The server's query timeout

`timeoutMs` is how long this driver waits. The server can enforce a limit of
its own:

    const conn = CoraDB.createConnection({ ..., queryTimeout: 60000 });
    conn.setQueryTimeout(5000);       // milliseconds; 0 for none (the default)
    conn.getQueryTimeout();           // 5000

It is sent with every statement executed from then on, by every method. A
statement that runs longer is stopped by the server and fails with the
server's error; the connection, its session and its transaction stay usable.

### Errors

Every failure the driver produces is a `CoraDB.CoraDBError`:

| field | |
|---|---|
| `code` | the CAS or engine code (negative) for an error the server reported; a string for one the driver decided on: `TIMEOUT`, `ABORT_ERR`, `ABORTED`, `CLOSED_WHILE_QUEUED`, `INVALID_PARAMETER`, `STATEMENT_CLOSED`, `NO_ACTIVE_QUERY`, ... |
| `casCode` | the integer as it arrived on the wire |
| `statement` | the SQL it belongs to, when known |
| `statementIndex` | its position in a batch |
| `retryable` | transient, and the statement did not take effect (deadlock victim, lock wait timed out, no CAS free): running it again may succeed. `CoraDB.isRetryable(err)` |

`message` and `code` keep the values they always had. An error the server sent
without text is named after its code, never `undefined`.

A batch with failures (`batchExecuteNoQuery`, `execute` with an array) rejects
with a `CoraDB.CoraDBBatchError` — still an `AggregateError` with the same
message — whose `errors` name each failed statement and its position, and whose
`results` hold the rows each statement changed (`null` where it failed).

Socket failures (`ECONNRESET`, `ECONNREFUSED`, ...) pass through as Node
reports them.

### Callbacks and promises

Every method that takes a callback also returns a promise, and both are now
answered — the promise used to stay pending for ever when a callback was given.
With a callback, a failure does not also surface as an unhandled rejection. A
callback is called once; if it throws, the exception is rethrown on its own
turn of the event loop instead of being reported back to the same callback.

### What else changed for the original methods

- `execute(sql)` resolves with the rows changed (an array of counts for an
  array of statements); `batchExecuteNoQuery()` resolves with one count per
  statement. Both used to resolve with nothing.
- `executeWithTypedParams()` resolves with the rows changed, checks its
  arguments before sending (one known type per value), binds `null`, and
  closes the statement handle it opened — it used to leave one open on the
  server per call.
- `getDatabaseParameter()` / `setDatabaseParameter()` take a name as well as a
  number: `'ISOLATION_LEVEL'`, `'isolationLevel'`, `CoraDB.DbParam.LOCK_TIMEOUT`.
- `beginTransaction()` before the first request is no longer undone by the
  login; the auto-commit choice also survives a reconnect.
- `getConnectedHost()` tells the host in use without connecting
  (`getActiveHost()` connects first).
- `getQueueLength()` is the new name of `getQueueDepth()`, which still works.
- `beginTransaction()` and `endTransaction()` are deprecated in favour of
  `transaction(fn)` and `setAutoCommitMode()`; they still work.

### As the JDBC driver does it

The driver follows the CoraDB JDBC driver in what it sends and how it reacts:

- **Changing the auto-commit mode commits.** `setAutoCommitMode()` (and so
  `beginTransaction()` / `endTransaction()`) commits the work done so far when
  the mode changes, as JDBC's `setAutoCommit()` does. If that commit fails,
  the mode stays as it was.
- **Results stay open across a commit.** When the broker supports it, results
  are asked for as holdable (JDBC's default, `HOLD_CURSORS_OVER_COMMIT`): a
  `cursor()` or a `query()` handle you are still fetching from survives a
  `commit()`. A `rollback()` closes the open results (prepared statements
  stay); `closeQuery()` of one of them afterwards succeeds, as closing a closed
  ResultSet does.
- **COMMIT and ROLLBACK are sent only when a transaction is open**, as the
  server reports it with each reply.
- **A statement is run once more on a new connection** after a lost connection
  or a server-side disconnect (errors -111, -199, -224, -677), when it was the
  first statement of its transaction — nothing done before it is lost. Not
  after you `close()` or `abort()` the connection.
- **A reconnect asks for the same session**: the driver sends back the session
  id the server gave it at the last login, as the JDBC driver does, so a server
  that still holds the session (its `@variables`, `LAST_INSERT_ID()`) can resume
  it. `close()` forgets it; a later `connect()` asks for a new one. Do not
  rely on it: the CoraDB server answers a reconnect after an abrupt
  disconnect with a new session, so its `@variables` are gone.
- **Error codes are in the current numbering** (`-10007`, not `-1007`): the
  driver asks the server for them, and converts the old ones a broker may
  still send.
- **`getSchema(CCI_SCH_CONSTRAINT, table)` takes the exact table name**; `_` is
  not a wildcard there (for the other types the name is a pattern).

## Request flow in node-coradb

When the request is sent to the server, CoraDB executes it, and returns the response, which can be either a query result set, or the error code. It is by design that CoraDB does not return any identification about the request sender. In other words, in order to associate the response with a request, the driver has to have only one active request which can be the only owner of this response.

For this reason, if a developer wants to execute several queries, they must execute them one after another, i.e. sequentially, NOT in parallel. This is how the communication between the driver and the server is implemented in CoraDB and most other database systems including MySQL.

If there is a vital need to run queries in parallel, developers can use connection pooling modules. An example with this technique is provided below.

## API Documentation

### Creating a CoraDB client

    /* 
     *  `createCoraDBConnection()` function accepts either an object or a list of
     *  connection parameters. The following list of parameters are supported:
     *  1. `hosts`: Can be either:
     *      - a string representing an IP or a domain name of the CoraDB host 
     *        (without the `http://` part)
     *      - (since 3.0.0) an array of strings like 
     *        `['host1[:port1]', 'host2[:port2]', ...]`.
     *               
     *        When a custom `port` is not specified, the driver will use the
     *        default `port` specified by the user when creating a connection.
     *        When a user has not specified the default `port`, it defaults to 
     *        `33000`.
     *               
     *     Defaults to `localhost`.
     *  2. `port`: a port CoraDB is listening to. Defaults to `33000`.
     *  3. `user`: the database username. Defaults to `PUBLIC` user.
     *  4. `password`: the database user password. Defaults to an empty string.
     *  5. `database`: the name of a database to connect to. Default to `demodb`.
     *  7. `connectionTimeout`: the timeout value in milliseconds for the connection.
     *     If `connectionTimeout = 0`, it will wait until the network socket times out
     *     itself. Defaults to `0`.
     *  8. `maxConnectionRetryCount`: the number of times the connection needs to
     *     be retried in case of failure. Defaults to `1`. Since `3.0.0`.
     *  9. `logger`: a custom logger that implements at least `debug` and `info` 
     *     functions. Defaults to noop (nothing will be logged). For more details
     *     refer to **Logging** section below. Since `3.0.0`.
     *  10. `requestTimeoutMs`: the default `timeoutMs` of `sql()`, `stream()`,
     *     `cursor()` and `prepare()`, and the time limit of the classic
     *     methods, in milliseconds. Defaults to `0` (none).
     *  11. `queryTimeout`: how long the server lets a statement run, in
     *     milliseconds (see "The server's query timeout"). Defaults to `0`
     *     (none). Since 0.9.9.
     */

    // All arguments are optional in which case default values will be set.
    var client = CoraDB.createCoraDBConnection(host, port, user, password, database, connectionTimeout);

    // An alias.
    var client = CoraDB.createConnection(host, port, user, password, database, connectionTimeout);
    
    // Alternatively, an object of parameters can be passed.
    var client = CoraDB.createConnection(paramsObject);

The following example shows how to create a client by providing an object of connection parameters.

    const client = CoraDB.createConnection({
        host: host,
        port: port,
        user: user,
        password: password,
        database: database,
        connectionTimeout: connectionTimeout,
        maxConnectionRetryCount: maxConnectionRetryCount,
        logger: logger,
        requestTimeoutMs: 30000,
        queryTimeout: 60000
    });

### Establishing a connection

    // callback(err) function receives one arguments: the error message if any.
    const promise = client.connect(callback);

#### Callback style

The code below illustrates a *callback* style when a function is passed as an argument
to a `connect()` API which is called after the module receives a response from CoraDB.

    const CoraDB = require('@coradb/node-coradb');
    const dbConf = {
        host: 'localhost',
        port: 33000,
        user: 'PUBLIC'
        password: '',
        database: 'demodb'
    };
    const client = CoraDB.createConnection(dbConf);
    
    client.connect(function (err) {
        if (err) {
            throw err;
        } else {
            console.log('connection is established');
            
            client.close(function (err) {
                if (err) {
                    throw err;
                } else {            
                    console.log('connection is closed');
                }
            });
        }
    });

#### Promise style

Alternatively, a `Promise` style is supported. For example, the above code can be rewritten as:

    client
        .connect()
        .then(() => {
          console.log('connection is established');
          
          return client.close();
        })
        .catch(err => {
          throw err;
        });
    
#### Implicit connection

**node-coradb** performs an implicit connection whenever necessary. When you execute a query
on a client without explicitly establishing a connection by calling `client.connect()`, the 
driver will automatically establish a connection before executing your query.

#### Connection errors

There can be several reasons for a connection to fail:

- **Connection timeout**:

    - when the host does not respond within the specified time larger than `0`, 
       you will receive the following error message:

            { [Error: connect ETIMEDOUT] }

    - when no timeout value is set or its value is `0`, the following timeout
       error is emitted by the underlying network socket.

            { [Error: connect ETIMEDOUT] code: 'ETIMEDOUT', errno: 'ETIMEDOUT', syscall: 'connect' }

- **Incorrect hostname**:

        { [Error: getaddrinfo ENOTFOUND] code: 'ENOTFOUND', errno: 'ENOTFOUND', syscall: 'getaddrinfo' }

- **Incorrect port**:

    * When you try to connect to a port listened by an active service other than 
      CoraDB or if a firewall refuses the connection, you will see the following error message:
    
            { [Error: connect ECONNREFUSED] code: 'ECONNREFUSED', errno: 'ECONNREFUSED', syscall: 'connect' }
    
    * If the port is not listened by any service, then you will see the **Connection timeout** 
      error as in the first case.
      
    * The last type of error message you would receive if an incorrect port is provided is:

            { [Error: read ECONNRESET] code: 'ECONNRESET', errno: 'ECONNRESET', syscall: 'read' }

### Connection configuration

#### Setting connection timeout

    const timeoutInMilliseconds = client.getConnectionTimeout();
    
    // Set connection timeout in milliseconds.
    client.setConnectionTimeout(2000);
    
    // Alternatively, set the connection timeout value at client creation time.
    var client = CoraDB.createConnection(host, port, user, password, database, connectionTimeout);

One of the requests we have got for the 2.0 driver release was to implement a connection
timeout feature. Simply said - wait for the connection to the database to complete within
the specified number of seconds and eventually throw an error if the timeout occurs.

Obviously, the key thing here was to set the connection timeout at the Node.js socket 
connection layer level (and not on the consumer level):

    this._socket = Net.createConnection(hostInfo.port, hostInfo.host);
    this._socket.setNoDelay(true);
    this._socket.setTimeout(this.getConnectionTimeout());

In **node-coradb** by default the connection timeout value is set to `0`, i.e. 
the driver will wait long enough until the underlying network socket times out itself. 
In this case, according to our observations, the `timeout` event is emitted in about 
`75` seconds (**purely observational point**).

So, if you want or expect the connection to timeout within the specified time, then 
manually set the timeout value as shown below.

    const client = new CoraDBConnection(dbConf.host, dbConf.port, dbConf.user, dbConf.password, dbConf.database, /* connectionTimeout */ 2000);
 
     // Or at runtime.
    client.setConnectionTimeout(2000);
    
    client.connect(function (err) {
        if (err) {
              console.log(err);
        }
        
        client.close();
    });

As you see, the timeout is specified in milliseconds `2000`, which is 2 seconds.
After 2 seconds, the script will timeout with an error like:

    { [Error: connect ETIMEDOUT] }

#### Setting CoraDB Server Parameters

    client.getDatabaseParameter(paramType);
    client.setDatabaseParameter(paramType, paramValue);

After connecting to a database, a user can override some *global* session parameters 
that will control the behavior queries being executed. For example, isolation level 
of transactions, the auto-commit behavior, etc.

The complete list of these CoraDB database parameters is defined in the 
[`CASConstants.js`](src/constants/CASConstants.js) file:

    /**
     * Define CoraDB Database parameters constants
     */
    exports.CCIDbParam = {
        CCI_PARAM_ISOLATION_LEVEL   : 1,
        CCI_PARAM_LOCK_TIMEOUT      : 2,
        CCI_PARAM_MAX_STRING_LENGTH : 3,
        CCI_PARAM_AUTO_COMMIT       : 4
    };

Both functions also take the parameter by name - `'ISOLATION_LEVEL'`,
`'isolationLevel'`, `'LOCK_TIMEOUT'`, ... - or as `CoraDB.DbParam.ISOLATION_LEVEL`.

For each parameter, the CoraDB communication protocol implements a dedicated support for GET 
and SET operations. Therefore, in order to manipulate them, also a dedicate functionality was 
needed in the driver and this is what we did in the 2.0 release.

Please note one exception - the `CCI_PARAM_MAX_STRING_LENGTH` parameter **cannot** be set 
programmatically from code as it is a CoraDB Broker parameter and the client can only query
its current value.

Let’s see some examples. First, let set the value of the `ISOLATION_LEVEL` parameter:

    const CAS = require('@coradb/node-coradb/src/constants/CASConstants');
    
    client.connect(function (err) {
        // handle error, then...
        client.setDatabaseParameter(CAS.CCIDbParam.CCI_PARAM_ISOLATION_LEVEL, CAS.CoraDBIsolationLevel.TRAN_REP_CLASS_COMMIT_INSTANCE, function (err) {
            // handle error
            CoraDBClient.close(function (err) {
                // …
            });
        });
    });

And let’s see how we can retrieve the value of the `LOCK_TIMEOUT` parameter for the current session:

    client.connect(function (err) {
        client.getDatabaseParameter(CAS.CCIDbParam.CCI_PARAM_LOCK_TIMEOUT, function (err, value) {
            // handle error, then...
            console.log('LOCK_TIMEOUT is: %s', value);
            
            CoraDBClient.close(function (err) {
                // ...
            });
          });
    });

The output result is:

    LOCK_TIMEOUT is: -1

**Note**: The same value can be obtained also from CoraDB Manager Client:

If you need to change the default values for these parameters, it is highly recommended 
to do it immediately after `connect ()`.

### Executing SQL queries

#### Recommended: use parameterized queries

To keep queries safe against SQL injection and to avoid manual value
formatting, prefer **server-side parameter binding** over embedding values
directly in the SQL text:

- For WRITE statements, use
  [`executeWithTypedParams(sql, params, dataTypes)`](#execute-with-typed-parameters),
  which binds each value on the server according to the supplied CoraDB data
  types.
- For READ statements, pass the `params` array to `query()`/`queryAll()` so
  values are substituted for the `?` placeholders rather than being
  concatenated into the SQL by hand.

When you use the `params` argument, the driver substitutes the values for the
`?` placeholders and escapes string values before sending the statement. This
escaping is a convenience, not a full substitute for server-side binding:
**never build SQL by string-concatenating untrusted input**. If a value can
come from an untrusted source, pass it through `params`/typed parameters — do
not interpolate it into the `sql` string yourself.

#### READ queries

    // Callback style.
    client.query(sql, callback);
    client.query(sql, params, callback);

    /*
     * 1. `sql`: a string representation of a single READ query. Required.
     * 2. `params` is an array of parameter values or the value itself
     *    which a user wants to bind instead of `?` placeholders
     *    in the `sql` query. If no placeholder is found, the `sql`
     *    will not be modified. This argument is optional. When
     *    omitted, `sql` will be sent to the server unmodified.
     * 3. `callback` is a function which will be invoked when the query
     *    finishes executing. Optional. The `callback` function
     *    can be omitted in which case users need to handle the 
     *    return value of the `Promise`.
     */
    
    /* 
     * The `callback(err, result, queryHandle)` function accepts three arguments.
     * 1. `err`: an error object if any.
     * 2. `result`: a query result object which has the following properties:
     *     - `ColumnDataTypes`: an array of strings that represent the column data type.
     *     - `ColumnNames`: an array of strings that represent the column names.
     *     - `ColumnValues`: an array of arrays that represent rows of records
     *        each row having one or more columns. Here each column represents a value
     *        of that column.
     *     - `RowsCount`: total number of records that match the provided SQL query.
     *       **Note** that not all records may have been fetched.
     * 3. `queryHandle`: an integer ID for the query handle. Used to fetch more data
     *     or close the query statement in order to release the memory being kept
     *     on the CoraDB server side. A handle belongs to the session that
     *     opened it: after a reconnect, fetch(), closeQuery(), getMetaData()
     *     and getGeneratedKeys() refuse it (NO_ACTIVE_QUERY) rather than act
     *     on the new session's statement under the same server number.
     */
        
    // Promise style.
    const promise = client.query(sql);
    const promise = client.query(sql, params);
    
    /*
     * A `promise` is resolved with a single `response` object that has the following
     * properties described above:
     * - result
     * - queryHandle
     *
     * A `promise` is rejected with a single instance of `Error` object.
     */
    
    /* 
     * Queries queueing: calling `query()` multiple times will result in queuing
     * the queries which will be executed sequentially one after another.
     */
    client.query(sql);
    client.query(sql, params);
       
    // Under the hood, `query()` and other functions that accept `params` all 
    // call `Helpers._sqlFormat()` function to perform the actual formatting.
        
    // When multiple queries are executed one after another without
    // waiting for a callback, the queries
    // will be queued and executed sequentially.

##### Callback example

Here is an example which executes a simple `SELECT` query.

    const CoraDB = require('@coradb/node-coradb');
        
    // Connection is established implicitly.
    client.query('SELECT * FROM nation', function (err, result, queryHandle) {
      if (err) {
        throw err;
      } else {
        const rows = result.ColumnValues;
        const rowsCount = result.RowsCount;
        
        for (let i = 0; i < rowsCount; ++i) {
          let columns = rows[i];
          
          for (let j = 0, columnsCount = columns.length; j < columnsCount; ++j) {
            console.log(columns[j]);
          }
        }
        
        // Fetch more data using queryHandle if necessary.
        // Refer to examples below.
      }
    });

The following example shows how to set placeholders and bind values in `SELECT` queries.

    client.query('SELECT * FROM nation WHERE continent = ?', ['Asia'], callback);

Alternatively, the `params` value can be a literal value.

    client.query('SELECT * FROM nation WHERE continent = ?', 'Asia', callback);

If the `params` value is `undefined` or `null`, it will be converted to SQL `NULL`.

    client.query('SELECT * FROM nation WHERE continent IS ?', null, callback);

The `Date` type values will be converted into CoraDB compatible `DATETIME` strings.

    client.query('SELECT * FROM game WHERE game_date = ?', [new Date('8/28/2004')], callback);
    // The query will be
    // `SELECT * FROM game WHERE game_date = '8/28/2004 0:0:0.0'`

And finally, everything else will be safely escaped and wrapped in single quotes.

##### Promise example

    const promise = client
        .query('SELECT * FROM nation')
        .then(response => {
          const result = response.result;
          const queryHandle = response.queryHandle;
          
          const rowsCount = result.RowsCount;
          const rows = result.ColumnValues;
                    
          for (let i = 0; i < rowsCount; ++i) {
            let columns = rows[i];
              
            for (let j = 0, columnsCount = columns.length; j < columnsCount; ++j) {
              console.log(columns[j]);
            }
          }
          
          // Do something more.
        })
        .catch(err => {
          // Handle the error.
        });

#### Fetch more data

    /*
     * `fetch()` accepts three arguments:
     * 1. `queryHandle`: an integer ID for the query handle obtained from `query()` function.
     * 2. `all`: a boolean that tells whether to fetch all available records or just the 
     *    next batch. Defaults to `false`. Since `3.0.0`.
     * 2. `callback(err, result, queryHandle)` function accepts the same three arguments
     *    accepted by the `query()` function.
     */
    client.fetch(queryHandle, all, callback);
    
    // Promise style is resolved and rejected similarly like the promise from `query()`.
    const promise = client.fetch(queryHandle, all);
    
##### Callback example

    client.query('SELECT * FROM nation', function (err, result, queryHandle) {
      if (err) {
        throw err;
      } else {
        const rows = result.ColumnValues;
        const rowsCount = result.RowsCount;
        
        for (let i = 0; i < rowsCount; ++i) {
          let columns = rows[i];
          
          for (let j = 0, columnsCount = columns.length; j < columnsCount; ++j) {
            console.log(columns[j]);
          }
        }
        
        // Fetch more data using the `queryHandle`.
        client.fetch(queryHandle, function (err, result, queryHandle) {
            // Handle the error and response.
            // Note that the fetch does not return all the records
            // but only some. So, users need to fetch records in batches.
        });
      }
    });

##### Promise example

    const promise = client
        .query('SELECT * FROM nation')
        .then(response => {
          const result = response.result;
          const queryHandle = response.queryHandle;
          
          const rowsCount = result.RowsCount;
          const rows = result.ColumnValues;
                    
          for (let i = 0; i < rowsCount; ++i) {
            let columns = rows[i];
              
            for (let j = 0, columnsCount = columns.length; j < columnsCount; ++j) {
              console.log(columns[j]);
            }
          }
          
          return client.fetch(queryHandle);
        })
        .then(response => {
          // The same `response` as after `query()`.
        })
        .catch(err => {
          // Handle the error.
        });

#### Close Query

It is vital to always close all the READ queries when they are no longer necessary.
When you query, CoraDB allocates a part of memory to hold the query statement 
information necessary to return values on consecutive `fetch()` requests. Unless
the connection with the client is disconnected, CoraDB will keep this information
in memory. When not released during the lifetime of the connection, eventual 
OOM (Out Of Memory) problems can occur on the server side. This is why when you
are done with the query results, close the queries. If the connection is disconnected,
CoraDB will automatically close all the query statements to free the memory.

    /*
     * `closeQuery()` accepts two arguments:
     * 1. `queryHandle`: an integer ID for the query handle obtained from `query()`
     *    or the last `fetch()`.
     * 2. `callback(err)` function that accepts one argument:
     *    1. `err`: an error object if any.
     */
    client.closeQuery(queryHandle, callback);
    
All READ queries **must be** closed explicitly except when you call `queryAll`
in which case the driver will close queries for you because there is no more
data that you may possibly request.

##### Callback example

    client.query(sql, function (err, result, queryHandle) {
        const arr = result.ColumnValues;
        
        if (arr.length) {
            // Try to fetch more.
        } else {
            client.closeQuery(queryHandle, function (err) {
                // Do something else.
            });
        }
    });

##### Promise example

    // Promise style.
    const promise = client
        .query(sql)
        .then(response => {
          // Do something with response.
            
          return client.closeQuery(response.queryHandle);  
        })
        .then(() => {
        
        })
        .catch(err => {
          // Handle the error.
        });

#### Query As Objects

There is a convenient function provided in case you want to retrieve result set
as an array of traditional JSON objects with column names and values as object 
properties and their corresponding values.
 
    /*
     * `queryAsObjects()` calls `query()`, therefore it accepts the same 
     * arguments as `query()`. Available since `3.0.0`.
     * 1. `sql`
     * 2. `params`
     * 3. `callback(err, result, queryHandle)` is different from the callback passed
     *    to `query()`. It accepts the same number of arguments, but `result` is no
     *    longer an object but an array that represents rows of record objects.
     *    1. `err`: an error object if any.
     *    2. `result`: an array of records each representing a single row object
     *       where keys are columns names and their values are column values.
     *    3. `queryHandle`: an integer ID for the query handle. Used to fetch more data
     *       or close the query statement in order to release the memory being kept
     *       on the CoraDB server side.
     */
    client.queryAsObjects(sql, params, callback);
 
    // Promise style.
    const promise = client.queryAsObjects(sql);
    const promise = client.queryAsObjects(sql, params);
    
**Note** that the `result` returned by `queryAsObjects` is no longer a result object 
but an array that represents rows of record objects. Thus, you cannot access the 
column meta information via `result.ColumnDataTypes`, `result.ColumnNames` or
`result.RowsCount`. If such information is necessary, call `getMetaData(queryHandle)`
explained below.

##### Callback example

Here is an example which executes a simple `SELECT` query.

    // Connection is established implicitly.
    client.queryAsObjects('SELECT * FROM nation', function (err, result, queryHandle) {
      if (err) {
        throw err;
      } else {
        // `result` is now an array of row objects.
        const rowsCount = result.length;
        
        for (let i = 0; i < rowsCount; ++i) {
          const row = rows[i];
          
          console.log(row.code);
          console.log(row.name);
          console.log(row.continent);
          console.log(row.capital);
        }
       
        // Do something more.
      }
    });

##### Promise example

    const promise = client
        .queryAsObjects('SELECT * FROM nation')
        .then(response => {
          const result = response.result;
          const queryHandle = response.queryHandle;
          
          // `result` is now an array of row objects.
          const rowsCount = result.length;
          
          for (let i = 0; i < rowsCount; ++i) {
            const row = rows[i];
            
            console.log(row.code);
            console.log(row.name);
            console.log(row.continent);
            console.log(row.capital);
          }
         
          // Do something more.
        })
        .catch(err => {
          // Handle the error.
        });

##### Get Query Result Metadata

    /*
     * `getMetaData()` accepts two arguments:
     * 1. `queryHandle`: that is associated with the required query result,
     *    obtained from the last `query()`.
     * 2. `callback(err, result)` accepts two arguments:
     *    1. `err`: an error object if any. 
     *    2. `result`: the same `result` object that is returned when calling 
     *       `query()` function. It provides the same `ColumnDataTypes`,
     *       `ColumnNames`, `ColumnValues`, and `RowsCount` properties. 
     */

    // Callback style.
    client.getMetaData(queryHandle, callback);
   
    // Promise style.
    const promise = client.getMetaData(queryHandle);
       
#### Query All

There is a convenient function provided in case you want to query all records
that match the SQL.
 
**Note** that this may potentially result in OOM in your application especially 
considering that in Node environment a typical process has a limited memory
around 1.6GB.

Use this function when you are sure that the result set will fit into your app's
memory.

    /*
     * `queryAll()` calls `query()` and then calls `fetch()` multiple times until
     * all records are retrieved, and finally calls `closeQuery()` explicitly to
     * close the query for you. Thus, it accepts the same arguments as `query()`.
     * Available since `3.0.0`.
     * 1. `sql`
     * 2. `params`
     * 3. `callback(err, result)` function is different from the callback you
     *    pass to `query()` in the way that in `queryAll` it accepts only
     *    the error and the result object. No `queryHandle` is returned.
     */
    client.queryAll(sql, params, callback);
 
    // Promise style.
    const promise = client.queryAll(sql);
    const promise = client.queryAll(sql, params);
    
##### Callback example

Here is an example which executes a simple `SELECT` query.

    // Connection is established implicitly.
    client.queryAll('SELECT * FROM nation', function (err, result) {
      if (err) {
        throw err;
      } else {
        // `rows` now include all records that matched the SQL query.
        const rows = result.ColumnValues;
        const rowsCount = result.RowsCount;
        
        for (let i = 0; i < rowsCount; ++i) {
          let columns = rows[i];
          
          for (let j = 0, columnsCount = columns.length; j < columnsCount; ++j) {
            console.log(columns[j]);
          }
        }
        
        // No need to fetch anything more.
        // No need to close the query as it is already closed by `queryAll()`.
      }
    });

**Note** once again that there is no need to call `closeQuery()` after `queryAll()`
because `queryAll()` automatically closes the query after all `fetch()` has been 
done.

##### Promise example

    const promise = client
        .queryAll('SELECT * FROM nation')
        .then(result => {
          const rowsCount = result.RowsCount;
          // `rows` now include all records that matched the SQL query.
          const rows = result.ColumnValues;
                    
          for (let i = 0; i < rowsCount; ++i) {
            let columns = rows[i];
              
            for (let j = 0, columnsCount = columns.length; j < columnsCount; ++j) {
              console.log(columns[j]);
            }
          }
          
          // No need to fetch anything more.
          // No need to close the query as it is already closed by `queryAll()`.
        })
        .catch(err => {
          // Handle the error.
        });

#### Query All As Objects

In case you want to retrieve all records as object, there is a function just for
that.

    /*
     * `queryAllAsObjects()` calls `queryAll()`, therefore it accepts the same 
     * arguments as `queryAll()`. Available since `3.0.0`.
     * 1. `sql`
     * 2. `params`
     * 3. `callback(err, result)` accepts the same number of arguments as `queryAll()`:
     *    1. `err`: an error object if any.
     *    2. `result`: an array of records each representing a single row object
     *       where keys are columns names and their values are column values.
     */
    client.queryAllAsObjects(sql, params, callback);
 
    // Promise style.
    const promise = client.queryAllAsObjects(sql);
    const promise = client.queryAllAsObjects(sql, params);
    
**Note** that just like with `queryAsObjects()`, the `result` returned by 
`queryAllAsObjects` is an array that represents rows of record objects. Likewise,
there is no need to call `closeQuery()` after `queryAllAsObjects()` as `queryAll()`
automatically closes the query after all `fetch()` has been done.

##### Callback example

Here is an example which executes a simple `SELECT` query.

    // Connection is established implicitly.
    client.queryAllAsObjects('SELECT * FROM nation', function (err, result) {
      if (err) {
        throw err;
      } else {
        // `result` is now an array of all row objects.
        const rowsCount = result.length;
        
        for (let i = 0; i < rowsCount; ++i) {
          const row = result[i];
          
          console.log(row.code);
          console.log(row.name);
          console.log(row.continent);
          console.log(row.capital);
        }
       
        // Do something more.
      }
    });

##### Promise example

    const promise = client
        .queryAllAsObjects('SELECT * FROM nation')
        .then(result => {
          // `result` is now an array of row objects.
          const rowsCount = result.length;
          
          for (let i = 0; i < rowsCount; ++i) {
            const row = result[i];
            
            console.log(row.code);
            console.log(row.name);
            console.log(row.continent);
            console.log(row.capital);
          }
        })
        .catch(err => {
          // Handle the error.
        });

#### WRITE queries

    /*
     * `execute(sql, params, callback)` function accepts three arguments.
     * 1. `sql`: a string which represents a WRITE query or an array
     *    of strings for batch processing. `sql` must be a string if
     *    `params` are provided.
     * 2. `params` is an array of parameter values or the value itself
     *    which a user wants to bind instead of `?` placeholders
     *    in the `sql` query. If no placeholder is found, the `sql`
     *    will not be modified. This argument is optional. When
     *    omitted, `sql` will be sent to the server unmodified.
     *    Available since `3.0.0`.
     * 3. `callback(err)`: a function that accepts one argument:
          1. `err`: an error object if any.

    // Callback style.
    client.execute(sql, callback);
    client.execute(sql, params, callback);
    
    // Promise style.
    const promise = client.execute(sql);
    const promise = client.execute(sql, params);

    /*
     * A `promise` is resolved with the number of rows changed - or, for an
     * array of statements, one count per statement.
     * A `promise` is rejected with a `CoraDBError` (a `CoraDBBatchError` for
     * an array in which statements failed).
     */
     
    /* 
     * Queries queueing: calling `execute()` multiple times will result in queuing
     * the queries which will be executed sequentially one after another.
     */
    client.execute(sql);
    client.execute(sql, params);

After executing WRITE queries there is no need to close the query.

##### Callback example

Here is an example which executes a simple `INSERT` query.

    client.execute('INSERT INTO tbl VALUES(1, 2, 3)', function (err) {
      // Handle the error;
    });

The following example shows how to set placeholders and bind values in `INSERT` queries.

    client.execute('INSERT INTO tbl VALUES(?, ?, ?)', [1, 2, 3], function (err) {
      // Handle the error;
    });

Alternatively, the `params` value can be a literal value.

    client.execute('INSERT INTO tbl (name) VALUES(?)', 'coradb', function (err) {
      // Handle the error;
    });

If the `params` value is `undefined` or `null`, it will be converted to SQL `NULL`.

    client.execute('INSERT INTO tbl (name) VALUES(?)', null, function (err) {
      // Handle the error;
    });

The `Date` type values will be converted into CoraDB compatible `DATETIME` strings.

    client.execute('INSERT INTO tbl (d) VALUES(?)', [new Date('8/28/2004')], callback);
    // The query will be
    // `INSERT INTO tbl (d) VALUES('8/28/2004 0:0:0.0')`

And finally, everything else will be safely escaped and wrapped in single quotes.

    batchExecuteNoQuery()

#### Execute with Typed Parameters

For cases when implicit type casting is insufficient or the result
is not as expected, data types can be specified by calling `executeWithTypedParams()`.

    /* 
     * `executeWithTypedParams()` accepts four arguments.
     * 1. `sql`: a string which represents a single WRITE query.
     *    **Note** not an array of strings.
     * 2. `params`: an optional array of parameter values which a user 
     *    wants to bind instead of `?` placeholders in the `sql`
     *    query. If no placeholder is found, the `sql` will not 
     *    be modified.
     * 3. `dataTypes`: an optional array of string values where each 
     *    element represents a data type for the corresponding
     *    value in `params`. The following data types are supported:
     *    `char`, `varchar`, `nchar`, `string`, `varnchar`, `json`, `short`,
     *    `int`, `bigint`, `float`, `double`, `monetary`, `numeric`, `date`,
     *    `time`, `datetime`, `timestamp`, `bit`, `varbit`, `blob`, `clob`,
     *    and for an array `set`, `multiset`, `sequence` or `list`, with the
     *    element type in the name or not: `'set of int'`, `'list(varchar)'`
     *    (see "Collections").
     *    `dataTypes` are required if `params` are specified, one per value;
     *    anything else is refused with code `INVALID_PARAMETER` before the
     *    statement is sent. A `null` value is bound as NULL.
     * 4. `callback(err, affectedRows)`: the error if any, else the number of
     *    rows changed (which the promise also resolves with).
     */
          
    const sql = 'INSERT INTO a VALUES(?, ?, ?, ?)';
    const params = [1, 23, 'val', new Date()];
    const dataTypes = ['int', 'short', 'varchar', 'datetime'];
    
    client.executeWithTypedParams(sql, params, dataTypes, function callback(err, affectedRows) {});
    
    // Promise way.
    const affectedRows = await client.executeWithTypedParams(sql, params, dataTypes);

    // A collection.
    await client.executeWithTypedParams('INSERT INTO t (id, l) VALUES (?, ?)', [1, [10, 20, 30]], ['int', 'list of int']);
    
**Note** that `executeWithTypedParams()` does not replace `?` placeholders.
The `param` and `dataTypes` are sent to CoraDB directly, and the server handles
explicit type casing.

#### Queueing

Almost all requests which initiate a network
communication pass through an internal queue. This includes READ and WRITE queries,
close query requests, fetch requests, rollback/commit requests.

Thus, in order to put queries into a queue, all you need to do is call `query()` / `execute()`
and their equivalent functions one after another. They will be added into the queue as 
they come in (FIFO).

Here is an example.

    client.execute('CREATE TABLE tbl_test(id INT)', callback);
    client.execute('INSERT INTO tbl_test (id) VALUES (1), (2), (3)', callback);
    client.query('SELECT * FROM tbl_test', callback);
    client.execute('DROP TABLE tbl_test', callback);

Remember that the `callback` is optional in which case you should handle the promises.

##### Check if queue is empty

In case you are interested in checking if the queue is empty, call the following function. 
Returns `true` or `false`.

    client.isQueueEmpty();

##### Get queue length

The below function will return the number of requests currently in the queue. 
Remember that this number represents all requests, including READ and WRITE, 
and fetch, and rollback/commit, etc. Briefly all requests which initiate a 
network communication, including the one currently in flight. It is zero
exactly when `isQueueEmpty()` is `true`.

    client.getQueueLength();

`getQueueDepth()` is the same function under its old name, and still works.

### Transactions

The simplest way is `transaction(fn)` (see [The everyday API](#transactionfn)):
it turns auto-commit off, commits when `fn` resolves, rolls back when it
throws, and puts auto-commit back. `beginTransaction()` and `endTransaction()`
below are deprecated in its favour, and still work.
    
This driver fully supports SQL transactions. By default `auto_commit` mode is set 
to `true` meaning after every WRITE query CoraDB Server will commit the changes to the disk.

You can begin, end, commit, and rollback transactions by calling these functions.

    client.beginTransaction(callback);
    client.endTransaction(callback);
    client.commit(callback);
    client.rollback(callback);
    
    // All `callback(err)` functions accept one argument: the error message if any.

`beginTransaction()` and `endTransaction()` functions simply call the following
`setAutoCommitMode()` by specifying a `false` or `true` arguments respectively.

    client.setAutoCommitMode(boolean, callback);
    
    // `boolean` is a boolean value which represents the auto_commit
    //           mode you wish to set the current transaction to.
    
    // The `callback(err)` function accepts one argument: the error message if any.

`beginTransaction()`, `endTransaction()` and `setAutoCommitMode()` functions are 
idempotent, that is you can call them multiple times and the result will be the same. 

**Note:** Unlike in other DBMS vendor drivers, in **node-coradb** when a transaction is 
rolled back or committed, the `auto_commit` mode remains unchanged, i.e. `false`. This is 
according to CoraDB spec. This means that after you commit/rollback the transaction and 
you no longer need to execute queries in `auto_commit = false` mode, explicitly turn the 
`auto_commit` mode to `true` by calling `setAutoCommitMode()` function.

Turning the auto commit mode back on with `setAutoCommitMode(true)` (or
`endTransaction()`) commits the changes made so far, as the JDBC driver's
`setAutoCommit()` does. To discard them, `rollback()` first.

Here is a promise based example that shows how to start and end a transaction. 

    client
        .execute('CREATE TABLE test_tran(id INT)')
        .then(() => {
            return client.beginTransaction();
        })
        .then(() => {
            return client.execute('INSERT INTO test_tran VALUES(1)');
        })
        .then(() => {
            return client.query('SELECT * FROM test_tran');
        })
        .then(response => {
            assert(response.result.RowsCount === 1);
            
            return client.closeQuery(response.queryHandle);
        })
        .then(() => {
            return client.rollback();
        })
        .then(() => {
            // **Note** that the auto commit mode is still OFF
            // even after the `rollback()`. 
            return client.query('SELECT * FROM test_tran');
        })
        .then(response => {
            assert(response.result.RowsCount === 0);
            
            return client.closeQuery(response.queryHandle);
        })
        .then(() => {
            // We are still inside the same transaction with
            // auto commit mode OFF.
            return client.execute('DROP TABLE test_tran');
        })
        .then(() => {
            return client.commit();
        })
        .then(() => {
            return client.endTransaction();
        })
        .then(() => { 
            return client.query("SELECT COUNT(*) FROM db_class WHERE class_name = 'test_tran'");
        })
        .then(response => {
            assert(response.result.RowsCount === 0);
            
            // Closing a connection will automatically close
            // all query statements.
            return client.close();
        });

### Generated keys

To read the keys an INSERT generates (its AUTO_INCREMENT values), run it with
`query()` and `{ getGeneratedKeys: true }`:

    const { queryHandle, generatedKeys } = await client.query(
        "INSERT INTO athlete (name) VALUES ('Kim'), ('Lee')",
        undefined, undefined, { getGeneratedKeys: true });   // or (sql, params, { ... })
    // generatedKeys: { ColumnNames: ['id'], ColumnDataTypes: ['Int'], ColumnValues: [[101], [102]], RowsCount: 2 }

    const keys = await client.getGeneratedKeys(queryHandle);   // the same keys
    await client.closeQuery(queryHandle);                      // forgets them

It works as `executeUpdate(sql, RETURN_GENERATED_KEYS)` does in the JDBC
driver. Before `query()` resolves, the driver:

1. sends the INSERT without auto-commit (a CAS that committed it at once would
   drop the keys);
2. reads the keys (GET_GENERATED_KEYS);
3. closes the INSERT's handle;
4. in auto-commit mode, commits (END_TRAN COMMIT).

So the INSERT is committed and the keys are in hand when it resolves.
`getGeneratedKeys(queryHandle)` answers from the keys already read, without a
request, until `closeQuery(queryHandle)` or `close()`. If reading the keys
fails, `query()` fails with that error — the INSERT is still committed in
auto-commit mode, as it is with JDBC. With auto-commit off, the INSERT is part
of the transaction like any other statement. A handle that was not run this
way, or is not open on the connection's session, fails with
`NO_ACTIVE_QUERY`.

### Checking the connection

    const ok = await client.isValid();

`true` when the connection is open and its session still answers a CHECK_CAS
request; `false` otherwise — never a rejection. A connection that is not open
is `false` at once: `isValid()` does not connect. The request queues like any
other, so on a busy connection it answers once the statement running has
finished.

### Requesting CoraDB Server information

There are a few functions that report meta information about the server.

    /*
     * `getEngineVersion()` accepts one argument:
     * 1. `callback(err, version)` accepts two arguments:
     *    1. `err`: an error object if any. 
     *    2. `version`: CoraDB Database version like `1.0.0`.  
     */

    // Callback style.
    client.getEngineVersion(callback);
   
    // Promise style.
    const promise = client.getEngineVersion();
       
    /*
     * `getActiveHost()` accepts one argument:
     * 1. `callback(err, host)` accepts two arguments:
     *    1. `err`: an error object if any. 
     *    2. `host`: an object with `host` and `port` properties that 
     *       represents the server which the client is connected to.  
     */

    // Callback style.
    client.getActiveHost(callback);
   
    // Promise style.
    const promise = client.getActiveHost();

### Closing a connection

    /*
     * `close()` or its alias `end()` functions accept one argument:
     * 1. `callback(err)` accepts one argument:
     *    1. `err`: an error object if any.   
     */

    // Callback style.
    client.close(callback);
    client.end(callback);
   
    // Promise style.
    const promise = client.close();
    const promise = client.end();

#### Callback style

    client.close(function (err) {
        if (err) {
            throw err;
        } else {            
            console.log('connection is closed');
        }
    });

#### Promise style

    const promise = client
        .connect()
        .then(() => {
            return client.close();
        });

When a connection is closed by calling `close()` or `end()`, all pending/queued 
requests will be removed from the internal queue. All in-flight queries will be
requested to be closed.

#### Errors on closing the connection

The following errors may be emitted when the application tries to close the connection:

1. If closing a connection was unsuccessful, an error message returned by a database is emitted.

### Reading a query plan

The plan is not a result set. It has a request of its own, and asking for it
neither prepares nor executes the statement — so you can ask what the engine
would do with a `DELETE` without running one:

    const plan = await client.getQueryPlan('select * from orders where id = 1');
    console.log(plan);

Raising the session's optimizer level (`SET OPTIMIZATION LEVEL 257` and
friends) is a different thing and not this one: it makes the engine produce a
plan and print it to the server's own output, where no client can read it.

### Cancelling a statement

A CoraDB connection serves one request at a time, and a CAS process busy
executing a statement is not reading its own socket. So a statement that is
already running cannot be called back the ordinary way — nothing you write to
that socket will be read until it is finished.

`cancel()` is the way to stop one. It tries two things, in order.

The first is to ask for it. The request goes over a socket opened for that one
message, to the port this connection is actually served on — the broker hands
the client on to a CAS port at connection time, and that is the port, not
necessarily the one in the connection string — and names the CAS process by the
id its login reply gave. Ten bytes: `'X'`, `'1'`, the protocol version, three
reserved zeroes, then the process id big-endian. The listener signals the
process, and the statement returns `CAS_ER_QUERY_CANCEL` to whoever was waiting
for it. **The connection survives** — the session, its transaction and its open
query handles are all still there.

The second is `abort()`, which takes the socket down. That always works, but
everything the connection held goes with it, including a transaction that had
not been committed.

Which one happened is in the result, because that difference is what the person
who pressed Cancel has to be told:

    const running = client.queryAll('select count(*) from huge a, huge b');

    const { method } = await client.cancel();
    // 'broker' - statement stopped; connection and transaction intact
    // 'abort'  - connection closed; uncommitted work rolled back

    await running.catch((err) => console.log('stopped:', err.message));

`cancel({ brokerCancel: false })` goes straight to `abort()`.
`cancel({ timeout })` sets how long it is given to answer, in milliseconds; the
default is 2000. An answer of zero or more means the cancel was taken; a
negative one is a refusal, and a refusal falls back to `abort()` like any other
failure. `canBrokerCancel()` says whether the first route is available at all
— it needs a connection that has logged in and been given a CAS process id.

Not every broker takes the out-of-band cancel; when yours refuses it, `cancel()`
falls back to `abort()` and resolves with `{ method: 'abort' }`.

#### Aborting

`abort([reason])` is the hard stop on its own, for when a connection has to let
go now and what it was doing does not matter:

    await client.abort('The user closed the tab.');

It fails the request in flight rather than leaving it waiting for a reply that
is not coming, and the requests queued behind it are failed in turn as the
queue drains — each with an error of its own, rather than being dropped. The
connection can be opened again with `connect()` afterwards.

This is what `close()` cannot do: a close queues behind the statement it is
meant to interrupt, so on a busy connection it does not return until the
statement it was called to escape has finished.

## Running tests

See [RUN-TESTS.md](RUN-TESTS.md) for every option. In short:

1. Node.js 20 or later, and `npm install`.
2. `npm run test:unit`: no server needed.
3. For the database and end-to-end tests, a CoraDB broker on `localhost:33000`
   with the official `olympics1988-2004` dataset. The settings are in `test/db-test/testSetup/connection.json`
   and `test/e2e-test/helpers.js` (environment variables `CORADB_HOST`,
   `CORADB_PORT`, `CORADB_USER`, `CORADB_PASSWORD`, `CORADB_DATABASE`).
4. `npm run test:db` and `npm run test:e2e`. Each suite drops the tables it
   creates before it starts and after it ends.
5. `npm run coverage` for the coverage report (c8).

## What's next

We continuously improve this driver, by adding more features and improving the existing code base.
You are more than welcome to suggest what we should improve or add - please let us know (mailto:contact@coradb.ai)!

## Authors and Contributors

The authors of this driver are the members of the [CoraDB Team](https://www.coradb.ai).
