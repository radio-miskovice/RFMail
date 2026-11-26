import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server, type Socket } from 'node:net';
import { Rigctld, RigError, defaultTransceiver, launchArgv, validateTransceiver } from '@rfmail/rig';

/** A rigctld that answers the commands this client sends, plus a way to misbehave. */
async function fakeRigctld(options: {
	behaviour?: 'normal' | 'error' | 'drop-once' | 'silent' | 'no-rear-ptt' | 'no-power';
	/** The two digits the rig answers `SH;` and `SL;` with. */
	ifShift?: string;
	filter?: string;
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
	let power = 0.35;

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
					else if (cmd === '\\dump_caps')
						socket.write(
							[
								'dump_caps:',
								'Caps dump for model: 2031',
								'Model name:	TS-590S',
								'Mfg name:	Kenwood',
								'Port type:	RS-232',
								'Serial speed:	4800..115200 baud, 8N1, ctrl=CTS/RTS',
								'Hamlib version:	Hamlib 4.6.3',
								'RPRT 0',
							].join('\n') + '\n',
						);
					else if (cmd === '\\get_level RFPOWER')
						socket.write(
							options.behaviour === 'no-power'
								? 'get_level: RFPOWER\nRPRT -11\n'
								: `get_level: RFPOWER\n${power}\nRPRT 0\n`,
						);
					else socket.write('RPRT -11\n');
					index = buffer.indexOf('\n');
					continue;
				}
				if (line === '\\get_rig_info')
					socket.write(
						[
							`VFO=VFOA Freq=${frequency} Mode=${mode} Width=${passband} RX=1 TX=1`,
							'VFO=VFOB Freq=0 Mode=None Width=0 RX=0 TX=0',
							'Split=0 SatMode=0',
							'Rig=TS-590S',
							'App=Hamlib',
							'Version=20241103 1.1.0',
							'Model=2031',
							'CRC=0x269e8082',
							'',
						].join('\n') + '\n',
					);
				else if (line === '\\get_freq') socket.write(`${frequency}\n`);
				else if (line.startsWith('\\set_freq')) {
					frequency = Number(line.split(' ')[1]);
					socket.write('RPRT 0\n');
				} else if (line === '\\get_mode') socket.write(`${mode}\n${passband}\n`);
				else if (line.startsWith('\\set_mode')) {
					const parts = line.split(/\s+/);
					mode = parts[1] ?? mode;
					// -1 is RIG_PASSBAND_NOCHANGE: the rig keeps the filter it had.
					const asked = Number(parts[2] ?? passband);
					if (asked >= 0) passband = asked;
					socket.write('RPRT 0\n');
				} else if (line.startsWith('\\set_level RFPOWER')) {
					power = Number(line.split(/\s+/)[2] ?? power);
					socket.write('RPRT 0\n');
				} else if (line.startsWith('\\set_ptt')) {
					if (options.behaviour === 'no-rear-ptt' && line.endsWith('3')) {
						socket.write('RPRT -8\n');
					} else {
						ptt = !line.endsWith('0');
						socket.write('RPRT 0\n');
					}
				} else if (line === '\\get_ptt') socket.write(`${ptt ? 1 : 0}\n`);
				else if (line === 'w SH;') socket.write(`SH${options.ifShift ?? '05'};\0`);
				else if (line === 'w SL;') socket.write(`SL${options.filter ?? '13'};\0`);
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
		await client.setMode('PKTUSB');
		assert.deepEqual(
			await client.getMode(),
			{ mode: 'PKTUSB', passbandHz: 2700 },
			'the mode changes, the filter is left where the operator put it',
		);

		await client.setPtt(true);
		assert.equal(await client.getPtt(), true);
		await client.setPtt(false);
		assert.equal(await client.getPtt(), false);

		assert.deepEqual(await client.getState(), { frequencyHz: 10_148_000, mode: 'PKTUSB', passbandHz: 2700 });
		assert.equal(await client.supportsVfo(), true);

		// Getters use the extended protocol, setters the classic one.
		assert.deepEqual(rig.received, [
			'+\\get_freq',
			'\\set_freq 10148000',
			'+\\get_freq',
			'+\\get_mode',
			'\\set_mode PKTUSB -1',
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

test('reads the daemon digest of the radio, its interface and the power setting', async () => {
	const rig = await fakeRigctld();
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port });
	try {
		// `\get_rig_info` is one command with no RPRT: VFOs, split, identity, and a CRC.
		const info = await client.getRigInfo();
		assert.equal(info.rig, 'TS-590S');
		assert.equal(info.app, 'Hamlib');
		assert.equal(info.model, 2031);
		assert.equal(info.split, false);
		assert.equal(info.crc, '0x269e8082');
		assert.deepEqual(info.vfos[0], {
			vfo: 'VFOA',
			frequencyHz: 7_040_000,
			mode: 'USB',
			widthHz: 2700,
			rx: true,
			tx: true,
		});
		assert.equal(info.vfos[1]?.frequencyHz, 0, 'an idle VFO comes through as zero, not as an error');

		assert.equal(await client.getPower(), 0.35);

		// The block ends at a blank line; the next command still reads cleanly off the socket.
		assert.equal(await client.getFrequency(), 7_040_000);
		assert.deepEqual(rig.received, [
			'\\get_rig_info',
			'+\\get_level RFPOWER',
			'+\\get_freq',
		]);
	} finally {
		client.close();
		await rig.close();
	}
});

test('a rig without a power setting says so instead of failing', async () => {
	const rig = await fakeRigctld({ behaviour: 'no-power' });
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port, reconnectAttempts: 1 });
	try {
		assert.equal(await client.getPower(), null, 'an unavailable level is not a broken link');
		assert.equal(await client.getRigInfo().then((info) => info.rig), 'TS-590S', 'the rest still reads');
	} finally {
		client.close();
		await rig.close();
	}
});

test('the IF shift and the filter are read with two fixed queries', async () => {
	const rig = await fakeRigctld();
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port });
	try {
		assert.equal(await client.getIfShiftHz(), 1500, 'SH05 is the centred 1500 Hz');
		assert.equal(await client.getDataFilterHz(), 2500, 'SL13 is the 2500 Hz filter');
		assert.deepEqual(
			rig.received,
			['w SH;', 'w SL;'],
			'fixed queries with no parameter; the raw channel is not a write channel here',
		);
	} finally {
		client.close();
		await rig.close();
	}
});

test('the SL ladder is the TS-590 data ladder, and a code outside it is unknown', async () => {
	// The operator's own table for SSB / SSB-DATA on a TS-590S.
	const ladder: Array<[string, number]> = [
		['00', 50],
		['01', 80],
		['02', 100],
		['03', 150],
		['04', 200],
		['05', 250],
		['06', 300],
		['07', 400],
		['08', 500],
		['09', 600],
		['10', 1000],
		['11', 1500],
		['12', 2000],
		['13', 2500],
	];
	for (const [code, hz] of ladder) {
		const rig = await fakeRigctld({ filter: code });
		const client = new Rigctld({ host: '127.0.0.1', port: rig.port });
		try {
			assert.equal(await client.getDataFilterHz(), hz, `SL${code} is ${hz} Hz`);
		} finally {
			client.close();
			await rig.close();
		}
	}

	// A code the ladder does not know is reported as unknown, never guessed.
	const rig = await fakeRigctld({ filter: '14' });
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port });
	try {
		assert.equal(await client.getDataFilterHz(), null);
	} finally {
		client.close();
		await rig.close();
	}
});

test('the IF shift is read from SH, centred at 1500', async () => {
	const off = await fakeRigctld({ ifShift: '01' });
	const client = new Rigctld({ host: '127.0.0.1', port: off.port });
	try {
		assert.equal(await client.getIfShiftHz(), 1100, 'SH01 is 1100 Hz — 400 Hz below centre');
	} finally {
		client.close();
		await off.close();
	}
});

test('a mode write never names a passband', async () => {
	const rig = await fakeRigctld();
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port });
	try {
		// The rig is sitting in a 2.7 kHz filter the operator chose. A station has no business
		// with the width or the IF shift: 0 would mean "the rig's normal passband" (which
		// narrows the filter and re-centres the IF), and 2300 — a bandwidth the TS-590 does not
		// have — makes Hamlib invent one by shifting the IF. Only `-1` leaves both alone.
		const before = await client.getMode();
		await client.setMode('PKTUSB');
		assert.deepEqual(
			await client.getMode(),
			{ mode: 'PKTUSB', passbandHz: before.passbandHz },
			'the mode changed, the filter did not',
		);
		assert.deepEqual(
			rig.received.filter((line) => line.startsWith('\\set_mode')),
			['\\set_mode PKTUSB -1'],
			'the only passband the station can send is RIG_PASSBAND_NOCHANGE',
		);
	} finally {
		client.close();
		await rig.close();
	}
});

test('the power setting is written to the rig and read back', async () => {
	const rig = await fakeRigctld();
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port });
	try {
		assert.equal(await client.getPower(), 0.35);
		await client.setPower(0.25);
		assert.equal(await client.getPower(), 0.25, 'the rig took the new level');
		assert.ok(rig.received.includes('\\set_level RFPOWER 0.25'));

		// A level outside the rig's scale is refused here, not sent and refused there.
		await assert.rejects(() => client.setPower(1.5), /refusing power level/);
		assert.equal(rig.received.filter((line) => line.startsWith('\\set_level')).length, 1);
	} finally {
		client.close();
		await rig.close();
	}
});

test('the transmitting connector can change without reopening the link', async () => {
	const rig = await fakeRigctld();
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port, pttInput: 'rear' });
	try {
		await client.setPtt(true);
		assert.equal(client.pttValueInUse, 3, 'rear input first');
		await client.setPtt(false);

		client.setPttInput('front');
		await client.setPtt(true);
		assert.equal(client.pttValueInUse, 1, 'the front microphone after the change');
		assert.deepEqual(
			rig.received.filter((line) => line.startsWith('\\set_ptt')),
			['\\set_ptt 3', '\\set_ptt 0', '\\set_ptt 1'],
		);
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
