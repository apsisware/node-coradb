'use strict';

const assert = require('node:assert');

describe('test_GetEngineVersionPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      GetEngineVersionPacket = require('../../src/packets/GetEngineVersionPacket'),
      CAS = require('../../src/constants/CASConstants'),
      packetReader = new PacketReader(),
      getEngineVersionPacket = new GetEngineVersionPacket({ casInfo: Buffer.from([0, 255, 255, 255]) }),
      packetWriter = new PacketWriter(getEngineVersionPacket.getBufferLength());

    getEngineVersionPacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 6); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_GET_DB_VERSION);
    assert.equal(packetWriter._toBuffer()[12], 1);
    assert.equal(packetWriter._toBuffer()[13], 1);

    packetReader.write(Buffer.from([0, 0, 0, 15,
      0, 255, 255, 255,
      0, 0, 0, 0]));
    packetReader._append(Buffer.from('8.4.1.0056'));
    packetReader._append(Buffer.from([0]));
    getEngineVersionPacket.parse(packetReader);

    assert.equal(getEngineVersionPacket.casInfo[0], 0); // Casinfo
    assert.equal(getEngineVersionPacket.casInfo[1], 255); // Casinfo
    assert.equal(getEngineVersionPacket.casInfo[2], 255); // Casinfo
    assert.equal(getEngineVersionPacket.casInfo[3], 255); // Casinfo

    assert.equal(getEngineVersionPacket.responseCode, 0);

    assert.equal(getEngineVersionPacket.errorCode, undefined);
    assert.equal(getEngineVersionPacket.errorMsg, undefined);

    assert.equal(getEngineVersionPacket.engineVersion, '8.4.1.0056');
  });
});
