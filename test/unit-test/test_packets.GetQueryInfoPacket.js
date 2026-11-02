'use strict';

const assert = require('node:assert');

describe('test_packets.GetQueryInfoPacket', function () {
  const PacketReader = require('../../src/packets/PacketReader');
  const PacketWriter = require('../../src/packets/PacketWriter');
  const GetQueryInfoPacket = require('../../src/packets/GetQueryInfoPacket');
  const CAS = require('../../src/constants/CASConstants');

  const CAS_INFO = Buffer.from([0, 255, 255, 255]);

  const written = (sql) => {
    const packet = new GetQueryInfoPacket({ casInfo: CAS_INFO, sql });
    const writer = new PacketWriter(packet.getBufferLength());

    packet.write(writer);

    return { packet, buffer: writer._toBuffer() };
  };

  it('asks for query information', function () {
    const { buffer } = written('select 1');

    // Byte 8 is the function code, after the length and the CAS info.
    assert.equal(buffer[8], CAS.CASFunctionCode.CAS_FC_GET_QUERY_INFO);
    assert.equal(buffer[8], 24);
  });

  it('declares the length of everything after the CAS info', function () {
    const { packet, buffer } = written('select 1');

    assert.equal(buffer.readInt32BE(0), packet.getBufferLength() - 8);
    assert.equal(buffer.length, packet.getBufferLength());
  });

  it('sends handle 0, which means "this SQL" rather than a prepared statement', function () {
    const { buffer } = written('select 1');

    // Each argument is its own length followed by its value.
    assert.equal(buffer.readInt32BE(9), 4);
    assert.equal(buffer.readInt32BE(13), 0);
  });

  it('asks for the plan, and nothing else', function () {
    const { buffer } = written('select 1');

    assert.equal(buffer.readInt32BE(17), 1);
    assert.equal(buffer[21], GetQueryInfoPacket.QUERY_INFO_PLAN);
    assert.equal(buffer[21], 0x01);
  });

  it('sends the statement null-terminated, with its length', function () {
    const { buffer } = written('select 1');

    assert.equal(buffer.readInt32BE(22), 'select 1'.length + 1);
    assert.equal(buffer.subarray(26, 34).toString(), 'select 1');
    assert.equal(buffer[34], 0);
  });

  it('measures a statement in bytes, not characters', function () {
    // A declared length taken from `.length` would be short for anything
    // outside ASCII, and the broker would read the packet off by that much.
    const { packet, buffer } = written('select é');

    assert.equal(buffer.length, packet.getBufferLength());
    assert.equal(buffer.readInt32BE(22), Buffer.byteLength('select é') + 1);
  });

  it('reads the plan out of the reply', function () {
    const plan = 'Join graph segments:\n  seg[0]: orders';
    const body = Buffer.concat([
      Buffer.from([0, 0, 0, 0]), // response code
      Buffer.from(plan, 'utf8'),
      Buffer.from([0]),
    ]);
    const head = Buffer.alloc(8);

    head.writeInt32BE(body.length, 0);
    CAS_INFO.copy(head, 4);

    const reader = new PacketReader();

    reader.write(Buffer.concat([head, body]));

    const packet = new GetQueryInfoPacket({});

    packet.parse(reader);

    assert.equal(packet.responseCode, 0);
    assert.equal(packet.plan, plan);
  });

  it('reports a refusal as an error rather than as a plan', function () {
    const body = Buffer.concat([
      Buffer.from([0xFF, 0xFF, 0xFC, 0x05]), // -1019
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('no such table\u0000', 'utf8'),
    ]);
    const head = Buffer.alloc(8);

    head.writeInt32BE(body.length, 0);
    CAS_INFO.copy(head, 4);

    const reader = new PacketReader();

    reader.write(Buffer.concat([head, body]));

    const packet = new GetQueryInfoPacket({});
    const error = packet.parse(reader);

    assert.ok(error instanceof Error);
    assert.equal(packet.plan, '');
  });
});
