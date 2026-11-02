'use strict';

const assert = require('node:assert');

describe('test_OpenDatabasePacket', function () {
  it('should encode and parse correctly', function () {
    let PacketReader = require('../../src/packets/PacketReader'),
      PacketWriter = require('../../src/packets/PacketWriter'),
      OpenDatabasePacket = require('../../src/packets/OpenDatabasePacket');

    let packetReader = new PacketReader();
    let options = { database: 'demodb', user: 'PUBLIC', password: '' };
    let openDatabasePacket = new OpenDatabasePacket(options);
    let packetWriter = new PacketWriter(openDatabasePacket.getBufferLength());

    openDatabasePacket.write(packetWriter);
    assert.equal(packetWriter._toBuffer().slice(0, 6).toString(), options.database);
    assert.equal(packetWriter._toBuffer().slice(32, 38).toString(), options.user);
    assert.equal(packetWriter._toBuffer().slice(64, 65)[0], 0);

    packetReader.write(Buffer.from([0, 0, 0, 15,
      0, 255, 255, 255,
      0, 0, 0, 0,
      5, 5, 5, 5, 5, 5, 5, 5,
      0, 0, 0, 3]));
    openDatabasePacket.parse(packetReader);

    assert.equal(openDatabasePacket.casInfo[0], 0); // Casinfo
    assert.equal(openDatabasePacket.casInfo[1], 255); // Casinfo
    assert.equal(openDatabasePacket.casInfo[2], 255); // Casinfo
    assert.equal(openDatabasePacket.casInfo[3], 255); // Casinfo

    assert.equal(openDatabasePacket.responseCode, 0);

    assert.equal(openDatabasePacket.errorCode, undefined);
    assert.equal(openDatabasePacket.errorMsg, undefined);

    assert.equal(openDatabasePacket.brokerInfo[0], undefined);
    assert.equal(openDatabasePacket.sessionId, 3);
  });
});
