import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server, type Socket } from 'node:net';
import { Rigctld, RigError, defaultTransceiver, launchArgv, validateTransceiver } from '@rfmail/rig';

/** A rigctld that answers the commands this client sends, plus a way to misbehave. */
async function fakeRigctld(options: {
	behaviour?: 'normal' | 'error' | 'drop-once' | 'silent' | 'no-rear-ptt';
} = {}): Promise<{
	port: number;
	received: string[];
	close: () => Promise<void>;
}> {
	const received: string[] = [];
	let dropped = false;
	const sockets = new Set<Socket>();
	let frequency = 7_040_000;
	let mode = 'USB';
	let passband = 2700;
	let ptt = false;

	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		let buffer = '';
		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1');
			let index = buffer.indexOf('\n');
			while (index !== -1) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				received.push(line);

				if (options.behaviour === 'silent') {
					index = buffer.indexOf('\n');
					continue;
				}
				if (options.behaviour === 'drop-once' && !dropped) {
					dropped = true;
					sockets.delete(socket);
					socket.destroy();
					index = buffer.indexOf('\n');
					continue;
				}
				if (options.behaviour === 'error' && line.startsWith('\\set_freq')) {
					socket.write('RPRT -8\n');
					index = buffer.indexOf('\n');
					continue;
				}

				if (line.startsWith('+')) {
					// The extended protocol: echo, labelled values, terminating RPRT.
					const cmd = line.slice(1);
					if (cmd === '\\get_freq') socket.write(`get_freq:\nFrequency: ${frequency}\nRPRT 0\n`);
					else if (cmd === '\\get_mode') socket.write(`get_mode:\nMode: ${mode}\nPassband: ${passband}\nRPRT 0\n`);
					else if (cmd === '\\get_ptt') socket.write(`get_ptt:\nPTT: ${ptt ? 1 : 0}\nRPRT 0\n`);
					else if (cmd === '\\get_split_vfo')
						socket.write('get_split_vfo:\nSplit: 0\nTX VFO: VFOA\nRPRT 0\n');
					else socket.write('RPRT -11\n');
					index = buffer.indexOf('\n');
					continue;
				}
				if (line === '\\get_freq') socket.write(`${frequency}\n`);
				else if (line.startsWith('\\set_freq')) {
					frequency = Number(line.split(' ')[1]);
					socket.write('RPRT 0\n');
				} else if (line === '\\get_mode') socket.write(`${mode}\n${passband}\n`);
				else if (line.startsWith('\\set_mode')) {
					const parts = line.split(/\s+/);
					mode = parts[1] ?? mode;
					passband = Number(parts[2] ?? passband);
					socket.write('RPRT 0\n');
				} else if (line.startsWith('\\set_ptt')) {
					if (options.behaviour === 'no-rear-ptt' && line.endsWith('3')) {
						socket.write('RPRT -8\n');
					} else {
						ptt = !line.endsWith('0');
						socket.write('RPRT 0\n');
					}
				} else if (line === '\\get_ptt') socket.write(`${ptt ? 1 : 0}\n`);
				else if (line === '\\chk_vfo') socket.write('CHKVFO 1\n');
				else socket.write('RPRT -11\n');

				index = buffer.indexOf('\n');
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	return {
		port,
		received,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test('reads and writes frequency, mode and PTT', async () => {
	const rig = await fakeRigctld();
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port });
	try {
		assert.equal(await client.getFrequency(), 7_040_000);
		await client.setFrequency(10_148_000);
		assert.equal(await client.getFrequency(), 10_148_000);

		assert.deepEqual(await client.getMode(), { mode: 'USB', passbandHz: 2700 });
		await client.setMode('PKTUSB', 500);
		assert.deepEqual(await client.getMode(), { mode: 'PKTUSB', passbandHz: 500 });

		await client.setPtt(true);
		assert.equal(await client.getPtt(), true);
		await client.setPtt(false);
		assert.equal(await client.getPtt(), false);

		assert.deepEqual(await client.getState(), { frequencyHz: 10_148_000, mode: 'PKTUSB', passbandHz: 500 });
		assert.equal(await client.supportsVfo(), true);

		// Getters use the extended protocol, setters the classic one.
		assert.deepEqual(rig.received, [
			'+\\get_freq',
			'\\set_freq 10148000',
			'+\\get_freq',
			'+\\get_mode',
			'\\set_mode PKTUSB 500',
			'+\\get_mode',
			'\\set_ptt 3',
			'+\\get_ptt',
			'\\set_ptt 0',
			'+\\get_ptt',
			'+\\get_freq',
			'+\\get_mode',
			'\\chk_vfo',
		]);
		assert.deepEqual(await client.getSplit(), { split: false, txVfo: 'VFOA' });
	} finally {
		client.close();
		await rig.close();
	}
});

test('an RPRT error is raised as a typed error and not retried', async () => {
	const rig = await fakeRigctld({ behaviour: 'error' });
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port });
	try {
		await assert.rejects(() => client.setFrequency(3_600_000), (error: unknown) => {
			const rigError = error as RigError;
			assert.ok(rigError instanceof RigError);
			assert.equal(rigError.code, -8);
			assert.equal(rigError.command, '\\set_freq 3600000');
			return true;
		});
		assert.equal(rig.received.filter((line) => line.startsWith('\\set_freq')).length, 1, 'no retry on a Hamlib error');
	} finally {
		client.close();
		await rig.close();
	}
});

test('a dropped connection is reconnected and the command repeated', async () => {
	const rig = await fakeRigctld({ behaviour: 'drop-once' });
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port, reconnectAttempts: 3 });
	try {
		// The daemon kills the first connection after one command; the client has to
		// notice, reconnect and send the command again.
		assert.equal(await client.getFrequency(), 7_040_000);
		assert.equal(rig.received.filter((line) => line === '+\\get_freq').length, 2);
	} finally {
		client.close();
		await rig.close();
	}
});

test('a radio that does not answer fails with a timeout instead of hanging', async () => {
	const rig = await fakeRigctld({ behaviour: 'silent' });
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port, timeoutMs: 150, reconnectAttempts: 2 });
	try {
		await assert.rejects(() => client.getFrequency(), /did not answer|closed the connection/);
	} finally {
		client.close();
		await rig.close();
	}
});

test('an unreachable daemon is reported as a connection error', async () => {
	const client = new Rigctld({ host: '127.0.0.1', port: 1, timeoutMs: 200, reconnectAttempts: 1 });
	await assert.rejects(() => client.getFrequency(), /cannot reach rigctld|ECONNREFUSED|did not answer/);
	client.close();
});

test('the transmitting connector is chosen per transceiver, not assumed', async () => {
	const rig = await fakeRigctld();
	const rear = new Rigctld({ host: '127.0.0.1', port: rig.port, pttInput: 'rear' });
	const front = new Rigctld({ host: '127.0.0.1', port: rig.port, pttInput: 'front' });
	const auto = new Rigctld({ host: '127.0.0.1', port: rig.port, pttInput: 'auto' });
	try {
		await rear.setPtt(true);
		assert.equal(rear.pttValueInUse, 3, 'the rear input is RIG_PTT_ON_DATA');
		await rear.setPtt(false);
		assert.equal(rear.pttValueInUse, 0);

		await front.setPtt(true);
		assert.equal(front.pttValueInUse, 1, 'the front microphone is plain RIG_PTT_ON');

		await auto.setPtt(true);
		assert.equal(auto.pttValueInUse, 3, 'auto prefers the rear input');
		assert.equal(auto.pttFellBackToFront, false);

		assert.deepEqual(
			rig.received.filter((line) => line.startsWith('\\set_ptt')),
			['\\set_ptt 3', '\\set_ptt 0', '\\set_ptt 1', '\\set_ptt 3'],
		);
	} finally {
		for (const client of [rear, front, auto]) client.close();
		await rig.close();
	}
});

test('auto falls back to plain PTT when the rig cannot select its rear input', async () => {
	const rig = await fakeRigctld({ behaviour: 'no-rear-ptt' });
	const auto = new Rigctld({ host: '127.0.0.1', port: rig.port, pttInput: 'auto', reconnectAttempts: 1 });
	const strict = new Rigctld({ host: '127.0.0.1', port: rig.port, pttInput: 'rear', reconnectAttempts: 1 });
	try {
		await auto.setPtt(true);
		assert.equal(auto.pttValueInUse, 1, 'fell back to the plain PTT value');
		assert.equal(auto.pttFellBackToFront, true);
		assert.deepEqual(
			rig.received.filter((line) => line.startsWith('\\set_ptt')),
			['\\set_ptt 3', '\\set_ptt 1'],
		);

		// A station that demanded the rear input is told instead of being guessed at.
		rig.received.length = 0;
		await assert.rejects(() => strict.setPtt(true), /RPRT -8/);
		assert.equal(strict.pttValueInUse, 0, 'never claims to be keyed');
	} finally {
		auto.close();
		strict.close();
		await rig.close();
	}
});

test('a transceiver config is validated before it reaches a radio', () => {
	const good = defaultTransceiver(1, 'TS-590SG');
	assert.equal(good.pttInput, 'rear', 'a modem station defaults to the rear input');
	assert.equal(validateTransceiver(good).ok, true);

	const broken = {
		...good,
		name: '   ',
		port: 0,
		pttInput: 'mike' as unknown as typeof good.pttInput,
		launchArgs: ['-m', '1042'],
	};
	const result = validateTransceiver(broken);
	assert.equal(result.ok, false);
	assert.ok(result.fields['name']);
	assert.ok(result.fields['port']);
	assert.ok(result.fields['pttInput']);
	assert.ok(result.fields['launchArgs'], 'arguments without a command are refused');

	// The launcher is an argv array: no shell string, no line breaks smuggled in.
	const launching = { ...good, launchCommand: '/usr/bin/rigctld', launchArgs: ['-m', '1042', '-r', '/dev/ttyUSB0'] };
	const argv = launchArgv(launching);
	assert.deepEqual(argv, { command: '/usr/bin/rigctld', args: ['-m', '1042', '-r', '/dev/ttyUSB0'] });
	const withNewline = launchArgv({ ...launching, launchArgs: ['-m', '1042\nrm -rf /'] });
	assert.ok(withNewline && withNewline.args[1]?.includes('\n'), 'argv keeps the bytes verbatim; spawn decides');
});
