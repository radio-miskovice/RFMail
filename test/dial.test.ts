import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	DIAL_MAX_HZ,
	DIAL_MIN_HZ,
	dialNumber,
	dialUnitFor,
	dialUnitForBand,
	formatDial,
	isDial,
	parseDial
} from '../apps/web/src/lib/dial.ts';

test('the dial is written in kilohertz below 10 MHz and megahertz from there up', () => {
	assert.equal(dialUnitFor(1_830_000), 'kHz', '160 m');
	assert.equal(dialUnitFor(3_597_000), 'kHz', '80 m');
	assert.equal(dialUnitFor(7_053_500), 'kHz', '40 m — the last band below ten megahertz');
	assert.equal(dialUnitFor(10_133_000), 'MHz', '30 m — ten megahertz and above');
	assert.equal(dialUnitFor(14_109_600), 'MHz', '20 m');
	assert.equal(dialUnitFor(144_875_000), 'MHz', '2 m');

	assert.equal(dialNumber(7_053_500), '7053.5');
	assert.equal(dialNumber(14_109_600), '14.1096');
	assert.equal(dialNumber(144_875_000), '144.8750');
	assert.equal(formatDial(7_053_500), '7053.5 kHz');
	assert.equal(formatDial(14_109_600), '14.1096 MHz');
});

test('a band decides the unit while the field is still empty', () => {
	assert.equal(dialUnitForBand('40m'), 'kHz');
	assert.equal(dialUnitForBand('80m'), 'kHz');
	assert.equal(dialUnitForBand('30m'), 'MHz');
	assert.equal(dialUnitForBand('20m'), 'MHz');
	assert.equal(dialUnitForBand('2m'), 'MHz');
	assert.equal(dialUnitForBand('70cm'), 'MHz');
	assert.equal(dialUnitForBand('any'), 'MHz');
});

test('typing is read in the unit shown, or in the other one if only that makes sense', () => {
	assert.deepEqual(parseDial('7053.5', 'kHz'), { hz: 7_053_500, unit: 'kHz' });
	assert.deepEqual(parseDial('7.053,5', 'kHz'), { hz: 7_053_500, unit: 'kHz' }, 'a comma is a decimal point');
	assert.deepEqual(parseDial('14.1096', 'MHz'), { hz: 14_109_600, unit: 'MHz' });
	// 14.1 cannot be kilohertz (that would be 14 kHz), so it is read as megahertz.
	assert.deepEqual(parseDial('14.1', 'kHz'), { hz: 14_100_000, unit: 'MHz' });
	// 7053.5 cannot be megahertz, so it is read as kilohertz.
	assert.deepEqual(parseDial('7053.5', 'MHz'), { hz: 7_053_500, unit: 'kHz' });

	assert.equal(parseDial('', 'kHz'), null);
	assert.equal(parseDial('forty metres', 'kHz'), null);
	assert.equal(parseDial('0.7', 'MHz'), null, 'below 160 m');
	assert.equal(parseDial('1200', 'MHz'), null, 'above 70 cm');
});

test('the legal dial spans 160 m to the top of 70 cm', () => {
	assert.equal(isDial(DIAL_MIN_HZ), true);
	assert.equal(isDial(DIAL_MAX_HZ), true);
	assert.equal(isDial(DIAL_MIN_HZ - 1), false);
	assert.equal(isDial(DIAL_MAX_HZ + 1), false);
	assert.equal(isDial(null), false);
});
