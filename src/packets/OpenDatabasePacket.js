'use strict';

const CAS = require('../constants/CASConstants');
const DATA_TYPES = require('../constants/DataTypes');
const NoopLogger = require('../NoopLogger');
const { driverError } = require('../errors');

/** The size of each login field. The server needs room for a closing NUL. */
const LOGIN_FIELD_SIZE = 32;
/** The session id: the last field of the login (SRV_CON_DBSESS_ID_SIZE). */
const SESSION_ID_SIZE = 20;

/**
 * Refuse a database name, user or password that does not fit its field.
 *
 * The fields are 32 bytes of UTF-8 with a NUL at the end, so a value may be
 * 31 bytes at most. A longer one used to run into the next field — the user
 * name into the password — and the server read something else entirely.
 * Throws a CoraDBError with code 'INVALID_PARAMETER'.
 */
function checkLoginFields(options) {
  for (const name of ['database', 'user', 'password']) {
    const value = options[name] === undefined || options[name] === null ? '' : String(options[name]);
    const bytes = Buffer.byteLength(value, 'utf8');

    if (bytes >= LOGIN_FIELD_SIZE) {
      throw driverError(
        'INVALID_PARAMETER',
        `The ${name} is ${bytes} bytes in UTF-8; the login allows at most ${LOGIN_FIELD_SIZE - 1}.`
      );
    }
  }
}

/**
 * Constructor
 * @param options
 * @constructor
 */
function OpenDatabasePacket(options) {
  this.options = options;
  typeof options.logger === 'undefined' && (options.logger = new NoopLogger());
}

/**
 * Write data
 * @param writer
 */
OpenDatabasePacket.prototype.write = function (writer) {
  const options = this.options;

  checkLoginFields(options);

  writer._writeFixedLengthString(options.database, 0, LOGIN_FIELD_SIZE); // Database name
  writer._writeFixedLengthString(options.user, 0, LOGIN_FIELD_SIZE); // User login ID
  writer._writeFixedLengthString(options.password, 0, LOGIN_FIELD_SIZE); // User login password
  writer._writeFiller(512, 0); // Used for extended connection info

  // The session to resume, as the JDBC driver sends it (checkReconnect()):
  // the 20-byte id the last login answered with, so that a reconnect finds
  // its session again — its variables, its LAST_INSERT_ID(). Before any login,
  // the text "0".
  const session = options.session;

  if (Buffer.isBuffer(session) && session.length === SESSION_ID_SIZE) {
    writer._writeBytes(session);
  } else {
    writer._writeFixedLengthString('0', 0, SESSION_ID_SIZE);
  }

  return writer;
};

/**
 * Read data
 * @param parser
 */
OpenDatabasePacket.prototype.parse = function (parser) {
  const logger = this.options.logger;
  const start = parser._offset;
  const responseLength = parser._parseInt();

  this.casInfo = parser._parseBytes(DATA_TYPES.CAS_INFO_SIZE);

  logger.debug('OpenDatabasePacket: casInfo', this.casInfo);

  this.responseCode = parser._parseInt();

  if (this.responseCode < 0) {
    return parser.readError(responseLength);
  }

  /*
    * Broker information: 8 bytes.
    * Byte 1: DBMS Type. 1 = CoraDB.
    * Byte 2: Reserved. 1.
    * Byte 3: Statement Polling. 1.
    * Byte 4: CCI_PCONNECT. 0.
    * Byte 5: Protocol Version.
    * Byte 6: Function Flag.
    * Byte 7: Reserved. 0.
    * Byte 8: Reserved. 0.
    * */
  const brokerInfo = parser._parseBytes(DATA_TYPES.BROKER_INFO_SIZEOF);

  logger.debug('OpenDatabasePacket: brokerInfo', brokerInfo);

  const protocolVersion = CAS.getProtocolVersion(brokerInfo[4]);
  logger.debug('OpenDatabasePacket: protocolVersion', protocolVersion);

  // Freeze the object, i.e. make it immutable.
  this.brokerInfo = Object.freeze({
    dbType: brokerInfo[0],
    protocolVersion,
    statementPolling: brokerInfo[2],
    // What the broker supports (renewed error codes 0x80, holdable results
    // 0x40, reconnect when the server is down 0x20), when the version byte has
    // the protocol indicator; 0 otherwise.
    functionFlag: (brokerInfo[4] & CAS.CAS_PROTO_INDICATOR) === CAS.CAS_PROTO_INDICATOR ? brokerInfo[5] : 0,
  });

  /*
   * The integer the broker sends after its own information.
   *
   * This driver has always called it the session id, and callers use that
   * name, so it keeps it. It is not the id an out-of-band cancel names: that
   * is the login response code above, which the CAS listener matches against
   * the process serving this connection. The two are different numbers, and
   * cancelling by this one asks the listener about a process it has never
   * heard of.
   */
  // Then, as the JDBC driver reads it (UClientSideConnection.connectDB()):
  // the CAS id (protocol V4 and later), and the 20-byte session id (V3 and
  // later) or, before V3, a session number. `sessionId` keeps the first
  // integer, the name this driver has always given it.
  const end = start + DATA_TYPES.DATA_LENGTH_SIZEOF + DATA_TYPES.CAS_INFO_SIZE + responseLength;
  const remaining = () => end - parser._offset;

  if (protocolVersion >= 4 || protocolVersion < 3) {
    this.sessionId = parser._parseInt();
  }

  if (protocolVersion >= 4) {
    this.casId = this.sessionId;
  }

  if (protocolVersion >= 3 && remaining() >= SESSION_ID_SIZE) {
    this.session = parser._parseBytes(SESSION_ID_SIZE);
  }

  logger.debug(
    `OpenDatabasePacket: responseLength ${responseLength}, CAS id ${this.casId},`,
    `session ${this.session ? this.session.toString('hex') : 'none'}`
  );
};

OpenDatabasePacket.prototype.getBufferLength = function () {
  const bufferLength =
        // Fixed database name length +
        // User login ID length +
        // User login password length.
        32 * 3 +
        // Used for extended connection info.
        512 +
        // The session id.
        SESSION_ID_SIZE
        ;

  return bufferLength;
};

module.exports = OpenDatabasePacket;
module.exports.checkLoginFields = checkLoginFields;
