'use strict';

const expect = require('chai').expect;
const CoraDB = require('../../index');
const testSetup = require('./testSetup');
const CAS = require('../../src/constants/CASConstants');
const OpenDatabasePacket = require('../../src/packets/OpenDatabasePacket');

/*
 * Against the live server: the behaviours the driver now shares with the JDBC
 * driver (coradb-jdbc). The wire details are unit-tested in
 * test/unit-test/test_CoraDBConnection.jdbc.js.
 */
describe('CoraDBConnection', function () {
  describe('as the JDBC driver does it', function () {
    const TABLE_NAME = 'tbl_test';
    // Its name matches `event_gender` as a LIKE pattern (`_` is any one
    // character), not as a name.
    const LOOKALIKE = 'eventxgender';

    this.timeout(20000);

    beforeEach(testSetup.cleanup(TABLE_NAME));
    beforeEach(testSetup.cleanup(LOOKALIKE));
    after(testSetup.cleanup(TABLE_NAME));
    after(testSetup.cleanup(LOOKALIKE));

    it('commits the work done when setAutoCommitMode() changes the mode (setAutoCommit)', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();
      const other = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.execute(`CREATE TABLE ${TABLE_NAME}(id INT)`);
        await client.setAutoCommitMode(false);
        await client.execute(`INSERT INTO ${TABLE_NAME} VALUES (1)`);

        // Turning auto-commit back on commits the INSERT.
        await client.setAutoCommitMode(true);

        const { rows } = await other.sql(`SELECT COUNT(*) AS n FROM ${TABLE_NAME}`);

        expect(Number(rows[0].n)).to.equal(1);
      } finally {
        await other.close();
        await client.close();
      }
    });

    it('keeps a result open across a commit (holdable results)', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.execute(`CREATE TABLE ${TABLE_NAME}(id INT)`);
        await client.setAutoCommitMode(false);

        const cursor = await client.cursor('SELECT * FROM athlete_result ORDER BY 1, 2, 4', { rowsAs: 'arrays' });
        const first = await cursor.next();

        expect(first.length).to.be.above(0);

        await client.execute(`INSERT INTO ${TABLE_NAME} VALUES (1)`);
        await client.commit();

        // Still open: the next batch comes, and the rows add up.
        let total = first.length;

        for (let batch = await cursor.next(); batch.length > 0; batch = await cursor.next()) {
          total += batch.length;
        }

        expect(total).to.equal(1935);
        await client.setAutoCommitMode(true);
      } finally {
        await client.close();
      }
    });

    it('reports primary-key and NOT NULL columns as not nullable (isNullable = !is_non_null)', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        // athlete: id INTEGER NOT NULL (the primary key), last_name VARCHAR(32)
        // NOT NULL, birth_date DATE (nullable). The driver used to report them
        // the other way round.
        const expected = [['id', false], ['last_name', false], ['birth_date', true]];

        const text = await client.sql('SELECT id, last_name, birth_date FROM athlete WHERE ROWNUM <= 1');
        const bound = await client.sql('SELECT id, last_name, birth_date FROM athlete WHERE id = ?', [0]);

        expect(text.columns.map((c) => [c.name, c.nullable])).to.deep.equal(expected);
        expect(bound.columns.map((c) => [c.name, c.nullable])).to.deep.equal(expected);
      } finally {
        await client.close();
      }
    });

    it('talks ISO-8859-1 to an ISO-8859-1 database with charset: iso-8859-1 (charSet)', async function () {
      // The dataset is ISO-8859-1. Sent as UTF-8 (the default), U+00E9 would
      // be stored as two characters.
      const client = CoraDB.createConnection(Object.assign({}, testSetup.config, { charset: 'iso-8859-1' }));
      const reader = testSetup.createDefaultCoraDBDemodbConnection();
      const word = 'caf' + String.fromCharCode(0xe9);

      try {
        await client.execute(`CREATE TABLE ${TABLE_NAME}(id INT, s VARCHAR(20))`);
        await client.execute(`INSERT INTO ${TABLE_NAME} VALUES (1, '${word}')`);
        await client.sql(`INSERT INTO ${TABLE_NAME} VALUES (?, ?)`, [2, word]);

        const { rows } = await client.sql(`SELECT id, s, CHAR_LENGTH(s) AS n FROM ${TABLE_NAME} WHERE s = ? ORDER BY id`, [word]);

        expect(rows.map((r) => [r.id, r.s, Number(r.n)])).to.deep.equal([[1, word, 4], [2, word, 4]]);

        // Values are read in their column's charset, whatever the connection's.
        const back = await reader.sql(`SELECT s FROM ${TABLE_NAME} WHERE id = 1`);

        expect(back.rows[0].s).to.equal(word);

        // A character ISO-8859-1 has no byte for is refused, not sent.
        await client.sql(`INSERT INTO ${TABLE_NAME} VALUES (3, ?)`, [String.fromCharCode(0x20ac)])
          .then(() => {
            throw new Error('The euro sign should have been refused.');
          }, (err) => {
            expect(err.code).to.equal('INVALID_PARAMETER');
          });
      } finally {
        await reader.close();
        await client.close();
      }
    });

    it('gets the CAS errors in the renewed numbering', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.query('SELECT * FROM country WHERE iso3 = ?', undefined)
          .then(() => {
            throw new Error('A `?` left unbound should have been refused.');
          }, (err) => {
            // CAS_ER_NUM_BIND: -10007, not the old -1007.
            expect(err.code).to.equal(-10007);
          });
      } finally {
        await client.close();
      }
    });

    it('asks for its session again when it reconnects', async function () {
      // What the driver controls: the reconnect's login sends back the session
      // id the first login answered with, as JDBC's checkReconnect() does.
      // Whether the server then resumes that session is up to the server: the
      // CoraDB server answers an abrupt disconnect with a new session (its
      // @variables are gone), so the test does not check them.
      const client = testSetup.createDefaultCoraDBDemodbConnection();
      const sent = [];
      const write = OpenDatabasePacket.prototype.write;

      OpenDatabasePacket.prototype.write = function (writer) {
        const session = this.options.session;

        sent.push(Buffer.isBuffer(session) ? Buffer.from(session) : null);

        return write.call(this, writer);
      };

      try {
        await client.execute('SELECT 1');

        const first = Buffer.from(client._session);

        expect(first).to.have.length(20);
        expect(sent).to.deep.equal([null]);

        // The socket goes; the next request logs in again.
        await new Promise((resolve) => {
          client._socket.once('close', resolve);
          client._socket.destroy();
        });

        await client.sql('SELECT 1 AS v');

        expect(sent).to.have.length(2);
        expect(sent[1].toString('hex')).to.equal(first.toString('hex'));
        // The connection keeps the id the server answered with this time.
        expect(client._session).to.have.length(20);
      } finally {
        OpenDatabasePacket.prototype.write = write;
        await client.close();
      }
    });

    it('reads the constraints of the table named, not of every table its name matches as a pattern', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        await client.execute(`CREATE TABLE ${LOOKALIKE} (id INT UNIQUE)`);

        // event_gender's own UNIQUE index. (This used athlete_result and its
        // athlete_result_medal_code_idx, which the dataset no longer has: the
        // foreign key's index covers medal_code.)
        const constraints = await client.getSchema(CAS.CoraDBSchemaType.CCI_SCH_CONSTRAINT, 'event_gender');
        const names = constraints.map((c) => c.ConstraintName);

        expect(names).to.include('u_event_gender_gender');
        expect(names).to.not.include(`u_${LOOKALIKE}_id`);
      } finally {
        await client.close();
      }
    });

    it('writes the LOB size into its packed handle (setLobSize)', async function () {
      const client = testSetup.createDefaultCoraDBDemodbConnection();

      try {
        const lob = await client.lobNew(CAS.CoraDBDataType.CCI_U_TYPE_CLOB);

        await client.lobWrite(lob, 0, 'hello');
        expect(lob.packedLobHandle.readBigInt64BE(4)).to.equal(5n);

        await client.lobWrite(lob, 5, ' world');
        expect(lob.packedLobHandle.readBigInt64BE(4)).to.equal(11n);
        expect(lob.lobLength).to.equal(11);
      } finally {
        await client.close();
      }
    });
  });
});
