'use strict';

const assert = require('node:assert');

describe('test_CommitPacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      CommitPacket = require('../../src/packets/CommitPacket'),
      CAS = require('../../src/constants/CASConstants'),
      packetReader = new PacketReader(),
      commitPacket = new CommitPacket({
        casInfo: Buffer.from([0, 255, 255, 255]),
        dbVersion: '1.0.0'
      }),
      packetWriter = new PacketWriter(commitPacket.getBufferLength());

    commitPacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer()[3], 6); // Total length

    assert.equal(packetWriter._toBuffer()[4], 0); // CasInfo
    assert.equal(packetWriter._toBuffer()[5], 255); // CasInfo
    assert.equal(packetWriter._toBuffer()[6], 255); // CasInfo
    assert.equal(packetWriter._toBuffer()[7], 255); // CasInfo

    assert.equal(packetWriter._toBuffer()[8], CAS.CASFunctionCode.CAS_FC_END_TRAN);
    assert.equal(packetWriter._toBuffer()[12], 1);
    assert.equal(packetWriter._toBuffer()[13], CAS.CCITransactionType.CCI_TRAN_COMMIT);

    packetReader.write(Buffer.from([0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 0]));

    assert.equal(packetReader._packetLength(), 12);

    commitPacket.parse(packetReader);

    assert.equal(commitPacket.casInfo[0], 0); // CasInfo
    assert.equal(commitPacket.casInfo[1], 255); // CasInfo
    assert.equal(commitPacket.casInfo[2], 255); // CasInfo
    assert.equal(commitPacket.casInfo[3], 255); // CasInfo

    assert.equal(commitPacket.responseCode, 0);
    assert.equal(commitPacket.errorCode, undefined);
    assert.equal(commitPacket.errorMsg, undefined);

  });
});
