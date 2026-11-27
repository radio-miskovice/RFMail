import assert from 'node:assert/strict';
import test from 'node:test';
import { Duplex } from 'node:stream';
import { SessionStreams, websocketAccept } from '@rfmail/server';

/** A socket the channel can write to, keeping every byte for the test to read. */
class FakeSocket extends Duplex {
  written = '';

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written += chunk.toString('latin1');
    callback();
  }
}

/** The payload of the first text frame in a byte string, and how many bytes it took. */
function firstTextFrame(bytes: string): { payload: unknown; length: number } {
  const buffer = Buffer.from(bytes, 'latin1');
  const opcode = (buffer[0] ?? 0) & 0x0f;
  if (opcode !== 0x1) throw new Error(`not a text frame: opcode ${opcode}`);
  const length = (buffer[1] ?? 0) & 0x7f;
  return { payload: JSON.parse(buffer.subarray(2, 2 + length).toString('utf8')), length: 2 + length };
}

/**
 * The one control, in two steps: the first call asks the link to come down, the second — while
 * that is still happening — cuts it. A third press must not do anything more.
 */
test('the single control escalates from a disconnect to an abort once', () => {
  const streams = new SessionStreams();
  const channel = streams.open('bench-1');
  const called: string[] = [];

  // Nothing is bound before the session has sockets to stop.
  assert.equal(channel.stop(), 'idle');
  assert.equal(called.length, 0);

  channel.bind({
    disconnect: () => called.push('disconnect'),
    abort: () => called.push('abort'),
  });

  assert.equal(channel.stop(), 'disconnecting');
  assert.deepEqual(called, ['disconnect'], 'the first press asks politely');

  assert.equal(channel.stop(), 'aborted');
  assert.deepEqual(called, ['disconnect', 'abort'], 'the second press cuts the link');

  assert.equal(channel.stop(), 'aborted');
  assert.deepEqual(called, ['disconnect', 'abort'], 'a third press has nothing left to do');
});

/** A channel is reachable by the id the screen made up, and only by it. */
test('a channel is found by its id and forgotten when the session ends', () => {
  const streams = new SessionStreams();
  const channel = streams.open('bench-2');
  assert.equal(streams.get('bench-2'), channel);
  assert.equal(streams.get('bench-3'), null);
  streams.forget('bench-2');
  assert.equal(streams.get('bench-2'), null);
});


/** The accept token is what the browser's own handshake check expects. */
test('the handshake answer is sha1 of the key and the WebSocket GUID', () => {
  assert.equal(
    websocketAccept('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'the token from RFC 6455 section 1.3',
  );
});

/** Every event reaches the attached screen as one unmasked text frame carrying its JSON. */
test('an event reaches the screen as a text frame, and the backlog precedes it', () => {
  const streams = new SessionStreams();
  const channel = streams.open('bench-6');

  // Said before anyone was watching: kept for a screen that arrives a moment late.
  channel.publish({ t: 'modem', dir: '<', text: 'CONNECTED VARA 2300', atMs: 0 });

  const socket = new FakeSocket();
  channel.attach(socket);

  const replayed = firstTextFrame(socket.written);
  assert.deepEqual(replayed.payload, { t: 'modem', dir: '<', text: 'CONNECTED VARA 2300', atMs: 0 });

  socket.written = socket.written.slice(replayed.length);
  channel.publish({ t: 'line', dir: '>', text: 'FBB station', atMs: 12 });
  const live = firstTextFrame(socket.written);
  assert.deepEqual(live.payload, { t: 'line', dir: '>', text: 'FBB station', atMs: 12 });
});
