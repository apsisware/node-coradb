'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');

/*
 * Every column type, written to the live server in each way the driver can
 * write it and read back in each way it can read it:
 *
 *   written as SQL literals, bound by sql(), by prepare().run(), by
 *   executeWithTypedParams(), and formatted into the text by execute(sql, params);
 *
 *   read by sql() with and without bound values, by the old query protocol,
 *   by query() / queryAllAsObjects(), and a batch at a time by a cursor.
 *
 * The table is created before each test and dropped after it (and before and
 * after the file), so nothing stays in the database.
 */

const TABLE_NAME = 'tbl_test';

const CREATE_TABLE = `CREATE TABLE ${TABLE_NAME} (
  id INT PRIMARY KEY,
  c_short SHORT, c_int INT, c_bigint BIGINT,
  c_float FLOAT, c_double DOUBLE, c_numeric NUMERIC(38,10), c_monetary MONETARY,
  c_char CHAR(5), c_varchar VARCHAR(200),
  c_bit BIT(16), c_varbit BIT VARYING(64),
  c_date DATE, c_time TIME, c_datetime DATETIME, c_timestamp TIMESTAMP,
  c_set SET OF INT, c_multiset MULTISET OF VARCHAR(20), c_list LIST OF DOUBLE,
  c_enum ENUM('red', 'green', 'blue'), c_json JSON,
  c_dttz DATETIMETZ, c_dtltz DATETIMELTZ, c_tstz TIMESTAMPTZ, c_tsltz TIMESTAMPLTZ
)`;

// Every column, in table order.
const COLUMNS = [
  'id', 'c_short', 'c_int', 'c_bigint', 'c_float', 'c_double', 'c_numeric', 'c_monetary',
  'c_char', 'c_varchar', 'c_bit', 'c_varbit', 'c_date', 'c_time', 'c_datetime', 'c_timestamp',
  'c_set', 'c_multiset', 'c_list', 'c_enum', 'c_json', 'c_dttz', 'c_dtltz', 'c_tstz', 'c_tsltz',
];

// The type the server reports for each column (Column.type).
const COLUMN_TYPES = {
  id: 'Int', c_short: 'Short', c_int: 'Int', c_bigint: 'Bigint',
  c_float: 'Float', c_double: 'Double', c_numeric: 'Numeric', c_monetary: 'Monetary',
  c_char: 'Char', c_varchar: 'String', c_bit: 'Bit', c_varbit: 'Varbit',
  c_date: 'Date', c_time: 'Time', c_datetime: 'DateTime', c_timestamp: 'Timestamp',
  c_set: 'Set', c_multiset: 'Multiset', c_list: 'Sequence',
  c_enum: 'ENUM', c_json: 'Json',
  c_dttz: 'DateTimeTz', c_dtltz: 'DateTimeLtz', c_tstz: 'TimestampTz', c_tsltz: 'TimestampLtz',
};

// ASCII only: olympics1988-2004 is an ISO-8859-1 database (db_root.charset 3).
// Strings go out as UTF-8 and come back decoded in the column's charset, as
// the JDBC driver sends and reads them, so other characters would not survive.
const VARCHAR_TEXT = 'it\'s a "test" \\ ok; 50% _off_ [x] {y} ?';
const JSON_TEXT = '{"a":[1,2,{"b":null}]}';

// The session's zone, set on every connection: the LTZ types are read in it.
const SESSION_ZONE = 'Asia/Seoul';

// The time-zone columns are always written as literals: no bind type exists
// for them.
const TZ_LITERALS =
  'DATETIMETZ\'2017-04-05 13:30:30.500 Asia/Seoul\', ' +
  'DATETIMELTZ\'2017-04-05 13:30:30.500 Asia/Seoul\', ' +
  'TIMESTAMPTZ\'2017-04-05 13:30:30 Europe/Bucharest\', ' +
  'TIMESTAMPLTZ\'2017-04-05 13:30:30 Asia/Seoul\'';

// The other columns' values as SQL literals.
const SCALAR_LITERALS = [
  '-32768', '-2147483648', '9223372036854775807',
  '3.5', '1.7976931348623157e308', '12345678901234567890.0123456789', '1234.56',
  '\'ab\'', `'${VARCHAR_TEXT.replaceAll('\'', '\'\'')}'`,
  'X\'0aff\'', 'X\'00ff10\'',
  'DATE\'2004-08-13\'', 'TIME\'23:59:58\'', 'DATETIME\'2004-08-13 20:45:01.007\'', 'TIMESTAMP\'2004-08-13 20:45:01\'',
];
const COLLECTION_LITERALS = ['{3, 1, 2}', '{\'b\', \'a\', \'a\'}', '{1.5, -2.25}'];
const ENUM_JSON_LITERALS = ['\'green\'', `'${JSON_TEXT}'`];

const DATETIME = new Date(Date.UTC(2004, 7, 13, 20, 45, 1, 7));

/** INSERT with the given expressions for the columns after `id`, tz columns as literals. */
function insertSql(expressions) {
  return `INSERT INTO ${TABLE_NAME} VALUES (?, ${expressions.join(', ')}, ${TZ_LITERALS})`;
}

const PLACEHOLDERS_20 = new Array(20).fill('?');

/** The values bound for the 20 columns between id and the time-zone ones. */
function boundValues() {
  return [
    { type: 'short', value: -32768 },
    -2147483648,
    9223372036854775807n,
    { type: 'float', value: 3.5 },
    { type: 'double', value: 1.7976931348623157e308 },
    { type: 'numeric', value: '12345678901234567890.0123456789' },
    { type: 'monetary', value: 1234.56 },
    'ab',
    VARCHAR_TEXT,
    { type: 'bit', value: Buffer.from('0aff', 'hex') },
    Buffer.from('00ff10', 'hex'),
    { type: 'date', value: '2004-08-13' },
    { type: 'time', value: '23:59:58' },
    DATETIME,
    { type: 'timestamp', value: '2004-08-13 20:45:01' },
    { type: 'set of int', value: [3, 1, 2] },
    { type: 'multiset', value: ['b', 'a', 'a'] },
    { type: 'list', elementType: 'double', value: [1.5, -2.25] },
    'green',
    { type: 'json', value: JSON.parse(JSON_TEXT) },
  ];
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

/** Check one row (an object keyed by column name) against the values written. */
function checkRow(row, id, how) {
  const at = (column) => `${how}: ${column}`;

  expect(Object.keys(row), at('columns')).to.deep.equal(COLUMNS);
  expect(row.id, at('id')).to.equal(id);

  expect(row.c_short, at('c_short')).to.equal(-32768);
  expect(row.c_int, at('c_int')).to.equal(-2147483648);
  // Beyond Number.MAX_SAFE_INTEGER: its decimal text.
  expect(row.c_bigint, at('c_bigint')).to.equal('9223372036854775807');
  expect(row.c_float, at('c_float')).to.equal(3.5);
  expect(row.c_double, at('c_double')).to.equal(1.7976931348623157e308);
  // More digits than a number keeps: its text.
  expect(row.c_numeric, at('c_numeric')).to.equal('12345678901234567890.0123456789');
  expect(row.c_monetary, at('c_monetary')).to.equal(1234.56);

  // CHAR is padded to its length.
  expect(row.c_char, at('c_char')).to.equal('ab   ');
  expect(row.c_varchar, at('c_varchar')).to.equal(VARCHAR_TEXT);

  expect(Buffer.isBuffer(row.c_bit), at('c_bit')).to.equal(true);
  expect(row.c_bit.toString('hex'), at('c_bit')).to.equal('0aff');
  expect(row.c_varbit.toString('hex'), at('c_varbit')).to.equal('00ff10');

  // Wall-clock times, in the Date's UTC fields.
  expect(iso(row.c_date), at('c_date')).to.equal('2004-08-13T00:00:00.000Z');
  expect(iso(row.c_time), at('c_time')).to.equal('1970-01-01T23:59:58.000Z');
  expect(iso(row.c_datetime), at('c_datetime')).to.equal('2004-08-13T20:45:01.007Z');
  expect(iso(row.c_timestamp), at('c_timestamp')).to.equal('2004-08-13T20:45:01.000Z');

  // A SET is kept sorted and without duplicates; a MULTISET keeps them.
  expect(row.c_set, at('c_set')).to.deep.equal([1, 2, 3]);
  expect(row.c_multiset.slice().sort(), at('c_multiset')).to.deep.equal(['a', 'a', 'b']);
  // A LIST keeps its order.
  expect(row.c_list, at('c_list')).to.deep.equal([1.5, -2.25]);

  expect(row.c_enum, at('c_enum')).to.equal('green');
  expect(JSON.parse(row.c_json), at('c_json')).to.deep.equal(JSON.parse(JSON_TEXT));

  checkZoned(row.c_dttz, '2017-04-05T13:30:30.500Z', 'Asia/Seoul KST', '+09', '2017-04-05T04:30:30.500Z', at('c_dttz'));
  checkZoned(row.c_dtltz, '2017-04-05T13:30:30.500Z', 'Asia/Seoul KST', '+09', '2017-04-05T04:30:30.500Z', at('c_dtltz'));
  checkZoned(row.c_tstz, '2017-04-05T13:30:30.000Z', 'Europe/Bucharest EEST', '+03', '2017-04-05T10:30:30.000Z', at('c_tstz'));
  checkZoned(row.c_tsltz, '2017-04-05T13:30:30.000Z', 'Asia/Seoul KST', '+09', '2017-04-05T04:30:30.000Z', at('c_tsltz'));
}

/** A time-zone value: its wall-clock time, its zone, its offset and the instant. */
function checkZoned(value, wallClock, zone, tzh, instant, label) {
  expect(value, label).to.be.an('object');
  expect(iso(value.datetime), label).to.equal(wallClock);
  expect(value.timezone, label).to.equal(zone);
  expect(value.tzh, label).to.equal(tzh);
  expect(value.tzm, label).to.equal('00');
  expect(new Date(value.valueOf()).toISOString(), label).to.equal(instant);
}

/** A row of the classic API (parallel arrays) as an object. */
function asObject(resultSet, index) {
  const row = {};

  resultSet.ColumnNames.forEach((name, i) => {
    row[name] = resultSet.ColumnValues[index][i];
  });

  return row;
}

/** Read row `id` in every way the driver reads, and check each. */
async function readAndCheck(client, id) {
  const select = `SELECT * FROM ${TABLE_NAME} WHERE id = ${id}`;

  // sql() with a bound value: EXECUTE.
  const bound = await client.sql(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`, [id]);

  expect(bound.rows, 'sql(bound)').to.have.length(1);
  checkRow(bound.rows[0], id, 'sql(bound)');
  bound.columns.forEach((c) => {
    expect(c.type, `sql(bound) column ${c.name}`).to.equal(COLUMN_TYPES[c.name]);
  });
  expect(bound.columns.find((c) => c.name === 'c_set').elementType).to.equal('Int');
  expect(bound.columns.find((c) => c.name === 'c_multiset').elementType).to.equal('String');
  expect(bound.columns.find((c) => c.name === 'c_list').elementType).to.equal('Double');

  // sql() without values: PREPARE_AND_EXECUTE.
  checkRow((await client.sql(select)).rows[0], id, 'sql(text)');

  // The same through the old query protocol (PREPARE, then EXECUTE).
  client.setEnforceOldQueryProtocol(true);

  try {
    checkRow((await client.sql(select)).rows[0], id, 'sql(old protocol)');
  } finally {
    client.setEnforceOldQueryProtocol(false);
  }

  // The classic API.
  const { result, queryHandle } = await client.query(select);

  try {
    expect(result.ColumnNames).to.deep.equal(COLUMNS);
    expect(result.ColumnDataTypes).to.deep.equal(COLUMNS.map((c) => COLUMN_TYPES[c]));
    checkRow(asObject(result, 0), id, 'query()');
  } finally {
    await client.closeQuery(queryHandle);
  }

  checkRow((await client.queryAllAsObjects(select))[0], id, 'queryAllAsObjects()');
}

/** A connection whose session reads the LTZ types in SESSION_ZONE. */
async function connect() {
  const client = testSetup.createDefaultCoraDBDemodbConnection();

  await client.sql(`SET SYSTEM PARAMETERS 'timezone=${SESSION_ZONE}'`);

  return client;
}

describe('CoraDBConnection', function () {
  describe('data types, written and read back', function () {
    this.timeout(30000);

    // The table is the test's own: made for each test, dropped after it.
    beforeEach(testSetup.cleanup(TABLE_NAME));
    beforeEach(async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.execute(CREATE_TABLE);
      } finally {
        await client.close();
      }
    });
    afterEach(testSetup.cleanup(TABLE_NAME));

    it('reads every type written as SQL literals', async function () {
      const client = await connect();

      try {
        await client.execute(insertSql(SCALAR_LITERALS.concat(COLLECTION_LITERALS, ENUM_JSON_LITERALS)).replace('?', '1'));
        await readAndCheck(client, 1);
      } finally {
        await client.close();
      }
    });

    it('writes every type bound by sql()', async function () {
      const client = await connect();

      try {
        const { affectedRows } = await client.sql(insertSql(PLACEHOLDERS_20), [2].concat(boundValues()));

        expect(affectedRows).to.equal(1);
        await readAndCheck(client, 2);
      } finally {
        await client.close();
      }
    });

    it('writes every type bound by prepare().run(), several times', async function () {
      const client = await connect();

      try {
        const stmt = await client.prepare(insertSql(PLACEHOLDERS_20));

        expect(stmt.paramCount).to.equal(21);

        for (const id of [3, 4, 5]) {
          expect((await stmt.run([id].concat(boundValues()))).affectedRows).to.equal(1);
        }

        await stmt.close();

        for (const id of [3, 4, 5]) {
          await readAndCheck(client, id);
        }
      } finally {
        await client.close();
      }
    });

    it('writes every type with executeWithTypedParams()', async function () {
      const client = await connect();

      try {
        const types = [
          'int', 'short', 'int', 'bigint', 'float', 'double', 'numeric', 'monetary',
          'char', 'varchar', 'bit', 'varbit', 'date', 'time', 'datetime', 'timestamp',
          'set of int', 'multiset of varchar', 'list of double', 'varchar', 'json',
        ];
        const values = [
          6, -32768, -2147483648, '9223372036854775807', 3.5, 1.7976931348623157e308,
          '12345678901234567890.0123456789', 1234.56, 'ab', VARCHAR_TEXT,
          Buffer.from('0aff', 'hex'), Buffer.from('00ff10', 'hex'),
          '2004-08-13', '23:59:58', '2004-08-13 20:45:01.007', '2004-08-13 20:45:01',
          [3, 1, 2], ['b', 'a', 'a'], [1.5, -2.25], 'green', JSON_TEXT,
        ];

        expect(await client.executeWithTypedParams(insertSql(PLACEHOLDERS_20), values, types)).to.equal(1);
        await readAndCheck(client, 6);
      } finally {
        await client.close();
      }
    });

    it('writes every scalar type formatted into the text by execute(sql, params)', async function () {
      const client = await connect();

      try {
        // The classic API writes the values into the statement as SQL text
        // (no bind types): collections stay literals.
        const placeholders = new Array(15).fill('?').concat(COLLECTION_LITERALS, ['?', '?']);
        const values = [
          7, -32768, -2147483648, 9223372036854775807n, 3.5, 1.7976931348623157e308,
          '12345678901234567890.0123456789', 1234.56, 'ab', VARCHAR_TEXT,
          Buffer.from('0aff', 'hex'), Buffer.from('00ff10', 'hex'),
          '2004-08-13', '23:59:58', DATETIME, '2004-08-13 20:45:01',
          'green', JSON_TEXT,
        ];

        expect(await client.execute(insertSql(placeholders), values)).to.equal(1);
        await readAndCheck(client, 7);
      } finally {
        await client.close();
      }
    });

    it('writes booleans as 1 and 0, and NULL for null and undefined', async function () {
      const client = await connect();

      try {
        await client.sql(`INSERT INTO ${TABLE_NAME} (id, c_short, c_int, c_varchar) VALUES (?, ?, ?, ?)`, [8, true, false, null]);
        await client.execute(`INSERT INTO ${TABLE_NAME} (id, c_short, c_int, c_varchar) VALUES (?, ?, ?, ?)`, [9, true, false, undefined]);

        const { rows } = await client.sql(`SELECT id, c_short, c_int, c_varchar FROM ${TABLE_NAME} ORDER BY id`, { rowsAs: 'arrays' });

        expect(rows).to.deep.equal([[8, 1, 0, null], [9, 1, 0, null]]);
      } finally {
        await client.close();
      }
    });

    it('reads NULL in every column, in every way', async function () {
      const client = await connect();

      try {
        await client.sql(`INSERT INTO ${TABLE_NAME} (id) VALUES (?)`, [10]);

        const expected = Object.fromEntries(COLUMNS.map((c) => [c, c === 'id' ? 10 : null]));
        const select = `SELECT * FROM ${TABLE_NAME} WHERE id = 10`;

        expect((await client.sql(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`, [10])).rows).to.deep.equal([expected]);
        expect((await client.sql(select)).rows).to.deep.equal([expected]);
        expect(await client.queryAllAsObjects(select)).to.deep.equal([expected]);
      } finally {
        await client.close();
      }
    });

    it('reads edge values: unsafe and safe BIGINTs, exact NUMERICs, the zero date, NULL in a collection, an empty set', async function () {
      const client = await connect();

      try {
        await client.execute(`INSERT INTO ${TABLE_NAME} (id, c_bigint, c_numeric, c_monetary, c_date, c_datetime, c_set, c_list) ` +
          'VALUES (11, 9007199254740993, 0.1000000000, -0.01, DATE\'0000-00-00\', DATETIME\'0000-00-00 00:00:00\', {}, {NULL, 5})');
        await client.execute(`INSERT INTO ${TABLE_NAME} (id, c_bigint, c_numeric, c_date, c_datetime) ` +
          'VALUES (12, -9007199254740991, 123.4, DATE\'0001-01-01\', DATETIME\'9999-12-31 23:59:59.999\')');

        const { rows } = await client.sql(
          `SELECT id, c_bigint, c_numeric, c_monetary, c_date, c_datetime, c_set, c_list FROM ${TABLE_NAME} WHERE id >= ? ORDER BY id`,
          [11]
        );

        // Above 2^53: text, so the value is not changed.
        expect(rows[0].c_bigint).to.equal('9007199254740993');
        // Within range: a number.
        expect(rows[1].c_bigint).to.equal(-9007199254740991);
        // A NUMERIC a number keeps exactly comes back as one.
        expect(rows[0].c_numeric).to.equal(0.1);
        expect(rows[1].c_numeric).to.equal(123.4);
        expect(rows[0].c_monetary).to.equal(-0.01);
        // The zero date has no Date: null.
        expect(rows[0].c_date).to.equal(null);
        expect(rows[0].c_datetime).to.equal(null);
        expect(iso(rows[1].c_date)).to.equal('0001-01-01T00:00:00.000Z');
        expect(iso(rows[1].c_datetime)).to.equal('9999-12-31T23:59:59.999Z');
        expect(rows[0].c_set).to.deep.equal([]);
        expect(rows[0].c_list).to.deep.equal([null, 5]);

        // The same through the classic API.
        const classic = await client.queryAllAsObjects(`SELECT c_bigint, c_numeric, c_date FROM ${TABLE_NAME} WHERE id = 11`);

        expect(classic).to.deep.equal([{ c_bigint: '9007199254740993', c_numeric: 0.1, c_date: null }]);
      } finally {
        await client.close();
      }
    });

    it('reads every type across fetch batches (1500 rows, by cursor and by queryAll)', async function () {
      const client = await connect();
      const ROWS = 1500;

      try {
        await client.execute(insertSql(SCALAR_LITERALS.concat(COLLECTION_LITERALS, ENUM_JSON_LITERALS)).replace('?', '1'));
        // 1499 copies of row 1, with ids 2..1500.
        const copied = await client.execute(
          `INSERT INTO ${TABLE_NAME} SELECT ROWNUM + 1, ${COLUMNS.slice(1).map((c) => `t.${c}`).join(', ')} ` +
          `FROM athlete_result a, ${TABLE_NAME} t WHERE t.id = 1 AND ROWNUM <= ${ROWS - 1}`
        );

        expect(copied).to.equal(ROWS - 1);

        const select = `SELECT * FROM ${TABLE_NAME} ORDER BY id`;
        const cursor = await client.cursor(select);
        let seen = 0;
        let batches = 0;

        for (let batch = await cursor.next(); batch.length > 0; batch = await cursor.next()) {
          batches += 1;
          batch.forEach((row) => {
            seen += 1;
            checkRow(row, seen, `cursor row ${seen}`);
          });
        }

        expect(seen).to.equal(ROWS);
        expect(batches, 'more than one fetch').to.be.above(1);

        const all = await client.queryAll(select);

        expect(all.ColumnValues).to.have.length(ROWS);
        checkRow(asObject(all, ROWS - 1), ROWS, 'queryAll() last row');
      } finally {
        await client.close();
      }
    });
  });

  describe('each type bound on its own', function () {
    // One column, one value at a time: when binding fails, the test that
    // fails names the type, and the message carries the server's code.
    this.timeout(30000);

    beforeEach(testSetup.cleanup(TABLE_NAME));
    beforeEach(async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.execute(CREATE_TABLE);
      } finally {
        await client.close();
      }
    });
    afterEach(testSetup.cleanup(TABLE_NAME));

    // [column, value for sql(), type and value for executeWithTypedParams(), what comes back]
    const CASES = [
      ['c_short', { type: 'short', value: -32768 }, 'short', -32768, -32768],
      ['c_int', -2147483648, 'int', -2147483648, -2147483648],
      ['c_bigint', 9223372036854775807n, 'bigint', '9223372036854775807', '9223372036854775807'],
      ['c_float', { type: 'float', value: 3.5 }, 'float', 3.5, 3.5],
      ['c_double', { type: 'double', value: 1.7976931348623157e308 }, 'double', 1.7976931348623157e308, 1.7976931348623157e308],
      ['c_numeric', { type: 'numeric', value: '12345678901234567890.0123456789' }, 'numeric',
        '12345678901234567890.0123456789', '12345678901234567890.0123456789'],
      ['c_monetary', { type: 'monetary', value: 1234.56 }, 'monetary', 1234.56, 1234.56],
      ['c_char', 'ab', 'char', 'ab', 'ab   '],
      ['c_varchar', VARCHAR_TEXT, 'varchar', VARCHAR_TEXT, VARCHAR_TEXT],
      ['c_bit', { type: 'bit', value: Buffer.from('0aff', 'hex') }, 'bit', Buffer.from('0aff', 'hex'), Buffer.from('0aff', 'hex')],
      ['c_varbit', Buffer.from('00ff10', 'hex'), 'varbit', Buffer.from('00ff10', 'hex'), Buffer.from('00ff10', 'hex')],
      ['c_date', { type: 'date', value: '2004-08-13' }, 'date', '2004-08-13', '2004-08-13T00:00:00.000Z'],
      ['c_time', { type: 'time', value: '23:59:58' }, 'time', '23:59:58', '1970-01-01T23:59:58.000Z'],
      ['c_datetime', DATETIME, 'datetime', '2004-08-13 20:45:01.007', '2004-08-13T20:45:01.007Z'],
      ['c_timestamp', { type: 'timestamp', value: '2004-08-13 20:45:01' }, 'timestamp', '2004-08-13 20:45:01', '2004-08-13T20:45:01.000Z'],
      ['c_set', { type: 'set of int', value: [3, 1, 2] }, 'set of int', [3, 1, 2], [1, 2, 3]],
      ['c_multiset', { type: 'multiset', value: ['b', 'a', 'a'] }, 'multiset of varchar', ['b', 'a', 'a'], ['a', 'a', 'b']],
      ['c_list', { type: 'list', elementType: 'double', value: [1.5, -2.25] }, 'list of double', [1.5, -2.25], [1.5, -2.25]],
      ['c_enum', 'green', 'varchar', 'green', 'green'],
      ['c_json', { type: 'json', value: JSON.parse(JSON_TEXT) }, 'json', JSON_TEXT, JSON_TEXT],
      // A string the server converts to the column's type.
      ['c_json', JSON_TEXT, 'varchar', JSON_TEXT, JSON_TEXT],
    ];

    /** What was read, comparable with deep.equal. */
    function comparable(column, value) {
      if (value instanceof Date) return value.toISOString();
      if (Buffer.isBuffer(value)) return value.toString('hex');
      if (column === 'c_multiset' && Array.isArray(value)) return value.slice().sort();
      if (column === 'c_json' && typeof value === 'string') return JSON.parse(value);
      return value;
    }

    /** Run `write`, and on failure say which column and type, with the server's code. */
    async function named(label, write) {
      try {
        return await write();
      } catch (err) {
        err.message = `${label}: ${err.message} (code ${err.code})`;
        throw err;
      }
    }

    CASES.forEach(([column, boundValue, typedType, typedValue, expected], n) => {
      const id = n + 1;
      const kind = Buffer.isBuffer(boundValue) ? 'Buffer'
        : boundValue instanceof Date ? 'Date'
          : typeof boundValue === 'object' ? `'${boundValue.type}'` : typeof boundValue;
      const what = `${column} (${kind})`;

      it(`binds ${what} with sql() and prepare().run()`, async function () {
        const client = await connect();

        try {
          const insert = `INSERT INTO ${TABLE_NAME} (id, ${column}) VALUES (?, ?)`;

          await named(`sql() ${what}`, () => client.sql(insert, [id, boundValue]));

          const stmt = await client.prepare(insert);

          await named(`prepare().run() ${what}`, () => stmt.run([id + 100, boundValue]));
          await stmt.close();

          const { rows } = await client.sql(`SELECT ${column} AS v FROM ${TABLE_NAME} ORDER BY id`);

          expect(rows.map((r) => comparable(column, r.v))).to.deep.equal([expected, expected].map((e) => comparable(column, e)));
        } finally {
          await client.close();
        }
      });

      it(`binds ${column} as '${typedType}' with executeWithTypedParams()`, async function () {
        const client = await connect();

        try {
          await named(`executeWithTypedParams() ${column} '${typedType}'`, () => client.executeWithTypedParams(
            `INSERT INTO ${TABLE_NAME} (id, ${column}) VALUES (?, ?)`, [id, typedValue], ['int', typedType]
          ));

          const { rows } = await client.sql(`SELECT ${column} AS v FROM ${TABLE_NAME}`);

          expect(comparable(column, rows[0].v)).to.deep.equal(comparable(column, expected));
        } finally {
          await client.close();
        }
      });
    });

    it('binds an id next to time-zone literals in a prepared INSERT', async function () {
      const client = await connect();

      try {
        await named('sql() with time-zone literals', () => client.sql(
          `INSERT INTO ${TABLE_NAME} (id, c_dttz, c_dtltz, c_tstz, c_tsltz) VALUES (?, ${TZ_LITERALS})`, [1]
        ));

        const { rows } = await client.sql(`SELECT c_dttz FROM ${TABLE_NAME}`);

        expect(rows[0].c_dttz.timezone).to.equal('Asia/Seoul KST');
      } finally {
        await client.close();
      }
    });
  });

  describe('time-zone values', function () {
    this.timeout(30000);

    beforeEach(testSetup.cleanup(TABLE_NAME));
    afterEach(testSetup.cleanup(TABLE_NAME));

    it('reads the LTZ types in the session\'s zone: the same instant, another wall clock', async function () {
      const client = await connect();

      try {
        await client.execute(`CREATE TABLE ${TABLE_NAME} (id INT, c_dtltz DATETIMELTZ, c_tsltz TIMESTAMPLTZ, c_dttz DATETIMETZ)`);
        await client.execute(`INSERT INTO ${TABLE_NAME} VALUES (1, DATETIMELTZ'2017-04-05 13:30:30.500 Asia/Seoul', ` +
          'TIMESTAMPLTZ\'2017-04-05 13:30:30 Asia/Seoul\', DATETIMETZ\'2017-04-05 13:30:30.500 Asia/Seoul\')');

        await client.sql('SET SYSTEM PARAMETERS \'timezone=Europe/Zurich\'');

        const { rows } = await client.sql(`SELECT c_dtltz, c_tsltz, c_dttz FROM ${TABLE_NAME}`);

        // 04:30:30.5 UTC is 06:30:30.5 in Zurich (CEST, +02).
        checkZoned(rows[0].c_dtltz, '2017-04-05T06:30:30.500Z', 'Europe/Zurich CEST', '+02', '2017-04-05T04:30:30.500Z', 'c_dtltz');
        checkZoned(rows[0].c_tsltz, '2017-04-05T06:30:30.000Z', 'Europe/Zurich CEST', '+02', '2017-04-05T04:30:30.000Z', 'c_tsltz');
        // A TZ value keeps its own zone.
        checkZoned(rows[0].c_dttz, '2017-04-05T13:30:30.500Z', 'Asia/Seoul KST', '+09', '2017-04-05T04:30:30.500Z', 'c_dttz');
      } finally {
        await client.close();
      }
    });

    it('tells apart the two readings of the hour repeated when daylight saving time ends', async function () {
      const client = await connect();

      try {
        await client.execute(`CREATE TABLE ${TABLE_NAME} (id INT, c_dttz DATETIMETZ)`);
        await client.execute(`INSERT INTO ${TABLE_NAME} VALUES ` +
          '(1, DATETIMETZ\'2017-11-05 01:30:00 America/New_York EDT\'), ' +
          '(2, DATETIMETZ\'2017-11-05 01:30:00 America/New_York EST\')');

        const { rows } = await client.sql(`SELECT c_dttz FROM ${TABLE_NAME} ORDER BY id`);

        // The same wall clock, an hour apart.
        checkZoned(rows[0].c_dttz, '2017-11-05T01:30:00.000Z', 'America/New_York EDT', '-04', '2017-11-05T05:30:00.000Z', 'EDT');
        checkZoned(rows[1].c_dttz, '2017-11-05T01:30:00.000Z', 'America/New_York EST', '-05', '2017-11-05T06:30:00.000Z', 'EST');
        expect(rows[0].c_dttz.getOffset()).to.equal(4 * 3600000);
        expect(rows[1].c_dttz.getOffset()).to.equal(5 * 3600000);
      } finally {
        await client.close();
      }
    });

    it('formats a value read from the server', async function () {
      const client = await connect();

      try {
        const { rows } = await client.sql('SELECT DATETIMETZ\'2017-04-05 13:30:30.500 Asia/Seoul\' AS v');
        const v = rows[0].v;

        expect(v.toString()).to.equal('2017-04-05 13:30:30.500 Asia/Seoul KST');
        expect(v.format('YYYY-MM-DD HH24:MI:SS.FF TZD TZH:TZM')).to.equal('2017-04-05 13:30:30.500 KST +09:00');
        expect(v.format('DAY, DD MONTH YYYY HH12:MI AM')).to.equal('Wednesday, 05 April 2017 01:30 PM');
        expect(v.getOffset()).to.equal(-9 * 3600000);
      } finally {
        await client.close();
      }
    });
  });
});
