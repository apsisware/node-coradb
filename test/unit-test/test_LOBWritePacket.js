'use strict';

const assert = require('node:assert');

describe('test_LOBWritePacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      LOBWritePacket = require('../../src/packets/LOBWritePacket'),
      CAS = require('../../src/constants/CASConstants');

    let packetReader = new PacketReader();
    let packedLobHandle = Buffer.from([0, 0, 0, 33, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 79, 102, 105, 108, 101, 58,
      67, 58, 92, 67, 85, 66, 82, 73, 68, 92, 100, 97, 116, 97, 98, 97, 115, 101, 92, 100, 101, 109, 111, 100,
      98, 47, 108, 111, 98, 47, 99, 101, 115, 95, 48, 56, 50, 47, 116, 101, 115, 116, 95, 108, 111, 98, 46, 48, 48,
      48, 48, 49, 51, 54, 49, 57, 55, 54, 53, 52, 50, 48, 48, 48, 48, 48, 48, 95, 56, 49, 52, 53, 0
    ]);
    let lobHandle =
    {
      lobType: CAS.CoraDBDataType.CCI_U_TYPE_BLOB, // BLOB type
      packedLobHandle: packedLobHandle,
      fileLocator: 'file:C:\\CoraDB\\databases\\demodb/lob/ces_670/test_lob.00001361976357078000_1538',
      lobLength: 4
    };
    let value = Buffer.from([1, 2, 3, 4]);

    let lobWritePacket = new LOBWritePacket({
        casInfo: Buffer.from([0, 255, 255, 255]),
        lobObject: lobHandle,
        position: 0,
        data: value,
        writeLen: 4,
        dbVersion: '1.0.0'
      }),
      packetWriter = new PacketWriter(lobWritePacket.getBufferLength());

    lobWritePacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 119); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_LOB_WRITE);
    assert.equal(packetWriter._toBuffer()[12], 94);
    for (let i = 0; i < packedLobHandle.length; i++) {
      assert.equal(packetWriter._toBuffer().slice(13, 110)[i], packedLobHandle[i]);
    }
    assert.equal(packetWriter._toBuffer()[111], 0);
    assert.equal(packetWriter._toBuffer()[119], 0);
    assert.equal(packetWriter._toBuffer()[123], 1);
    assert.equal(packetWriter._toBuffer()[124], 2);
    assert.equal(packetWriter._toBuffer()[125], 3);
    assert.equal(packetWriter._toBuffer()[126], 4);
    assert.equal(packetWriter._toBuffer()[127], undefined);

    packetReader.write(Buffer.from([0, 0, 0, 4,
      0, 255, 255, 255,
      0, 0, 0, 4,
      1, 2, 3, 4]));
    lobWritePacket.parse(packetReader);


    assert.equal(lobWritePacket.bytesWritten, 4);

  });
});
