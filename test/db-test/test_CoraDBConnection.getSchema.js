'use strict';

const expect = require('chai').expect;
const testSetup = require('./testSetup');
const CAS = require('../../src/constants/CASConstants');

/*
 * getSchema() against olympics1988-2004. The system classes differ from one
 * engine version to the next, so the tests check the database's own objects
 * (its 11 tables and 4 views, their keys and columns) rather than totals.
 *
 * Table names may come back with their owner ('dba.athlete') or without it,
 * depending on the server: compared without it.
 */
const TABLES = [
  'athlete', 'athlete_gender', 'athlete_result', 'continent', 'country', 'event',
  'event_gender', 'medal', 'olympic_games', 'olympic_games_sponsorship', 'stadium',
];
const VIEWS = ['continent_medals', 'country_host_cities', 'country_medals', 'olympic_sponsors'];

// The CCI class types (as the JDBC driver reads them).
const SYSTEM = 0;
const VIEW = 1;
const TABLE = 2;

/** A name without its owner: 'dba.athlete' -> 'athlete'. */
function bare(name) {
  return typeof name === 'string' ? name.replace(/^[^.]+\./, '') : name;
}

/** Run `check(schema, client)` on getSchema(type, filter), as a promise or with a callback. */
function schemaTest(type, filter, withCallback, check) {
  return function () {
    const client = testSetup.createDefaultCoraDBDemodbConnection();

    const schema = withCallback
      ? new Promise((resolve, reject) => {
        const callback = (err, result) => (err ? reject(err) : resolve(result));

        if (filter === undefined) {
          client.getSchema(type, callback);
        } else {
          client.getSchema(type, filter, callback);
        }
      })
      : client.getSchema(type, filter);

    return schema
      .then(result => {
        expect(result).to.be.an('array');
        check(result, client);

        return client.close();
      }, err => client.close().then(() => {
        throw err;
      }));
  };
}

function checkClasses(schema) {
  // Exactly the official schema: the test tables are dropped before this file.
  const user = schema.filter(c => c.Type !== SYSTEM);

  expect(user.map(c => bare(c.Name)).sort()).to.deep.equal(TABLES.concat(VIEWS).sort());

  TABLES.forEach(name => {
    const table = user.find(c => bare(c.Name) === name);

    expect(table.Type, name).to.equal(TABLE);
    expect(table.TypeName, name).to.equal('User class/view');
  });

  VIEWS.forEach(name => {
    const view = user.find(c => bare(c.Name) === name);

    expect(view.Type, name).to.equal(VIEW);
    expect(view.TypeName, name).to.equal('User view');
  });

  expect(schema.filter(c => c.Type === SYSTEM)).to.have.length.above(0);
}

function checkViews(schema) {
  // System views (db_class, ...) and the database's own.
  schema.forEach(v => expect([SYSTEM, VIEW]).to.include(v.Type));

  const user = schema.filter(v => v.Type === VIEW).map(v => bare(v.Name)).sort();

  expect(user).to.deep.equal(VIEWS.slice().sort());
}

function checkPrivileges(schema) {
  // The connection's user (dba) owns every table: all of their privileges.
  expect(schema).to.have.length.of.at.least(TABLES.length + VIEWS.length);

  schema.forEach(p => {
    expect(p).to.have.property('TableName').that.is.a('string');
    expect(p).to.have.property('Privilege').that.is.a('string');
    expect(p).to.have.property('Grantable').that.is.a('boolean');
  });

  const athlete = schema.filter(p => bare(p.TableName) === 'athlete').map(p => p.Privilege);

  expect(athlete).to.include.members(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
}

function checkEventConstraints(schema) {
  // One row per column of each UNIQUE constraint and index of the event table
  // (TYPE 0 unique, 1 index), as the JDBC driver's getIndexInfo() reads them.
  // The primary key and the foreign keys are not listed here: they are read
  // with CCI_SCH_PRIMARY_KEY (checkEventPrimaryKey) and CCI_SCH_IMPORTED_KEYS,
  // as JDBC's getPrimaryKeys() and getImportedKeys() read them.
  schema.forEach(c => {
    expect(c).to.have.property('ConstraintName').that.is.a('string');
    expect(c).to.have.property('AttributeName').that.is.a('string');
    expect(c).to.have.property('Type').that.is.a('number');
    expect(c).to.have.property('PrimaryKey').that.is.a('boolean');
  });

  // The attributes an index is on (a constraint may be listed once as the
  // constraint and once as its index: duplicates are allowed).
  const columnsOf = name => [...new Set(schema.filter(c => c.ConstraintName === name).map(c => c.AttributeName))];

  const typesOf = name => [...new Set(schema.filter(c => c.ConstraintName === name).map(c => c.Type))];

  expect(columnsOf('u_event_discipline_name_event_gender_code'))
    .to.have.members(['discipline', 'name', 'event_gender_code']);
  expect(typesOf('u_event_discipline_name_event_gender_code')).to.deep.equal([0]);

  expect(columnsOf('event_discipline_idx')).to.deep.equal(['discipline']);
  expect(typesOf('event_discipline_idx')).to.deep.equal([1]);

  expect(columnsOf('event_name_idx')).to.deep.equal(['name']);
  expect(typesOf('event_name_idx')).to.deep.equal([1]);

  expect(schema.every(c => c.PrimaryKey === false)).to.be.true;
}

/** A foreign key row: names compared without the owner. */
function checkForeignKey(key, expected) {
  expect(key, expected.FkName).to.be.an('object');

  Object.keys(expected).forEach(field => {
    const actual = /TableName$/.test(field) ? bare(key[field]) : key[field];

    expect(actual, `${expected.FkName}.${field}`).to.equal(expected[field]);
  });
}

function checkAthleteExportedKeys(schema) {
  // athlete.id is referenced by athlete_result.athlete_id only.
  expect(schema).to.have.length(1);

  checkForeignKey(schema[0], {
    FkName: 'fk_athlete_result_athlete_id',
    PkName: 'pk_athlete_id',
    FkTableName: 'athlete_result',
    PkTableName: 'athlete',
    FkColumnName: 'athlete_id',
    PkColumnName: 'id',
    // ON UPDATE RESTRICT ON DELETE RESTRICT
    UpdateAction: 1,
    DeleteAction: 1,
  });
}

function checkAthleteResultImportedKeys(schema) {
  const expected = [
    ['fk_athlete_result_athlete_id', 'pk_athlete_id', 'athlete', 'athlete_id', 'id'],
    ['fk_athlete_result_event_id', 'pk_event_id', 'event', 'event_id', 'id'],
    ['fk_athlete_result_medal_code', 'pk_medal_code', 'medal', 'medal_code', 'code'],
    ['fk_athlete_result_stadium_id', 'pk_stadium_id', 'stadium', 'stadium_id', 'id'],
    ['fk_athlete_result_year', 'pk_olympic_games_year', 'olympic_games', 'year', 'year'],
  ];

  expect(schema.map(k => k.FkName).sort()).to.deep.equal(expected.map(e => e[0]));

  expected.forEach(([FkName, PkName, PkTableName, FkColumnName, PkColumnName]) => {
    checkForeignKey(schema.find(k => k.FkName === FkName), {
      FkName,
      PkName,
      FkTableName: 'athlete_result',
      PkTableName,
      FkColumnName,
      PkColumnName,
      UpdateAction: 1,
      DeleteAction: 1,
    });
  });
}

function checkEventPrimaryKey(schema) {
  // The primary key the CONSTRAINT rows above do not list.
  expect(schema).to.have.length(1);
  expect(bare(schema[0].TableName)).to.equal('event');
  expect(schema[0].ColumnName).to.equal('id');
  expect(schema[0].KeyName).to.equal('pk_event_id');
}

function checkAthletePrimaryKey(schema) {
  expect(schema).to.have.length(1);

  const key = schema[0];

  expect(bare(key.TableName)).to.equal('athlete');
  expect(key.ColumnName).to.equal('id');
  expect(key.KeyName).to.equal('pk_athlete_id');
}

function checkAttributes(schema) {
  // The database's 65 columns (52 in its tables, 13 in its views), and the
  // system classes' own.
  expect(schema).to.have.length.of.at.least(65);

  const id = schema.find(a => a.Name === 'id' && bare(a.ClassName) === 'athlete');

  expect(id, 'athlete.id').to.be.an('object');
  expect(id.TypeName).to.equal('Int');
  expect(id.Scale).to.equal(0);
  expect(id.Precision).to.equal(10);
  expect(id.NonNull).to.be.true;
  expect(id.Unique).to.be.true;
  expect(bare(id.SourceClass)).to.equal('athlete');
  expect(id.IsKey).to.be.true;

  const lastName = schema.find(a => a.Name === 'last_name' && bare(a.ClassName) === 'athlete');

  expect(lastName, 'athlete.last_name').to.be.an('object');
  expect(lastName.Precision).to.equal(32);
  expect(lastName.NonNull).to.be.true;
  expect(lastName.Unique).to.be.false;
  expect(lastName.IsKey).to.be.false;
}

describe('CoraDBConnection', function () {
  describe('getSchema', function () {
    // Tables an earlier file or a stopped run left behind would be counted.
    before(testSetup.dropLeftoverTestTables);

    const S = CAS.CoraDBSchemaType;

    [false, true].forEach(withCallback => {
      const how = withCallback ? 'getSchema(callback)' : 'getSchema()';

      it(`should succeed to ${how} for CCI_SCH_CLASS`,
        schemaTest(S.CCI_SCH_CLASS, undefined, withCallback, checkClasses));

      it(`should succeed to ${how} for CCI_SCH_VCLASS`,
        schemaTest(S.CCI_SCH_VCLASS, undefined, withCallback, checkViews));

      it(`should succeed to ${how} for CCI_SCH_CLASS_PRIVILEGE`,
        schemaTest(S.CCI_SCH_CLASS_PRIVILEGE, undefined, withCallback, checkPrivileges));

      it(`should succeed to ${how} for CCI_SCH_CONSTRAINT for "event" table`,
        schemaTest(S.CCI_SCH_CONSTRAINT, 'event', withCallback, checkEventConstraints));

      it(`should succeed to ${how} for CCI_SCH_EXPORTED_KEYS for "athlete" table`,
        schemaTest(S.CCI_SCH_EXPORTED_KEYS, 'athlete', withCallback, checkAthleteExportedKeys));

      it(`should succeed to ${how} for CCI_SCH_IMPORTED_KEYS for "athlete_result" table`,
        schemaTest(S.CCI_SCH_IMPORTED_KEYS, 'athlete_result', withCallback, checkAthleteResultImportedKeys));

      it(`should succeed to ${how} for CCI_SCH_PRIMARY_KEY for "event" table`,
        schemaTest(S.CCI_SCH_PRIMARY_KEY, 'event', withCallback, checkEventPrimaryKey));

      it(`should succeed to ${how} for CCI_SCH_PRIMARY_KEY for "athlete" table`,
        schemaTest(S.CCI_SCH_PRIMARY_KEY, 'athlete', withCallback, checkAthletePrimaryKey));

      it(`should succeed to ${how} for CCI_SCH_ATTRIBUTE`,
        schemaTest(S.CCI_SCH_ATTRIBUTE, undefined, withCallback, checkAttributes));
    });
  });
});
