'use strict';

const assert = require('node:assert');

describe('test_FetchPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      ExecuteQueryPacket = require('../../src/packets/ExecuteQueryPacket'),
      FetchPacket = require('../../src/packets/FetchPacket'),
      CAS = require('../../src/constants/CASConstants'),
      packetReader = new PacketReader(),
      options = {
        sql: 'select * from code',
        casInfo: Buffer.from([0, 255, 255, 255]),
        autoCommitMode: 1,
        dbVersion: '1.0.0'
      },
      executeQueryPacket = new ExecuteQueryPacket(options),
      packetWriter = new PacketWriter(executeQueryPacket.getBufferLength());

    executeQueryPacket.write(packetWriter);
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

    let fetchPacket = new FetchPacket(options);
    packetReader = new PacketReader();
    packetWriter = new PacketWriter(fetchPacket.getBufferLength());
    fetchPacket.write(packetWriter, executeQueryPacket);
    assert.equal(packetWriter._toBuffer()[3], 38); // Total length
    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_FETCH);
    assert.equal(packetWriter._toBuffer()[16], 4);
    assert.equal(packetWriter._toBuffer()[24], 7);
    assert.equal(packetWriter._toBuffer()[32], 100);
    assert.equal(packetWriter._toBuffer()[37], 0);
    assert.equal(packetWriter._toBuffer()[45], 0);

    packetReader.write(Buffer.from([0, 0, 0, 0,
      0, 255, 255, 255,
      0, 0, 0, 0,
      0, 0, 0, 0]));
    fetchPacket.parse(packetReader, executeQueryPacket);

    assert.equal(fetchPacket.casInfo[0], 0); // Casinfo
    assert.equal(fetchPacket.casInfo[1], 255); // Casinfo
    assert.equal(fetchPacket.casInfo[2], 255); // Casinfo
    assert.equal(fetchPacket.casInfo[3], 255); // Casinfo

    assert.equal(fetchPacket.responseCode, 0);
    assert.equal(fetchPacket.errorCode, undefined);
    assert.equal(fetchPacket.errorMsg, undefined);

    assert.equal(fetchPacket.tupleCount, 0);
  });
});
