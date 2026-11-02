'use strict';

const assert = require('node:assert');

describe('test_CloseQueryPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      CloseQueryPacket = require('../../src/packets/CloseQueryPacket'),
      CAS = require('../../src/constants/CASConstants'),
      packetReader = new PacketReader(),
      closeQueryPacket = new CloseQueryPacket({
        casInfo: Buffer.from([0, 255, 255, 255]),
        dbVersion: '1.0.0'
      }),
      packetWriter = new PacketWriter(closeQueryPacket.getBufferLength());

    closeQueryPacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 14); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // CasInfo
    assert.equal(packetWriter._toBuffer()[5], 255); // CasInfo
    assert.equal(packetWriter._toBuffer()[6], 255); // CasInfo
    assert.equal(packetWriter._toBuffer()[7], 255); // CasInfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_CLOSE_REQ_HANDLE);
    assert.equal(packetWriter._toBuffer()[12], 4);
    assert.equal(packetWriter._toBuffer()[16], 0);
    assert.equal(packetWriter._toBuffer()[20], 1);
    assert.equal(packetWriter._toBuffer()[21], 0);

    packetReader.write(Buffer.from([0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 0]));

    assert.equal(packetReader._packetLength(), 12);

    closeQueryPacket.parse(packetReader);

    assert.equal(closeQueryPacket.casInfo[0], 0); // CasInfo
    assert.equal(closeQueryPacket.casInfo[1], 255); // CasInfo
    assert.equal(closeQueryPacket.casInfo[2], 255); // CasInfo
    assert.equal(closeQueryPacket.casInfo[3], 255); // CasInfo

    assert.equal(closeQueryPacket.responseCode, 0);

    assert.equal(closeQueryPacket.errorCode, undefined);
    assert.equal(closeQueryPacket.errorMsg, undefined);
  });
});
