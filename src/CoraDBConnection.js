'use strict';

const Net = require('node:net');
const EventEmitter = require('node:events').EventEmitter;

const ErrorMessages = require('./constants/ErrorMessages');
const DATA_TYPES = require('./constants/DataTypes');
const CASConstants = require('./constants/CASConstants');

const Helpers = require('./utils/Helpers');
const { CoraDBBatchError, driverError, serverError, withStatement } = require('./errors');
const { checkTyped } = require('./params');
const NoopLogger = require('./NoopLogger');
const Query = require('./query/Query');
const Queue = require('./query/Queue');
const PacketReader = require('./packets/PacketReader');
const PacketWriter = require('./packets/PacketWriter');
const ClientInfoExchangePacket = require('./packets/ClientInfoExchangePacket');
const OpenDatabasePacket = require('./packets/OpenDatabasePacket');
const GetEngineVersionPacket = require('./packets/GetEngineVersionPacket');
const ExecuteQueryPacket = require('./packets/ExecuteQueryPacket');
const GetSchemaPacket = require('./packets/GetSchemaPacket.js');
const CloseQueryPacket = require('./packets/CloseQueryPacket');
const BatchExecuteNoQueryPacket = require('./packets/BatchExecuteNoQueryPacket');
const CloseDatabasePacket = require('./packets/CloseDatabasePacket');
const CancelRequestPacket = require('./packets/CancelRequestPacket');
const GetQueryInfoPacket = require('./packets/GetQueryInfoPacket');
const FetchPacket = require('./packets/FetchPacket');
const RollbackPacket = require('./packets/RollbackPacket');
const CommitPacket = require('./packets/CommitPacket');
const CheckCasPacket = require('./packets/CheckCasPacket');
const GeneratedKeysPacket = require('./packets/GeneratedKeysPacket');
const LOBReadPacket = require('./packets/LOBReadPacket');
const LOBNewPacket = require('./packets/LOBNewPacket');
const LOBWritePacket = require('./packets/LOBWritePacket');
const SetDbParameterPacket = require('./packets/SetDbParameterPacket');
const GetDbParameterPacket = require('./packets/GetDbParameterPacket');
const PrepareExecutePacket = require('./packets/PrepareExecutePacket');
const NextResultPacket = require('./packets/NextResultPacket');

// Default connection parameters, applied when the caller does not provide them.
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 33000;
const DEFAULT_USER = 'PUBLIC';
const DEFAULT_PASSWORD = '';
const DEFAULT_DATABASE = 'demodb';
// Connection timeout in milliseconds (0 = no client-side timeout).
const DEFAULT_CONNECTION_TIMEOUT = 0;
const DEFAULT_MAX_CONNECTION_RETRY_COUNT = 1;
// The longest a Node.js timer can wait; a longer one fires at once.
const MAX_TIMER_MS = 2147483647;

/**
 * A timeout option as a whole number of milliseconds; 0 (none) for anything
 * that is not a positive number. Strings of digits count as numbers. A
 * negative value or a string used to reach `socket.setTimeout()`, which threw
 * — every connect then failed with ERR_OUT_OF_RANGE or ERR_INVALID_ARG_TYPE.
 */
function timeoutMs(value) {
  const ms = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

  if (typeof ms !== 'number' || !(ms > 0)) {
    return 0;
  }

  return Math.min(Math.floor(ms), MAX_TIMER_MS) || 0;
}

/**
 * Call a user's callback without letting it disturb the driver.
 *
 * A callback that throws used to throw into the driver's own promise chain,
 * which then reported the exception back to the same callback as if the
 * request had failed — a second call, with the wrong error. Now the exception
 * is rethrown on its own turn of the event loop, the way Node's own callback
 * APIs surface it, and the request's outcome stands.
 */
function invoke(callback, args) {
  try {
    callback(...args);
  } catch (err) {
    process.nextTick(() => {
      throw err;
    });
  }
}

/**
 * Centralizes the dual Promise/callback completion shared by the public async
 * methods built on `new Promise((resolve, reject) => ...)` (most of which also
 * drain a request-queue slot via `done`).
 *
 * Both are answered: the callback, when one was given, and the promise,
 * always. The promise used to stay pending for ever whenever a callback was
 * passed, so `await conn.query(sql, cb)` never returned, and every such call
 * kept a pending promise and its closure alive. (A promise that rejects while
 * a callback was given is marked handled — see `markHandledWithCallback` — so
 * callback-style code that ignores it sees no unhandled rejection.)
 *
 * Returns two handlers, each effective once:
 *   - `fulfil(resolveValue, ...callbackArgs)`: resolve the promise with
 *     `resolveValue`, and call `callback(undefined, ...callbackArgs)`. When no
 *     `callbackArgs` are given they default to `[resolveValue]` (or none when
 *     `resolveValue` is undefined), which covers the single-value and void
 *     cases.
 *   - `fail(err)`: reject the promise, and call `callback(err)`.
 *
 * @param resolve the Promise resolve function
 * @param reject the Promise reject function
 * @param callback optional node-style callback
 * @param done optional queue-slot release function, called before settling
 */
function settle(resolve, reject, callback, done) {
  const hasCallback = typeof callback === 'function';
  let settled = false;

  const release = function () {
    if (typeof done === 'function') {
      done();
    }
  };

  return {
    fulfil: function (resolveValue, ...callbackArgs) {
      if (settled) {
        return;
      }

      settled = true;
      release();

      if (hasCallback) {
        if (callbackArgs.length > 0) {
          invoke(callback, [undefined, ...callbackArgs]);
        } else {
          invoke(callback, resolveValue === undefined ? [] : [undefined, resolveValue]);
        }
      }

      resolve(resolveValue);
    },
    fail: function (err) {
      if (settled) {
        return;
      }

      settled = true;
      release();

      if (hasCallback) {
        invoke(callback, [err]);
      }

      reject(err);
    },
  };
}

/**
 * How a request that never ran reports its failure.
 *
 * Handed to the queue when the request is enqueued, and called if the request
 * is dropped before it starts — a connection closed or aborted out from under
 * it. There is no queue slot to release, because the request never took one;
 * all that is owed is an answer, to the callback if one was given and to the
 * promise always.
 *
 * @param reject the Promise reject function
 * @param callback optional node-style callback
 */
function dropped(reject, callback) {
  return function (err) {
    if (typeof callback === 'function') {
      invoke(callback, [err]);
    }

    reject(err);
  };
}

/**
 * Adapts a Promise to an optional node-style callback for the simpler methods
 * that chain off an existing Promise (rather than constructing their own).
 * The callback, when supplied, receives `(err)` or `(undefined, result)`; the
 * promise returned settles with the same outcome either way. (It used to
 * resolve to whatever the callback returned.)
 *
 * @param promise the source Promise
 * @param callback optional node-style callback
 */
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/**
 * The logger to use: the one given, with any level it lacks made a no-op, or
 * a NoopLogger. `null` used to pass the `typeof … === 'object'` test, and a
 * logger without `debug` threw on first use — from `connect()`, or from a
 * socket listener, where nothing catches it.
 */
function loggerOf(logger) {
  if (logger === null || (typeof logger !== 'object' && typeof logger !== 'function')) {
    return new NoopLogger();
  }

  if (LOG_LEVELS.every(level => typeof logger[level] === 'function')) {
    return logger;
  }

  const complete = {};

  LOG_LEVELS.forEach(level => {
    complete[level] = typeof logger[level] === 'function' ? logger[level].bind(logger) : () => {};
  });

  return complete;
}

function adaptPromise(promise, callback) {
  if (typeof callback === 'function') {
    promise.then(
      result => invoke(callback, [undefined, result]),
      err => invoke(callback, [err])
    );
  }

  return promise;
}

const noop = () => undefined;

/**
 * Wrap public methods so that, when the caller passed a callback, the promise
 * the method returns is marked as handled.
 *
 * Callback-style code does not look at the promise, and since every method now
 * settles both, a failure would otherwise also surface as an unhandled
 * rejection — which ends the process on Node 15 and later. A caller who does
 * `await` the promise still sees the rejection.
 */
function markHandledWithCallback(proto, names) {
  for (const name of names) {
    const original = proto[name];

    if (typeof original !== 'function') {
      continue;
    }

    proto[name] = function (...args) {
      const result = original.apply(this, args);

      if (result && typeof result.catch === 'function' && args.some(a => typeof a === 'function')) {
        result.catch(noop);
      }

      return result;
    };

    Object.defineProperty(proto[name], 'name', { value: name });
  }
}

/**
 * A host as given — 'db1', 'db1:33000', '[::1]:33000', '[fe80::1]' or a bare
 * IPv6 address such as '::1' — as `{ host, port }`, with `defaultPort` when it
 * names none. The text after the first colon used to be taken for the port,
 * so '::1' became host '' and port ':1'.
 * @private
 */
function parseHost(hostPort, defaultPort) {
  const text = String(hostPort).trim();
  const bracketed = /^\[([^\]]*)\](?::(\d*))?$/.exec(text);

  if (bracketed) {
    return { host: bracketed[1], port: bracketed[2] || defaultPort };
  }

  const ix = text.indexOf(':');

  // More than one colon, unbracketed: an IPv6 address on its own.
  if (ix < 0 || text.indexOf(':', ix + 1) > -1) {
    return { host: text, port: defaultPort };
  }

  return { host: text.slice(0, ix), port: text.slice(ix + 1) || defaultPort };
}

/**
 * Create a new CoraDB connection instance
 * @param host(s)
 * @param port
 * @param user
 * @param password
 * @param database
 * @param connectionTimeout
 * @param maxConnectionRetryCount
 * @param logger
 * @param requestTimeoutMs default client-side timeout of sql(), stream(), cursor() and prepare()
 * @param queryTimeout server-side query timeout, in milliseconds (see setQueryTimeout())
 * @constructor
 */
function CoraDBConnection(hosts, port, user, password, database, connectionTimeout, maxConnectionRetryCount, logger, requestTimeoutMs, queryTimeout) {
  // Using EventEmitter.call on an object will do the setup of instance methods / properties
  // (not inherited) of an EventEmitter.
  // It is similar in purpose to super(...) in Java or base(...) in C#, but it is not implicit in Javascript.
  // Because of this, we must manually call it ourselves:
  EventEmitter.call(this);

  // Allow to pass the connection parameters as an object.
  // Not null: `createConnection(null)` threw a TypeError reading its port.
  if (hosts !== null && typeof hosts === 'object' && !Array.isArray(hosts)) {
    port = hosts.port;
    user = hosts.user;
    password = hosts.password;
    database = hosts.database;
    connectionTimeout = hosts.connectionTimeout;
    maxConnectionRetryCount = hosts.maxConnectionRetryCount;
    logger = hosts.logger;
    requestTimeoutMs = hosts.requestTimeoutMs;
    queryTimeout = hosts.queryTimeout;
    // Allow users to specify a single host via `host`
    // or multiple hosts as `hosts` array.
    hosts = hosts.host || hosts.hosts;
  }

  if (!Array.isArray(hosts)) {
    hosts = [hosts];
  }

  // Connection parameters
  this.connectionBrokerPort = -1;
  this.connectionRetryCount = 0;
  // `??`: 0 means no retry, and used to become the default of 1.
  this.maxConnectionRetryCount = maxConnectionRetryCount ?? DEFAULT_MAX_CONNECTION_RETRY_COUNT;
  this.currentHostIndex = 0;
  const defaultPort = port || DEFAULT_PORT;

  this.hosts = hosts.map(hostPort => parseHost(hostPort || DEFAULT_HOST, defaultPort));

  this.user = user || DEFAULT_USER;
  this.password = password || DEFAULT_PASSWORD;
  this.database = database || DEFAULT_DATABASE;
  // Connection timeout in milliseconds.
  this.connectionTimeout = timeoutMs(connectionTimeout) || DEFAULT_CONNECTION_TIMEOUT;
  this.logger = loggerOf(logger);
  // The default `timeoutMs` for sql(), stream(), cursor() and prepare(), in
  // milliseconds; 0 for none. Each call can give its own.
  this.requestTimeoutMs = timeoutMs(requestTimeoutMs);
  // How long the server lets a statement run, in milliseconds; 0 for no
  // limit. Sent with every execute (see setQueryTimeout()).
  this.queryTimeout = timeoutMs(queryTimeout);

  // Session public variables
  this.autoCommitMode = true;
  this.sessionId = 0;

  // Execution semaphore variables; prevent double-connect-attempts, overlapping-queries etc.
  this.connectionOpened = false;
  this.connectionPending = false;
  // The connect in progress, which a second caller waits for (see _connect).
  this._connecting = undefined;

  // Auto-commit constants
  this.AUTOCOMMIT_ON = true;
  this.AUTOCOMMIT_OFF = !this.AUTOCOMMIT_ON;

  this._CASInfo = [0, 0xFF, 0xFF, 0xFF];
  this._queryResultSets = {};
  // How many times the caller has closed or aborted the connection (see
  // _executeWithReconnect).
  this._closes = 0;
  // The caller's handles of the results a commit or rollback closed (see
  // _closeResultHandles), for closeQuery() to accept.
  this._endedHandles = new Set();
  // The keys of the statements run with `{ getGeneratedKeys: true }`, by the
  // caller's handle: read, and the handle closed, before query() resolved (see
  // _completeGeneratedKeys). getGeneratedKeys() answers from here, and
  // closeQuery() or close() forgets them.
  this._generatedKeys = new Map();
  // Which login the connection is on: 1 for the first, and one more for every
  // login after it. Each query handle, prepared statement and cursor is
  // stamped with the login it came from, because a new session hands out
  // handle numbers from 1 again: a handle kept across a reconnect would
  // otherwise name another statement entirely.
  this._generation = 0;
  // Bumped by close() and abort(), so a connect they interrupted knows.
  this._connectAttempt = 0;
  // Set when a session is lost while auto-commit is off; see _ensureConnected.
  this._transactionLost = false;
  // Whether a transaction() is running; there is one at a time.
  this._transactionActive = false;
  // Deadlock victims (-72) seen with auto-commit off; see transaction().
  this._rollbacks = 0;
  this._lastRollbackError = undefined;
  this._INVALID_RESPONSE_LENGTH = -1;
  this._LOB_MAX_IO_LENGTH = 128 * 1024;

  // Enforce query execution using the old/new protocol.
  this._ENFORCE_OLD_QUERY_PROTOCOL = false;

  // SQL queries queue.
  this._queue = new Queue();
}

// Support custom events: inherit EventEmitter's prototype. This is the
// non-deprecated, drop-in replacement for util.inherits().
Object.setPrototypeOf(CoraDBConnection.prototype, EventEmitter.prototype);

/**
 * The error a request gets when the connection goes away under it, or when it
 * is about to be sent on a connection that has already gone.
 */
function connectionClosedError(cause) {
  return driverError('CONNECTION_CLOSED', ErrorMessages.ERROR_CONNECTION_CLOSED, cause ? { cause } : undefined);
}

/** The engine's code for "chosen as a deadlock victim; transaction rolled back". */
const DEADLOCK_VICTIM = -72;

/** Errors already counted by `_noteServerError` (a chained request sees one twice). */
const countedErrors = new WeakSet();

/**
 * Look at a server error before the request that got it does.
 *
 * A deadlock victim (-72) has had its whole transaction rolled back. With
 * auto-commit on that transaction was the one statement, and running it again
 * is the right thing to do; with auto-commit off it was everything since the
 * last commit, and running the one statement again would carry on in a new
 * transaction as if the rest had happened. So inside a transaction the error
 * is marked not retryable (and `transactionRolledBack`), and counted, so that
 * `transaction()` can refuse to commit what is left.
 */
function _noteServerError(err) {
  if (!err || typeof err !== 'object' || this.autoCommitMode !== false) {
    return;
  }

  const victims = [err].concat(Array.isArray(err.errors) ? err.errors : [])
    .filter((e) => e && e.code === DEADLOCK_VICTIM);

  if (victims.length === 0) {
    return;
  }

  for (const e of victims.concat(err)) {
    e.retryable = false;
    e.transactionRolledBack = true;
  }

  if (!countedErrors.has(err)) {
    countedErrors.add(err);
    this._rollbacks += 1;
    this._lastRollbackError = victims[0];
  }
}

/** `callback`, seeing every error through `_noteServerError` first. */
function _observe(callback) {
  if (callback._coradbObserved) {
    return callback;
  }

  const observed = (err, ...rest) => {
    if (err) {
      _noteServerError.call(this, err);
    }

    return callback(err, ...rest);
  };

  observed._coradbObserved = true;

  return observed;
}

/**
 * Watch a socket for the end of it.
 *
 * Every way a socket can go — an error, a clean close from the server (FIN),
 * the connect/login timeout, a reply that cannot be parsed — ends in
 * `_onSocketGone`, which answers whatever was waiting on it. The `close`
 * handler used to only note the fact, so a CAS restarting mid-request left
 * that request, and the whole queue behind it, waiting for ever.
 *
 * (Also the hook the tests use to wire a stand-in socket.)
 */
CoraDBConnection.prototype._attachSocketListeners = function (socket) {
  socket.on('error', (err) => _onSocketGone.call(this, socket, err));
  socket.on('close', () => _onSocketGone.call(this, socket));
};

/**
 * A socket has gone. Once per socket, whichever event says so first.
 *
 * For the connection's current socket:
 *   - the request in flight is failed — with the socket error when there was
 *     one (ECONNRESET and the like, as Node reports them), otherwise with
 *     CONNECTION_CLOSED;
 *   - if the session was open, every queued request is failed too
 *     (CONNECTION_CLOSED): they were asked of a session that no longer exists,
 *     and silently running them on a new one is how half a transaction got
 *     committed;
 *   - the session's query handles are forgotten, and if auto-commit was off,
 *     the connection remembers that a transaction was lost (see
 *     `_ensureConnected`).
 *
 * A socket the connection tore down itself (`_destroySocket`) only reports
 * 'disconnect': whoever tore it down has answered everyone already. A socket
 * the connection has moved on from (the broker's, after it handed the
 * connection to a CAS port) is ignored, so a late `close` from it can no
 * longer mark the new connection closed.
 */
function _onSocketGone(socket, err) {
  if (socket._coradbGone) {
    return;
  }

  socket._coradbGone = true;

  if (err) {
    this.logger.debug('Socket error', err);
  }

  socket.setTimeout(0);
  socket.removeAllListeners('timeout');
  socket.removeAllListeners('data');

  if (!socket.destroyed) {
    socket.destroy();
  }

  if (socket._coradbDetached) {
    this.emit('disconnect');
    return;
  }

  if (this._socket !== socket) {
    return;
  }

  const wasOpen = this.connectionOpened;

  this._socket = null;
  this.connectionOpened = false;
  // Handles belong to the session that has just ended.
  this._queryResultSets = {};

  if (wasOpen && this.autoCommitMode === false) {
    this._transactionLost = true;
  }

  // While connecting there is no queue to fail: the request in flight is the
  // one connecting, and it may yet succeed on the next host.
  if (wasOpen) {
    this._queue.empty(driverError(
      'CONNECTION_CLOSED',
      ErrorMessages.ERROR_CONNECTION_LOST_WHILE_QUEUED,
      err ? { cause: err } : undefined
    ));
  }

  const waiting = this._socketCurrentEventCallback;

  this._socketCurrentEventCallback = undefined;

  if (typeof waiting === 'function') {
    try {
      waiting(err || connectionClosedError());
    } catch (e) {
      this.logger.debug('A request refused its own failure:', e && e.message);
    }
  } else if (err) {
    // Nothing is waiting on the socket — it failed while idle. Throwing from
    // an EventEmitter listener would end the whole process, which is out of
    // proportion to a dropped idle connection.
    this._lastSocketError = err;
    this.logger.debug('Socket error on an idle connection:', err && err.message);
  }

  this.emit('disconnect');
}

/**
 * The broker has handed this connection on to a CAS port: its socket is no
 * longer ours. Its listeners go before it is closed, so nothing it does later
 * is taken for the new socket's.
 */
function _retireSocket(socket) {
  socket.removeAllListeners('close');
  socket.removeAllListeners('error');
  socket.removeAllListeners('timeout');
  socket.removeAllListeners('data');
  socket.on('error', noop);
  socket.setTimeout(0);

  if (this._socket === socket) {
    this._socket = null;
  }

  socket.end();
}

/** The connect/login timeout, failing whatever is waiting when it fires. */
function _armTimeout(socket) {
  const ms = this.getConnectionTimeout();

  socket.removeAllListeners('timeout');
  socket.setTimeout(ms);

  if (ms > 0) {
    socket.once('timeout', () => {
      _onSocketGone.call(this, socket, driverError('ETIMEDOUT', ErrorMessages.ERROR_CONNECTION_TIMEOUT));
    });
  }
}

function _disarmTimeout(socket) {
  socket.setTimeout(0);
  socket.removeAllListeners('timeout');
}

/**
 * Send one request and route its reply to `parserFunction` (in `options`),
 * which answers `callback`.
 *
 * On a connection that is not open (or a socket that has gone), the callback
 * is failed with CONNECTION_CLOSED at once rather than writing into nothing.
 * `options.connecting` allows the login, which is sent before the connection
 * counts as open.
 */
function _send(buffer, options, callback) {
  const socket = this._socket;
  const observed = _observe.call(this, callback);

  if (!socket || socket.destroyed || socket._coradbGone || (!this.connectionOpened && !options.connecting)) {
    return observed(connectionClosedError());
  }

  this._socketCurrentEventCallback = observed;

  socket.removeAllListeners('data');
  socket.on('data', _receiveBytes.call(this, socket, options, observed));
  socket.write(buffer);
}

/**
 * Get broker connection port
 * @private
 */
function _doGetBrokerPort() {
  this.logger.debug(`_doGetBrokerPort: connectionRetryCount = ${this.connectionRetryCount}.`);

  return new Promise((resolve, reject) => {
    const clientInfoExchangePacket = new ClientInfoExchangePacket();
    const packetWriter = new PacketWriter(clientInfoExchangePacket.getBufferLength());

    const hostInfo = this.hosts[this.currentHostIndex];

    const socket = this._socket = Net.createConnection(hostInfo.port, hostInfo.host);

    socket.setNoDelay(true);

    clientInfoExchangePacket.write(packetWriter);

    // A connection failure warrants trying the next host / retrying. Note that
    // Node's Happy-Eyeballs (autoSelectFamily) wraps per-address failures for a
    // multi-address host (e.g. 'localhost' -> ::1 and 127.0.0.1) in an
    // AggregateError whose own `message` is empty; the useful details live on
    // `code` and in the `errors` array, so inspect all of them.
    const indicatesConnectionFailure = (e) => {
      if (!e) {
        return false;
      }

      const message = e.message || '';

      if (message.includes(ErrorMessages.ERROR_CONNECTION_TIMEOUT) ||
                    message.includes('ECONNREFUSED') ||
                    e.code === 'ECONNREFUSED') {
        return true;
      }

      return Array.isArray(e.errors) && e.errors.some(indicatesConnectionFailure);
    };

    let callback = (err) => {
      if (err) {
        this.logger.error(`_doGetBrokerPort error`, err.message);

        // If connection has failed, we need to try to connect to the next
        // broker.
        if (indicatesConnectionFailure(err)) {
          // Check if we have any more hosts left to try connecting.
          if (++this.currentHostIndex < this.hosts.length) {
            // Try the next host.
            return resolve(_doGetBrokerPort.call(this));
          }

          // We have already tried all hosts.
          // Try again from the beginning `maxConnectionRetryCount` times.
          if (++this.connectionRetryCount <= this.maxConnectionRetryCount) {
            this.currentHostIndex = 0;

            return resolve(_doGetBrokerPort.call(this));
          }
        }

        return reject(err);
      }

      // Reset the retry counter on successful connection.
      this.connectionRetryCount = 0;
      this.logger.debug(`_doGetBrokerPort: connected to ${hostInfo.host}:${hostInfo.port}.`);

      resolve();
    };

    this._attachSocketListeners(socket);
    this._socketCurrentEventCallback = callback;
    _armTimeout.call(this, socket);

    // The answer is one integer, which may arrive in pieces.
    let received = Buffer.alloc(0);

    socket.on('data', (data) => {
      if (this._socket !== socket) {
        return;
      }

      received = Buffer.concat([received, data]);

      if (received.length < DATA_TYPES.INT_SIZEOF) {
        return;
      }

      socket.removeAllListeners('data');
      _disarmTimeout(socket);
      this._socketCurrentEventCallback = undefined;

      const packetReader = new PacketReader();

      packetReader.write(received);

      clientInfoExchangePacket.parse(packetReader);

      const newPort = clientInfoExchangePacket.newConnectionPort;

      this.logger.debug(`_doGetBrokerPort: newPort = ${newPort}`);

      this.connectionBrokerPort = newPort;

      if (newPort !== 0) {
        // If the new port is not `0`, i.e. it has changed, this socket is
        // done with: the new one is opened in `_doDatabaseLogin()`. If it is
        // `0`, we keep using this same socket.
        _retireSocket.call(this, socket);
      }

      if (newPort > -1) {
        return callback();
      }

      // A negative answer is the broker's error code, in the old numbering
      // when it is above -10000 (as the JDBC driver reads it in
      // BrokerHandler.connectBroker()).
      const code = newPort > -10000 ? newPort - 9000 : newPort;

      callback(serverError(code, ErrorMessages.CASErrorMsgId[code] || ErrorMessages.ERROR_NEW_BROKER_PORT));
    });

    socket.write(packetWriter._buffer);
  });
}

/**
 * Login to a database
 * @private
 */
function _doDatabaseLogin() {
  this.logger.debug(`_doDatabaseLogin: connectionBrokerPort = ${this.connectionBrokerPort}`);

  return new Promise((resolve, reject) => {
    let socket;

    if (this.connectionBrokerPort) {
      // The broker port has changed, so we need to create
      // a new socket connection.
      const hostInfo = this.hosts[this.currentHostIndex];

      socket = this._socket = Net.createConnection(this.connectionBrokerPort, hostInfo.host);

      socket.setNoDelay(true);

      this._attachSocketListeners(socket);
    } else {
      // The broker port has not been changed. We can reuse the socket.
      socket = this._socket;
    }

    if (!socket || socket.destroyed || socket._coradbGone) {
      return reject(connectionClosedError());
    }

    let callback = (err) => {
      // Clear connection timeout
      _disarmTimeout(socket);

      if (err) {
        return reject(err);
      }

      resolve();
    };

    this.logger.debug(`_doDatabaseLogin: session ${this._session ? `${this._session.toString('hex')} (resumed)` : 'new'}`);

    let openDatabasePacket = new OpenDatabasePacket({
      database: this.database,
      user: this.user,
      password: this.password,
      session: this._session,
      logger: this.logger
    });
    const packetWriter = new PacketWriter(openDatabasePacket.getBufferLength());

    try {
      openDatabasePacket.write(packetWriter);
    } catch (err) {
      return callback(err);
    }

    // The login has a callback and a timeout of its own. On a reused socket
    // (broker port 0) it used to have neither: the client-info exchange had
    // already cleared the timeout, and its own callback — long since settled —
    // was the one a reset would have reached. A CAS dying during the login
    // left `connect()` pending for ever, and every later connect() refused
    // with CONNECTION_ALREADY_PENDING.
    _armTimeout.call(this, socket);

    _send.call(this, packetWriter._buffer, {
      connecting: true,
      parserFunction: _parseDatabaseLoginBuffer.bind(this),
      dataPacket: openDatabasePacket
    }, callback);
  });
}

/**
 * Get the server database engine version
 */
function _getEngineVersion() {
  this.logger.debug('Executing _getEngineVersion');

  return new Promise((resolve, reject) => {
    // The real auto-commit mode: the CAS commits after answering when it is
    // 1, and a version request is what a ping sends — in the middle of the
    // caller's manual-commit transaction, which it used to commit.
    let getEngineVersionPacket = new GetEngineVersionPacket({
      autoCommit: this.autoCommitMode,
      casInfo: this._CASInfo
    });
    const packetWriter = new PacketWriter(getEngineVersionPacket.getBufferLength());

    getEngineVersionPacket.write(packetWriter);

    let callback = (err, engineVersion) => {
      if (err) {
        return reject(err);
      }

      resolve(engineVersion);
    };

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseEngineVersionBuffer.bind(this),
      dataPacket: getEngineVersionPacket
    }, callback);
  });
}

/**
 * Connect if the connection is not open — the implicit connect every request
 * makes.
 *
 * Except after a session was lost while auto-commit was off. That session's
 * transaction has been rolled back by the server, and a request made now
 * belongs to it as far as its caller knows: running it on a new session, in a
 * new transaction, is what let `transaction()` commit half its work. So it
 * fails with TRANSACTION_LOST until the caller says what to do — rollback(),
 * setAutoCommitMode(), or an explicit connect().
 * @private
 */
function _ensureConnected() {
  if (this.connectionOpened) {
    return Promise.resolve();
  }

  if (this._transactionLost) {
    return Promise.reject(driverError('TRANSACTION_LOST', ErrorMessages.ERROR_TRANSACTION_LOST));
  }

  return _connect.call(this);
}

CoraDBConnection.prototype._ensureConnected = function () {
  return _ensureConnected.call(this);
};

/**
 * The host this connection talks to, connecting first if it is not connected.
 * Use `getConnectedHost()` to ask without connecting.
 * @param callback
 */
CoraDBConnection.prototype.getActiveHost = function (callback) {
  return adaptPromise(
    _ensureConnected.call(this).then(() => Object.freeze(this.hosts[this.currentHostIndex])),
    callback
  );
};
/**
 * The host this connection is talking to, or null when it is not connected.
 * Unlike `getActiveHost()`, this never connects.
 * @return {{ host: string, port: (number|string) }|null}
 */
CoraDBConnection.prototype.getConnectedHost = function () {
  return this.connectionOpened ? Object.freeze(Object.assign({}, this.hosts[this.currentHostIndex])) : null;
};

/**
 * Connect to database.
 *
 * An explicit connect also says the caller knows any session it had is gone:
 * it clears a lost transaction (see `_ensureConnected`).
 * @param callback
 */
CoraDBConnection.prototype.connect = function (callback) {
  this._transactionLost = false;

  return _connect.call(this, callback);
};

function _connect(callback) {
  this.logger.debug(`Connect with timeout = ${this.connectionTimeout} ms.`);

  let promise;

  if (this.connectionOpened) {
    promise = Promise.resolve();
  } else if (this.connectionPending && this._connecting) {
    // A connect is already on its way: this one waits for it. Two callers
    // racing to connect — an explicit connect() beside the implicit one a
    // queued request makes, or two requests after a drop — used to have the
    // second fail with CONNECTION_ALREADY_PENDING, its statement unsent.
    promise = this._connecting.then(noop);
  } else {
    promise = _startConnect.call(this);
  }

  return adaptPromise(promise, callback);
}

/** Open the connection: the one attempt every waiting caller shares. */
function _startConnect() {
  const promise = new Promise((resolve, reject) => {
    // A database name, user or password that cannot be sent is refused here,
    // before a socket is opened for it.
    try {
      OpenDatabasePacket.checkLoginFields(this);
    } catch (err) {
      return reject(err);
    }

    this.connectionPending = true;
    // Every host, and every retry, from the start. After one failed connect
    // used them all up, the host index pointed past the list and every later
    // connect threw a TypeError, even once the server was back.
    this.currentHostIndex = 0;
    this.connectionRetryCount = 0;
    // A socket left over from an attempt that failed.
    this._destroySocket(true);

    const attempt = ++this._connectAttempt;
    const stillWanted = () => attempt === this._connectAttempt;
    const interrupted = () => driverError('ABORTED', ErrorMessages.ERROR_ABORTED);

    _doGetBrokerPort.call(this)
      .then(() => (stillWanted() ? _doDatabaseLogin.call(this) : Promise.reject(interrupted())))
      .then(() => {
        if (!stillWanted()) {
          throw interrupted();
        }

        this.connectionPending = false;
        this.connectionOpened = true;
        resolve();
      })
      .catch((err) => {
        // close() or abort() has already put the state right if it was them.
        if (stillWanted()) {
          this.connectionPending = false;
          this.connectionOpened = false;
          this._destroySocket(true);
        }

        reject(err);
      });
  });

  this._connecting = promise;

  const forget = () => {
    if (this._connecting === promise) {
      this._connecting = undefined;
    }
  };

  promise.then(forget, forget);

  return promise;
}

/**
 * Get the server database engine version
 * @param callback
 */
CoraDBConnection.prototype.getEngineVersion = function (callback) {
  // Through the queue, like every other request. It used to go straight to
  // the socket, so asking for the version while a query was running stole
  // that query's reply — and every caller had to check the queue was empty
  // first, a check that could not be made safely.
  return new Promise((resolve, reject) => {
    this._queue.push(done => {
      const { fulfil, fail } = settle(resolve, reject, callback, done);

      _ensureConnected.call(this)
        .then(_getEngineVersion.bind(this))
        .then(version => {
          this.logger.debug(`Executing getEngineVersion: engineVersion = ${version}`);
          fulfil(version);
        })
        .catch(fail);
    }, dropped(reject, callback));
  });
};

/**
 * Execute SQL statements in batch mode
 * @param sqls
 * @param callback
 */
CoraDBConnection.prototype.batchExecuteNoQuery = function (sqls, callback) {
  return new Promise((resolve, reject) => {
    this._queue.push(done => {
      const { fulfil, fail } = settle(resolve, reject, callback, done);

      this.logger.debug('Executing batchExecuteNoQuery: sqls =', sqls);

      _ensureConnected.call(this)
        .then(() => _batchExecuteNoQuery.call(this, sqls))
        // The rows each statement changed, in order. They were parsed all
        // along and thrown away; the promise resolved with nothing.
        .then(counts => fulfil(counts))
        .catch(err => fail(Array.isArray(sqls) || err.statement !== undefined ? err : withStatement(err, sqls)));
    }, dropped(reject, callback));
  });
};

function _batchExecuteNoQuery(sqls) {
  if (!Array.isArray(sqls)) {
    sqls = [sqls]
  }

  if (!sqls.length) {
    return Promise.resolve([]);
  }

  return new Promise((resolve, reject) => {
    const batchExecuteNoQueryPacket = new BatchExecuteNoQueryPacket({
      autoCommit: this.autoCommitMode,
      casInfo: this._CASInfo,
      logger: this.logger,
      protocolVersion: this.brokerInfo.protocolVersion,
      sqls,
      // The query timeout goes with a batch too: it always went out as 0, so
      // setQueryTimeout() had no effect on execute() and batchExecuteNoQuery().
      timeout: this.queryTimeout,
    });
    const packetWriter = new PacketWriter(batchExecuteNoQueryPacket.getBufferLength());

    batchExecuteNoQueryPacket.write(packetWriter);

    let callback = (err, counts) => {
      // Propagate the error.
      if (err) {
        return reject(err);
      }

      resolve(counts || []);
    };

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseBatchExecuteBuffer.bind(this),
      dataPacket: batchExecuteNoQueryPacket
    }, callback);
  });
}

/**
 * Run a WRITE statement, or an array of them as one batch.
 *
 * Resolves with the number of rows the statement changed — or, for an array,
 * one count per statement. (It used to resolve with nothing.) The callback,
 * when given, receives `(err)` or `(undefined, count)`.
 *
 * @param sql a statement, or an array of statements
 * @param params optional values for `?` placeholders, formatted into the text
 *               (see `query()` for how each value is written)
 * @param callback optional node-style callback
 */
CoraDBConnection.prototype.execute = function execute(sql, params, callback) {
  let query;
  try {
    query = new Query(sql, params, callback);
  } catch (err) {
    return adaptPromise(Promise.reject(err), typeof params === 'function' ? params : callback);
  }

  // At debug, like every statement: with the values written into its text,
  // the SQL can hold personal data, which info-level logs (kept, shipped)
  // should not.
  this.logger.debug('execute', query.sql);

  const single = !Array.isArray(query.sql);
  const promise = this.shouldUseOldQueryProtocol()
    ? this.executeWithTypedParams(query.sql)
    : this.batchExecuteNoQuery(query.sql).then(counts => single ? (counts[0] === undefined ? 0 : counts[0]) : counts);

  return adaptPromise(promise, query.callback);
};

/**
 * Execute a WRITE statement with typed parameters.
 *
 * This is the recommended, injection-safe way to run WRITE statements with
 * dynamic values: each value in `params` is bound server-side according to the
 * matching CoraDB data type in `dataTypes`, so values are never concatenated
 * into the SQL text.
 *
 * @param sql the statement, using `?` placeholders for the bound values
 * @param params array of parameter values to bind
 * @param dataTypes array of CoraDB data types, one per value in `params`
 * @param callback optional node-style callback (err)
 * @return {*}
 */
CoraDBConnection.prototype.executeWithTypedParams = function (sql, params, dataTypes, callback) {
  return new Promise((resolve, reject) => {
    // Checked before anything is queued: one known type per value. A
    // misspelt type used to go out as UNKNOWN and corrupt the packet.
    let bound;
    try {
      bound = checkTyped(params, dataTypes);
    } catch (err) {
      return dropped(reject, callback)(withStatement(err, sql));
    }

    this._queue.push(done => {
      const { fulfil, fail } = settle(resolve, reject, callback, done);

      // The values are not logged, only how many there are and their types.
      this.logger.debug('Executing executeWithTypedParams: sql =', sql, '| params:', bound.values ? bound.values.length : 0, '| dataTypes =', bound.types);

      _executeWithReconnect.call(this, () => _ensureConnected.call(this)
        .then(() => prepareExecute.call(this, sql, bound.values, bound.types)))
        .then(response => {
          const affected = response.packet.totalTupleCount;

          // The prepared handle is closed here, in the same turn. It used to
          // stay open on the server until the connection closed — one per
          // call.
          return _closeQuery.call(this, response.queryHandle)
            .catch(noop)
            .then(() => fulfil(typeof affected === 'number' ? affected : 0));
        })
        .catch(err => fail(withStatement(err, sql)));
    }, dropped(reject, callback));
  });
};

/**
 * PREPARE and EXECUTE, prepared again (with the plan pinned) if the broker's
 * statement pooling dropped the handle in between — see _withStmtPoolingRetry.
 */
function prepareExecute(sql, paramValues, paramTypes, options) {
  return _withStmtPoolingRetry.call(this, (prepareFlag) =>
    _prepareExecuteOnce.call(this, sql, paramValues, paramTypes, Object.assign({}, options, { prepareFlag })));
}

function _prepareExecuteOnce(sql, paramValues, paramTypes, options) {
  this.logger.debug('Executing prepareExecute: sql =', sql, '| params:', paramValues ? paramValues.length : 0, '| paramTypes =', paramTypes);

  return new Promise((resolve, reject) => {
    if (Array.isArray(sql)) {
      return reject(driverError('MULTIPLE_QUERIES', ErrorMessages.ERROR_MULTIPLE_QUERIES));
    }

    const prepareExecutePacket = new PrepareExecutePacket({
      autoCommit: this.autoCommitMode,
      holdable: _holdable.call(this),
      casInfo: this._CASInfo,
      getGeneratedKeys: Boolean(options && options.getGeneratedKeys),
      logger: this.logger,
      paramTypes,
      prepareFlag: options && options.prepareFlag,
      queryAll: Boolean(options && options.queryAll),
      paramValues,
      protocolVersion: this.brokerInfo.protocolVersion,
      queryTimeout: this.queryTimeout,
      sql,
    });
    const packetWriter = new PacketWriter(prepareExecutePacket.getPrepareBufferLength());

    prepareExecutePacket.writePrepare(packetWriter);

    let callback = (err, result, queryHandle) => {
      if (err) {
        // Prepared, then the execute failed: the handle exists on the server
        // and nobody else knows it. Close it behind this request.
        const prepared = prepareExecutePacket.queryHandle;

        if (prepared !== undefined && this._queryResultSets[prepared] === prepareExecutePacket) {
          this._releaseHandle(prepared, prepareExecutePacket._generation);
        }

        return reject(err);
      }

      // Always an answer, and the handle always registered: a statement that
      // returns no rows still holds a handle on the server, which only
      // closeQuery() (or closing the connection) gives back. It used to
      // resolve with nothing, leaving that handle with no way to close it.
      resolve({
        queryHandle,
        result,
        packet: prepareExecutePacket,
        generation: prepareExecutePacket._generation,
      });
    };

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parsePrepareBufferForOldProtocol.bind(this),
      dataPacket: prepareExecutePacket
    }, callback);
  });
}

/**
 * PREPARE only: the statement compiled on the server and a handle for it,
 * executed later — as many times as wanted — by `_executePrepared`.
 * @private
 */
function _prepareOnly(sql, prepareFlag) {
  return new Promise((resolve, reject) => {
    const packet = new PrepareExecutePacket({
      prepareFlag,
      autoCommit: this.autoCommitMode,
      holdable: _holdable.call(this),
      casInfo: this._CASInfo,
      logger: this.logger,
      protocolVersion: this.brokerInfo.protocolVersion,
      sql,
    });
    const packetWriter = new PacketWriter(packet.getPrepareBufferLength());

    packet.writePrepare(packetWriter);

    const callback = (err) => (err ? reject(err) : resolve(packet));

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parsePrepareOnly.bind(this),
      dataPacket: packet
    }, callback);
  });
}

function _parsePrepareOnly(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parsePrepare(packetReader);

  if (error) {
    return this._callback(error);
  }

  // A prepared statement, not a result: commit() and rollback() leave it open
  // (see _closeResultHandles).
  dataPacket._isPrepared = true;
  _register.call(this, dataPacket.queryHandle, dataPacket);
  this._callback();
}

/**
 * PREPARE `prepared`'s statement again, into the same object, which other
 * code holds (a PreparedStatement): its handle, description and login are
 * replaced, and it is registered under the new handle — the JDBC driver's
 * UStatement.reset(). With `pinned`, the plan is pinned in the server's cache
 * (XASL_CACHE_PINNED, protocol V7 and later).
 * @private
 */
function _reprepare(prepared, pinned) {
  const old = prepared.queryHandle;
  const oldGeneration = prepared._generation;
  const flag = pinned ? CASConstants.CCIPrepareOption.CCI_PREPARE_XASL_CACHE_PINNED : 0;

  return _prepareOnly.call(this, prepared.options.sql, flag).then((fresh) => {
    const current = this._queryResultSets[old];

    // The old handle, if it is still ours: the server has dropped it.
    if (old !== fresh.queryHandle && current && current._isPrepared && current._generation === oldGeneration) {
      delete this._queryResultSets[old];
    }

    for (const field of PREPARED_FIELDS) {
      prepared[field] = fresh[field];
    }

    prepared._generation = fresh._generation;
    prepared._isPrepared = true;
    this._queryResultSets[fresh.queryHandle] = prepared;

    return prepared;
  });
}

/** CAS_ER_STMT_POOLING, in the new numbering or the old. */
function isStmtPoolingError(err) {
  return Boolean(err) && (err.code === -10024 || err.code === -1024);
}

/**
 * Run `run(prepareFlag)`, and again if it fails with CAS_ER_STMT_POOLING on a
 * broker with statement pooling — the server dropped the handle — as the JDBC
 * driver does in UStatement.execute(): once more, with the plan pinned, from
 * protocol V7; before V7, until it stops failing that way (here, at most
 * STMT_POOLING_RETRIES times).
 * @private
 */
function _withStmtPoolingRetry(run) {
  const pinned = Boolean(this.brokerInfo) && this.brokerInfo.protocolVersion >= 7;
  const flag = pinned ? CASConstants.CCIPrepareOption.CCI_PREPARE_XASL_CACHE_PINNED : 0;

  const attempt = (left) => run(left === null ? 0 : flag).catch((err) => {
    const pooling = Boolean(this.brokerInfo) && this.brokerInfo.statementPolling === 1;
    const remaining = left === null ? (pinned ? 1 : STMT_POOLING_RETRIES) : left;

    if (!pooling || !isStmtPoolingError(err) || remaining <= 0) {
      throw err;
    }

    this.logger.debug('CAS_ER_STMT_POOLING: preparing again');

    return attempt(remaining - 1);
  });

  return attempt(null);
}

const STMT_POOLING_RETRIES = 10;

/** The errors the JDBC driver reconnects after (UConnection.isErrorToReconnect()). */
const RECONNECT_SERVER_CODES = new Set([
  -111, // ER_TM_SERVER_DOWN_UNILATERALLY_ABORTED
  -199, // ER_NET_SERVER_CRASHED
  -224, // ER_OBJ_NO_CONNECT
  -677, // ER_BO_CONNECT_FAILED
]);

/**
 * A failure of the connection itself — JDBC's ER_COMMUNICATION and
 * ER_ILLEGAL_DATA_SIZE, and CAS_ER_COMMUNICATION — rather than of the
 * statement.
 */
function isCommunicationError(err) {
  if (!err) {
    return false;
  }

  return ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'CONNECTION_CLOSED', 'PROTOCOL_ERROR'].includes(err.code) ||
    err.code === -10003 || err.code === -1003;
}

function isErrorToReconnect(err) {
  return isCommunicationError(err) || (Boolean(err) && RECONNECT_SERVER_CODES.has(err.code));
}

/**
 * Run a statement, and run it again on a new connection if it failed with an
 * error the JDBC driver reconnects after — when it was the first statement of
 * its transaction, so nothing done before it is lost (UStatement.execute():
 * `!isActive() || isFirstExecInTran`). `run()` connects first if it has to.
 * Once; a second failure is the caller's.
 *
 * `onReconnect`, if given, runs before the second attempt (a prepared
 * statement is prepared again there).
 * @private
 */
function _executeWithReconnect(run, onReconnect) {
  const wasActive = this.connectionOpened && _transactionActive.call(this);
  const wasLost = this._transactionLost;
  // Not after the caller closed or aborted the connection meanwhile.
  const closes = this._closes;

  return run().catch((err) => {
    if (wasActive || wasLost || closes !== this._closes || !isErrorToReconnect(err)) {
      throw err;
    }

    this.logger.debug('Reconnecting after', err.code, 'to run the statement again');

    // A new CAS: the socket goes (it is already gone after a communication
    // error), unless the broker reconnects to the server by itself.
    const flags = this.brokerInfo ? this.brokerInfo.functionFlag || 0 : 0;

    if (this.connectionOpened &&
        (isCommunicationError(err) || (flags & CASConstants.CAS_RECONNECT_WHEN_SERVER_DOWN) === 0)) {
      _dropConnection.call(this);
    }

    // Nothing was pending: a session lost now lost no work.
    this._transactionLost = false;

    return Promise.resolve(onReconnect ? onReconnect() : undefined).then(run);
  });
}

/**
 * Let the connection go without failing the requests waiting behind the one
 * running: it is about to be opened again for that one.
 * @private
 */
function _dropConnection() {
  this.connectionOpened = false;
  this.connectionPending = false;
  this._queryResultSets = {};
  this._destroySocket(true);
}

/**
 * Whether results are asked to stay open across a commit: when the broker
 * supports it (or speaks protocol V2), as the JDBC driver asks by default
 * (HOLD_CURSORS_OVER_COMMIT, `UConnection.supportHoldableResult()`).
 * @private
 */
function _holdable() {
  const info = this.brokerInfo;

  return Boolean(info) && (
    ((info.functionFlag || 0) & CASConstants.CAS_SUPPORT_HOLDABLE_RESULT) !== 0 || info.protocolVersion === 2
  );
}

/** What an execute needs to know about the statement it runs. */
const PREPARED_FIELDS = ['queryHandle', 'resultCacheLifetime', 'statementType', 'bindCount', 'isUpdatable', 'columnCount', 'infoArray'];

/**
 * EXECUTE a handle `_prepareOnly` prepared, with these values. Resolves with a
 * packet of its own, which is also what `fetch()` reads further rows through.
 * @private
 */
function _executePrepared(prepared, paramValues, paramTypes) {
  return new Promise((resolve, reject) => {
    const packet = new PrepareExecutePacket({
      autoCommit: this.autoCommitMode,
      holdable: _holdable.call(this),
      casInfo: this._CASInfo,
      logger: this.logger,
      paramTypes,
      paramValues,
      protocolVersion: this.brokerInfo.protocolVersion,
      queryTimeout: this.queryTimeout,
      sql: prepared.options.sql,
    });

    for (const field of PREPARED_FIELDS) {
      packet[field] = prepared[field];
    }

    const packetWriter = new PacketWriter(packet.getExecuteBufferLength());

    packet.writeExecute(packetWriter);

    const callback = (err) => (err ? reject(err) : resolve(packet));

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseExecutePrepared.bind(this),
      dataPacket: packet
    }, callback);
  });
}

function _parseExecutePrepared(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parseExecute(packetReader);

  if (error) {
    return this._callback(error);
  }

  // Still the prepared statement's handle (see _parsePrepareOnly).
  dataPacket._isPrepared = true;
  _register.call(this, dataPacket.queryHandle, dataPacket);
  this._callback();
}

/**
 * The `data` handler for one reply on `socket`: gathers the bytes the reply's
 * length says are coming, then hands them to the parser.
 *
 * Anything a parser throws — a reply this driver cannot read — is caught
 * here. It used to escape the socket's event handler as an uncaught
 * exception, which ended the whole process (the web server with it). Now the
 * request waiting on it is failed with PROTOCOL_ERROR, and the socket, whose
 * stream can no longer be trusted, is destroyed.
 */
function _receiveBytes(socket, options, cb) {
  this._callback = cb;
  this._parserOptions = options;
  this._parserFunction = options.parserFunction;
  this._totalBuffLength = 0;
  this._buffArr = [];
  this._expectedResponseLength = this._INVALID_RESPONSE_LENGTH;

  return (data) => {
    // A socket this connection has moved on from.
    if (this._socket !== socket) {
      return;
    }

    try {
      _receiveData.call(this, data);
    } catch (err) {
      _protocolFailure.call(this, socket, err);
    }
  };
}

function _receiveData(data) {
  this._totalBuffLength += data.length;
  this._buffArr.push(data);

  if (this._expectedResponseLength === this._INVALID_RESPONSE_LENGTH &&
        this._totalBuffLength >= DATA_TYPES.DATA_LENGTH_SIZEOF) {
    if (this._buffArr.length > 1) {
      // For later, use this already concatenated buffer.
      this._buffArr = [Buffer.concat(this._buffArr, this._totalBuffLength)];
    }

    this._expectedResponseLength = Helpers._getExpectedResponseLength(this._buffArr[0]);
  }

  // If we have received all the expected data, start parsing it.
  // `>=`, not `===`: on over-delivery the exact test is never true again and,
  // with no request timeout, the request would never settle.
  if (this._expectedResponseLength !== this._INVALID_RESPONSE_LENGTH &&
        this._totalBuffLength >= this._expectedResponseLength) {
    _parseBuffer.call(this);
  }
}

function _parseBuffer() {
  this._socket.removeAllListeners('data');

  const callback = this._callback;
  const packetReader = new PacketReader();
  const reply = Buffer.concat(this._buffArr, this._totalBuffLength);

  packetReader.write(reply);
  this._buffArr = [];

  // The CAS info at the head of the reply: kept, and sent back with the next
  // request, as the JDBC driver does (UInputBuffer). It was the login's for
  // ever.
  if (reply.length >= DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE) {
    this._CASInfo = Buffer.from(reply.subarray(DATA_TYPES.DATA_LENGTH_SIZEOF, DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE));
  }

  _readErrorsAsJdbc.call(this, packetReader, this._CASInfo);

  // The reply is in: nothing waits on the socket any more, unless the parser
  // sends a follow-up request (which registers its own callback). A socket
  // that closes while the connection is idle then fails nobody.
  this._socketCurrentEventCallback = undefined;

  try {
    this._parserFunction(packetReader);
  } catch (err) {
    if (!this._socketCurrentEventCallback) {
      this._socketCurrentEventCallback = callback;
    }

    throw err;
  }
}

/**
 * How an error in this reply is read, as the JDBC driver reads it
 * (UInputBuffer):
 *
 *  - before the login is answered, a CAS error above -10000 (and -1018) is
 *    in the old numbering, and is moved to the new one (UClientSideConnection
 *    connectDB());
 *  - after it, unless the broker says it sends the renewed codes, a CAS
 *    error (indicator -1) and -1018 are moved likewise (convertErrorByVersion);
 *  - when the broker reconnects to a server that went down and this reply
 *    flags a new session id, the error message ends with that id, which
 *    replaces the one the next login sends.
 * @private
 */
function _readErrorsAsJdbc(packetReader, casInfo) {
  const info = this.connectionOpened ? this.brokerInfo : undefined;
  const flags = info ? info.functionFlag || 0 : 0;

  if (!info) {
    packetReader.errorCodes = 'login';
  } else if (info.protocolVersion !== 2 && (flags & CASConstants.CAS_RENEWED_ERROR_CODE) === 0) {
    packetReader.errorCodes = 'old';
  }

  if ((flags & CASConstants.CAS_RECONNECT_WHEN_SERVER_DOWN) !== 0 &&
      casInfo && (casInfo[CASConstants.CAS_INFO_ADDITIONAL_FLAG] & CASConstants.CAS_INFO_FLAG_MASK_NEW_SESSION_ID) !== 0) {
    packetReader.sessionIdInError = true;
    packetReader.onNewSessionId = (session) => {
      this._session = session;
    };
  }
}

/** A reply that could not be read: fail its request, and drop the socket. */
function _protocolFailure(socket, err) {
  this.logger.error('Could not read a reply from the server:', err && err.message);

  if (!this._socketCurrentEventCallback) {
    this._socketCurrentEventCallback = this._callback;
  }

  _onSocketGone.call(this, socket, driverError(
    'PROTOCOL_ERROR',
    `${ErrorMessages.ERROR_PROTOCOL} (${err && err.message})`,
    { cause: err }
  ));
}

/**
 * Remember an open handle, stamped with the login it belongs to (see
 * `_generation`).
 */
function _register(queryHandle, packet) {
  packet._generation = this._generation;
  this._queryResultSets[queryHandle] = packet;
}

function _parseBufferForNewProtocol(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parse(packetReader);

  if (error) {
    return this._callback(error);
  }

  const queryHandle = dataPacket.queryHandle;

  _register.call(this, queryHandle, dataPacket);

  this._callback(undefined, dataPacket.resultSet, queryHandle);
}

function _parsePrepareBufferForOldProtocol(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;

  const error = dataPacket.parsePrepare(packetReader);

  if (error) {
    return this._callback(error);
  }

  // Known from here on, so it can be closed whatever the execute does.
  _register.call(this, dataPacket.queryHandle, dataPacket);

  _parseExecuteForOldProtocol.call(this);
}

function _parseExecuteForOldProtocol() {
  const dataPacket = this._parserOptions.dataPacket;
  const packetWriter = new PacketWriter(dataPacket.getExecuteBufferLength());

  dataPacket.writeExecute(packetWriter);

  _send.call(this, packetWriter._buffer, {
    parserFunction: _parseExecuteBufferForOldProtocol.bind(this),
    dropDataPacket: this._parserOptions.dropDataPacket,
    dataPacket: dataPacket
  }, this._callback);
}

function _parseExecuteBufferForOldProtocol(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parseExecute(packetReader);

  if (error) {
    return this._callback(error);
  }

  const queryHandle = dataPacket.queryHandle;

  _register.call(this, queryHandle, dataPacket);

  this._callback(undefined, dataPacket.resultSet, queryHandle);
}

function _parseFetchBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  // The packet that owns the handle, captured when the fetch was sent: the
  // table may have been cleared since (a session lost meanwhile).
  const error = dataPacket.parse(packetReader, this._parserOptions.queryPacket);

  this._callback(error, dataPacket.resultSet);
}

function _parseBatchExecuteBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  // CAS error.
  let error = dataPacket.parse(packetReader);

  if (!error) {
    // Individual per-statement SQL errors. A batch can fail on more than one
    // statement, so wrap them in a single AggregateError (a real Error, never
    // a bare array) that exposes the individual errors via its `errors`
    // property.
    if (dataPacket.errors.length) {
      // Still an AggregateError, with the same message; each entry now names
      // its statement and position, and `results` has the rows changed by
      // every statement that did run (null where one failed).
      error = new CoraDBBatchError(
        dataPacket.errors,
        `${dataPacket.errors.length} statement(s) in the batch failed`,
        dataPacket.counts
      );
    }
  }

  this._callback(error, error ? undefined : dataPacket.counts);
}

function _parseDatabaseLoginBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parse(packetReader);

  if (!error) {
    // A new session: a new login generation, and none of the old session's
    // handles. A new session hands out handle numbers from 1 again, so an old
    // handle kept here would name whatever the new session put under it.
    this._generation += 1;
    this._queryResultSets = {};
    this._CASInfo = dataPacket.casInfo;
    this.sessionId = dataPacket.sessionId;
    // The CAS id, and the 20-byte session id the next login sends back so
    // that a reconnect resumes this session, as the JDBC driver does.
    this.casId = dataPacket.casId;
    this._session = dataPacket.session;
    this.brokerInfo = dataPacket.brokerInfo;
    // A new session starts in auto-commit — unless the caller already chose
    // otherwise. `beginTransaction()` before the first request (which is what
    // connects) used to be silently undone here: begin, delete, rollback, and
    // the rows were gone, committed. The same held after any reconnect.
    this.autoCommitMode = this._autoCommitChosen === undefined ? this.AUTOCOMMIT_ON : this._autoCommitChosen;
    // What `cancel()` needs, captured while we have it. The cancel goes on a
    // socket of its own, so the process to name and the address to name it at
    // both have to outlive the login.
    //
    // The process id is the login response code — not `sessionId`, which is a
    // different number the listener does not know. The address is where this
    // connection is actually served: the broker hands the client on to a CAS
    // port at the client-info exchange, and `connectionBrokerPort` is that
    // port. Only when the broker kept the connection itself (port 0) is the
    // host's own port the right one.
    const loginHost = this.hosts[this.currentHostIndex];

    this._casProcessId = dataPacket.responseCode;
    this._cancelHost = {
      host: loginHost.host,
      port: this.connectionBrokerPort > 0 ? this.connectionBrokerPort : loginHost.port,
    };
  }

  this._callback(error);
}

function _parseEngineVersionBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parse(packetReader);

  this._callback(error, dataPacket.engineVersion);
}

function _parseCloseQueryBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parse(packetReader);

  this._callback(error);
}

function _parseResponseCodeBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parse(packetReader);

  this._callback(error);
}

function _parseGetSchemaBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parseRequestSchema(packetReader);

  if (error) {
    return this._callback(error);
  }

  _parseWriteFetchSchema.call(this);
}

function _parseWriteFetchSchema() {
  let dataPacket = this._parserOptions.dataPacket,
    packetWriter = new PacketWriter(dataPacket.getFetchSchemaBufferLength());

  dataPacket.writeFetchSchema(packetWriter);

  _send.call(this, packetWriter._buffer, {
    parserFunction: _parseFetchSchemaBuffer.bind(this),
    dataPacket: dataPacket
  }, this._callback);
}

function _parseFetchSchemaBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parseFetchSchema(packetReader);

  // Rows still to come: fetch the rest, in the same request.
  if (!error && dataPacket.needsMoreRows()) {
    return _parseWriteFetchSchema.call(this);
  }

  this._callback(error, error ? undefined : (dataPacket.schemaInfo || []));
}

function _parseLobNewBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parse(packetReader);

  this._callback(error, dataPacket.result);
}

CoraDBConnection.prototype.queryAll = function (sql, params, callback) {
  let query;
  try {
    query = new Query(sql, params, callback);
  } catch (err) {
    return adaptPromise(Promise.reject(err), typeof params === 'function' ? params : callback);
  }

  const promise = this
    .query(query.sql)
    .then(response => {
      const result = response.result;
      const handle = response._handle;
      // The rest of the rows, and the close, are for this handle in this
      // session only: if the session is lost in between, the number may be
      // another statement's by the time they run.
      const generation = response._generation;

      // A statement without a result (an UPDATE, a SAVEPOINT, a SET) has
      // nothing to fetch: its handle is closed, and it resolves with an empty
      // result. Fetching for it used to go on for ever.
      if (!result) {
        return this._releaseHandle(handle, generation).then(() => emptyResult());
      }

      return this
        ._fetchFor(handle, /* fetch all */true, generation)
        .then(res => {
          const extraValues = res.result && res.result.ColumnValues || undefined;

          if (extraValues) {
            const len = extraValues.length;
            // A first reply without rows (a CALL's) still gets a list to
            // add them to.
            let values = result.ColumnValues || (result.ColumnValues = []);

            for (let i = 0; i < len; ++i) {
              values.push(extraValues[i]);
            }
          }

          // Auto close the query statement because we have already
          // retrieved all the values.
          return this._releaseHandle(handle, generation);
        }, err => {
          // A failed fetch must not leave the handle allocated on the server:
          // close it, then report the fetch's own error.
          return this._releaseHandle(handle, generation).then(() => { throw err; });
        })
        // Return only the result without the query handle.
        .then(() => result);
    });

  return adaptPromise(promise, query.callback);
};

/** What `queryAll()` resolves with for a statement that returns no rows. */
function emptyResult() {
  return {
    ColumnDataTypes: [],
    ColumnNames: [],
    ColumnValues: [],
    RowsCount: 0,
  };
}

CoraDBConnection.prototype.queryAllAsObjects = function (sql, params, callback) {
  let query;
  try {
    query = new Query(sql, params, callback);
  } catch (err) {
    return adaptPromise(Promise.reject(err), typeof params === 'function' ? params : callback);
  }

  return adaptPromise(
    this.queryAll(query.sql).then(getObjects),
    query.callback
  );
};

function getObjects(result) {
  // A statement with no result set (an UPDATE, an INSERT) has no rows. It used
  // to throw a TypeError here, after the server had opened a handle the
  // caller then never got back to close.
  if (!result || !Array.isArray(result.ColumnNames) || !Array.isArray(result.ColumnValues)) {
    return [];
  }

  const columnNames = result.ColumnNames;
  const columnValues = result.ColumnValues;
  const rowsCount = result.ColumnValues.length;
  const colCount = columnNames.length;

  let arr = new Array(rowsCount);

  for (let i = 0; i < rowsCount; ++i) {
    let row = arr[i] = {};

    let columns = columnValues[i];

    for (let j = 0; j < colCount; ++j) {
      row[columnNames[j]] = columns[j];
    }
  }

  return arr;
}

CoraDBConnection.prototype.queryAsObjects = function (sql, params, callback) {
  // Like `query()`: the first batch of rows, and the handle left open for
  // `fetch()` and `closeQuery()`. `queryAllAsObjects()` or `sql()` read every
  // row and close the handle.
  let query;
  try {
    query = new Query(sql, params, callback);
  } catch (err) {
    return adaptPromise(Promise.reject(err), typeof params === 'function' ? params : callback);
  }

  const promise = this
    .query(query.sql)
    .then(response => ({
      queryHandle: response.queryHandle,
      result: getObjects(response.result),
    }));

  if (typeof query.callback === 'function') {
    // One call, with (err) or (undefined, rows, queryHandle). It used to be
    // able to call twice — once with the rows and again with any exception
    // the first call threw — and resolved even when the query failed.
    promise.then(
      r => invoke(query.callback, [undefined, r.result, r.queryHandle]),
      err => invoke(query.callback, [err])
    );
  }

  return promise;
};

/**
 * Execute a READ query.
 *
 * Security note: prefer passing untrusted values through `params` (bound to
 * the `?` placeholders and escaped by the driver) rather than concatenating
 * them into `sql`. For the strongest guarantees, bind values on the server:
 * `sql()`, `prepare()`, or `executeWithTypedParams()`.
 *
 * How `params` are written into the text: NULL for null/undefined; numbers
 * and bigints bare, negative ones in parentheses (`(-5)`, so `bal-?` can never
 * become a `--` comment); booleans as 1/0; a Date as a quoted UTC DATETIME
 * with three-digit milliseconds; anything else as a single-quoted string with
 * `'` doubled and nothing else escaped — backslashes are ordinary characters
 * under CoraDB's default `no_backslash_escapes=yes`. On a server configured
 * with `no_backslash_escapes=no`, bind on the server instead. A `?` inside a
 * string, a quoted identifier or a comment (`--`, `//`, `/* *\/`) is not a
 * placeholder. A NUL character in a string, or a number that is not finite, is
 * refused with INVALID_PARAMETER.
 *
 * With `{ getGeneratedKeys: true }`, as `executeUpdate(sql,
 * RETURN_GENERATED_KEYS)` in the JDBC driver: the INSERT is sent without
 * auto-commit, its keys read at once, its handle closed and — in auto-commit
 * mode — the work committed, all before this resolves. The response has the
 * keys as `generatedKeys`; `getGeneratedKeys(queryHandle)` returns them too.
 *
 * @param sql a single READ query, optionally containing `?` placeholders
 * @param params value or array of values bound to the `?` placeholders
 * @param callback optional node-style callback (err, result, queryHandle)
 * @param options optional `{ getGeneratedKeys: true }`
 */
CoraDBConnection.prototype.query = function (sql, params, callback, options) {
  // `query(sql, params, options)`: the options where the callback would be.
  if (callback !== null && typeof callback === 'object' && options === undefined) {
    options = callback;
    callback = undefined;
  }

  return new Promise((resolve, reject) => {
    // Built before the request is queued, not inside its slot: the Query is
    // what works out which argument is the callback, and a request dropped
    // before it runs (close, abort) has to answer that callback. Formatting
    // the SQL can also throw — a parameter of a type it cannot escape — and
    // a throw inside a queue slot would leave the queue unable to move.
    let query;
    try {
      query = new Query(sql, params, callback);
    } catch (err) {
      return dropped(reject, typeof params === 'function' ? params : callback)(err);
    }

    this._queue.push(done => {
      const { fulfil, fail } = settle(resolve, reject, query.callback, done);

      this.logger.debug('query', query.sql);

      _executeWithReconnect.call(this, () => _ensureConnected.call(this)
        .then(() => {
          if (this.shouldUseOldQueryProtocol()) {
            return prepareExecute.call(this, query.sql, undefined, undefined, options);
          }

          return _queryNewProtocol.call(this, query.sql, options);
        }))
        .then(r => _withFirstRows.call(this, r))
        .then(r => (options && options.getGeneratedKeys ? _completeGeneratedKeys.call(this, r) : r))
        .then(r => {
          const response = { queryHandle: toPublicHandle(r.queryHandle, r.generation), result: r.result };

          // The server's number and the login it belongs to, for queryAll()
          // to fetch and close it by (not enumerable: the response's shape is
          // unchanged).
          Object.defineProperty(response, '_handle', { value: r.queryHandle });
          Object.defineProperty(response, '_generation', { value: r.generation });

          if (r.generatedKeys !== undefined) {
            response.generatedKeys = r.generatedKeys;
            // For getGeneratedKeys(queryHandle) and closeQuery(queryHandle),
            // which answer from here: the handle is already closed.
            this._generatedKeys.set(response.queryHandle, r.generatedKeys);
          }

          fulfil(response, response.result, response.queryHandle);
        })
        .catch(err => fail(withStatement(err, query.sql)));
    }, dropped(reject, query.callback));
  });
};

/**
 * A statement run with `{ getGeneratedKeys: true }`, completed the way the
 * JDBC driver completes `executeUpdate(sql, RETURN_GENERATED_KEYS)`, in the
 * same queue slot as the statement:
 *
 *   1. it was sent without auto-commit (see ExecuteQueryPacket), so the CAS
 *      still has its keys;
 *   2. for an INSERT, the keys are read at once (GET_GENERATED_KEYS);
 *   3. the handle is closed;
 *   4. in auto-commit mode, the work is committed (END_TRAN COMMIT) — the
 *      commit JDBC sends itself (`turnOnAutoCommitBySelf()`).
 *
 * The call then resolves with the work committed and the keys in hand, as
 * JDBC's does. If reading the keys fails, the handle is still closed and the
 * INSERT still committed (in auto-commit mode), and the call fails with that
 * error.
 * @private
 */
function _completeGeneratedKeys(r) {
  const packet = r.packet;
  const isInsert = Boolean(packet) && packet.statementType === CASConstants.CoraDBStatementType.CORADB_STMT_INSERT;
  let keysError;

  const keys = isInsert
    ? _getGeneratedKeys.call(this, r.queryHandle).catch((err) => {
      keysError = err;
    })
    : Promise.resolve(undefined);

  return keys
    .then((generatedKeys) => {
      r.generatedKeys = generatedKeys;

      return _closeQuery.call(this, r.queryHandle).catch(noop);
    })
    .then(() => (this.autoCommitMode && this.connectionOpened ? _sendCommit.call(this) : undefined))
    .then(() => {
      if (keysError) {
        throw keysError;
      }

      return r;
    });
}

/**
 * Whether the CAS says a transaction is open: the status byte of the CAS info
 * of its last reply (UConnection.isActive()).
 * @private
 */
function _transactionActive() {
  const casInfo = this._CASInfo;

  return Boolean(casInfo) && casInfo[CASConstants.CAS_INFO_STATUS] === CASConstants.CAS_INFO_STATUS_ACTIVE;
}

/**
 * Close the open results, one at a time, before the transaction ends — as the
 * JDBC driver completes its statements: every result before a rollback
 * (completeAllStatements()), and before a commit only those that would not
 * stay open across it (completeStatementForCommit(); none when results are
 * holdable, see _holdable). Prepared statements stay open.
 * @private
 */
function _closeResultHandles(forCommit) {
  if (forCommit && _holdable.call(this)) {
    return Promise.resolve();
  }

  let chain = Promise.resolve();

  for (const queryHandle of Object.keys(this._queryResultSets)) {
    const packet = this._queryResultSets[queryHandle];

    if (packet && !packet._isPrepared) {
      // Remembered by the caller's number: a closeQuery() of it afterwards
      // succeeds, as closing a closed ResultSet does in JDBC.
      this._endedHandles.add(toPublicHandle(Number(queryHandle), packet._generation));
      chain = chain.then(() => _closeQuery.call(this, queryHandle).catch(noop));
    }
  }

  return chain;
}

/**
 * END_TRAN COMMIT, sent at once: the caller holds the queue slot. Only when the
 * CAS says a transaction is open, as the JDBC driver sends it
 * (UClientSideConnection.endTransaction()); otherwise there is nothing to
 * commit, and nothing is sent.
 */
function _sendCommit() {
  if (!_transactionActive.call(this)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const commitPacket = new CommitPacket({ casInfo: this._CASInfo });
    const packetWriter = new PacketWriter(commitPacket.getBufferLength());

    commitPacket.write(packetWriter);

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseResponseCodeBuffer.bind(this),
      dataPacket: commitPacket,
    }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * The first batch of a result whose EXECUTE reply carried none. A CALL's or an
 * EVALUATE's value is not sent with the reply but fetched, and `query()` —
 * which hands out the first batch — resolved with no rows and a row count of
 * 1. Fetched here, in the same queue slot; if that fails, the handle (which
 * the caller never sees) is closed.
 * @private
 */
function _withFirstRows(r) {
  const packet = r.packet;
  const result = r.result;

  if (!result || !packet || (result.ColumnValues && result.ColumnValues.length > 0) ||
      !(packet.currentTupleCount < packet.totalTupleCount)) {
    return Promise.resolve(r);
  }

  return _fetch.call(this, r.queryHandle, false, r.generation).then(f => {
    const rows = f.result && f.result.ColumnValues;
    const values = result.ColumnValues || (result.ColumnValues = []);

    for (let i = 0, len = rows ? rows.length : 0; i < len; ++i) {
      values.push(rows[i]);
    }

    return r;
  }, err => {
    this._releaseHandle(r.queryHandle, r.generation);
    throw err;
  });
}

function _queryNewProtocol(sql, options) {
  this.logger.debug('Executing _queryNewProtocol');

  return new Promise((resolve, reject) => {
    const executeQueryPacket = new ExecuteQueryPacket({
      autoCommit: this.autoCommitMode,
      holdable: _holdable.call(this),
      casInfo: this._CASInfo,
      getGeneratedKeys: Boolean(options && options.getGeneratedKeys),
      logger: this.logger,
      protocolVersion: this.brokerInfo.protocolVersion,
      queryTimeout: this.queryTimeout,
      sql,
    });
    const packetWriter = new PacketWriter(executeQueryPacket.getBufferLength());

    executeQueryPacket.write(packetWriter);

    let callback = (err, result, queryHandle) => {
      if (err) {
        return reject(err);
      }

      resolve({
        queryHandle,
        result,
        packet: executeQueryPacket,
        generation: executeQueryPacket._generation,
      });
    };

    _send.call(this, packetWriter._buffer, {
      sql: sql,
      parserFunction: _parseBufferForNewProtocol.bind(this),
      dataPacket: executeQueryPacket
    }, callback);
  });
}

/**
 * Fetch query next rows results.
 *
 * A handle lives as long as the session that opened it: on a connection that
 * has lost its session since, this fails with NO_ACTIVE_QUERY rather than
 * reconnecting (a new session has no such handle — or, worse, has another
 * statement under the same number).
 * @param queryHandle
 * @param callback
 */
CoraDBConnection.prototype.fetch = function (queryHandle, all, callback) {
  // Normalised before queueing, so a request dropped before it runs still
  // reaches the callback (see `dropped`).
  if (typeof all === 'function') {
    callback = all;
    all = false;
  }

  const h = fromPublicHandle(queryHandle);

  return _fetchQueued.call(this, h.handle, all, h.generation, callback, true);
};

/**
 * `fetch()` for a handle known to come from login `generation`: refused if
 * the handle now in the table under that number is from another login.
 * @private
 */
CoraDBConnection.prototype._fetchFor = function (queryHandle, all, generation) {
  return _fetchQueued.call(this, queryHandle, all, generation);
};

/**
 * NEXT_RESULT for a handle from login `generation`: the handle moves on to
 * the next result of the statements it ran together, and the packet that
 * describes that result replaces the handle's entry, so the ordinary fetch
 * reads its rows. Resolves with that packet. Queued like a fetch.
 * @private
 */
CoraDBConnection.prototype._nextResultFor = function (queryHandle, generation) {
  return new Promise((resolve, reject) => {
    this._queue.unshift(done => {
      const { fulfil, fail } = settle(resolve, reject, undefined, done);
      const current = this.connectionOpened ? this._queryResultSets[queryHandle] : undefined;

      if (!current || current._generation !== generation || this._generation !== generation) {
        const ended = !this.connectionOpened || this._generation !== generation;

        return fail(driverError(
          'NO_ACTIVE_QUERY',
          ended ? ErrorMessages.ERROR_HANDLE_SESSION_ENDED : ErrorMessages.ERROR_NO_ACTIVE_QUERY
        ));
      }

      this.logger.debug(`nextResult: queryHandle = ${queryHandle}`);

      const packet = new NextResultPacket({ casInfo: this._CASInfo, logger: this.logger, queryHandle });
      const packetWriter = new PacketWriter(packet.getBufferLength());

      packet.write(packetWriter);

      _send.call(this, packetWriter._buffer, {
        parserFunction: _parseNextResultBuffer.bind(this),
        dataPacket: packet,
      }, (err) => (err ? fail(err) : fulfil(packet)));
    }, dropped(reject), handleKey(queryHandle));
  });
};

function _parseNextResultBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parse(packetReader);

  if (error) {
    return this._callback(error);
  }

  _register.call(this, dataPacket.queryHandle, dataPacket);

  this._callback(undefined, dataPacket);
}

/**
 * What a handle's fetches and close queue under: they jump the queue (a fetch
 * goes ahead of statements queued after the query), but keep their order
 * among themselves (see `Queue.unshift`).
 */
function handleKey(queryHandle) {
  return `handle:${Number(queryHandle)}`;
}

/*
 * The handle numbers callers get (from query(), queryAsObjects(), fetch())
 * carry the login they came from. A new session numbers its statements from 1
 * again, so a bare server number kept across a reconnect named whatever the
 * new session had put under it: fetch() read another statement's rows,
 * closeQuery() closed it, getGeneratedKeys() asked for its keys.
 *
 * The first login's handles are the server's numbers as they are; each later
 * login's are offset by HANDLE_SPAN (far above the number of statements a CAS
 * keeps open). fetch(), closeQuery(), getMetaData() and getGeneratedKeys()
 * take them apart again and refuse one from another login.
 */
const HANDLE_SPAN = 0x100000;

function toPublicHandle(serverHandle, generation) {
  if (!(generation > 1) || !Number.isSafeInteger(serverHandle) || serverHandle < 0 || serverHandle >= HANDLE_SPAN) {
    return serverHandle;
  }

  return (generation - 1) * HANDLE_SPAN + serverHandle;
}

/**
 * A caller's handle as `{ handle, generation }`: the server's number and the
 * login it is from. Anything that is not a handle number is kept as it is,
 * with no login, for the lookup to miss.
 */
function fromPublicHandle(queryHandle) {
  const n = typeof queryHandle === 'number' || typeof queryHandle === 'string' ? Number(queryHandle) : NaN;

  if (!Number.isSafeInteger(n) || n < 0 || (typeof queryHandle === 'string' && queryHandle.trim() === '')) {
    return { handle: queryHandle, generation: undefined };
  }

  return { handle: n % HANDLE_SPAN, generation: Math.floor(n / HANDLE_SPAN) + 1 };
}

/**
 * Whether a caller's handle is from a login other than the current one (the
 * session it was opened in has ended).
 */
function fromEndedSession(h) {
  return h.generation !== undefined && this.connectionOpened && h.generation !== this._generation;
}

function _fetchQueued(queryHandle, all, generation, callback, publicHandle) {
  return new Promise((resolve, reject) => {
    this._queue.unshift(done => {
      const query = new Query(callback);
      const { fulfil, fail } = settle(resolve, reject, query.callback, done);

      this.logger.info(`fetch: queryHandle = ${queryHandle}`);

      _fetch.call(this, queryHandle, all, generation)
        .then(response => {
          if (publicHandle) {
            response.queryHandle = toPublicHandle(response.queryHandle, generation);
          }

          fulfil(response, response.result, response.queryHandle);
        })
        .catch(fail);
    }, dropped(reject, callback), handleKey(queryHandle));
  });
}

function _fetch(queryHandle, all, generation) {
  return new Promise((resolve, reject) => {
    const packet = this.connectionOpened ? this._queryResultSets[queryHandle] : undefined;
    let results = null;

    if (!packet || (generation !== undefined && packet._generation !== generation)) {
      const ended = !this.connectionOpened || (generation !== undefined && generation !== this._generation);

      return reject(driverError(
        'NO_ACTIVE_QUERY',
        ended ? ErrorMessages.ERROR_HANDLE_SESSION_ENDED : ErrorMessages.ERROR_NO_ACTIVE_QUERY
      ));
    }

    // A statement without a result (an UPDATE, a SAVEPOINT, ...) has no rows
    // to fetch. Its count of changed rows used to be taken for a row count,
    // and `queryAll()` asked the server for the missing rows for ever.
    if (!packet.resultSet) {
      return resolve({
        queryHandle,
        result: null,
      });
    }

    let fetchSome = (err, result) => {
      if (err) {
        return reject(err);
      }

      // A batch with no rows in it: the server has no more, whatever the
      // total said. Asking again would only get the same answer.
      if (result && (!result.ColumnValues || result.ColumnValues.length === 0)) {
        return resolve({
          queryHandle,
          result: results || result,
        });
      }

      if (result) {
        // If we could fetch some data, add them to the existing list.
        if (results) {
          let values = results.ColumnValues;
          const extraValues = result.ColumnValues;

          for (let i = 0, len = extraValues.length; i < len; ++i) {
            values.push(extraValues[i]);
          }
        } else {
          results = result;
        }
      }

      // If there is no more data left to fetch, return what we could retrieve.
      // Or we have received the first batch of results and the user
      // has not requested to retrieve all values, then return what
      // we have.
      if (!(packet.currentTupleCount < packet.totalTupleCount) || results && !all) {
        return resolve({
          queryHandle,
          result: results,
        });
      }

      const fetchPacket = new FetchPacket({
        casInfo: this._CASInfo,
        logger: this.logger,
      });
      const packetWriter = new PacketWriter(fetchPacket.getBufferLength());

      fetchPacket.write(packetWriter, packet);

      _send.call(this, packetWriter._buffer, {
        queryHandle,
        queryPacket: packet,
        parserFunction: _parseFetchBuffer.bind(this),
        dataPacket: fetchPacket
      }, fetchSome);
    };

    fetchSome(undefined, null);
  });
}

/**
 * Close query. It is important to close every query because CoraDB Broker
 * (CAS actually that was assigned to this connection by the Broker) will
 * keep the memory occupied by the query. The query statement resources
 * will get closed automatically only on disconnection. Until then the
 * query resources will be kept in memory. If not released on time, OOM
 * (Out Of Memory) issue can be caused on the server side.
 * @param queryHandle
 * @param callback
 */
CoraDBConnection.prototype.closeQuery = function (queryHandle, callback) {
  // A statement run with `{ getGeneratedKeys: true }`: its handle was closed
  // before query() resolved; only its keys are forgotten. And a result the end
  // of a transaction closed (see _closeResultHandles): nothing left to do.
  if (this._generatedKeys.delete(Number(queryHandle)) || this._endedHandles.delete(Number(queryHandle))) {
    return adaptPromise(Promise.resolve(), callback);
  }

  const h = fromPublicHandle(queryHandle);

  return new Promise((resolve, reject) => {
    this._queue.unshift(done => {
      const { fulfil, fail } = settle(resolve, reject, callback, done);

      this.logger.debug(`Executing closeQuery: queryHandle = ${queryHandle}`);

      // No reconnect for this: a handle does not outlive its session, and a
      // new session would only find another statement under the number.
      if (fromEndedSession.call(this, h)) {
        return fail(driverError('NO_ACTIVE_QUERY', `${ErrorMessages.ERROR_HANDLE_SESSION_ENDED}: ${queryHandle}`));
      }

      _closeQuery.call(this, h.handle, queryHandle)
        .then(() => fulfil())
        .catch(fail);
    }, dropped(reject, callback), handleKey(h.handle));
  });
};

/**
 * Close a handle from login `generation`, never failing: queued like
 * closeQuery(), and skipped when the handle's session has ended — that
 * session took the handle with it, and the number may now be someone else's.
 * @private
 */
CoraDBConnection.prototype._releaseHandle = function (queryHandle, generation) {
  return new Promise((resolve) => {
    this._queue.unshift(done => {
      const packet = this._queryResultSets[queryHandle];

      if (!this.connectionOpened || !packet || packet._generation !== generation || this._generation !== generation) {
        done();
        return resolve();
      }

      _closeQuery.call(this, queryHandle)
        .catch(noop)
        .then(() => {
          done();
          resolve();
        });
    }, () => resolve(), handleKey(queryHandle));
  });
};

function _closeQuery(queryHandle, shownHandle = queryHandle) {
  return new Promise((resolve, reject) => {
    const queryResultSets = this._queryResultSets;

    if (!this.connectionOpened || !queryResultSets[queryHandle]) {
      return reject(driverError('NO_ACTIVE_QUERY', `${ErrorMessages.ERROR_NO_ACTIVE_QUERY}: ${shownHandle}`));
    }

    _closeServerHandle.call(this, Number(queryHandle)).then(() => {
      // Remove the referenced query packet from the hash.
      delete queryResultSets[queryHandle];
      resolve();
    }, reject);
  });
}

/**
 * Send CLOSE_REQ_HANDLE for a handle on the server.
 *
 * The connection going away during the close counts as success, as in the
 * CCI driver (qe_send_close_handle_msg): the broker may have handed the CAS to
 * another client in the meantime and reset this connection, and a handle goes
 * with its session either way.
 * @private
 */
function _closeServerHandle(queryHandle) {
  return new Promise((resolve, reject) => {
    let closeQueryPacket = new CloseQueryPacket({
      autoCommit: this.autoCommitMode,
      casInfo: this._CASInfo,
      reqHandle: queryHandle,
    });
    const packetWriter = new PacketWriter(closeQueryPacket.getBufferLength());

    closeQueryPacket.write(packetWriter);

    const callback = (err) => {
      if (err && (err.code === 'ECONNRESET' || err.code === 'CONNECTION_CLOSED')) {
        return resolve();
      }

      return err ? reject(err) : resolve();
    };

    _send.call(this, packetWriter._buffer, {
      queryHandle: queryHandle,
      parserFunction: _parseCloseQueryBuffer.bind(this),
      dataPacket: closeQueryPacket
    }, callback);
  });
}

CoraDBConnection.prototype.getMetaData = function (queryHandle, callback) {
  return new Promise((resolve, reject) => {
    const { fulfil, fail } = settle(resolve, reject, callback);
    const h = fromPublicHandle(queryHandle);

    if (fromEndedSession.call(this, h)) {
      return fail(driverError('NO_ACTIVE_QUERY', ErrorMessages.ERROR_HANDLE_SESSION_ENDED));
    }

    const queryResultSet = this._queryResultSets[h.handle];

    if (!queryResultSet) {
      return fail(driverError('NO_ACTIVE_QUERY', ErrorMessages.ERROR_NO_ACTIVE_QUERY));
    }

    fulfil(queryResultSet.resultSet);
  });
};

/**
 * Closes the active connection.
 * @alias end()
 * @param callback
 */
CoraDBConnection.prototype.close = close;
CoraDBConnection.prototype.end = close;

/**
 * Fully tear down the underlying socket so it cannot keep the Node.js event
 * loop alive (clears its idle timeout, drops listeners, destroys it, and
 * forgets the reference). Safe to call multiple times.
 *
 * Whoever calls this answers the requests that were waiting on the socket
 * (abort(), close(), a failed connect): the socket's own `close` event then
 * only emits the public 'disconnect' — or nothing at all, when `quiet`.
 * @private
 */
CoraDBConnection.prototype._destroySocket = function (quiet) {
  const socket = this._socket;

  if (!socket) {
    return;
  }

  this._socket = null;
  socket._coradbDetached = true;

  if (quiet) {
    socket.removeAllListeners('close');
  }

  socket.setTimeout(0);
  // Drop the per-request listeners that could keep firing, but KEEP the
  // 'close' listener: destroying the socket triggers it, which is what emits
  // the public 'disconnect' event. Removing it here would swallow that event.
  socket.removeAllListeners('data');
  socket.removeAllListeners('timeout');
  socket.removeAllListeners('error');
  // An error after this point has nobody to tell; it must not be uncaught.
  socket.on('error', noop);

  if (!socket.destroyed) {
    socket.destroy();
  }
};

function close(callback) {
  return new Promise((resolve, reject) => {
    const { fulfil } = settle(resolve, reject, callback);

    this.logger.debug('Executing close');

    // Remove all pending requests, and tell each one why. Dropping them
    // silently is what left their callers waiting on a promise that could
    // never settle.
    this._queue.empty(driverError('CLOSED_WHILE_QUEUED', ErrorMessages.ERROR_CLOSED_WHILE_QUEUED));
    // Closing says the caller is done with any transaction it had.
    this._transactionLost = false;
    this._generatedKeys.clear();
    // And a statement failing because of it is not run again elsewhere.
    this._closes += 1;
    this._endedHandles.clear();
    // And with its session: a connect() after close() starts a new one.
    this._session = undefined;

    if (!this.connectionOpened) {
      // Not logged in — but possibly still connecting. That request is
      // answered too: it used to be left waiting on a socket that had just
      // been destroyed under it, for ever.
      const waiting = this._socketCurrentEventCallback;

      this._socketCurrentEventCallback = undefined;
      this._connectAttempt += 1;
      // A close during a handshake would otherwise leave the flag set, and
      // every later connect() would refuse with "already pending".
      this.connectionPending = false;
      this._queryResultSets = {};
      this._destroySocket();

      if (typeof waiting === 'function') {
        try {
          waiting(connectionClosedError());
        } catch (err) {
          this.logger.debug('close: in-flight callback threw', err && err.message);
        }
      }

      return fulfil();
    }

    // Behind the request running now, if there is one; at once otherwise,
    // with the queue held so nothing starts beside it.
    const run = (done) => {
      const finish = () => {
        this.connectionOpened = false;
        this.connectionPending = false;
        this._queryResultSets = {};
        this._destroySocket();
        done();
        fulfil();
      };

      if (!this.connectionOpened) {
        return finish();
      }

      // Every open handle, one at a time. A handle that fails to close is
      // let go — it goes with the session anyway — and the session is closed
      // whatever happened to them. One failure used to skip CON_CLOSE and
      // leave the socket open.
      let chain = Promise.resolve();

      for (const queryHandle of Object.keys(this._queryResultSets)) {
        chain = chain.then(() => _closeQuery.call(this, queryHandle).catch(noop));
      }

      chain
        .then(() => _closeDatabase.call(this).catch(noop))
        .then(finish, finish);
    };

    const release = this._queue.claim();

    if (release) {
      run(release);
    } else {
      // Dropped only by an abort(), which closes the connection itself.
      this._queue.unshift(run, () => fulfil());
    }
  });
}

/** CON_CLOSE: end the session on the server. @private */
function _closeDatabase() {
  return new Promise((resolve, reject) => {
    const closeDatabasePacket = new CloseDatabasePacket({
      casInfo: this._CASInfo,
    });
    const packetWriter = new PacketWriter(closeDatabasePacket.getBufferLength());

    closeDatabasePacket.write(packetWriter);

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseResponseCodeBuffer.bind(this),
      dataPacket: closeDatabasePacket
    }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * The plan the engine would use for a statement.
 *
 * Not a result set, and not something `SET OPTIMIZATION LEVEL` delivers: that
 * setting makes the engine produce a plan and print it to the server's own
 * output, which is why raising it and running the statement returns nothing to
 * look at. The plan has a request of its own, and this is it.
 *
 * The statement is compiled but neither prepared nor executed, so this is safe
 * to call on anything — including a DELETE you have no intention of running.
 *
 *   const plan = await client.getQueryPlan('select * from orders where id = 1');
 *
 * @param sql the statement to plan
 * @param callback optional node-style callback
 */
CoraDBConnection.prototype.getQueryPlan = function (sql, callback) {
  return new Promise((resolve, reject) => {
    // Enqueued first and connected inside, the way every other request works.
    // Connecting first and enqueueing afterwards leaves the request belonging
    // to nobody in between: not yet in the queue, so a connection taken down
    // in that moment cannot find it to tell it.
    this._queue.push(done => {
      const { fulfil, fail } = settle(resolve, reject, callback, done);

      this.logger.debug('getQueryPlan', sql);

      _ensureConnected.call(this)
        .then(() => _getQueryPlan.call(this, sql))
        .then(plan => fulfil(plan, plan))
        .catch(fail);
    }, dropped(reject, callback));
  });
};

/**
 * @private
 */
function _getQueryPlan(sql) {
  return new Promise((resolve, reject) => {
    const packet = new GetQueryInfoPacket({ casInfo: this._CASInfo, sql });
    const packetWriter = new PacketWriter(packet.getBufferLength());
    const socket = this._socket;

    if (!socket) {
      return reject(driverError('CONNECTION_ALREADY_CLOSED', ErrorMessages.ERROR_CONNECTION_ALREADY_CLOSED));
    }

    packet.write(packetWriter);

    const callback = (err, plan) => (err ? reject(err) : resolve(plan));

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseQueryPlanBuffer.bind(this),
      dataPacket: packet
    }, callback);
  });
}

function _parseQueryPlanBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parse(packetReader);

  this._callback(error, dataPacket.plan);
}

/**
 * Whether the connection is open and its session still answers: a CHECK_CAS
 * request, queued like any other. Resolves `true` or `false` and never
 * rejects; a connection that is not open is `false` without a request (this
 * does not connect).
 *
 *   if (!(await conn.isValid())) { ... }
 *
 * @param callback optional node-style callback (err is always undefined)
 * @return {Promise<boolean>}
 */
CoraDBConnection.prototype.isValid = function (callback) {
  return new Promise((resolve) => {
    const answer = (valid) => {
      if (typeof callback === 'function') {
        invoke(callback, [undefined, valid]);
      }

      resolve(valid);
    };

    if (!this.connectionOpened) {
      return answer(false);
    }

    this._queue.push(done => {
      const finish = (valid) => {
        done();
        answer(valid);
      };

      if (!this.connectionOpened) {
        return finish(false);
      }

      _checkCas.call(this).then(() => finish(true), () => finish(false));
    }, () => answer(false));
  });
};

/** @private */
function _checkCas() {
  return new Promise((resolve, reject) => {
    const packet = new CheckCasPacket({ casInfo: this._CASInfo });
    const packetWriter = new PacketWriter(packet.getBufferLength());

    packet.write(packetWriter);

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseResponseCodeBuffer.bind(this),
      dataPacket: packet
    }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * How long the server lets a statement run, in milliseconds; 0 (the default)
 * for no limit. Sent with every statement executed from now on, by every
 * method (`query()`, `execute()` with parameters, `sql()`, `cursor()`,
 * `prepare()`...). A statement that runs longer is stopped by the server and
 * fails with its error; the connection stays usable.
 *
 * Not the same as `requestTimeoutMs` / `{ timeoutMs }`, which is how long this
 * driver waits for an answer before it cancels the request itself.
 *
 * @param queryTimeout milliseconds; 0, a negative number or anything that is
 *                     not a number for none
 */
CoraDBConnection.prototype.setQueryTimeout = function (queryTimeout) {
  this.queryTimeout = timeoutMs(queryTimeout);
  this.logger.debug(`Executing setQueryTimeout: queryTimeout = ${this.queryTimeout}`);
};

/**
 * The server-side query timeout, in milliseconds (0: none). See
 * `setQueryTimeout()`.
 * @return {Number}
 */
CoraDBConnection.prototype.getQueryTimeout = function () {
  return this.queryTimeout;
};

/**
 * The keys an INSERT generated (its AUTO_INCREMENT values), as a result set
 * `{ ColumnNames, ColumnDataTypes, ColumnValues, RowsCount }`.
 *
 * The INSERT has to have been run with `query(sql, params, callback,
 * { getGeneratedKeys: true })`, which makes the server keep the keys, and its
 * `queryHandle` that resolved with. As in the JDBC driver, the keys were read
 * when the INSERT ran (query() also resolves with them, as `generatedKeys`),
 * its handle closed and, in auto-commit mode, the INSERT committed: this
 * answers from what was read, without a request. `closeQuery()` forgets them.
 *
 *   const { queryHandle } = await conn.query(
 *     "INSERT INTO t (name) VALUES ('a')", undefined, undefined, { getGeneratedKeys: true });
 *   const keys = await conn.getGeneratedKeys(queryHandle);  // keys.ColumnValues[0][0]
 *   await conn.closeQuery(queryHandle);
 *
 * Fails with NO_ACTIVE_QUERY for a handle that is not open on this session.
 *
 * @param queryHandle the INSERT's query handle
 * @param callback optional node-style callback (err, result)
 * @return {Promise<Object>}
 */
CoraDBConnection.prototype.getGeneratedKeys = function (queryHandle, callback) {
  // Read when the INSERT ran, as the JDBC driver reads them.
  if (this._generatedKeys.has(Number(queryHandle))) {
    return adaptPromise(Promise.resolve(this._generatedKeys.get(Number(queryHandle))), callback);
  }

  return new Promise((resolve, reject) => {
    this._queue.push(done => {
      const { fulfil, fail } = settle(resolve, reject, callback, done);

      this.logger.debug(`Executing getGeneratedKeys: queryHandle = ${queryHandle}`);

      const h = fromPublicHandle(queryHandle);

      if (!this.connectionOpened || fromEndedSession.call(this, h) || !this._queryResultSets[h.handle]) {
        return fail(driverError(
          'NO_ACTIVE_QUERY',
          this.connectionOpened && !fromEndedSession.call(this, h) ? ErrorMessages.ERROR_NO_ACTIVE_QUERY : ErrorMessages.ERROR_HANDLE_SESSION_ENDED
        ));
      }

      _getGeneratedKeys.call(this, h.handle)
        .then(result => fulfil(result, result))
        .catch(fail);
    }, dropped(reject, callback));
  });
};

/** @private */
function _getGeneratedKeys(queryHandle) {
  return new Promise((resolve, reject) => {
    const packet = new GeneratedKeysPacket({
      casInfo: this._CASInfo,
      logger: this.logger,
      queryHandle,
    });
    const packetWriter = new PacketWriter(packet.getBufferLength());

    packet.write(packetWriter);

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseGeneratedKeysBuffer.bind(this),
      dataPacket: packet,
    }, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function _parseGeneratedKeysBuffer(packetReader) {
  const dataPacket = this._parserOptions.dataPacket;
  const error = dataPacket.parse(packetReader);

  this._callback(error, dataPacket.resultSet);
}

/**
 * Default wait for the broker's answer to a cancel, in milliseconds.
 *
 * Short on purpose. A cancel is something a person is waiting on, and there is
 * always the fallback below, so a broker that does not answer promptly is not
 * worth waiting for.
 */
const CANCEL_TIMEOUT = 2000;

/**
 * Stop the statement this connection is executing.
 *
 * Two ways, in order of preference.
 *
 * The first is to ask the broker. A CAS process busy with a statement is not
 * reading its own socket, so the request goes to the broker on a socket of its
 * own and names the CAS by process id; the broker signals it, and the
 * statement returns CAS_ER_QUERY_CANCEL to whoever was waiting for it. The
 * connection survives: the session, its transaction and its open query handles
 * are all still there, and the caller may carry straight on.
 *
 * The second is `abort()`, below, which takes the socket down. That always
 * works and never leaves a request hanging, but the connection and anything
 * uncommitted on it go with it.
 *
 * Which one happened is in the result, because the difference matters to
 * whoever has to be told what just became of their transaction:
 *
 *   const { method } = await conn.cancel();
 *   // 'broker' — statement stopped, connection and transaction intact
 *   // 'abort'  — connection closed, uncommitted work rolled back
 *
 * @param options `{ brokerCancel: false }` to go straight to `abort()`,
 *                `{ timeout }` to wait other than `CANCEL_TIMEOUT` for the
 *                broker.
 * @param callback optional node-style callback
 */
CoraDBConnection.prototype.cancel = function (options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }

  const opts = options || {};

  // Checked before any socket is made: an invalid one used to throw from
  // `socket.setTimeout()` with the socket already connecting and nothing
  // listening for its errors — an ECONNREFUSED then crashed the process.
  if (opts.timeout !== undefined &&
      (typeof opts.timeout !== 'number' || !Number.isFinite(opts.timeout) || opts.timeout < 0)) {
    return adaptPromise(Promise.reject(driverError(
      'INVALID_PARAMETER',
      `cancel(): timeout must be a number of milliseconds, not ${JSON.stringify(opts.timeout)}.`
    )), callback);
  }

  // `onlyWhile`: a test made again immediately before the broker is asked and
  // again before falling back to an abort. A timed-out call passes "my request
  // is still the one running": the broker cancel can take seconds, and by
  // then the request may have finished and the next caller's started — whose
  // statement the cancel would stop, and whose connection the abort would
  // take down. When the test fails, nothing is interrupted and the result's
  // method is 'none'.
  const stillWanted = typeof opts.onlyWhile === 'function' ? opts.onlyWhile : () => true;
  const none = () => ({ method: 'none' });

  const toAbort = (reason) => (stillWanted()
    ? this.abort(reason).then(() => ({ method: 'abort' }))
    : Promise.resolve(none()));

  if (!stillWanted()) {
    return adaptPromise(Promise.resolve(none()), callback);
  }

  if (opts.brokerCancel === false || !this.canBrokerCancel()) {
    return adaptPromise(toAbort(), callback);
  }

  const promise = _brokerCancel
    .call(this, opts.timeout, stillWanted)
    .then((sent) => (sent ? { method: 'broker' } : none()))
    // Anything at all: the broker refused, did not answer, is not listening,
    // or named a process it does not know. The point of a cancel is that the
    // statement stops, so the fallback is not optional.
    .catch((err) => toAbort(err && err.message));

  return adaptPromise(promise, callback);
};

/**
 * Whether a cancel can be asked for rather than taken by force.
 *
 * False before the connection has logged in, and false when the login reply
 * carried no process id to name.
 */
CoraDBConnection.prototype.canBrokerCancel = function () {
  return Boolean(
    this.connectionOpened &&
    this._cancelHost &&
    typeof this._casProcessId === 'number' &&
    this._casProcessId > 0
  );
};

/** The CAS process id this connection is served by, or undefined. */
CoraDBConnection.prototype.getCasProcessId = function () {
  return this._casProcessId;
};

/**
 * Ask the CAS listener to signal the process serving this connection.
 * @private
 */
function _brokerCancel(timeout, stillWanted) {
  return new Promise((resolve, reject) => {
    const host = this._cancelHost;
    const packet = new CancelRequestPacket({ processId: this._casProcessId });
    const packetWriter = new PacketWriter(packet.getBufferLength());

    packet.write(packetWriter);

    this.logger.debug(
      `_brokerCancel: ${host.host}:${host.port}, CAS pid ${this._casProcessId}`
    );

    const socket = Net.createConnection(host.port, host.host);
    let settled = false;

    const finish = (err, value = true) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.on('error', noop);
      socket.destroy();

      return err ? reject(err) : resolve(value);
    };

    // The error listener first: nothing after it may throw with a socket
    // that has no one to report its errors to.
    socket.on('error', finish);
    socket.setNoDelay(true);
    socket.setTimeout(typeof timeout === 'number' ? Math.min(Math.floor(timeout), MAX_TIMER_MS) : CANCEL_TIMEOUT);
    socket.on('timeout', () => finish(driverError('CANCEL_TIMEOUT', ErrorMessages.ERROR_CANCEL_TIMEOUT)));
    // Closed without an answer. Treated as a refusal rather than a success:
    // the caller falls back to an abort, which is the safe way round.
    socket.on('close', () => finish(driverError('CANCEL_REFUSED', ErrorMessages.ERROR_CANCEL_REFUSED)));

    socket.once('connect', () => {
      // Asked again at the last moment: is it still worth stopping?
      if (typeof stillWanted === 'function' && !stillWanted()) {
        return finish(undefined, false);
      }

      socket.write(packetWriter._toBuffer());
    });

    let answer = Buffer.alloc(0);

    socket.on('data', (data) => {
      answer = Buffer.concat([answer, data]);

      if (answer.length < CancelRequestPacket.RESPONSE_SIZE) {
        return;
      }

      const packetReader = new PacketReader();

      packetReader.write(answer);

      const code = packet.parse(packetReader);

      this.logger.debug(`_brokerCancel: answered ${code}`);

      // A negative integer is the refusal — the listener does not know the
      // process, or would not signal it. Anything else means it did.
      if (code >= 0) {
        return finish();
      }

      const err = serverError(code, ErrorMessages.CASErrorMsgId[code] || ErrorMessages.ERROR_CANCEL_REFUSED);

      finish(err);
    });
  });
}

/**
 * Take the connection down, now, and answer everything waiting on it.
 *
 * The blunt instrument behind `cancel()`, and the only one that always works:
 * a statement the engine has already started cannot be called back on a socket
 * the CAS process is not reading. What this does is stop waiting for it. The
 * socket is destroyed, the request in flight is failed rather than left for
 * ever on a reply that is not coming, and the requests queued behind it are
 * failed in turn as the queue drains.
 *
 * Everything the connection held goes with it: its query handles, its session,
 * and any transaction the engine had open, which the engine rolls back when
 * the client disappears. A connection may be opened again afterwards with
 * `connect()`.
 *
 * Every request still waiting is answered with an `ABORTED` error — the one on
 * the wire, and the ones queued behind it. None of them is simply dropped.
 *
 * @param reason optional message for the error every waiting request receives
 * @param callback optional node-style callback
 */
CoraDBConnection.prototype.abort = function (reason, callback) {
  if (typeof reason === 'function') {
    callback = reason;
    reason = undefined;
  }

  this._closes += 1;

  const message = reason || ErrorMessages.ERROR_ABORTED;
  const error = driverError('ABORTED', message);

  this.logger.debug(`Executing abort: ${message}`);

  // The requests that have not started. They are answered before the socket
  // goes, so that the one in flight cannot release its slot and let the queue
  // start another against a connection that is already being taken down.
  this._queue.empty(error);

  // The request in flight. Its reply is never coming, and the driver hands
  // socket-level failures to exactly this callback, so this is where it is
  // told. Taken before the socket goes, because tearing the socket down
  // removes the listener that would otherwise do it.
  const waiting = this._socketCurrentEventCallback;

  this._socketCurrentEventCallback = undefined;

  // A session with auto-commit off takes its transaction with it; requests
  // made after this one must not carry on in a new one (see
  // `_ensureConnected`).
  if (this.connectionOpened && this.autoCommitMode === false) {
    this._transactionLost = true;
  }

  this.connectionOpened = false;
  this.connectionPending = false;
  // A connect in progress is abandoned: it must not complete after this.
  this._connectAttempt += 1;
  // Handles belong to a CAS process this connection is no longer talking to.
  this._queryResultSets = {};
  this._destroySocket();

  if (typeof waiting === 'function') {
    try {
      // Its own error, not the queue's: it stamps its statement on it.
      waiting(driverError('ABORTED', message));
    } catch (err) {
      // A request that refuses its own failure is not worth taking the
      // process down for.
      this.logger.debug('abort: in-flight callback threw', err && err.message);
    }
  }

  return adaptPromise(Promise.resolve(), callback);
};

/**
 * Turn auto-commit off. Nothing is sent to the server: the transaction begins
 * with the next statement, and lasts until `commit()` or `rollback()`.
 *
 * @deprecated Prefer `transaction(fn)`, which commits or rolls back for you,
 * or `setAutoCommitMode(false)`, which says what this does.
 * @param callback
 */
CoraDBConnection.prototype.beginTransaction = function (callback) {
  return this.setAutoCommitMode(this.AUTOCOMMIT_OFF, callback);
};

/**
 * Turn auto-commit back on. It neither commits nor rolls back what is pending:
 * call `commit()` or `rollback()` first.
 *
 * @deprecated Prefer `transaction(fn)`, or `setAutoCommitMode(true)`, which
 * says what this does.
 * @param callback
 */
CoraDBConnection.prototype.endTransaction = function (callback) {
  return this.setAutoCommitMode(this.AUTOCOMMIT_ON, callback);
};

/**
 * Set session auto-commit mode.
 *
 * Nothing is sent: the mode goes with each statement. It takes effect in
 * queue order, behind every request made before this call — so statements
 * already queued run in the mode they were queued in. (It used to change at
 * once, so `sql(insert)` followed by `transaction(...)` ran the insert inside
 * the transaction, and rolled it back with it.) Resolves once it is in
 * effect.
 *
 * Choosing a mode also clears a lost transaction (see `_ensureConnected`).
 * @param autoCommitMode
 * @param callback
 */
CoraDBConnection.prototype.setAutoCommitMode = function (autoCommitMode, callback) {
  return _setAutoCommitQueued.call(this, autoCommitMode).then(
    () => settledValue(callback),
    (err) => settledError(err, callback)
  );
};

/** setAutoCommitMode(), resolving with the mode it replaced. @private */
CoraDBConnection.prototype._swapAutoCommit = function (autoCommitMode) {
  return _setAutoCommitQueued.call(this, autoCommitMode);
};

function _setAutoCommitQueued(autoCommitMode) {
  return new Promise((resolve, reject) => {
    this._queue.push(done => {
      const previous = this.autoCommitMode;
      // Accept any truthful value.
      const next = !!autoCommitMode;

      const apply = () => {
        this.autoCommitMode = next;
        // Remembered, so the next login (the first, or a reconnect) keeps it.
        this._autoCommitChosen = next;
        this._transactionLost = false;

        done();
        resolve(previous);
      };

      // Changing the mode commits the work done so far, as the JDBC driver's
      // setAutoCommit() does. It used to only change the flag, so work done
      // with auto-commit off stayed uncommitted after turning it back on. Not
      // for a session already lost: its work went with it.
      if (previous === next || !this.connectionOpened || this._transactionLost) {
        return apply();
      }

      _closeResultHandles.call(this, true)
        .then(() => _sendCommit.call(this))
        .then(apply, (err) => {
          done();
          reject(err);
        });
    }, dropped(reject));
  });
}

function settledValue(callback) {
  if (typeof callback === 'function') {
    invoke(callback, []);
  }
}

function settledError(err, callback) {
  if (typeof callback === 'function') {
    invoke(callback, [err]);
  }

  throw err;
}

/**
 * Get session auto-commit mode
 */
CoraDBConnection.prototype.getAutoCommitMode = function () {
  return this.autoCommitMode;
};

/**
 * Rollback transaction
 * @param callback
 */
CoraDBConnection.prototype.rollback = function (callback) {
  return new Promise((resolve, reject) => {
    // In order, behind whatever was sent before it: a rollback jumping the
    // queue undoes less than the caller asked it to.
    this._queue.push(done => {
      const { fulfil, fail } = settle(resolve, reject, callback, done);

      if (!this.autoCommitMode && !this.connectionOpened) {
        // The session is gone, and its transaction with it: the server
        // rolled it back. Nothing to send, and nothing lost any more.
        this._transactionLost = false;
        return fulfil();
      }

      _rollback
        .call(this)
        .then(() => fulfil())
        .catch(fail);
    }, dropped(reject, callback));
  });
};

function _rollback() {
  if (this.autoCommitMode) {
    return Promise.reject(driverError('NO_ROLLBACK', ErrorMessages.ERROR_NO_ROLLBACK));
  }

  // As the JDBC driver rolls back: the open results closed first, then
  // END_TRAN ROLLBACK — only when the CAS says a transaction is open.
  return _closeResultHandles.call(this, false).then(() => (_transactionActive.call(this) ? _sendRollback.call(this) : undefined));
}

/** END_TRAN ROLLBACK, sent at once: the caller holds the queue slot. */
function _sendRollback() {
  return new Promise((resolve, reject) => {
    const rollbackPacket = new RollbackPacket({
      casInfo: this._CASInfo,
    });
    const packetWriter = new PacketWriter(rollbackPacket.getBufferLength());

    rollbackPacket.write(packetWriter);

    let callback = (err) => {
      if (err) {
        return reject(err);
      }

      resolve();
    };

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseResponseCodeBuffer.bind(this),
      dataPacket: rollbackPacket
    }, callback);
  });
}

/**
 * Commit transaction
 * @param callback
 */
CoraDBConnection.prototype.commit = function (callback) {
  return _commitQueued.call(this, undefined, callback);
};

/**
 * commit(), refused with TRANSACTION_LOST unless the connection is still on
 * login `generation` — the session the transaction began in.
 * @private
 */
CoraDBConnection.prototype._commitIn = function (generation) {
  return _commitQueued.call(this, generation);
};

/**
 * The commit the JDBC driver sends by itself in auto-commit mode once every
 * result of a statement with several has been read (`turnOnAutoCommitBySelf`,
 * see `MultiResult`). Like `_commitIn()`, but allowed in auto-commit mode.
 * @private
 */
CoraDBConnection.prototype._commitBySelf = function (generation) {
  return _commitQueued.call(this, generation, undefined, true);
};

function _commitQueued(generation, callback, bySelf) {
  return new Promise((resolve, reject) => {
    // In order, behind whatever was sent before it. It used to jump the
    // queue, so `conn.query(insert); conn.commit();` committed before the
    // insert had run.
    this._queue.push(done => {
      this.logger.debug('Executing commit');

      const { fulfil, fail } = settle(resolve, reject, callback, done);
      // The socket layer expects a single node-style (err) callback.
      let cb = (err) => err ? fail(err) : fulfil();

      // A transaction whose session has gone cannot be committed, and must
      // not look as if it had been: what is open now (if anything) is a
      // different transaction.
      if (this._transactionLost || (generation !== undefined && this._generation !== generation)) {
        return cb(driverError('TRANSACTION_LOST', ErrorMessages.ERROR_TRANSACTION_LOST));
      }

      if (!this.connectionOpened) {
        return cb(driverError('CLOSED_CONNECTION_COMMIT', ErrorMessages.ERROR_CLOSED_CONNECTION_COMMIT));
      }

      if (this.autoCommitMode && !bySelf) {
        return cb(driverError('AUTO_COMMIT_ENABLED_COMMIT', ErrorMessages.ERROR_AUTO_COMMIT_ENABLED_COMMIT));
      }

      _closeResultHandles.call(this, true)
        .then(() => _sendCommit.call(this))
        .then(() => cb(), cb);
    }, dropped(reject, callback));
  });
}

/**
 * Get database schema information
 * @param schemaType
 * @param tableNameFilter
 * @param callback
 */
CoraDBConnection.prototype.getSchema = function (schemaType, tableNameFilter, callback) {
  // Normalised before queueing, so a request dropped before it runs still
  // reaches the callback (see `dropped`).
  if (typeof tableNameFilter === 'function') {
    callback = tableNameFilter;
    tableNameFilter = undefined;
  }

  // Refused before anything is sent: for a type the reply parser cannot read,
  // the request went out and the rows came back as garbage.
  if (!GetSchemaPacket.SUPPORTED_TYPES.has(schemaType)) {
    const names = [...GetSchemaPacket.SUPPORTED_TYPES].map(t => CASConstants.getCoraDBSchemaTypeName(t)).join(', ');

    return adaptPromise(Promise.reject(driverError(
      'INVALID_SCHEMA_TYPE',
      `${ErrorMessages.ERROR_INVALID_SCHEMA_TYPE} ${schemaType} (${CASConstants.getCoraDBSchemaTypeName(schemaType)}) is not supported. Use one of: ${names}.`
    )), callback);
  }

  return new Promise((resolve, reject) => {
    this._queue.push(done => {
      const query = new Query(callback);
      const { fulfil, fail } = settle(resolve, reject, query.callback, done);

      this.logger.debug(`getSchema: schemaType = ${schemaType} (${CASConstants.getCoraDBSchemaTypeName(schemaType)}); tableNameFilter = ${tableNameFilter}.`);

      _ensureConnected.call(this)
        .then(() => _getSchema.call(this, schemaType, tableNameFilter))
        .then(response => fulfil(response))
        .catch(fail);
    }, dropped(reject, callback));
  });
};

function _getSchema(schemaType, tableNameFilter) {
  this.logger.debug(`Executing _getSchema: schemaType = ${schemaType} (${CASConstants.getCoraDBSchemaTypeName(schemaType)}), tableNameFilter = ${tableNameFilter}`);

  return new Promise((resolve, reject) => {
    const getSchemaPacket = new GetSchemaPacket({
      casInfo: this._CASInfo,
      protocolVersion: this.brokerInfo.protocolVersion,
      schemaType: schemaType,
      shardId: this.shardId,
      tableNamePattern: tableNameFilter,
      logger: this.logger,
    });
    const packetWriter = new PacketWriter(getSchemaPacket.getRequestSchemaBufferLength());

    getSchemaPacket.writeRequestSchema(packetWriter);

    let callback = (err, result) => {
      const answer = () => (err ? reject(err) : resolve(result));
      const handle = getSchemaPacket.queryHandle;

      // The schema request opened a handle on the server; it is closed here,
      // in the same slot, whether or not the fetch worked. It used to be left
      // open — one more on the CAS for every call.
      if (handle === undefined || !this.connectionOpened) {
        return answer();
      }

      _closeServerHandle.call(this, handle).catch(noop).then(answer);
    };

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseGetSchemaBuffer.bind(this),
      dataPacket: getSchemaPacket
    }, callback);
  });
}

/**
 * Create a new LOB object
 * @param lobType
 * @param callback
 */
CoraDBConnection.prototype.lobNew = function (lobType, callback) {
  return new Promise((resolve, reject) => {
    this._queue.push(done => {
      const query = new Query(callback);
      const { fulfil, fail } = settle(resolve, reject, query.callback, done);

      this.logger.debug(`lobNew: lobType = ${lobType}.`);

      _ensureConnected.call(this)
        .then(() => _lobNew.call(this, lobType))
        .then(lobObject => fulfil(lobObject))
        .catch(fail);
    }, dropped(reject, callback));
  });
};

function _lobNew(lobType) {
  this.logger.debug(`Executing _lobNew: lobType = ${lobType} (${CASConstants.getCoraDBDataTypeName(lobType)})`);

  return new Promise((resolve, reject) => {
    const lobNewPacket = new LOBNewPacket({
      casInfo: this._CASInfo,
      lobType,
    });
    const packetWriter = new PacketWriter(lobNewPacket.getBufferLength());

    lobNewPacket.write(packetWriter);

    let callback = (err, result) => {
      if (err) {
        return reject(err);
      }

      resolve(result);
    };

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseLobNewBuffer.bind(this),
      dataPacket: lobNewPacket
    }, callback);
  });
}

/**
 * Write data to a LOB object
 * @param lobObject
 * @param offset
 * @param data
 * @param callback
 */
CoraDBConnection.prototype.lobWrite = function (lobObject, offset, data, callback) {
  return new Promise((resolve, reject) => {
    this._queue.push(done => {
      const query = new Query(callback);
      const { fulfil, fail } = settle(resolve, reject, query.callback, done);

      this.logger.debug('Executing lobWrite');

      _ensureConnected.call(this)
        .then(() => _lobWrite.call(this, lobObject, offset, data))
        .then(response => fulfil(response, response.lobObject, response.length))
        .catch(fail);
    }, dropped(reject, callback));
  });
};

/**
 * Write a LOB's size into its packed handle: a long after the 4-byte LOB type.
 * @private
 */
function setLobHandleSize(lobObject, size) {
  const handle = lobObject.packedLobHandle;

  if (Buffer.isBuffer(handle) && handle.length >= DATA_TYPES.INT_SIZEOF + DATA_TYPES.LONG_SIZEOF) {
    handle.writeBigInt64BE(BigInt(size), DATA_TYPES.INT_SIZEOF);
  }
}

function _lobWrite(lobObject, offset, data) {
  this.logger.debug(`Executing _lobWrite: offset = ${offset}, lobObject =`, lobObject);

  return new Promise((resolve, reject) => {
    // Ensure sequential write.
    if (lobObject.lobLength !== offset) {
      return reject(driverError('INVALID_LOB_POSITION', ErrorMessages.ERROR_INVALID_LOB_POSITION));
    }

    if (typeof data !== 'string' && !Buffer.isBuffer(data)) {
      return reject(driverError('INVALID_LOB_DATA', ErrorMessages.ERROR_INVALID_LOB_DATA));
    }

    if (typeof data === 'string') {
      // Convert CLOB into a binary buffer.
      data = Helpers.getBufferFromString(data);
    }

    // Two positions, kept apart: where the next chunk goes in the LOB, and
    // where it comes from in `data`. They were one, so a write at a non-zero
    // offset sliced `data` from that offset — past its end — and sent empty
    // chunks for ever.
    let position = offset;
    let written = 0;

    const step = (err) => {
      if (err) {
        return reject(err);
      }

      if (written >= data.length) {
        lobObject.lobLength = position;

        return resolve({
          lobObject,
          length: position,
        });
      }

      const chunk = data.subarray(written, written + Math.min(data.length - written, this._LOB_MAX_IO_LENGTH));
      const lobWritePacket = new LOBWritePacket({
        casInfo: this._CASInfo,
        data: chunk,
        lobObject,
        offset: position,
      });
      const packetWriter = new PacketWriter(lobWritePacket.getBufferLength());

      lobWritePacket.write(packetWriter);

      _send.call(this, packetWriter._buffer, {
        parserFunction: _parseResponseCodeBuffer.bind(this),
        dataPacket: lobWritePacket
      }, (e) => {
        if (e) {
          return step(e);
        }

        const n = Math.min(lobWritePacket.bytesWritten, chunk.length);

        // A server that takes nothing would be asked again, and again.
        if (!(n > 0)) {
          return step(driverError('LOB_WRITE_FAILED', ErrorMessages.ERROR_LOB_WRITE_STALLED));
        }

        position += n;
        written += n;

        // The new size, into the packed handle the next write and a bind send,
        // as the JDBC driver's CORADBLobHandle.setLobSize() does.
        setLobHandleSize(lobObject, position);
        step();
      });
    };

    step();
  });
}

/**
 * Read a LOB object from the database
 * @param lobObject
 * @param offset
 * @param length
 * @param callback
 */
CoraDBConnection.prototype.lobRead = function (lobObject, offset, length, callback) {
  return new Promise((resolve, reject) => {
    this._queue.push(done => {
      const query = new Query(callback);
      const { fulfil, fail } = settle(resolve, reject, query.callback, done);

      this.logger.debug('Executing lobRead');

      _ensureConnected.call(this)
        .then(() => _lobRead.call(this, lobObject, offset, length))
        .then(response => fulfil(response, response.data, response.length))
        .catch(fail);
    }, dropped(reject, callback));
  });
};

function _lobRead(lobObject, offset, length) {
  this.logger.debug(`Executing _lobRead: offset = ${offset}, length = ${length}, lobObject =`, lobObject);

  return new Promise((resolve, reject) => {
    if (lobObject.lobLength < offset + length) {
      return reject(driverError('INVALID_LOB_POSITION', ErrorMessages.ERROR_INVALID_LOB_POSITION));
    }

    let buffers = [];
    let totalReadLen = 0;

    const finish = (err) => {
      if (err) {
        return reject(err);
      }

      let data = Buffer.concat(buffers, totalReadLen);

      if (lobObject.lobType === CASConstants.CoraDBDataType.CCI_U_TYPE_CLOB) {
        data = data.toString();
      }

      resolve({
        data,
        length: totalReadLen,
      });
    };

    const continueReading = (err) => {
      if (err || length <= totalReadLen) {
        return finish(err);
      }

      const lobReadPacket = new LOBReadPacket({
        casInfo: this._CASInfo,
        bytesToRead: length - totalReadLen,
        lobObject,
        offset,
      });
      const packetWriter = new PacketWriter(lobReadPacket.getBufferLength());

      lobReadPacket.write(packetWriter);

      // Through the same reader as every other reply, so a reply it cannot
      // parse fails this request rather than the process.
      _send.call(this, packetWriter._buffer, {
        parserFunction: _parseResponseCodeBuffer.bind(this),
        dataPacket: lobReadPacket
      }, (e) => {
        if (e) {
          return continueReading(e);
        }

        const realReadLen = lobReadPacket.readLength;

        // The actual data stored in CoraDB may be empty.
        if (realReadLen === 0) {
          length = 0;
        } else {
          // The data received from the server can be partial.
          // So if we haven't received enough data, we need
          // to keep requesting.
          offset += realReadLen;
          totalReadLen += realReadLen;
          buffers.push(lobReadPacket.lobBuffer);
        }

        setImmediate(continueReading);
      });
    };

    continueReading();
  });
}

/**
 * Set connection timeout value in milliseconds.
 * 1. If the value is <= 0, the client-side timeout is disabled (the socket's
 * inactivity timeout is turned off). A stalled connection then falls back to
 * the operating system's TCP timeout, which is platform-dependent - e.g. the
 * classic BSD/macOS connect timeout is about 75 seconds, while Linux (SYN
 * retransmissions) is typically longer.
 * @param timeout (msec)
 */
CoraDBConnection.prototype.setConnectionTimeout = function (timeout) {
  this.connectionTimeout = timeoutMs(timeout);
  this.logger.debug(`Executing setConnectionTimeout: connectionTimeout = ${this.connectionTimeout} ms`);
};

/**
 * Returns the connection timeout
 * @return {Number} (.msec)
 */
CoraDBConnection.prototype.getConnectionTimeout = function () {
  return this.connectionTimeout;
};

/**
 * The CAS database parameters, by name.
 *
 * Exported as `DbParam`. `getDatabaseParameter` and `setDatabaseParameter`
 * take either the number or the name, in any of the usual spellings:
 * `'ISOLATION_LEVEL'`, `'isolationLevel'`, `'isolation_level'`.
 */
const DB_PARAMS = Object.freeze({
  ISOLATION_LEVEL: CASConstants.CCIDbParam.CCI_PARAM_ISOLATION_LEVEL,
  LOCK_TIMEOUT: CASConstants.CCIDbParam.CCI_PARAM_LOCK_TIMEOUT,
  MAX_STRING_LENGTH: CASConstants.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH,
  AUTO_COMMIT: CASConstants.CCIDbParam.CCI_PARAM_AUTO_COMMIT,
});

function dbParamNumber(parameter) {
  if (typeof parameter === 'number' && Object.values(DB_PARAMS).includes(parameter)) {
    return parameter;
  }

  if (typeof parameter === 'string') {
    const key = parameter
      .trim()
      .replace(/^CCI_PARAM_/i, '')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toUpperCase();

    if (Object.prototype.hasOwnProperty.call(DB_PARAMS, key)) {
      return DB_PARAMS[key];
    }
  }

  throw driverError(
    'INVALID_PARAMETER',
    `Unknown database parameter ${JSON.stringify(parameter)}. Use one of: ${Object.keys(DB_PARAMS).join(', ')}.`
  );
}

CoraDBConnection.DB_PARAMS = DB_PARAMS;

/**
 * Set a database parameter
 * @param parameter a `DbParam` number or name, e.g. 'LOCK_TIMEOUT'
 * @param value
 * @param callback
 */
CoraDBConnection.prototype.setDatabaseParameter = function (parameter, value, callback) {
  return new Promise((resolve, reject) => {
    try {
      parameter = dbParamNumber(parameter);
    } catch (err) {
      return dropped(reject, callback)(err);
    }

    this._queue.push((done) => {
      const { fulfil, fail } = settle(resolve, reject, callback, done);

      _ensureConnected.call(this)
        .then(() => _setDatabaseParameter.call(this, parameter, value))
        .then(() => fulfil())
        .catch(fail);
    }, dropped(reject, callback));
  });
};

function _setDatabaseParameter(parameter, value) {
  return new Promise((resolve, reject) => {
    if (parameter === CASConstants.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH) {
      // The `CCI_PARAM_MAX_STRING_LENGTH` parameter **cannot** be set
      // programmatically from code as it is a CoraDB Broker parameter
      // and the client can only query its current value.
      return reject(serverError(-10011));
    }

    const setDbParameterPacket = new SetDbParameterPacket({
      casInfo: this._CASInfo,
      parameter,
      value
    });
    const packetWriter = new PacketWriter(setDbParameterPacket.getBufferLength());

    setDbParameterPacket.write(packetWriter);

    let callback = (err) => {
      if (err) {
        return reject(err);
      }

      resolve();
    };

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseResponseCodeBuffer.bind(this),
      dataPacket: setDbParameterPacket
    }, callback);
  });
}

/**
 * Get a database parameter
 * @param parameter a `DbParam` number or name, e.g. 'ISOLATION_LEVEL'
 * @param callback
 */
CoraDBConnection.prototype.getDatabaseParameter = function (parameter, callback) {
  return new Promise((resolve, reject) => {
    try {
      parameter = dbParamNumber(parameter);
    } catch (err) {
      return dropped(reject, callback)(err);
    }

    this._queue.push((done) => {
      const { fulfil, fail } = settle(resolve, reject, callback, done);

      _ensureConnected.call(this)
        .then(() => _getDatabaseParameter.call(this, parameter))
        .then(value => fulfil(value))
        .catch(fail);
    }, dropped(reject, callback));
  });
};

function _getDatabaseParameter(parameter) {
  return new Promise((resolve, reject) => {
    // MAX_STRING_LENGTH is a broker setting: it cannot be set (see
    // _setDatabaseParameter), but it can be read. Reading it was refused
    // here too, by a copy of the setter's check.
    const getDbParameterPacket = new GetDbParameterPacket({
      casInfo: this._CASInfo,
      parameter,
    });
    const packetWriter = new PacketWriter(getDbParameterPacket.getBufferLength());

    getDbParameterPacket.write(packetWriter);

    let callback = (err) => {
      if (err) {
        return reject(err);
      }

      resolve(getDbParameterPacket.value);
    };

    _send.call(this, packetWriter._buffer, {
      parserFunction: _parseResponseCodeBuffer.bind(this),
      dataPacket: getDbParameterPacket
    }, callback);
  });
}

/**
 * Set the protocol to be used for queries execution.
 * If set to true, the driver will use the old protocol.
 * If set to false, the driver will use the newer protocol.
 * @param enforceOldProtocol
 */
CoraDBConnection.prototype.setEnforceOldQueryProtocol = function (enforceOldProtocol) {
  this.logger.info('setEnforceOldQueryProtocol', enforceOldProtocol);

  this._ENFORCE_OLD_QUERY_PROTOCOL = enforceOldProtocol;
};

/**
 * Returns the protocol used for queries execution.
 * If true, the driver uses the (old) 8.4.x protocol.
 * If false, the driver uses the newer 9.x protocol.
 */
CoraDBConnection.prototype.shouldUseOldQueryProtocol = function () {
  return !!this._ENFORCE_OLD_QUERY_PROTOCOL;
};

/**
 * Return true if there are pending queries in the queries queue
 * @return {Boolean}
 */
CoraDBConnection.prototype.isQueueEmpty = function () {
  return this._queue.isEmpty();
};

/**
 * How many requests this connection has: the one running, if any, plus every
 * one waiting behind it. Zero exactly when `isQueueEmpty()` is true.
 * @return {Number}
 */
CoraDBConnection.prototype.getQueueLength = function () {
  return this._queue.getDepth();
};

/**
 * @deprecated The same as `getQueueLength()`, under its old name.
 */
CoraDBConnection.prototype.getQueueDepth = CoraDBConnection.prototype.getQueueLength;

// Every public method that takes a callback: with one given, the promise it
// returns is marked handled (see `markHandledWithCallback`).
markHandledWithCallback(CoraDBConnection.prototype, [
  'abort', 'batchExecuteNoQuery', 'beginTransaction', 'cancel', 'close', 'closeQuery',
  'commit', 'connect', 'end', 'endTransaction', 'execute', 'executeWithTypedParams', 'fetch',
  'getActiveHost', 'getDatabaseParameter', 'getEngineVersion', 'getGeneratedKeys', 'getMetaData', 'getQueryPlan',
  'getSchema', 'lobNew', 'lobRead', 'lobWrite', 'query', 'queryAll', 'queryAllAsObjects',
  'queryAsObjects', 'rollback', 'setAutoCommitMode', 'setDatabaseParameter',
]);

// sql(), stream(), cursor(), prepare(), transaction(): built on the requests
// above, in a module of their own.
require('./modern').install(CoraDBConnection, {
  closeQuery: _closeQuery,
  executeWithReconnect: _executeWithReconnect,
  reprepare: _reprepare,
  withStmtPoolingRetry: _withStmtPoolingRetry,
  dropped,
  executePrepared: _executePrepared,
  noop,
  prepareExecute,
  prepareOnly: _prepareOnly,
  queryNewProtocol: _queryNewProtocol,
  settle,
});

module.exports = CoraDBConnection;
