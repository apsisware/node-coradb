'use strict';

const assert = require('node:assert');

describe('test_LOBNewPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      LOBNewPacket = require('../../src/packets/LOBNewPacket'),
      CAS = require('../../src/constants/CASConstants'),
      packetReader = new PacketReader(),
      lobnewPacket = new LOBNewPacket({
        casInfo: Buffer.from([0, 255, 255, 255]),
        lobType: CAS.CoraDBDataType.CCI_U_TYPE_BLOB,
        dbVersion: '1.0.0'
      }),
      packetWriter = new PacketWriter(lobnewPacket.getBufferLength());

    lobnewPacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 9); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_LOB_NEW);
    assert.equal(packetWriter._toBuffer()[12], 4);
    assert.equal(packetWriter._toBuffer()[16], CAS.CoraDBDataType.CCI_U_TYPE_BLOB);

    packetReader.write(Buffer.from([0, 0, 0, 99, 1, 255, 255, 255, 0, 0, 0, 95, 0, 0, 0, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 79, 102, 105, 108, 101, 58, 67, 58, 92, 67, 111, 114, 97, 68, 66, 92, 100, 97, 116,
      97, 98, 97, 115, 101, 115, 92, 100, 101, 109, 111, 100, 98, 47, 108, 111, 98, 47, 99,
      101, 115, 95, 50, 49, 50, 47, 99, 101, 115, 95, 116, 101, 109, 112, 46, 48, 48, 48, 48,
      49, 51, 54, 50, 49, 51, 54, 54, 49, 51, 53, 52, 54, 48, 48, 48, 95, 48, 48, 52, 49, 0,
      0, 0, 0, 30, 0, 255, 255, 255, 0, 0, 0, 1, 0, 0, 0, 0, 1, 20, 0, 0, 0, 1, 0, 0, 22, 128,
      11, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    lobnewPacket.parse(packetReader);
    let lobHandle = lobnewPacket.result;

    assert.equal(lobHandle.lobType, CAS.CoraDBDataType.CCI_U_TYPE_BLOB);
    assert.equal(lobHandle.fileLocator, String.raw`file:C:\CoraDB\databases\demodb/lob/ces_212/ces_temp.00001362136613546000_0041`);
    assert.equal(lobHandle.lobLength, 0);
  });
});
