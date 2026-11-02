/**
 * Define CoraDB internal error messages and custom driver error messages
 */

exports.ERROR_NEW_BROKER_PORT = 'Error receiving a new connection port.';
exports.ERROR_CONNECTION_ALREADY_OPENED = 'The connection is already opened: denying a second connection request.';
exports.ERROR_CONNECTION_ALREADY_PENDING = 'A connection is already in progress: denying current connection request.';
exports.ERROR_CONNECTION_ALREADY_CLOSED = 'The connection is already closed.';
exports.ERROR_MULTIPLE_QUERIES = 'Multiple queries are not supported when using the old prepare-execute protocol.';
exports.ERROR_NO_ACTIVE_QUERY = 'No active query with this handle.';
exports.ERROR_NO_ROLLBACK = 'AutoCommitMode is enabled: denying rollback request.';
exports.ERROR_AUTO_COMMIT_ENABLED_COMMIT = 'AutoCommitMode is enabled: denying commit request.';
exports.ERROR_ON_CLOSE_QUERY_HANDLE = 'Error closing request: ';
exports.ERROR_INPUT_VALIDATION = 'Error validating input parameters.';
exports.ERROR_INVALID_DATA_TYPE = 'Invalid data type.';
exports.ERROR_INVALID_SCHEMA_TYPE = 'Invalid schema type.';
exports.ERROR_INVALID_LOB_POSITION = 'Invalid LOB position.';
exports.ERROR_INVALID_LOB_TYPE = 'Invalid LOB type.';
exports.ERROR_INVALID_LOB_DATA = 'Invalid LOB data: must be a string or Buffer.';
// Set the same timeout error message as emitted by Node.js socket client.
exports.ERROR_CONNECTION_TIMEOUT = 'connect ETIMEDOUT';
exports.ERROR_CLOSED_CONNECTION_COMMIT = 'Cannot commit on a closed/offline connection.';
exports.ERROR_QUERIES_IN_PROGRESS = "Cannot close the connection: there are queries in execution.";
exports.ERROR_ABORTED = 'The connection was aborted while a request was in progress.';
exports.ERROR_CLOSED_WHILE_QUEUED = 'The connection was closed before this request ran.';
exports.ERROR_CANCEL_TIMEOUT = 'The broker did not answer the cancel request in time.';
exports.ERROR_CANCEL_REFUSED = 'The broker refused the cancel request.';
exports.ERROR_CONNECTION_CLOSED = 'The connection to the server was closed.';
exports.ERROR_CONNECTION_LOST_WHILE_QUEUED = 'The connection to the server was lost before this request ran.';
exports.ERROR_PROTOCOL = "The server's reply could not be read; the connection was closed.";
exports.ERROR_TRANSACTION_LOST = 'The connection was lost while auto-commit was off, and the server rolled back the open transaction. ' +
  'Nothing was sent on a new session: call rollback(), setAutoCommitMode() or connect() to go on.';
exports.ERROR_TRANSACTION_ROLLED_BACK = 'The server rolled the transaction back (it was chosen as a deadlock victim); nothing in it was committed. ' +
  'Running the whole transaction again may succeed.';
exports.ERROR_TRANSACTION_IN_PROGRESS = 'Another transaction() is still running on this connection; a connection has one transaction at a time.';
exports.ERROR_TRANSACTION_ROLLBACK_FAILED = 'The transaction failed, and it could not be rolled back. Auto-commit is still off and its work may still be pending: ' +
  'call rollback() before going on.';
exports.ERROR_HANDLE_SESSION_ENDED = 'The query handle belongs to a session that has ended.';
exports.ERROR_STATEMENT_SESSION_ENDED = 'The prepared statement belongs to a session that has ended; prepare it again.';
exports.ERROR_LOB_WRITE_STALLED = 'The server accepted none of the LOB data it was sent.';

// CAS error codes are reported in two encodings depending on the protocol
// version: a -10000-based set (e.g. -10007) used by protocol version 2, and a
// -1000-based set (e.g. -1007) used by the other protocol versions. Both
// encodings denote the same CAS error, so the table lists both keys for each
// error and callers can look the message up directly with `CASErrorMsgId[code]`
// - no offset conversion required.
exports.CASErrorMsgId = {
  // -10000-based codes (protocol version 2).
  '-10000': 'CAS_ER_DBMS',
  '-10001': 'CAS_ER_INTERNAL',
  '-10002': 'CAS_ER_NO_MORE_MEMORY',
  '-10003': 'CAS_ER_COMMUNICATION',
  '-10004': 'CAS_ER_ARGS',
  '-10005': 'CAS_ER_TRAN_TYPE',
  '-10006': 'CAS_ER_SRV_HANDLE',
  '-10007': 'CAS_ER_NUM_BIND',
  '-10008': 'CAS_ER_UNKNOWN_U_TYPE',
  '-10009': 'CAS_ER_DB_VALUE',
  '-10010': 'CAS_ER_TYPE_CONVERSION',
  '-10011': 'CAS_ER_PARAM_NAME',
  '-10012': 'CAS_ER_NO_MORE_DATA',
  '-10013': 'CAS_ER_OBJECT',
  '-10014': 'CAS_ER_OPEN_FILE',
  '-10015': 'CAS_ER_SCHEMA_TYPE',
  '-10016': 'CAS_ER_VERSION',
  '-10017': 'CAS_ER_FREE_SERVER',
  '-10018': 'CAS_ER_NOT_AUTHORIZED_CLIENT',
  '-10019': 'CAS_ER_QUERY_CANCEL',
  '-10020': 'CAS_ER_NOT_COLLECTION',
  '-10021': 'CAS_ER_COLLECTION_DOMAIN',
  '-10022': 'CAS_ER_NO_MORE_RESULT_SET',
  '-10023': 'CAS_ER_INVALID_CALL_STMT',
  '-10024': 'CAS_ER_STMT_POOLING',
  '-10025': 'CAS_ER_DBSERVER_DISCONNECTED',
  '-10026': 'CAS_ER_MAX_PREPARED_STMT_COUNT_EXCEEDED',
  '-10027': 'CAS_ER_HOLDABLE_NOT_ALLOWED',
  '-10028': 'CAS_ER_HOLDABLE_NOT_ALLOWED_KEEP_CON_OFF',
  '-10100': 'CAS_ER_NOT_IMPLEMENTED',
  '-10101': 'CAS_ER_MAX_CLIENT_EXCEEDED',
  '-10102': 'CAS_ER_INVALID_CURSOR_POS',
  '-10103': 'CAS_ER_SSL_TYPE_NOT_ALLOWED',
  '-10200': 'CAS_ER_IS',

  // -1000-based codes (protocol versions other than 2).
  '-1000': 'CAS_ER_DBMS',
  '-1001': 'CAS_ER_INTERNAL',
  '-1002': 'CAS_ER_NO_MORE_MEMORY',
  '-1003': 'CAS_ER_COMMUNICATION',
  '-1004': 'CAS_ER_ARGS',
  '-1005': 'CAS_ER_TRAN_TYPE',
  '-1006': 'CAS_ER_SRV_HANDLE',
  '-1007': 'CAS_ER_NUM_BIND',
  '-1008': 'CAS_ER_UNKNOWN_U_TYPE',
  '-1009': 'CAS_ER_DB_VALUE',
  '-1010': 'CAS_ER_TYPE_CONVERSION',
  '-1011': 'CAS_ER_PARAM_NAME',
  '-1012': 'CAS_ER_NO_MORE_DATA',
  '-1013': 'CAS_ER_OBJECT',
  '-1014': 'CAS_ER_OPEN_FILE',
  '-1015': 'CAS_ER_SCHEMA_TYPE',
  '-1016': 'CAS_ER_VERSION',
  '-1017': 'CAS_ER_FREE_SERVER',
  '-1018': 'CAS_ER_NOT_AUTHORIZED_CLIENT',
  '-1019': 'CAS_ER_QUERY_CANCEL',
  '-1020': 'CAS_ER_NOT_COLLECTION',
  '-1021': 'CAS_ER_COLLECTION_DOMAIN',
  '-1022': 'CAS_ER_NO_MORE_RESULT_SET',
  '-1023': 'CAS_ER_INVALID_CALL_STMT',
  '-1024': 'CAS_ER_STMT_POOLING',
  '-1025': 'CAS_ER_DBSERVER_DISCONNECTED',
  '-1026': 'CAS_ER_MAX_PREPARED_STMT_COUNT_EXCEEDED',
  '-1027': 'CAS_ER_HOLDABLE_NOT_ALLOWED',
  '-1028': 'CAS_ER_HOLDABLE_NOT_ALLOWED_KEEP_CON_OFF',
  '-1100': 'CAS_ER_NOT_IMPLEMENTED',
  '-1101': 'CAS_ER_MAX_CLIENT_EXCEEDED',
  '-1102': 'CAS_ER_INVALID_CURSOR_POS',
  '-1103': 'CAS_ER_SSL_TYPE_NOT_ALLOWED',
  '-1200': 'CAS_ER_IS'
};
