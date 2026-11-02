'use strict';

const assert = require('node:assert');

describe('test_PrepareExecuteOldProtocolPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      PrepareExecutePacket = require('../../src/packets/PrepareExecutePacket'),
      CAS = require('../../src/constants/CASConstants');

    let options = {
        sql: 'select * from code',
        casInfo: Buffer.from([0, 255, 255, 255]),
        autoCommitMode: 1,
        dbVersion: '1.0.0',
        paramValues: {},
        paramTypes: {}
      },
      prepareExecutePacket = new PrepareExecutePacket(options),
      packetReader = new PacketReader(),
      packetWriter = new PacketWriter(prepareExecutePacket.getPrepareBufferLength());

    prepareExecutePacket.writePrepare(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 34); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_PREPARE);
    assert.equal(packetWriter._toBuffer()[12], 19);
    assert.equal(packetWriter._toBuffer().slice(13, 31).toString(), 'select * from code');
    assert.equal(packetWriter._toBuffer()[35], 1);
    assert.equal(packetWriter._toBuffer()[36], CAS.CCIPrepareOption.CCI_PREPARE_NORMAL);
    assert.equal(packetWriter._toBuffer()[40], 1);
    assert.equal(packetWriter._toBuffer()[41], 0);

    packetReader.write(Buffer.from([0, 0, 0, 108, 1, 255, 255, 255, 0, 0, 0, 1, 255, 255, 255, 255, 21, 0, 0, 0, 0, 0, 0, 0,
      0, 2, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 7, 115, 95, 110, 97, 109, 101, 0, 0, 0, 0, 1, 0, 0,
      0, 0, 5, 99, 111, 100, 101, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0,
      6, 0, 0, 0, 7, 102, 95, 110, 97, 109, 101, 0, 0, 0, 0, 1, 0, 0, 0, 0, 5, 99, 111, 100,
      101, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]));

    prepareExecutePacket.parsePrepare(packetReader);
    assert.equal(prepareExecutePacket.queryHandle, 1);
    assert.equal(prepareExecutePacket.resultCacheLifetime, -1);
    assert.equal(prepareExecutePacket.statementType, 21);
    assert.equal(prepareExecutePacket.bindCount, 0);
    assert.equal(prepareExecutePacket.isUpdatable, false);
    assert.equal(prepareExecutePacket.infoArray[0].ColumnType, 1);
    // The scale the server sent (0). `Scale` used to be a separate field left at its default, -1.
    assert.equal(prepareExecutePacket.infoArray[0].Scale, 0);
    assert.equal(prepareExecutePacket.infoArray[0].scale, 0);
    assert.equal(prepareExecutePacket.infoArray[0].Name, "s_name");
    assert.equal(prepareExecutePacket.infoArray[0].RealName, "");
    assert.equal(prepareExecutePacket.infoArray[0].TableName, "code");
    assert.equal(prepareExecutePacket.infoArray[0].IsNullable, false);
    assert.equal(prepareExecutePacket.infoArray[0].DafaultValue, "");
    assert.equal(prepareExecutePacket.infoArray[0].IsAutoIncrement, false);
    assert.equal(prepareExecutePacket.infoArray[0].IsUniqueKey, false);
    assert.equal(prepareExecutePacket.infoArray[0].IsPrimaryKey, false);
    assert.equal(prepareExecutePacket.infoArray[0].IsReverseIndex, false);
    assert.equal(prepareExecutePacket.infoArray[0].IsReverseUnique, false);
    assert.equal(prepareExecutePacket.infoArray[0].IsForeignKey, false);
    assert.equal(prepareExecutePacket.infoArray[0].IsShared, false);

    packetReader = new PacketReader();
    packetWriter = new PacketWriter(prepareExecutePacket.getExecuteBufferLength());
    prepareExecutePacket.writeExecute(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 69); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_EXECUTE);
    assert.equal(packetWriter._toBuffer()[16], 1);
    assert.equal(packetWriter._toBuffer()[21], CAS.CCIExecutionOption.CCI_EXEC_NORMAL);
    assert.equal(packetWriter._toBuffer()[29], 0);
    assert.equal(packetWriter._toBuffer()[37], 0);
    assert.equal(packetWriter._toBuffer()[41], 0);
    assert.equal(packetWriter._toBuffer()[46], 1);
    assert.equal(packetWriter._toBuffer()[51], 0);
    assert.equal(packetWriter._toBuffer()[56], 1);
    assert.equal(packetWriter._toBuffer()[68], 0);
    assert.equal(packetWriter._toBuffer()[76], 0);

    packetReader.write(Buffer.from([0, 0, 0, 205, 0, 255, 255, 255, 0, 0, 0, 6, 0, 0, 0, 0, 1, 21, 0, 0, 0, 6, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 1, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 2, 88, 0, 0, 0, 0, 6, 77, 105, 120, 101, 100, 0, 0, 0, 0, 2, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 2, 87, 0, 0, 0, 0, 6, 87, 111, 109, 97, 110, 0, 0, 0, 0, 3, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 77, 0, 0, 0, 0, 4, 77, 97, 110, 0, 0, 0, 0, 4, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 2, 66, 0, 0, 0, 0, 7, 66, 114, 111, 110, 122, 101, 0, 0, 0, 0,
      5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 83, 0, 0, 0, 0, 7, 83, 105, 108, 118, 101, 114,
      0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 71, 0, 0, 0, 0, 5, 71, 111, 108, 100, 0]));

    prepareExecutePacket.parseExecute(packetReader);
    var resultSet = JSON.stringify(prepareExecutePacket.resultSet);

    assert.equal(resultSet, '{"ColumnNames":["s_name","f_name"],"ColumnDataTypes":["Char","String"],"RowsCount":6,"ColumnValues":[["X","Mixed"],["W","Woman"],["M","Man"],["B","Bronze"],["S","Silver"],["G","Gold"]]}');
  });
});
