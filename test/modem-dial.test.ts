import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import {
	ardopBandwidth,
	bandwidthOfMode,
	dialModem,
	nearestBandwidth,
	probeModem
} from '../packages/server/src/modem-dial.ts';

/** A modem that speaks whatever the test tells it to, and records what it hears. */
async function fakeModem(
	onLine: (line: string, socket: Socket) => void,
): Promise<{ port: number; heard: string[]; close: () => Promise<void> }> {
	const heard: string[] = [];
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		let buffer = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			let index = buffer.search(/[\r\n]/);
			while (index >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line) {
					heard.push(line);
					onLine(line, socket);
				}
				index = buffer.search(/[\r\n]/);
			}
		});
		socket.on('error', () => undefined);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	return {
		port: address.port,
		heard,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

const base = {
	host: '127.0.0.1',
	myCallsign: 'OK1ABC',
	target: 'OK1RAA',
	bandwidthHz: 2300,
	timeoutMs: 4_000,
};

test('VARA dialect: a call that is answered succeeds, and is hung up', async () => {
	const modem = await fakeModem((line, socket) => {
		if (line === 'CONNECT OK1ABC OK1RAA') {
			socket.write('PTT ON\r');
			socket.write('CONNECTED OK1ABC OK1RAA\r');
		}
		if (line === 'DISCONNECT') socket.write('DISCONNECTED\r');
	});
	try {
		const outcome = await dialModem({
			...base,
			port: modem.port,
			dialect: 'vara',
			hf: true,
			bandwidthChoices: [500, 2300, 2750]
		});
		assert.equal(outcome.result, 'connected', outcome.message);
		assert.match(outcome.message, /connected to OK1RAA/);
		// The reference order: MYCALL, LISTEN OFF, COMPRESSION TEXT, WINLINK SESSION,
		// BW<bandwidth>, CONNECT <my> <target> — bandwidth is not a CONNECT argument.
		assert.deepEqual(modem.heard.slice(0, 6), [
			'MYCALL OK1ABC',
			'LISTEN OFF',
			'COMPRESSION TEXT',
			'WINLINK SESSION',
			'BW2300',
			'CONNECT OK1ABC OK1RAA'
		]);
		assert.ok(modem.heard.includes('DISCONNECT'), 'the link was dropped again');
		assert.ok(outcome.log.includes('PTT ON'));
		assert.ok(outcome.elapsedMs >= 0);
	} finally {
		await modem.close();
	}
});

test('VARA dialect: a busy frequency is a failure, not an error', async () => {
	const modem = await fakeModem((line, socket) => {
		if (line.startsWith('CONNECT ')) socket.write('BUSY ON\r');
	});
	try {
		const outcome = await dialModem({ ...base, port: modem.port, dialect: 'vara' });
		assert.equal(outcome.result, 'failed');
		assert.match(outcome.message, /busy/);
	} finally {
		await modem.close();
	}
});

test('VARA dialect: DISCONNECTED means the gateway did not answer', async () => {
	const modem = await fakeModem((line, socket) => {
		if (line.startsWith('CONNECT ')) setTimeout(() => socket.write('DISCONNECTED\r'), 20);
	});
	try {
		const outcome = await dialModem({ ...base, port: modem.port, dialect: 'vara' });
		assert.equal(outcome.result, 'failed');
		assert.match(outcome.message, /did not answer/);
	} finally {
		await modem.close();
	}
});

test('ARDOP dialect: MYCALL, ARQBW and ARQCALL, then CONNECTED with the bandwidth', async () => {
	const modem = await fakeModem((line, socket) => {
		if (line.startsWith('ARQCALL')) {
			socket.write('NEWSTATE ARQ\r');
			setTimeout(() => socket.write('CONNECTED OK1RAA 500\r'), 20);
		}
	});
	try {
		const outcome = await dialModem({
			...base,
			port: modem.port,
			dialect: 'ardop',
			bandwidthHz: 500,
			connectRequests: 6
		});
		assert.equal(outcome.result, 'connected', outcome.message);
		assert.deepEqual(modem.heard.slice(0, 3), ['MYCALL OK1ABC', 'ARQBW 500MAX', 'ARQCALL OK1RAA 6']);
		assert.equal(outcome.connectedBandwidthHz, 500, "the modem's own report of the bandwidth");
	} finally {
		await modem.close();
	}
});

test('ARDOP dialect: a FAULT is an error and is quoted back', async () => {
	const modem = await fakeModem((line, socket) => {
		if (line.startsWith('ARQCALL')) socket.write('FAULT not connected\r');
	});
	try {
		const outcome = await dialModem({ ...base, port: modem.port, dialect: 'ardop' });
		assert.equal(outcome.result, 'error');
		assert.match(outcome.message, /FAULT not connected/);
	} finally {
		await modem.close();
	}
});

test('Data2G dials at its own bandwidths, not VARA\'s', async () => {
	const modem = await fakeModem((line, socket) => {
		if (line.startsWith('CONNECT ')) setTimeout(() => socket.write('CONNECTED\r'), 20);
	});
	try {
		// The channel says VARA 2750; Data2G tops out at 2300.
		const outcome = await dialModem({
			...base,
			port: modem.port,
			dialect: 'vara',
			hf: true,
			bandwidthHz: 2750,
			bandwidthChoices: [200, 500, 2300]
		});
		assert.equal(outcome.result, 'connected', outcome.message);
		assert.ok(modem.heard.includes('BW2300'), `sent ${modem.heard.join(', ')}`);
		assert.ok(!modem.heard.includes('BW2750'));
	} finally {
		await modem.close();
	}
});

test('Data2G gets the common commands only, not VARA\'s session preamble', async () => {
	const modem = await fakeModem((line, socket) => {
		if (line.startsWith('CONNECT ')) setTimeout(() => socket.write('CONNECTED OK1ABC OK1RAA 2300\r'), 20);
	});
	try {
		const outcome = await dialModem({
			...base,
			port: modem.port,
			dialect: 'vara',
			hf: true,
			plainVara: true,
			bandwidthHz: 2300,
			bandwidthChoices: [500, 1200, 2300, 2750]
		});
		assert.equal(outcome.result, 'connected', outcome.message);
		assert.deepEqual(modem.heard.slice(0, 3), ['MYCALL OK1ABC', 'LISTEN OFF', 'BW2300']);
		assert.ok(!modem.heard.includes('WINLINK SESSION'), 'Data2G has no WINLINK SESSION');
		assert.ok(!modem.heard.includes('COMPRESSION TEXT'), 'nor COMPRESSION');
		assert.ok(modem.heard.includes('CONNECT OK1ABC OK1RAA'));
	} finally {
		await modem.close();
	}
});

test('a modem whose bandwidths are unknown gets no bandwidth command', async () => {
	const modem = await fakeModem((line, socket) => {
		if (line.startsWith('CONNECT ')) setTimeout(() => socket.write('CONNECTED\r'), 20);
	});
	try {
		const outcome = await dialModem({
			...base,
			port: modem.port,
			dialect: 'vara',
			bandwidthHz: 2300,
			bandwidthChoices: null
		});
		assert.equal(outcome.result, 'connected', outcome.message);
		assert.ok(!modem.heard.some((line) => line.startsWith('BW')), 'no invented command');
		assert.ok(outcome.log.some((line) => /not recorded/.test(line)));
	} finally {
		await modem.close();
	}
});

test('a silent modem times out as a failed call', async () => {
	const modem = await fakeModem(() => undefined);
	try {
		const outcome = await dialModem({ ...base, port: modem.port, dialect: 'vara', timeoutMs: 300 });
		assert.equal(outcome.result, 'failed');
		assert.match(outcome.message, /no answer/);
	} finally {
		await modem.close();
	}
});

test('a modem that is not listening is reported, not thrown', async () => {
	// Port 1 on the loopback is closed on any sane host.
	const outcome = await dialModem({ ...base, port: 1, dialect: 'vara', timeoutMs: 1_000 });
	assert.equal(outcome.result, 'error');
	assert.match(outcome.message, /cannot reach the modem at 127\.0\.0\.1:1/);
	assert.deepEqual(outcome.log, []);
});

test('a configured modem is only running when its port answers', async () => {
	// Nothing listening: a closed port on the loopback.
	const closed = await probeModem('127.0.0.1', 1, 500);
	assert.equal(closed.running, false);
	assert.ok(closed.error);

	// A modem that is up: the probe connects, sends nothing and hangs up.
	const modem = await fakeModem(() => undefined);
	try {
		const open = await probeModem('127.0.0.1', modem.port, 500);
		assert.equal(open.running, true);
		assert.equal(open.error, null);
		assert.deepEqual(modem.heard, [], 'the probe must not speak to the modem');
	} finally {
		await modem.close();
	}
});

test('bandwidths are written the way each dialect expects', () => {
	assert.equal(ardopBandwidth(2000), '2000MAX');
	assert.equal(ardopBandwidth(500), '500MAX');
	assert.equal(ardopBandwidth(700), '500MAX', 'the nearest ARDOP allows');
	assert.equal(bandwidthOfMode('VARA 2750'), 2750);
	assert.equal(bandwidthOfMode('VARA 500'), 500);
	assert.equal(bandwidthOfMode('ARDOP 2000'), 2000);
	assert.equal(bandwidthOfMode('VARA'), 2300, 'a bare VARA entry is the standard 2300 Hz mode');
	assert.equal(bandwidthOfMode('VARA FM'), 1200);
	assert.equal(bandwidthOfMode('Packet 1200'), 1200);

	// Each modem has its own set, and a wanted bandwidth is snapped to it before it is
	// sent as BWnnn.
	const vara = [500, 2300, 2750];
	const data2g = [200, 500, 2300];
	assert.equal(nearestBandwidth(2750, vara), 2750);
	assert.equal(nearestBandwidth(1200, vara), 500);
	// A DATA2G channel listed as VARA 2750 is still a 2300 Hz Data2G contact.
	assert.equal(nearestBandwidth(2750, data2g), 2300);
	assert.equal(nearestBandwidth(500, data2g), 500);
	assert.equal(nearestBandwidth(2000, data2g), 2300);
	assert.equal(nearestBandwidth(200, data2g), 200);
});
