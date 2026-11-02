'use strict';

const assert = require('node:assert');

describe('test_GetSchemaPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      GetSchemaPacket = require('../../src/packets/GetSchemaPacket.js'),
      CAS = require('../../src/constants/CASConstants'),
      packetReader = new PacketReader(),
      getSchemaPacket = new GetSchemaPacket({
        casInfo: Buffer.from([0, 255, 255, 255]),
        tableNamePattern: null,
        schemaType: CAS.CoraDBSchemaType.CCI_SCH_CLASS,
        dbVersion: '1.0.0'
      }),
      packetWriter = new PacketWriter(getSchemaPacket.getRequestSchemaBufferLength());

    getSchemaPacket.writeRequestSchema(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 1 + 5 * 4 + 1); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_SCHEMA_INFO);
    assert.equal(packetWriter._toBuffer()[16], CAS.CoraDBSchemaType.CCI_SCH_CLASS);
    assert.equal(packetWriter._toBuffer()[21], 0);
    assert.equal(packetWriter._toBuffer()[28], 1);
    assert.equal(packetWriter._toBuffer()[29], 3);

    packetReader.write(Buffer.from([0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 1]));

    assert.equal(packetReader._packetLength(), 12);

    getSchemaPacket.parseRequestSchema(packetReader);

    assert.equal(getSchemaPacket.casInfo[0], 0); // Casinfo
    assert.equal(getSchemaPacket.casInfo[1], 255); // Casinfo
    assert.equal(getSchemaPacket.casInfo[2], 255); // Casinfo
    assert.equal(getSchemaPacket.casInfo[3], 255); // Casinfo

    assert.equal(getSchemaPacket.responseCode, 1);

    assert.equal(getSchemaPacket.errorCode, undefined);
    assert.equal(getSchemaPacket.errorMsg, undefined);

    packetWriter = new PacketWriter(getSchemaPacket.getFetchSchemaBufferLength());
    getSchemaPacket.writeFetchSchema(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 38); //total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_FETCH);
    assert.equal(packetWriter._toBuffer()[16], 1);
    assert.equal(packetWriter._toBuffer()[24], 1);
    assert.equal(packetWriter._toBuffer()[32], 0);
    assert.equal(packetWriter._toBuffer()[37], 0);
    assert.equal(packetWriter._toBuffer()[45], 0);
  });
});
