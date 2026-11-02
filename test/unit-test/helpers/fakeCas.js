'use strict';

const Net = require('node:net');

const CAS = require('../../../src/constants/CASConstants');

/*
 * A pretend CAS on a local port: enough of the protocol for the driver to log
 * in, run statements, fetch, close handles, and commit or roll back.
 *
 *   const cas = await fakeCas({
 *     onQuery(sql, request) { return { columns: [['id', 'int']], rows: [[1]] }; },
 *   });
 *   const conn = CoraDB.createConnection({ host: `127.0.0.1:${cas.port}`, ... });
 *
 * `onQuery` answers with rows (`{ columns: [[name, type]], rows }`), a count
 * (`{ affected }`), several results (`{ results: [answer, answer, ...] }`,
 * one per statement: the first comes with the reply, the others with
 * NEXT_RESULT), or an error (`{ error: { code, message } }`), and may
 * return a promise to take its time. `{ close: true }` closes the socket
 * cleanly (FIN) instead of answering. `fetchSize` rows go with the first reply
 * and with each fetch. Every request is recorded in `cas.log`.
 *
 * A column type is a name from TYPES or a CAS type number; a cell may be
 * `{ raw: Buffer }` to send those bytes as the value, as they are (with
 * `size` to claim a different length).
 *
 * Other options:
 *   handlesPerSession  number handles from 1 in every session, as a real CAS
 *                      does (by default they are unique across sessions);
 *   handlers           `{ [fc]: (body, entry, socket) => Buffer | null | undefined }`,
 *                      tried before the built-in answer: a Buffer is the reply,
 *                      null means no reply, undefined falls through;
 *   onCancel(socket)   called for a connection that sends a cancel request
 *                      rather than a client-info exchange (default: answer 0);
 *   skipClientInfo     start at the login, as a CAS the broker redirected to;
 *   port               listen on this port rather than any free one;
 *   brokerFlags        the broker's function flag (default 0xC0: renewed
 *                      error codes and holdable results, as a CoraDB broker);
 *   statementPooling   the broker's statement-pooling byte (default 0).
 *
 * Like a CAS, the first byte of each reply's CAS info says whether a
 * transaction is open: set by a statement run without auto-commit, or with it
 * while its result is open (a SELECT, several results); cleared by END_TRAN,
 * by a statement run with auto-commit that leaves no result open, or by a
 * close that carries auto-commit. The client-info flags (`{ clientInfo, flags }`) and each login's session
 * id (`{ login, session, resumed }`) are in `cas.connectionLog`.
 */

const TYPES = {
  int: CAS.CoraDBDataType.CCI_U_TYPE_INT,
  string: CAS.CoraDBDataType.CCI_U_TYPE_STRING,
  bigint: CAS.CoraDBDataType.CCI_U_TYPE_BIGINT,
  short: CAS.CoraDBDataType.CCI_U_TYPE_SHORT,
  numeric: CAS.CoraDBDataType.CCI_U_TYPE_NUMERIC,
  double: CAS.CoraDBDataType.CCI_U_TYPE_DOUBLE,
};

const typeCode = (type) => (typeof type === 'number' ? type : TYPES[type]);

const FC = CAS.CASFunctionCode;

class Out {
  constructor() {
    this.parts = [];
  }

  int(v) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.parts.push(b);
    return this;
  }

  short(v) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.parts.push(b);
    return this;
  }

  byte(v) {
    this.parts.push(Buffer.from([v & 0xff]));
    return this;
  }

  bytes(n) {
    this.parts.push(Buffer.alloc(n));
    return this;
  }

  /** Length (with the NUL) and the string, as `_parseNullTerminatedString` reads it. */
  str(s) {
    if (s === '') {
      return this.int(0);
    }

    const b = Buffer.from(s);
    this.int(b.length + 1);
    this.parts.push(b, Buffer.from([0]));
    return this;
  }

  /** The whole reply: data length, CAS info, then the body. */
  reply() {
    const body = Buffer.concat(this.parts);
    const head = Buffer.alloc(8);
    head.writeInt32BE(body.length, 0);
    head.writeInt32BE(0, 4);
    return Buffer.concat([head, body]);
  }
}

const COLLECTION_FLAGS = {
  [CAS.CoraDBDataType.CCI_U_TYPE_SET]: CAS.CollectionFlag.SET,
  [CAS.CoraDBDataType.CCI_U_TYPE_MULTISET]: CAS.CollectionFlag.MULTISET,
  [CAS.CoraDBDataType.CCI_U_TYPE_SEQUENCE]: CAS.CollectionFlag.SEQUENCE,
};

/**
 * A column's type as a protocol V7+ CAS sends it: two bytes, the first with
 * the high bit, the collection kind and the charset, the second the type (or
 * a collection's element type). `opts`: `{ elementType, charset }`, or
 * `{ oneByte: true }` for the single byte of the older protocols (collection
 * kind in bits 6-5, type in bits 4-0).
 */
function typeBytes(out, type, opts = {}) {
  const code = typeCode(type);
  const element = opts.elementType !== undefined ? typeCode(opts.elementType) : undefined;
  const flag = element !== undefined ? COLLECTION_FLAGS[code] || 0 : 0;
  const base = element !== undefined ? element : code;

  if (opts.oneByte) {
    return out.byte(flag | (base & CAS.ColumnTypeMask.TYPE));
  }

  return out.byte(CAS.ColumnTypeMask.HAS_2_BYTES | flag | ((opts.charset || 0) & CAS.ColumnTypeMask.CHARSET)).byte(base);
}

function columnInfo(out, [name, type, opts]) {
  typeBytes(out, type, opts);
  out.short(0).int(0).str(name).str(name).str('t').byte(1).int(0);
  for (let i = 0; i < 7; ++i) out.byte(0);
}

function rowsOut(out, rows, columns, from) {
  rows.forEach((row, i) => {
    out.int(from + i).bytes(8);
    row.forEach((v, j) => {
      if (v === null || v === undefined) {
        out.int(-1);
        return;
      }

      const type = columns[j][1];

      if (v && Buffer.isBuffer(v.raw)) {
        // `size` may lie about the length, to send a broken reply.
        out.int(v.size !== undefined ? v.size : v.raw.length);
        out.parts.push(v.raw);
      } else if (type === 'short') {
        out.int(2).short(v);
      } else if (type === 'double') {
        const b = Buffer.alloc(8);
        b.writeDoubleBE(v);
        out.int(8);
        out.parts.push(b);
      } else if (type === 'int') {
        out.int(4).int(v);
      } else if (type === 'bigint') {
        const b = Buffer.alloc(8);
        b.writeBigInt64BE(BigInt(v));
        out.int(8);
        out.parts.push(b);
      } else {
        const b = Buffer.from(String(v));
        out.int(b.length + 1);
        out.parts.push(b, Buffer.from([0]));
      }
    });
  });
}

function errorReply(error) {
  const out = new Out().int(-1).int(error.code).str(error.message || '');
  // readError reads the message by the reply length, not a length prefix.
  const body = Buffer.concat(out.parts.slice(0, 2).concat([Buffer.from(error.message || ''), Buffer.from([0])]));
  const head = Buffer.alloc(8);
  head.writeInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** The type of a statement that returns no rows: INSERT, or else UPDATE. */
function statementTypeOf(sql) {
  return /^\s*insert\b/i.test(sql) ? CAS.CoraDBStatementType.CORADB_STMT_INSERT : CAS.CoraDBStatementType.CORADB_STMT_UPDATE;
}

function readString(buf, at) {
  const len = buf.readInt32BE(at);
  return { value: len > 0 ? buf.subarray(at + 4, at + 4 + len - 1).toString() : '', next: at + 4 + Math.max(len, 0) };
}

async function fakeCas(options) {
  const opts = Object.assign({ fetchSize: 2, pid: 4242, handlers: {}, brokerFlags: 0xc0, statementPooling: 0 }, options);
  const log = [];
  const sockets = new Set();
  let sharedNextHandle = 1;
  let logins = 0;
  // The session ids this server has given out, for a login to resume.
  const sessions = new Set();
  const connectionLog = [];

  const server = Net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    const handles = new Map();
    let sessionNextHandle = 1;
    const nextHandleNumber = () => (opts.handlesPerSession ? sessionNextHandle++ : sharedNextHandle++);
    let stage = opts.skipClientInfo ? 1 : 0;
    let pending = Buffer.alloc(0);
    let busy = Promise.resolve();
    // Whether this session has a transaction open (the CAS info status).
    let active = false;
    // The handle of the statement run last.
    let lastHandle;

    const send = (b) => {
      if (!socket.destroyed) socket.write(b);
    };

    const statement = (sql, whole, prepared) => {
      const out = new Out();
      const results = whole.results || [whole];
      const answer = whole.results ? Object.assign({}, whole.results[0]) : whole;
      if (prepared && whole.results && !answer.columns && whole.columns) answer.columns = whole.columns;
      const columns = answer.columns || [];
      const isSelect = Boolean(answer.columns);
      const all = answer.rows || [];
      const first = all.slice(0, opts.fetchSize);
      const handle = prepared ? prepared.handle : nextHandleNumber();

      handles.set(handle, { sql, columns, rows: all, isSelect, results, current: 0 });
      lastHandle = handle;

      if (!prepared) {
        out.int(handle).int(0)
          .byte(isSelect ? CAS.CoraDBStatementType.CORADB_STMT_SELECT : statementTypeOf(sql))
          .int((sql.match(/\?/g) || []).length).byte(0).int(columns.length);
        columns.forEach((c) => columnInfo(out, c));
      }

      const total = isSelect ? all.length : answer.affected || 0;

      // The row count (or rows changed): after the column list for a
      // PREPARE_AND_EXECUTE, first thing for an EXECUTE.
      out.int(total);

      // Cache reusable, then one result info per statement.
      out.byte(0).int(results.length);
      results.forEach((r) => {
        const select = Boolean(r.columns);
        out.byte(select ? CAS.CoraDBStatementType.CORADB_STMT_SELECT : CAS.CoraDBStatementType.CORADB_STMT_UPDATE)
          .int(select ? (r.rows || []).length : r.affected || 0).bytes(8).int(0).int(0);
      });
      out.byte(0).int(0); // include_column_info, shard id

      if (isSelect) {
        out.int(0).int(first.length);
        rowsOut(out, first, columns, 1);
      }

      return out.reply();
    };

    const handle = async (frame) => {
      const reply = await handleRequest(frame);
      const entry = log[log.length - 1] || {};
      const fc = frame[8];
      const body = frame.subarray(9);

      // The transaction status, as a CAS keeps it.
      if (fc === FC.CAS_FC_END_TRAN) {
        active = false;
      } else if (fc === FC.CAS_FC_EXECUTE_BATCH) {
        active = body[4] === 0;
      } else if (fc === FC.CAS_FC_CLOSE_REQ_HANDLE) {
        if (body[12] === 1) active = false;
      } else if (entry.autoCommit !== undefined && entry.fc === fc && !(reply && reply.length >= 12 && reply.readInt32BE(8) < 0)) {
        // Without auto-commit the transaction stays open; with it, it stays
        // open only while a result does (a SELECT's rows, several results),
        // until the handle is closed.
        const known = handles.get(entry.handle !== undefined ? entry.handle : lastHandle);
        active = entry.autoCommit === 0 || Boolean(known && (known.isSelect || (known.results && known.results.length > 1)));
      }

      return reply;
    };

    const handleRequest = async (frame) => {
      const fc = frame[8];
      const body = frame.subarray(9);
      // The CAS info the client sent back (bytes 4-7 of the request).
      const entry = { fc, session: logins, casInfo: Buffer.from(frame.subarray(4, 8)) };
      log.push(entry);

      if (opts.handlers[fc]) {
        const custom = await opts.handlers[fc](body, entry, socket);

        if (custom !== undefined) {
          return custom;
        }
      }

      if (fc === FC.CAS_FC_PREPARE_AND_EXECUTE || fc === FC.CAS_FC_PREPARE_AND_EXECUTE_FOR_PROTO_V2) {
        // addInt(3), then the statement.
        const text = readString(body, 8);
        const sql = text.value;
        entry.sql = sql;
        entry.raw = Buffer.from(body);
        // The execute flag (an int length, then the byte) and the query
        // timeout, the last int of the request.
        entry.flag = body[text.next + 14];
        entry.prepareFlag = body[text.next + 4];
        entry.queryTimeout = body.readInt32BE(body.length - 4);
        // addByte(prepare flag), then addByte(auto-commit): each an int
        // length and the byte.
        entry.autoCommit = body[text.next + 5 + 4];
        const answer = await opts.onQuery(sql, entry);
        if (answer.close) {
          socket.end();
          return null;
        }
        return answer.error ? errorReply(answer.error) : statement(sql, answer);
      }

      if (fc === FC.CAS_FC_PREPARE) {
        const text = readString(body, 0);
        const sql = text.value;
        entry.sql = sql;
        // [1][prepare flag] [1][auto-commit]
        entry.prepareFlag = body[text.next + 4];
        const h = nextHandleNumber();
        const isSelect = /^\s*select\b/i.test(sql);
        const columns = isSelect && opts.columnsOf ? opts.columnsOf(sql) : [];
        handles.set(h, { sql, columns, rows: [], isSelect, prepared: true });
        const out = new Out().int(h).int(0)
          .byte(isSelect ? CAS.CoraDBStatementType.CORADB_STMT_SELECT : statementTypeOf(sql))
          .int((sql.match(/\?/g) || []).length).byte(0).int(columns.length);
        columns.forEach((c) => columnInfo(out, c));
        return out.reply();
      }

      if (fc === FC.CAS_FC_EXECUTE) {
        const h = body.readInt32BE(4);
        const known = handles.get(h);
        entry.handle = h;
        entry.sql = known && known.sql;
        entry.raw = Buffer.from(body);
        // [int 4][handle][int 1][execute flag]
        entry.flag = body[12];
        // [4][max col] [4][max row] [0: NULL] [1][fetch flag] [1][auto-commit]
        entry.autoCommit = body[42];
        const answer = await opts.onQuery(known.sql, entry);
        if (answer.close) {
          socket.end();
          return null;
        }
        if (answer.error) return errorReply(answer.error);
        known.columns = answer.columns || known.columns;
        return statement(known.sql, Object.assign({ columns: known.isSelect ? known.columns : undefined }, answer), { handle: h });
      }

      if (fc === FC.CAS_FC_FETCH) {
        const h = body.readInt32BE(4);
        const start = body.readInt32BE(12);
        entry.handle = h;
        const known = handles.get(h);
        const batch = known.rows.slice(start - 1, start - 1 + opts.fetchSize);
        const out = new Out().int(0).int(batch.length);
        rowsOut(out, batch, known.columns, start);
        return out.reply();
      }

      if (fc === FC.CAS_FC_NEXT_RESULT) {
        // [int 4][handle][int 4][0]
        const h = body.readInt32BE(4);
        const known = handles.get(h);
        entry.handle = h;
        if (!known || !known.results || known.current + 1 >= known.results.length) {
          return errorReply({ code: -10022, message: 'No more result set' });
        }
        known.current += 1;
        const r = known.results[known.current];
        known.columns = r.columns || [];
        known.rows = r.rows || [];
        known.isSelect = Boolean(r.columns);
        const out = new Out().int(0)
          .int(known.isSelect ? known.rows.length : r.affected || 0)
          .byte(known.isSelect ? CAS.CoraDBStatementType.CORADB_STMT_SELECT : CAS.CoraDBStatementType.CORADB_STMT_UPDATE)
          .byte(0)
          .int(known.columns.length);
        known.columns.forEach((c) => columnInfo(out, c));
        return out.reply();
      }

      if (fc === FC.CAS_FC_CLOSE_REQ_HANDLE) {
        entry.handle = body.readInt32BE(4);
        handles.delete(entry.handle);
        return new Out().int(0).reply();
      }

      if (fc === FC.CAS_FC_END_TRAN) {
        entry.type = body[body.length - 1];
        return new Out().int(0).reply();
      }

      if (fc === FC.CAS_FC_GET_DB_PARAMETER) {
        entry.parameter = body.readInt32BE(4);
        return new Out().int(0).int(4).reply();
      }

      if (fc === FC.CAS_FC_CON_CLOSE) {
        return new Out().int(0).reply();
      }

      return new Out().int(0).reply();
    };

    socket.on('data', (chunk) => {
      if (stage === 0) {
        if (chunk.subarray(0, 2).toString() === 'X1') {
          // Not a client: a cancel request for the CAS serving one.
          stage = -1;
          log.push({ cancel: true, pid: chunk.readInt32BE(chunk.length - 4) });
          if (opts.onCancel) return opts.onCancel(socket);
          send(Buffer.from([0, 0, 0, 0]));
          return;
        }

        // Client info exchange: keep this socket (port 0).
        connectionLog.push({ clientInfo: true, flags: chunk[7] });
        stage = 1;
        send(Buffer.from([0, 0, 0, 0]));
        return;
      }

      if (stage === -1) {
        return;
      }

      if (stage === 1) {
        // Login.
        stage = 2;
        logins += 1;
        // The session the client asks to resume: the last 20 bytes of the
        // login ("0" for a new one). A session this server gave out is kept.
        const asked = chunk.length >= 628 ? Buffer.from(chunk.subarray(608, 628)) : Buffer.alloc(20);
        const resumed = sessions.has(asked.toString('hex'));
        const session = resumed ? asked : Buffer.alloc(20, 0);

        if (!resumed) {
          session.write(`session-${logins}`);
          sessions.add(session.toString('hex'));
        }

        connectionLog.push({ login: true, session: asked, resumed });
        active = false;

        const b = Buffer.alloc(4 + 4 + 4 + 8 + 4 + 20);
        b.writeInt32BE(b.length - 8, 0);
        b.writeInt32BE(opts.pid, 8);
        Buffer.from([1, 1, opts.statementPooling, 0, CAS.CAS_PROTO_INDICATOR | CAS.CAS_PROTOCOL_VERSION, opts.brokerFlags, 0, 0]).copy(b, 12);
        b.writeInt32BE(7, 20); // CAS id
        session.copy(b, 24);
        send(b);
        return;
      }

      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= 8) {
        const len = pending.readInt32BE(0) + 8;

        if (pending.length < len) break;

        const frame = pending.subarray(0, len);
        pending = pending.subarray(len);
        busy = busy.then(() => handle(frame)).then((reply) => {
          if (Buffer.isBuffer(reply) && reply.length >= 8) {
            reply[4] = active ? 1 : 0;
          }
          send(reply);
        }, () => undefined);
      }
    });
  });

  await new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    log,
    connectionLog,
    /** How many logins the server has answered. */
    logins: () => logins,
    /** Close every client socket from the server's side (FIN). */
    dropAll: () => {
      for (const s of sockets) s.end();
    },
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

module.exports = { fakeCas, Out, columnInfo, typeBytes, errorReply, TYPES };
