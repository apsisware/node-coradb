'use strict';

const assert = require('node:assert');

describe('test_ExecuteQueryPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      ExecuteQueryPacket = require('../../src/packets/ExecuteQueryPacket'),
      CAS = require('../../src/constants/CASConstants'),
      packetReader = new PacketReader(),
      executeQueryPacket = new ExecuteQueryPacket({
        sql: 'select * from code',
        casInfo: Buffer.from([0, 255, 255, 255]),
        autoCommitMode: 1,
        dbVersion: '1.0.0'
      }),
      packetWriter = new PacketWriter(executeQueryPacket.getBufferLength());

    executeQueryPacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 87); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_PREPARE_AND_EXECUTE);
    assert.equal(packetWriter._toBuffer()[16], 3);
    assert.equal(packetWriter._toBuffer().slice(21, 39).toString(), 'select * from code');
    assert.equal(packetWriter._toBuffer()[44], 0);
    assert.equal(packetWriter._toBuffer()[49], 0);
    assert.equal(packetWriter._toBuffer()[54], CAS.CCIExecutionOption.CCI_EXEC_QUERY_ALL);
    assert.equal(packetWriter._toBuffer()[62], 0);
    assert.equal(packetWriter._toBuffer()[70], 0);
    assert.equal(packetWriter._toBuffer()[82], 0);
    assert.equal(packetWriter._toBuffer()[86], 0);
    assert.equal(packetWriter._toBuffer()[94], 0);

    packetReader.write(Buffer.from([0, 0, 1, 57, 0, 255, 255, 255, 0, 0, 0, 4, 255, 255, 255, 255, 21, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 7, 115, 95, 110, 97, 109, 101, 0,
      0, 0, 0, 1, 0, 0, 0, 0, 5, 99, 111, 100, 101, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 6, 0, 0, 0, 7, 102,
      95, 110, 97, 109, 101, 0, 0, 0, 0, 1, 0, 0, 0, 0, 5, 99, 111, 100, 101, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6,
      0, 0, 0, 0, 1, 21, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 1, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 2, 88, 0, 0, 0, 0, 6, 77, 105, 120, 101, 100, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 87, 0, 0,
      0, 0, 6, 87, 111, 109, 97, 110, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 77, 0, 0, 0, 0, 4, 77, 97, 110, 0, 0, 0, 0,
      4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 66, 0, 0, 0, 0, 7, 66, 114, 111, 110, 122, 101, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 2, 83, 0, 0, 0, 0, 7, 83, 105, 108, 118, 101, 114, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 71, 0, 0, 0, 0, 5,
      71, 111, 108, 100, 0]));

    executeQueryPacket.parse(packetReader);
    let resultSet = JSON.stringify(executeQueryPacket.resultSet);
    assert.equal(resultSet, "{\"ColumnDataTypes\":[\"Char\",\"String\"],\"ColumnNames\":[\"s_name\",\"f_name\"],\"ColumnValues\":[[\"X\",\"Mixed\"],[\"W\",\"Woman\"],[\"M\",\"Man\"],[\"B\",\"Bronze\"],[\"S\",\"Silver\"],[\"G\",\"Gold\"]],\"RowsCount\":6}");
  });
});
