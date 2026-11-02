'use strict';

const assert = require('node:assert');

describe('test_RollbackPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      RollbackPacket = require('../../src/packets/RollbackPacket'),
      CAS = require('../../src/constants/CASConstants');

    let packetReader = new PacketReader(),
      rollbackPacket = new RollbackPacket({ casInfo: Buffer.from([0, 255, 255, 255]), dbVersion: '1.0.0' }),
      packetWriter = new PacketWriter(rollbackPacket.getBufferLength());

    rollbackPacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 6); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // Casinfo
    assert.equal(packetWriter._toBuffer()[5], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[6], 255); // Casinfo
    assert.equal(packetWriter._toBuffer()[7], 255); // Casinfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_END_TRAN);
    assert.equal(packetWriter._toBuffer()[12], 1);
    assert.equal(packetWriter._toBuffer()[13], CAS.CCITransactionType.CCI_TRAN_ROLLBACK);

    packetReader.write(Buffer.from([0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 0]));

    assert.equal(packetReader._packetLength(), 12);

    rollbackPacket.parse(packetReader);

    assert.equal(rollbackPacket.casInfo[0], 0); // Casinfo
    assert.equal(rollbackPacket.casInfo[1], 255); // Casinfo
    assert.equal(rollbackPacket.casInfo[2], 255); // Casinfo
    assert.equal(rollbackPacket.casInfo[3], 255); // Casinfo

    assert.equal(rollbackPacket.responseCode, 0);

    assert.equal(rollbackPacket.errorCode, undefined);
    assert.equal(rollbackPacket.errorMsg, undefined);
  });
});
