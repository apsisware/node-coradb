'use strict';

const assert = require('node:assert');

describe('test_SetDbParameterPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      SetDbParameterPacket = require('../../src/packets/SetDbParameterPacket'),
      CAS = require('../../src/constants/CASConstants');

    let packetReader = new PacketReader(),
      setDbParameterPacket = new SetDbParameterPacket({
        casInfo: Buffer.from([0, 255, 255, 255]),
        parameter: CAS.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH,
        value: 99
      }),
      packetWriter = new PacketWriter(setDbParameterPacket.getBufferLength());

    setDbParameterPacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 17); // Total length
    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_SET_DB_PARAMETER);
    assert.equal(packetWriter._toBuffer()[12], 4);
    assert.equal(packetWriter._toBuffer()[16], CAS.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH);
    assert.equal(packetWriter._toBuffer()[20], 4);
    assert.equal(packetWriter._toBuffer()[24], 99);

    packetReader.write(Buffer.from([0, 0, 0, 0,
      0, 255, 255, 255,
      0, 0, 0, 0]));
    setDbParameterPacket.parse(packetReader);

    assert.equal(setDbParameterPacket.casInfo[0], 0); // Casinfo
    assert.equal(setDbParameterPacket.casInfo[1], 255); // Casinfo
    assert.equal(setDbParameterPacket.casInfo[2], 255); // Casinfo
    assert.equal(setDbParameterPacket.casInfo[3], 255); // Casinfo

    assert.equal(setDbParameterPacket.responseCode, 0);
    assert.equal(setDbParameterPacket.errorCode, undefined);
    assert.equal(setDbParameterPacket.errorMsg, undefined);
  });
});
