'use strict';

const assert = require('node:assert');

describe('test_packets.CancelRequestPacket', function () {
  const PacketReader = require('../../src/packets/PacketReader');
  const PacketWriter = require('../../src/packets/PacketWriter');
  const CancelRequestPacket = require('../../src/packets/CancelRequestPacket');
  const CASConstants = require('../../src/constants/CASConstants');

  /** The ten bytes as they go on the wire. */
  function bytesFor(processId) {
    const packet = new CancelRequestPacket({ processId });
    const writer = new PacketWriter(packet.getBufferLength());

    packet.write(writer);

    return writer._toBuffer();
  }

  it('opens with the two bytes the listener reads first', function () {
    const buffer = bytesFor(1);

    assert.equal(buffer[0], 0x58); // 'X'
    assert.equal(buffer[1], 0x31); // '1'
  });

  it('states the protocol version the client speaks', function () {
    // The listener answers a version it does not know with a refusal rather
    // than by guessing, so this byte is not decoration.
    assert.equal(bytesFor(1)[2], CASConstants.CAS_VERSION);
  });

  it('leaves the three reserved bytes at zero', function () {
    const buffer = bytesFor(0x7FFFFFFF);

    assert.equal(buffer[3], 0);
    assert.equal(buffer[4], 0);
    assert.equal(buffer[5], 0);
  });

  it('names the CAS process, big-endian, in the last four bytes', function () {
    const buffer = bytesFor(0x01020304);

    assert.equal(buffer[6], 0x01);
    assert.equal(buffer[7], 0x02);
    assert.equal(buffer[8], 0x03);
    assert.equal(buffer[9], 0x04);
  });

  it('is exactly ten bytes, with no length prefix', function () {
    // The listener reads a fixed ten for a cancel. A length header in front of
    // them would be read as the magic and the request rejected.
    const packet = new CancelRequestPacket({ processId: 4242 });

    assert.equal(packet.getBufferLength(), 10);
    assert.equal(bytesFor(4242).length, 10);
  });

  it('writes the whole request the CAS listener expects', function () {
    // The format in one place, so a change to any part of it is deliberate.
    assert.deepEqual(
      [...bytesFor(0x01020304)],
      [0x58, 0x31, CASConstants.CAS_VERSION, 0, 0, 0, 0x01, 0x02, 0x03, 0x04]
    );
  });

  it('reads the answer as one integer', function () {
    const packet = new CancelRequestPacket({ processId: 1 });
    const reader = new PacketReader();

    reader.write(Buffer.from([0, 0, 0, 0]));

    assert.equal(packet.parse(reader), 0);
    assert.equal(packet.responseCode, 0);
  });

  it('reports a refusal as the negative code that was sent', function () {
    const packet = new CancelRequestPacket({ processId: 1 });
    const reader = new PacketReader();

    // -1019 is CAS_ER_QUERY_CANCEL in the -1000-based encoding.
    reader.write(Buffer.from([0xFF, 0xFF, 0xFC, 0x05]));

    assert.equal(packet.parse(reader), -1019);
  });
});
