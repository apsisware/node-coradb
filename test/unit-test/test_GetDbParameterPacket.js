'use strict';

const assert = require('node:assert');

describe('test_GetDbPatameterPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      GetDbParameterPacket = require('../../src/packets/GetDbParameterPacket'),
      CAS = require('../../src/constants/CASConstants'),
      packetReader = new PacketReader(),
      getDbParameterPacket = new GetDbParameterPacket({
        casInfo: Buffer.from([0, 255, 255, 255]),
        parameter: CAS.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH
      }),
      packetWriter = new PacketWriter(getDbParameterPacket.getBufferLength());

    getDbParameterPacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 9); // Total length
    assert.equal(packetWriter._toBuffer()[8], 4);
    assert.equal(packetWriter._toBuffer()[12], CAS.CASFunctionCode.CAS_FC_GET_DB_PARAMETER);
    assert.equal(packetWriter._toBuffer()[16], CAS.CCIDbParam.CCI_PARAM_MAX_STRING_LENGTH);

    packetReader.write(Buffer.from([0, 0, 0, 0,
      0, 255, 255, 255,
      0, 0, 0, 0,
      0, 0, 0, 99]));
    getDbParameterPacket.parse(packetReader);

    assert.equal(getDbParameterPacket.casInfo[0], 0); // Casinfo
    assert.equal(getDbParameterPacket.casInfo[1], 255); // Casinfo
    assert.equal(getDbParameterPacket.casInfo[2], 255); // Casinfo
    assert.equal(getDbParameterPacket.casInfo[3], 255); // Casinfo

    assert.equal(getDbParameterPacket.responseCode, 0);
    assert.equal(getDbParameterPacket.errorCode, undefined);
    assert.equal(getDbParameterPacket.errorMsg, undefined);

    assert.equal(getDbParameterPacket.value, 99);
  });
});
