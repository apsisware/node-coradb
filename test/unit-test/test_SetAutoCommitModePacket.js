'use strict';

const assert = require('node:assert');

describe('test_SetAutoCommitModePacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      SetAutoCommitModePacket = require('../../src/packets/SetAutoCommitModePacket'),
      CAS = require('../../src/constants/CASConstants');

    let packetReader = new PacketReader();
    let setAutoCommitModePacket = new SetAutoCommitModePacket({ casInfo: Buffer.from([0, 255, 255, 255]), autoCommitMode: 1, dbVersion: '1.0.0' }),
      packetWriter = new PacketWriter(setAutoCommitModePacket.getBufferLength());

    setAutoCommitModePacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 1 + 4 * 4); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_SET_DB_PARAMETER);
    assert.equal(packetWriter._toBuffer()[16], CAS.CCIDbParam.CCI_PARAM_AUTO_COMMIT);
    assert.equal(packetWriter._toBuffer()[20], 4);
    assert.equal(packetWriter._toBuffer()[24], 1);

    packetReader.write(Buffer.from([0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 0]));

    assert.equal(packetReader._packetLength(), 12);

    setAutoCommitModePacket.parse(packetReader);

    assert.equal(setAutoCommitModePacket.casInfo[0], 0); // Casinfo
    assert.equal(setAutoCommitModePacket.casInfo[1], 255); // Casinfo
    assert.equal(setAutoCommitModePacket.casInfo[2], 255); // Casinfo
    assert.equal(setAutoCommitModePacket.casInfo[3], 255); // Casinfo

    assert.equal(setAutoCommitModePacket.responseCode, 0);

    assert.equal(setAutoCommitModePacket.errorCode, undefined);
    assert.equal(setAutoCommitModePacket.errorMsg, undefined);

  });
});
