'use strict';

let expect = require('chai').expect;

const Helpers = require('../../src/utils/Helpers');

it('should succeed to validate the input', function () {
  let sql = 'INSERT INTO a VALUES(?, ?, ?)';
  let newSQL = Helpers._sqlFormat(sql, ['1', 2, null], ["'", '', '']);

  expect(newSQL).to.equal("INSERT INTO a VALUES('1', 2, NULL)");

  // Quotes are doubled; nothing else is escaped (no MySQL backslash escapes:
  // CoraDB reads a backslash as an ordinary character by default).
  expect(Helpers._escapeString('INSERT INTO "a VALUES(\b)')).to.equal('INSERT INTO ""a VALUES(\b)');

  sql = 'stringWithDouble"Quote';

  // Should not escape the double quote if the delimiter is a single quote.
  expect(Helpers._escapeString(sql, "'")).to.equal(sql);

  sql = "stringWithSingle'Quote";

  // Should not escape the single quote if the delimiter is a double quote.
  expect(Helpers._escapeString(sql, '"')).to.equal(sql);

  sql = 'INSERT INTO a VALUES(?, ?, ?)';
  newSQL = Helpers._sqlFormat(sql, ['stringWithDouble"Quote', 2, null]);

  expect(newSQL).to.equal("INSERT INTO a VALUES('stringWithDouble\"Quote', 2, NULL)");

  // Test Input validation functions
  expect(Helpers._validateInputBoolean(null)).to.be.false;
  expect(Helpers._validateInputBoolean(4)).to.be.false;
  expect(Helpers._validateInputBoolean(3.14)).to.be.false;
  expect(Helpers._validateInputBoolean('qwerty')).to.be.false;
  expect(Helpers._validateInputBoolean(true)).to.be.true;
  expect(Helpers._validateInputBoolean(1)).to.be.true;

  expect(Helpers._validateInputPositive(null)).to.be.false;
  expect(Helpers._validateInputPositive(3.14)).to.be.true;
  expect(Helpers._validateInputPositive(-1)).to.be.false;
  expect(Helpers._validateInputPositive(0)).to.be.true;
  expect(Helpers._validateInputPositive(14)).to.be.true;

  expect(Helpers._validateInputTimeout(null)).to.be.false;
  expect(Helpers._validateInputTimeout(3.14)).to.be.false;
  expect(Helpers._validateInputTimeout(-1)).to.be.false;
  expect(Helpers._validateInputTimeout(0)).to.be.true;
  expect(Helpers._validateInputTimeout(14)).to.be.true;

  expect(Helpers._validateInputString(null)).to.be.false;
  expect(Helpers._validateInputString(3)).to.be.false;
  expect(Helpers._validateInputString(true)).to.be.false;
  expect(Helpers._validateInputString('')).to.be.false;
  expect(Helpers._validateInputString('querty')).to.be.true;

  expect(Helpers._validateInputSQLString(null)).to.be.false;
  expect(Helpers._validateInputSQLString(3)).to.be.false;
  expect(Helpers._validateInputSQLString(true)).to.be.false;
  expect(Helpers._validateInputSQLString('')).to.be.false;
  expect(Helpers._validateInputSQLString('a')).to.be.false;
  expect(Helpers._validateInputSQLString('qwerty')).to.be.true;
});
