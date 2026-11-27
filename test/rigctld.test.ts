import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeRigctld } from './helpers/fake-rigctld.ts';
import { Rigctld, RigError, defaultTransceiver, launchArgv, validateTransceiver } from '@rfmail/rig';

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

test('a long-lived link does not pile up listeners on its socket', async () => {
	// The station polls rigctld every few seconds for as long as it is running, so a
	// listener per command turns into a `MaxListenersExceededWarning` after ten of them.
	const warnings: string[] = [];
	const collect = (warning: Error): void => {
		warnings.push(`${warning.name}: ${warning.message}`);
	};
	process.on('warning', collect);
	const rig = await fakeRigctld();
	const client = new Rigctld({ host: '127.0.0.1', port: rig.port });
	try {
		await client.connect();
		for (let i = 0; i < 12; i += 1) await client.getFrequency();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(
			warnings.filter((warning) => /MaxListeners/.test(warning)),
			[],
		);
	} finally {
		process.off('warning', collect);
		client.close();
		await rig.close();
	}
});
