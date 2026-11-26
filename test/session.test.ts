// The B2F exchange against a scripted peer: the gateway side of the protocol is
// written out here line by line, so the client engine is proven against the wire
// form rather than against itself.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ByteReader,
	Session,
	buildOutbound,
	decompressB2,
	encodeTransfer,
	formatProposalBlock,
	parseB2Message,
	parseProposal,
	parseSid,
	proposalChecksum,
	secureLoginResponse,
	TransferDecoder,
	type B2Message,
	type Duplex,
	type LogEntry,
	type OutboundItem,
	type Proposal,
	type ProposalAnswer,
	type SessionHandler,
	type SessionOptions,
} from '@rfmail/core-b2f';

/** One end of an in-memory connection. Closing it is an EOF at the other end. */
class Channel implements Duplex {
	private chunks: Buffer[] = [];
	private waiters: Array<{ resolve: (chunk: Uint8Array) => void; reject: (error: Error) => void }> = [];
	private closed = false;
	peer: Channel | null = null;

	write(chunk: Uint8Array): void {
		this.peer?.push(Buffer.from(chunk));
	}

	async flush(): Promise<void> {
		// A socket has no flush; a modem transport waits on its own buffer instead.
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('the connection was closed'));
		this.peer?.end();
	}

	end(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('the peer closed the connection'));
	}

	read(): Promise<Uint8Array> {
		const chunk = this.chunks.shift();
		if (chunk) return Promise.resolve(new Uint8Array(chunk));
		if (this.closed) return Promise.reject(new Error('the connection was closed'));
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	private push(chunk: Buffer): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve(new Uint8Array(chunk));
		else this.chunks.push(chunk);
	}
}

function pair(): { station: Channel; gateway: Channel } {
	const station = new Channel();
	const gateway = new Channel();
	station.peer = gateway;
	gateway.peer = station;
	return { station, gateway };
}

/** The remote's side of the line: lines and framing over one channel. */
class Peer {
	readonly channel: Channel;
	private readonly reader: ByteReader;

	constructor(channel: Channel) {
		this.channel = channel;
		this.reader = new ByteReader(channel);
	}

	async line(): Promise<string> {
		return await this.reader.line();
	}

	async send(text: string): Promise<void> {
		this.channel.write(Buffer.from(`${text}\r`, 'latin1'));
	}

	async sendLines(lines: readonly string[]): Promise<void> {
		for (const line of lines) await this.send(line);
	}

	/** Reads one framed message: its header, its payload and anything after the EOT. */
	async readTransfer(): Promise<{ header: { title: string; offset: number }; payload: Uint8Array }> {
		const decoder = new TransferDecoder();
		let header: { title: string; offset: number } | null = null;
		for (;;) {
			const chunk = await this.reader.take();
			for (const event of decoder.push(chunk)) {
				if (event.type === 'header') header = event.header;
				if (event.type === 'end') {
					this.reader.unshift(decoder.drain());
					assert.ok(header, 'a transfer begins with a header');
					return { header, payload: event.payload };
				}
				if (event.type === 'remote-error') assert.fail(`the station refused a message: ${event.line}`);
			}
		}
	}
}

/** Reads a proposal block (or FF/FQ) from the station side. */
async function readBlock(peer: Peer): Promise<{ proposals: Proposal[]; terminator: string }> {
	const proposals: Proposal[] = [];
	for (;;) {
		const line = await peer.line();
		if (line === 'FF' || line === 'FQ') return { proposals, terminator: line };
		if (line.startsWith('F> ')) return { proposals, terminator: line.slice(3) };
		proposals.push(parseProposal(line));
	}
}

function b2(mid: string, from: string, subject: string, body: string, extra: Partial<B2Message> = {}): B2Message {
	return {
		mid,
		dateUtc: Date.UTC(2026, 10, 24, 18, 20),
		from,
		to: [from === 'OK4RM' ? 'OK1RAA' : 'OK4RM'],
		cc: [],
		subject,
		type: 'Private',
		mbo: '',
		body,
		charset: 'ISO-8859-1',
		attachments: [],
		headers: [],
		...extra,
	};
}

interface Log {
	sent: string[];
	rejected: string[];
	deferred: string[];
	received: B2Message[];
	lines: LogEntry[];
	failed: Array<{ mid: string; reason: string }>;
}

/** A handler with the state a real store keeps: what is still pending. */
function handler(
	outbound: OutboundItem[] = [],
	answer: (proposal: Proposal) => ProposalAnswer = () => '+',
): { handler: SessionHandler; log: Log } {
	const log: Log = { sent: [], rejected: [], deferred: [], received: [], lines: [], failed: [] };
	const pending = new Map(outbound.map((item) => [item.mid, item]));
	const settled = new Set<string>();
	return {
		log,
		handler: {
			outbound: () => [...pending.values()].filter((item) => !settled.has(item.mid)),
			sent: (mid) => {
				settled.add(mid);
				log.sent.push(mid);
			},
			rejected: (mid) => {
				settled.add(mid);
				log.rejected.push(mid);
			},
			deferred: (mid) => {
				settled.add(mid);
				log.deferred.push(mid);
			},
			answer: (proposal) => answer(proposal),
			received: (message) => {
				log.received.push(message);
			},
			receiveFailed: (proposal, reason) => {
				log.failed.push({ mid: proposal.mid, reason });
			},
			line: (direction, text) => {
				log.lines.push({ direction, text });
			},
		},
	};
}

function options(overrides: Partial<SessionOptions> & { handler: SessionHandler }): SessionOptions {
	return {
		myCallsign: 'OK4RM',
		target: 'OK1RAA',
		locator: 'JO70AA',
		silenceMs: 3_000,
		...overrides,
	};
}

const GW_SID = '[WL2K-5.0-B2FWIHJM$]';
const GW_PROMPT = '; OK4RM DE OK1RAA (JO70AA)>';

/** The gateway's opening: its SID, some chatter, and the prompt. */
async function openGateway(peer: Peer): Promise<void> {
	await peer.sendLines([GW_SID, '*** MTD Stats Total connects = 2580 Total messages = 3900', GW_PROMPT]);
}

/** The station's handshake lines (`;PR` makes it four), as the gateway reads them. */
async function readStationHandshake(peer: Peer, count = 3): Promise<string[]> {
	const lines: string[] = [];
	for (let index = 0; index < count; index += 1) lines.push(await peer.line());
	return lines;
}

function proposalOf(item: OutboundItem): Proposal {
	return {
		code: item.code,
		messageType: item.type,
		mid: item.mid,
		size: item.raw.length,
		compressedSize: item.compressed.length,
	};
}

test('the station offers its outbound mail and honours every answer', async () => {
	const { station, gateway } = pair();
	const accepted = buildOutbound(b2('AAAAAAAABBBB', 'OK4RM', 'Pozdrav', 'Ahoj z Prahy.\n'));
	const rejected = buildOutbound(b2('CCCCCCCCDDDD', 'OK4RM', 'Repeat', 'Already at the far end.\n'));
	const deferred = buildOutbound(b2('EEEEEEEEFFFF', 'OK4RM', 'Later', 'Ask me again.\n'));
	const state = handler([accepted, rejected, deferred]);
	const session = new Session(options({ handler: state.handler }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);

	await openGateway(peer);
	assert.deepEqual(await readStationHandshake(peer), [
		';FW: OK4RM',
		'[RF Mail-0.1-B2FHM$]',
		'; OK1RAA DE OK4RM (JO70AA)',
	]);

	// The station's first turn: three proposals as offered, one checksum.
	const block = await readBlock(peer);
	assert.deepEqual(
		block.proposals.map((proposal) => proposal.mid),
		['AAAAAAAABBBB', 'CCCCCCCCDDDD', 'EEEEEEEEFFFF'],
	);
	assert.equal(
		block.terminator,
		proposalChecksum(
			block.proposals.map(
				(proposal) =>
					`F${proposal.code} ${proposal.messageType} ${proposal.mid} ${proposal.size} ${proposal.compressedSize} 0`,
			),
		),
	);
	assert.equal(block.proposals[0]!.code, 'C', 'LZHUF is the default');
	assert.equal(block.proposals[0]!.size, accepted.raw.length);
	assert.equal(block.proposals[0]!.compressedSize, accepted.compressed.length);

	// Accept, reject (already have it), defer.
	await peer.send('FS +-=');

	const transfer = await peer.readTransfer();
	assert.equal(transfer.header.offset, 0);
	assert.equal(transfer.header.title, 'Pozdrav');
	assert.deepEqual(transfer.payload, accepted.compressed);
	const decoded = parseB2Message(decompressB2(transfer.payload));
	assert.equal(decoded.mid, 'AAAAAAAABBBB');
	assert.equal(decoded.body, 'Ahoj z Prahy.\n');

	// Its turn is over and the next one is the gateway's: a gateway with nothing
	// left quits, and the station stops there.
	await peer.send('FQ');

	const result = await exchange;
	assert.equal(result.result, 'complete');
	assert.deepEqual(result.sent, ['AAAAAAAABBBB']);
	assert.deepEqual(result.rejected, ['CCCCCCCCDDDD']);
	assert.deepEqual(result.deferred, ['EEEEEEEEFFFF']);
	assert.deepEqual(state.log.sent, ['AAAAAAAABBBB']);
	assert.deepEqual(state.log.rejected, ['CCCCCCCCDDDD']);
	assert.deepEqual(state.log.deferred, ['EEEEEEEEFFFF']);
	assert.equal(result.remoteSid, GW_SID);
	assert.deepEqual(result.forwarders, []);
	assert.ok(result.log.some((entry) => entry.direction === '<' && entry.text.startsWith('*** MTD Stats')));
	assert.ok(result.log.some((entry) => entry.direction === '<' && entry.text === 'FQ'));

	// What was settled is not offered again.
	assert.deepEqual(state.handler.outbound([]), []);
});

test('the station receives both compression codes and defers a duplicated proposal', async () => {
	const { station, gateway } = pair();
	const lzhuf = buildOutbound(
		b2('GGGGGGGGHHHH', 'OK1RAA', 'Compressed', 'LZHUF body.\n', {
			attachments: [{ name: 'note.txt', contentType: 'text/plain', data: Buffer.from('attachment\n') }],
		}),
	);
	const gzip = buildOutbound(b2('IIIIIIIIJJJJ', 'OK1RAA', 'Gzipped', 'gzip body.\n'), { gzip: true });
	const state = handler();
	const session = new Session(options({ handler: state.handler, gzip: true }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);

	await openGateway(peer);
	const handshake = await readStationHandshake(peer);
	assert.equal(handshake[1], '[RF Mail-0.1-B2FHMG$]', 'the gzip letter goes before the closing $');
	assert.equal(parseSid(handshake[1]!)?.flags, 'B2FHMG$');

	// Nothing outbound: the station says FF on its first turn.
	assert.equal((await readBlock(peer)).terminator, 'FF');

	// The gateway's turn: the same message twice (a radio gateway does that) and a
	// gzipped one, each announced with ;PM.
	await peer.sendLines([
		';PM: OK4RM GGGGGGGGHHHH 128 OK1RAA Compressed',
		...formatProposalBlock([proposalOf(lzhuf), proposalOf(lzhuf), proposalOf(gzip)]),
	]);
	assert.equal(await peer.line(), 'FS +=+', 'the first copy is accepted, its duplicate deferred, the gzipped one accepted');

	// The gateway sends the accepted messages, each framed on its own.
	gateway.write(encodeTransfer({ title: lzhuf.subject, offset: 0 }, lzhuf.compressed));
	gateway.write(encodeTransfer({ title: gzip.subject, offset: 0 }, gzip.compressed));

	// The station's next turn is outbound again: nothing left, so FF; then FQ.
	assert.equal((await readBlock(peer)).terminator, 'FF');
	await peer.send('FQ');

	const result = await exchange;
	assert.equal(result.result, 'complete');
	assert.deepEqual(result.received, ['GGGGGGGGHHHH', 'IIIIIIIIJJJJ']);
	assert.equal(state.log.received.length, 2);
	assert.equal(state.log.received[0]!.body, 'LZHUF body.\n');
	assert.equal(state.log.received[0]!.attachments.length, 1);
	assert.equal(Buffer.from(state.log.received[0]!.attachments[0]!.data).toString('latin1'), 'attachment\n');
	assert.equal(state.log.received[1]!.body, 'gzip body.\n');
	assert.deepEqual(result.failed, []);
	assert.equal(result.pending.length, 1);
	assert.equal(result.pending[0]!.mid, 'GGGGGGGGHHHH');
	assert.equal(result.pending[0]!.from, 'OK1RAA');
	assert.equal(result.pending[0]!.subject, 'Compressed');
});

test('an offset answer resumes the compressed stream at that byte', async () => {
	const { station, gateway } = pair();
	const big = buildOutbound(b2('KKKKKKKKLLLL', 'OK4RM', 'Long', `${'x'.repeat(4_000)}\n`));
	const state = handler([big]);
	const session = new Session(options({ handler: state.handler }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);

	await openGateway(peer);
	await readStationHandshake(peer);
	const block = await readBlock(peer);
	assert.equal(block.proposals.length, 1);
	await peer.send('FS A1000');

	const transfer = await peer.readTransfer();
	assert.equal(transfer.header.offset, 1000);
	assert.deepEqual(transfer.payload, big.compressed.subarray(1000), 'the payload starts at the accepted offset');

	await peer.send('FQ');
	const result = await exchange;
	assert.equal(result.result, 'complete');
	assert.deepEqual(result.sent, ['KKKKKKKKLLLL']);
});

test('the secure-login challenge is answered, and the response is in the log', async () => {
	const { station, gateway } = pair();
	const state = handler();
	const session = new Session(options({ handler: state.handler, password: 'hunter2' }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);

	await peer.sendLines([GW_SID, ';PQ: 12345678', GW_PROMPT]);
	const response = secureLoginResponse('12345678', 'hunter2');
	assert.deepEqual(await readStationHandshake(peer, 4), [
		';FW: OK4RM',
		'[RF Mail-0.1-B2FHM$]',
		`;PR: ${response}`,
		'; OK1RAA DE OK4RM (JO70AA)',
	]);

	assert.equal((await readBlock(peer)).terminator, 'FF');
	await peer.send('FQ');
	const result = await exchange;

	assert.equal(result.result, 'complete');
	const logged = result.log.filter((entry) => entry.direction === '>');
	// The response is a hash of the nonce and the password, not the password: it is shown
	// as it went out, so an operator can see what a gateway was offered.
	assert.ok(logged.some((entry) => entry.text === `;PR: ${response}`), 'the response is logged as sent');
	assert.ok(!logged.some((entry) => entry.text.includes('hunter2')), 'and the password itself never is');

	// The same nonce gives the same response and no other: it cannot be replayed against a
	// different challenge, which is what makes logging it harmless.
	assert.equal(secureLoginResponse('12345678', 'hunter2'), response);
	assert.notEqual(secureLoginResponse('87654321', 'hunter2'), response);
});

test('a challenge with no password set fails before anything is transmitted', async () => {
	const { station, gateway } = pair();
	const state = handler();
	const session = new Session(options({ handler: state.handler }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);
	await peer.sendLines([GW_SID, ';PQ: 12345678', GW_PROMPT]);
	await peer.line(); // ;FW
	await peer.line(); // SID
	const result = await exchange;

	assert.equal(result.result, 'failed');
	assert.match(result.error ?? '', /no Winlink password/);
});

test('a peer without B2 fails the session instead of guessing', async () => {
	const { station, gateway } = pair();
	const state = handler();
	const session = new Session(options({ handler: state.handler }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);
	await peer.sendLines(['[BPQ-1.0-AF$]', '; OK4RM DE OK1RAA>']);
	const result = await exchange;

	assert.equal(result.result, 'failed');
	assert.match(result.error ?? '', /does not support B2/);
	assert.deepEqual(result.sent, []);
});

test('a wrong proposal checksum fails the session', async () => {
	const { station, gateway } = pair();
	const state = handler();
	const session = new Session(options({ handler: state.handler }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);
	await openGateway(peer);
	await readStationHandshake(peer);
	assert.equal((await readBlock(peer)).terminator, 'FF');
	await peer.sendLines(['FC EM ZZZZZZZZYYYY 100 40 0', 'F> 00']);
	const result = await exchange;

	assert.equal(result.result, 'failed');
	assert.match(result.error ?? '', /checksum mismatch/);
});

test('a damaged message is reported on its own and the rest of the block still arrives', async () => {
	const { station, gateway } = pair();
	const good = buildOutbound(b2('MMMMMMMMNNNN', 'OK1RAA', 'Good', 'Fine.\n'));
	const damaged = buildOutbound(b2('OOOOOOOOPPPP', 'OK1RAA', 'Damaged', 'Broken.\n'));
	const state = handler();
	const session = new Session(options({ handler: state.handler }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);
	await openGateway(peer);
	await readStationHandshake(peer);
	assert.equal((await readBlock(peer)).terminator, 'FF');

	await peer.sendLines(formatProposalBlock([proposalOf(damaged), proposalOf(good)]));
	assert.equal(await peer.line(), 'FS ++');

	// The first message arrives with one payload byte corrupted: the framing is
	// intact, so only that message fails.
	const framed = Buffer.from(encodeTransfer({ title: damaged.subject, offset: 0 }, damaged.compressed));
	// The last two bytes are EOT and its checksum; flip a payload byte instead.
	framed[framed.length - 3] = framed[framed.length - 3]! ^ 0xff;
	gateway.write(framed);
	gateway.write(encodeTransfer({ title: good.subject, offset: 0 }, good.compressed));

	assert.equal((await readBlock(peer)).terminator, 'FF');
	await peer.send('FQ');

	const result = await exchange;
	assert.equal(result.result, 'complete');
	assert.deepEqual(result.received, ['MMMMMMMMNNNN']);
	assert.equal(result.failed.length, 1);
	assert.equal(result.failed[0]!.mid, 'OOOOOOOOPPPP');
	assert.match(result.failed[0]!.reason, /checksum/);
	assert.equal(state.log.received.length, 1);
});

test('a silent peer is a lost link, not a hung session', async () => {
	const { station, gateway } = pair();
	const state = handler();
	const session = new Session(options({ handler: state.handler, silenceMs: 60 }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);
	await peer.send(GW_SID);
	const result = await exchange;

	assert.equal(result.result, 'failed');
	assert.match(result.error ?? '', /silent/);
});

test('an aborted session ends as aborted and closes the link', async () => {
	const { station, gateway } = pair();
	const state = handler();
	const session = new Session(options({ handler: state.handler, silenceMs: 5_000 }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);
	await openGateway(peer);
	session.abort('the operator cancelled the session');
	const result = await exchange;

	assert.equal(result.result, 'aborted');
	assert.equal(result.error, 'the operator cancelled the session');
});

test('the answering half runs the turns the other way round', async () => {
	const { station, gateway } = pair();
	const offered = buildOutbound(b2('QQQQQQQQRRRR', 'OK4RM', 'From the post office', 'Hello.\n'));
	const theirs = buildOutbound(b2('SSSSSSSSTTTT', 'OK1XYZ', 'For a user', 'Inbound.\n'));
	const state = handler([offered]);
	const session = new Session(options({ handler: state.handler, master: true }));
	const peer = new Peer(gateway);

	const exchange = session.run(station);

	// The master opens the handshake and prompts.
	assert.deepEqual(await readStationHandshake(peer), [
		';FW: OK4RM',
		'[RF Mail-0.1-B2FHM$]',
		'; OK1RAA DE OK4RM (JO70AA)>',
	]);

	// The client answers; the master waits for the greeting, not a prompt.
	await peer.sendLines([';FW: OK1RAA', GW_SID, '; OK4RM DE OK1RAA (JO70AA)']);

	// The client's turn comes first when this station is the answering half.
	await peer.sendLines(formatProposalBlock([proposalOf(theirs)]));
	assert.equal(await peer.line(), 'FS +');
	gateway.write(encodeTransfer({ title: theirs.subject, offset: 0 }, theirs.compressed));

	// Now the station's turn: it offers what it holds.
	const block = await readBlock(peer);
	assert.equal(block.proposals.length, 1);
	assert.equal(block.proposals[0]!.mid, 'QQQQQQQQRRRR');
	await peer.send('FS +');
	assert.deepEqual((await peer.readTransfer()).payload, offered.compressed);

	// The client has nothing more; the station quits.
	await peer.send('FF');
	assert.equal(await peer.line(), 'FQ');

	const result = await exchange;
	assert.equal(result.result, 'complete');
	assert.deepEqual(result.sent, ['QQQQQQQQRRRR']);
	assert.deepEqual(result.received, ['SSSSSSSSTTTT']);
});

// -- the three kinds of far end ----------------------------------------------
//
// What decides them is not the exchange, which is identical, but the two lines B2
// asks for before it: `;FW:` (whom we collect mail for) and `;PR:` (whether a
// secure-login challenge is answered, and whether having no password is fatal).

test('a CMS session asks for the auxiliary addresses too', async () => {
	const { station, gateway } = pair();
	const state = handler();
	const session = new Session(options({ handler: state.handler, myCallsign: 'OK4RM', auxiliary: ['OK2XYZ'] }));
	const peer = new Peer(gateway);
	const exchange = session.run(station);

	await openGateway(peer);
	const handshake = await readStationHandshake(peer);
	assert.equal(handshake[0], ';FW: OK4RM OK2XYZ', 'a CMS routes for the whole system, so it is asked for every address');
	assert.equal((await readBlock(peer)).terminator, 'FF');
	await peer.send('FQ');

	assert.equal((await exchange).result, 'complete');
});

test('a peer-to-peer session asks only for its own address', async () => {
	const { station, gateway } = pair();
	const state = handler();
	const session = new Session(
		options({ handler: state.handler, myCallsign: 'OK4RM', auxiliary: ['OK2XYZ'], mode: 'p2p' }),
	);
	const peer = new Peer(gateway);
	const exchange = session.run(station);

	await openGateway(peer);
	const handshake = await readStationHandshake(peer);
	assert.equal(handshake[0], ';FW: OK4RM', 'a peer holds mail for itself alone');
	assert.equal((await readBlock(peer)).terminator, 'FF');
	await peer.send('FQ');

	assert.equal((await exchange).result, 'complete');
});

test('a post office is asked for the auxiliary addresses as well', async () => {
	const { station, gateway } = pair();
	const state = handler();
	const session = new Session(
		options({ handler: state.handler, myCallsign: 'OK4RM', auxiliary: ['OK2XYZ'], mode: 'postoffice' }),
	);
	const peer = new Peer(gateway);
	const exchange = session.run(station);

	await openGateway(peer);
	const handshake = await readStationHandshake(peer);
	assert.equal(handshake[0], ';FW: OK4RM OK2XYZ', 'a post office may hold mail for several of our addresses');
	assert.equal((await readBlock(peer)).terminator, 'FF');
	await peer.send('FQ');

	assert.equal((await exchange).result, 'complete');
});

test('a challenge is refused by a server and merely reported by a peer', async () => {
	// A peer station has no password of ours to check, so a challenge from one is a
	// statement we cannot answer and the session goes on unauthenticated. A post office
	// or a CMS that challenges is different: it holds accounts and is asking who we
	// are, so an unanswered challenge is refused rather than served.
	const { station, gateway } = pair();
	const session = new Session(options({ handler: handler().handler, myCallsign: 'OK4RM', mode: 'p2p', password: null }));
	const peer = new Peer(gateway);
	const exchange = session.run(station);

	await peer.sendLines([GW_SID, ';PQ: 12345678', '; OK4RM DE OK1RAA (JO70AA)>']);
	const handshake = await readStationHandshake(peer);
	assert.equal(handshake.length, 3, 'no ;PR: line when there is no password');
	assert.ok(!handshake.some((line) => line.startsWith(';PR:')), 'no credential is invented');
	assert.equal((await readBlock(peer)).terminator, 'FF');
	await peer.send('FQ');

	const result = await exchange;
	assert.equal(result.result, 'complete', 'a peer session goes on unauthenticated');
	assert.ok(result.log.some((entry) => entry.text.includes('a peer cannot be authenticated')));

	for (const mode of ['postoffice', 'cms'] as const) {
		const pair2 = pair();
		const refused = new Session(options({ handler: handler().handler, myCallsign: 'OK4RM', mode, password: null }));
		const askPeer = new Peer(pair2.gateway);
		const attempt = refused.run(pair2.station);
		await askPeer.sendLines([GW_SID, ';PQ: 12345678', '; OK4RM DE OK1RAA (JO70AA)>']);
		const end = await attempt;
		assert.equal(end.result, 'failed', `${mode}: an unanswered challenge ends the session`);
		assert.match(end.error ?? '', /no Winlink password/);
	}
});

test('a claimed client identity replaces ours in the SID, and an invalid one does not', async () => {
	for (const [claimed, expected] of [
		[{ application: 'RMS Express', version: '1.8.6.0' }, '[RMS Express-1.8.6.0-B2FHM$]'],
		[null, '[RF Mail-0.1-B2FHM$]'],
	] as const) {
		const { station, gateway } = pair();
		const state = handler();
		const session = new Session(
			options({ handler: state.handler, myCallsign: 'OK4RM', ...(claimed ?? {}) }),
		);
		const peer = new Peer(gateway);
		const exchange = session.run(station);

		await openGateway(peer);
		const handshake = await readStationHandshake(peer);
		assert.equal(handshake[1], expected, 'the SID names the client the station presents');
		assert.equal((await readBlock(peer)).terminator, 'FF');
		await peer.send('FQ');
		assert.equal((await exchange).result, 'complete');
	}
});
