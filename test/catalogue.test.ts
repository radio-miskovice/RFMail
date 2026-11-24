import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	bandOf,
	distanceKm,
	bearingDeg,
	gatewayReliability,
	fetchCatalogue,
	gridsquareToLatLon,
	isOpenNow,
	pathQuality,
	selectChannels,
	toChannels,
} from '../packages/server/src/catalogue.ts';

const FIXTURE = JSON.stringify({
	ServerName: 'api.winlink.org',
	ErrorCode: 0,
	Gateways: [
		{
			Callsign: 'OK0N',
			LastStatus: 'Tue, 24 Nov 2026 18:30:00 UTC',
			HoursSinceStatus: 0,
			Latitude: 50,
			Longitude: 14.4,
			GatewayChannels: [
				{
					SupportedModes: 'ARDOP 2000',
					Mode: 30,
					Gridsquare: 'JO70AA',
					Frequency: 7_103_300,
					OperatingHours: '00-23',
					Baud: '0',
					RadioRange: '500',
					Antenna: 'Dipole',
					ServiceCode: 'PUBLIC',
				},
				{
					SupportedModes: 'VARA 2750',
					Mode: 41,
					Gridsquare: 'JO70AA',
					Frequency: 14_106_000,
					OperatingHours: '06-18',
					Baud: '0',
					RadioRange: '0',
					Antenna: 'Dipole',
					ServiceCode: 'PUBLIC',
				},
			],
		},
		{
			Callsign: 'DL1AAA',
			LastStatus: 'Tue, 24 Nov 2026 12:00:00 UTC',
			HoursSinceStatus: 6,
			GatewayChannels: [
				{
					SupportedModes: 'VARA FM WIDE',
					Mode: 52,
					Gridsquare: 'JO62',
					Frequency: 145_220_000,
					OperatingHours: '00-23',
					ServiceCode: 'PUBLIC',
				},
			],
		},
		{
			// A channel the gateway lists for Data2G clients: ordinary VARA underneath.
			Callsign: 'D2G-1',
			LastStatus: 'Tue, 24 Nov 2026 18:00:00 UTC',
			HoursSinceStatus: 1,
			GatewayChannels: [
				{
					SupportedModes: 'VARA',
					Mode: 50,
					Gridsquare: 'JO70AA',
					Frequency: 7_105_000,
					OperatingHours: '00-23',
					ServiceCode: 'DATA2G',
				},
				{
					// Emergency-only station: never offered for routine mail.
					SupportedModes: 'VARA',
					Mode: 50,
					Gridsquare: 'JO70AA',
					Frequency: 7_106_000,
					OperatingHours: '00-23',
					ServiceCode: 'EMCOMM',
				},
			],
		},
		{
			// A class nobody asked for must never appear in a list the operator can act on.
			Callsign: 'PRIV-1',
			HoursSinceStatus: 1,
			GatewayChannels: [
				{
					SupportedModes: 'ARDOP 500',
					Frequency: 3_600_000,
					Gridsquare: 'JO70',
					ServiceCode: 'MARS',
				},
			],
		},
	],
});

test('grid squares become positions, on both axes', () => {
	const Prague = gridsquareToLatLon('JO70AA');
	assert.ok(Prague);
	assert.ok(Math.abs(Prague.lat - 50.02) < 0.02);
	assert.ok(Math.abs(Prague.lon - 14.04) < 0.02);

	const Berlin = gridsquareToLatLon('JO62');
	assert.ok(Berlin);
	assert.ok(Math.abs(Berlin.lat - 52.5) < 0.01);
	assert.ok(Math.abs(Berlin.lon - 13.0) < 0.01);

	// The centre of a four-character square, not its corner.
	const fourChar = gridsquareToLatLon('JO70');
	assert.ok(fourChar);
	assert.equal(fourChar.lon, 15);
	assert.equal(fourChar.lat, 50.5);

	assert.equal(gridsquareToLatLon('Prague'), null);
	assert.equal(gridsquareToLatLon('JO7'), null);
	assert.equal(gridsquareToLatLon('ZZ00'), null);
});

test('distances are measured, not guessed', () => {
	const Prague = gridsquareToLatLon('JO70AA');
	const NewYork = gridsquareToLatLon('FN20');
	const Berlin = gridsquareToLatLon('JO62');
	assert.ok(Prague && NewYork && Berlin);
	assert.ok(Math.abs(distanceKm(Prague, NewYork) - 6629) < 60);
	assert.ok(Math.abs(distanceKm(Prague, Berlin) - 285) < 15);
	assert.equal(distanceKm(Prague, Prague), 0);
});

test('a frequency finds its band, and bands keep their boundaries', () => {
	assert.equal(bandOf(7_103_300), '40m');
	assert.equal(bandOf(14_106_000), '20m');
	assert.equal(bandOf(145_220_000), '2m');
	assert.equal(bandOf(439_000_000), '70cm');
	assert.equal(bandOf(5_300_000), '60m');
	assert.equal(bandOf(12_345_678), 'unknown');
});

test('operating hours are read in UTC, including windows that wrap midnight', () => {
	assert.equal(isOpenNow('00-23', new Date('2026-11-24T03:00:00Z')), true);
	assert.equal(isOpenNow('06-18', new Date('2026-11-24T03:00:00Z')), false);
	assert.equal(isOpenNow('06-18', new Date('2026-11-24T12:00:00Z')), true);
	// 22-02 is open at 23 and at 01, closed at 12.
	assert.equal(isOpenNow('22-02', new Date('2026-11-24T23:00:00Z')), true);
	assert.equal(isOpenNow('22-02', new Date('2026-11-24T01:00:00Z')), true);
	assert.equal(isOpenNow('22-02', new Date('2026-11-24T12:00:00Z')), false);
});

test('the path quality prefers a band that suits the distance', () => {
	const near = pathQuality({ band: '40m', distanceKm: 300 });
	const far = pathQuality({ band: '40m', distanceKm: 6000 });
	assert.ok(near > far, `${near} should beat ${far}`);
	assert.ok(pathQuality({ band: '2m', distanceKm: 30 }) > 0.8, 'a local FM channel is a good path');
	assert.ok(pathQuality({ band: '2m', distanceKm: 3000 }) < 0.2, '2 m never reaches that far');
});

test('the reliability prefers a gateway heard recently and open now', () => {
	const fresh = gatewayReliability({ hoursSinceStatus: 1, openNow: true });
	const stale = gatewayReliability({ hoursSinceStatus: 46, openNow: true });
	assert.ok(fresh > stale, `${fresh} should beat ${stale}`);
	assert.equal(gatewayReliability({ hoursSinceStatus: 0, openNow: false }), 0, 'closed is worthless');
	assert.equal(gatewayReliability({ hoursSinceStatus: null, openNow: true }), 0.5, 'unknown is neutral');
});

test('bearings point the right way', () => {
	const Prague = gridsquareToLatLon('JO70AA')!;
	const expected: Array<[string, number]> = [
		['JO62', 346], // Berlin
		['FN20', 298], // New York
		['KO85', 60], // Moscow
		['IO91', 285] // London
	];
	for (const [square, degrees] of expected) {
		const target = gridsquareToLatLon(square);
		assert.ok(target);
		const bearing = bearingDeg(Prague, target);
		assert.ok(Math.abs(bearing - degrees) <= 2, `${square}: ${bearing}° should be near ${degrees}°`);
	}
	assert.equal(bearingDeg(Prague, Prague), 0);
	assert.ok(bearingDeg(Prague, gridsquareToLatLon('FN20')!) < 360);
});

test('channels are flattened from gateways, with distances from the operator', () => {
	const gateways = JSON.parse(FIXTURE).Gateways;
	const origin = gridsquareToLatLon('JO70AA');
	const channels = toChannels(gateways, { origin, now: new Date('2026-11-24T12:00:00Z') });

	assert.equal(channels.length, 5, 'the private channel is dropped; the emergency one is parsed and withheld');
	const tagged = channels.find((channel) => channel.callsign === 'D2G-1');
	assert.ok(tagged, 'a channel listed for Data2G is offered');
	assert.equal(tagged.serviceCode, 'DATA2G');
	assert.equal(tagged.mode, 'VARA', 'its mode string is ordinary VARA');
	const emergency = channels.find((channel) => channel.frequencyHz === 7_106_000);
	assert.ok(emergency, 'an EMCOMM channel is parsed');
	assert.equal(emergency.serviceCode, 'EMCOMM');
	// …and withheld from an ordinary selection.
	assert.equal(
		selectChannels(channels, { modems: ['vara'], limit: 50 }).some(
			(channel) => channel.serviceCode === 'EMCOMM',
		),
		false,
		'a station open for emergency traffic only is never listed by default',
	);
	const ardop = channels.find((channel) => channel.mode === 'ARDOP 2000');
	assert.ok(ardop);
	assert.equal(ardop.callsign, 'OK0N');
	assert.equal(ardop.band, '40m');
	assert.equal(ardop.family, 'ardop');
	assert.equal(ardop.distanceKm, 0, 'same square as the operator');
	assert.equal(ardop.openNow, true);
	assert.equal(ardop.radioRangeKm, 500);
	assert.equal(ardop.mode, 'ARDOP 2000', 'the catalogue string, untouched');
	assert.equal(ardop.gridsquare, 'JO70AA');
	assert.equal(ardop.bearingDeg, 0, 'the operator is in that very square');

	const vara = channels.find((channel) => channel.mode === 'VARA 2750');
	assert.ok(vara);
	assert.equal(vara.band, '20m');
	assert.equal(vara.openNow, true, '06-18 at 12:00 UTC');
	assert.equal(vara.radioRangeKm, null, 'a reported range of 0 is not a range');

	const fm = channels.find((channel) => channel.family === 'vara-fm');
	assert.ok(fm);
	assert.equal(fm.band, '2m');
	assert.equal(fm.distanceKm, 285);
	assert.equal(fm.mode, 'VARA FM WIDE');
	assert.equal(fm.bearingDeg, 346, 'Berlin lies north-north-west of Prague');
});

test('a modem sees only the channels it can work, ordered as asked', () => {
	const gateways = JSON.parse(FIXTURE).Gateways;
	const channels = toChannels(gateways, {
		origin: gridsquareToLatLon('JO70AA'),
		now: new Date('2026-11-24T12:00:00Z'),
	});

	const ardopOnly = selectChannels(channels, { modems: ['ardop'], limit: 10 });
	assert.deepEqual(
		ardopOnly.map((channel) => channel.mode),
		['ARDOP 2000'],
	);

	// XARA speaks the VARA interface, so it reaches VARA channels and no others.
	const xara = selectChannels(channels, { modems: ['xara'], limit: 10 });
	assert.deepEqual(
		xara.map((channel) => channel.mode),
		['VARA 2750'],
	);

	// A Data2G modem sees the channels listed for Data2G and nothing else: its waveform
	// is its own, so an ordinary VARA or ARDOP channel is not a channel it can work.
	const forData2G = selectChannels(channels, { modems: ['data2g'], limit: 10 });
	assert.deepEqual(
		forData2G.map((channel) => `${channel.callsign}:${channel.serviceCode}`),
		['D2G-1:DATA2G'],
	);
	assert.equal(
		forData2G.some((channel) => channel.serviceCode === 'PUBLIC'),
		false,
		'no ordinary channel belongs to a Data2G modem',
	);

	// And a VARA modem does not see the Data2G channel.
	const forVara = selectChannels(channels, { modems: ['vara'], limit: 10 });
	assert.equal(
		forVara.some((channel) => channel.serviceCode === 'DATA2G'),
		false,
		'a tagged channel belongs to the modem it was tagged for',
	);
	// XARA speaks VARA's interface, so it works VARA's ordinary channels too.
	const forXara = selectChannels(channels, { modems: ['xara'], limit: 10 });
	assert.equal(forXara.some((channel) => channel.serviceCode === 'DATA2G'), false);
	assert.ok(forXara.some((channel) => channel.serviceCode === 'PUBLIC'));

	// Without a modem there is no way to know whose tagged channel this is, so the
	// unfiltered list is the ordinary PUBLIC class only.
	const everything = selectChannels(channels, { limit: 10, sort: 'distance' });
	assert.deepEqual(
		everything.map((channel) => channel.callsign),
		['OK0N', 'OK0N', 'DL1AAA'],
		'distance order puts the local gateway first',
	);

	// Only when explicitly asked for.
	const withEmergency = selectChannels(channels, { modems: ['vara'], limit: 50, includeEmcomm: true });
	assert.ok(
		withEmergency.some((channel) => channel.serviceCode === 'EMCOMM'),
		'the emergency class appears when the operator asks for it',
	);

	const byQuality = selectChannels(channels, { limit: 10, sort: 'quality' });
	const score = (channel: { quality: number; reliability: number }): number =>
		channel.quality * channel.reliability;
	const first = byQuality[0];
	const last = byQuality[byQuality.length - 1];
	assert.ok(first && last);
	assert.ok(score(first) >= score(last), 'quality order multiplies path and gateway');
});

test('the catalogue is downloaded once, then answered from the cache', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'rfmail-catalogue-'));
	try {
		let downloads = 0;
		const fetcher = async (): Promise<Response> => {
			downloads += 1;
			return new Response(FIXTURE, { status: 200 });
		};

		const first = await fetchCatalogue({ cacheDir: dir, fetcher: fetcher as typeof fetch });
		assert.equal(downloads, 1);
		assert.equal(first.source, 'network');
		assert.equal(first.stale, false);
		assert.equal(first.channels.length, 5);

		// A second call within the refresh interval must not hit the network again.
		const second = await fetchCatalogue({ cacheDir: dir, fetcher: fetcher as typeof fetch });
		assert.equal(downloads, 1);
		assert.equal(second.source, 'cache');

		// An explicit refresh does.
		const third = await fetchCatalogue({ cacheDir: dir, fetcher: fetcher as typeof fetch, force: true });
		assert.equal(downloads, 2);
		assert.equal(third.source, 'network');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a cache fetched for fewer service classes is not trusted for more', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'rfmail-catalogue-'));
	try {
		const { writeFileSync } = await import('node:fs');
		// A payload on disk, minutes old, recorded as fetched for the ordinary class
		// only: the emergency stations cannot be in it, so a fresh download is owed.
		writeFileSync(`${dir}/gateway-status.json`, FIXTURE);
		writeFileSync(`${dir}/gateway-status.fetched`, String(Date.now()));
		writeFileSync(`${dir}/gateway-status.codes`, 'PUBLIC');

		let downloads = 0;
		const fetcher = (async (): Promise<Response> => {
			downloads += 1;
			return new Response(FIXTURE, { status: 200 });
		}) as typeof fetch;

		const result = await fetchCatalogue({ cacheDir: dir, fetcher });
		assert.equal(downloads, 1, 'the wider request refetches');
		assert.equal(result.source, 'network');
		assert.equal(result.channels.length, 5);

		// With the classes recorded, the next call is content with the cache.
		const second = await fetchCatalogue({ cacheDir: dir, fetcher });
		assert.equal(downloads, 1);
		assert.equal(second.source, 'cache');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a failed download falls back to the cache and says it is stale', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'rfmail-catalogue-'));
	try {
		const good = await fetchCatalogue({
			cacheDir: dir,
			fetcher: (async () => new Response(FIXTURE, { status: 200 })) as typeof fetch,
		});
		assert.equal(good.source, 'network');

		// Now the network is gone: the cached list still answers, marked stale.
		const failed = await fetchCatalogue({
			cacheDir: dir,
			fetcher: (async () => {
				throw new Error('getaddrinfo ENOTFOUND api.winlink.org');
			}) as typeof fetch,
			force: true,
		});
		assert.equal(failed.stale, true);
		assert.equal(failed.channels.length, 5);
		assert.match(failed.error ?? '', /ENOTFOUND/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('with no cache and no network the list is empty and explains itself', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'rfmail-catalogue-'));
	try {
		const result = await fetchCatalogue({
			cacheDir: dir,
			fetcher: (async () => {
				throw new Error('network unreachable');
			}) as typeof fetch,
			force: true,
		});
		assert.equal(result.channels.length, 0);
		assert.equal(result.source, 'none');
		assert.match(result.error ?? '', /network unreachable/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
