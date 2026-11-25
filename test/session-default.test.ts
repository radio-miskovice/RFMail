// The session screen's opening mode: a mode whose modem is listening, else the mode this
// browser chose last, else the first mode the station offers.

import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseSessionMode, type ModemLike } from '../apps/web/src/lib/session-default.ts';
import { modemForChannel } from '@rfmail/shared';
import type { ModemKind } from '@rfmail/shared';

const kinds: ModemKind[] = ['ardop', 'vara', 'vara-fm', 'xara', 'data2g', 'mercury'];

function modem(id: number, kind: ModemKind, enabled = true): ModemLike {
  return { id, kind, enabled };
}

test('a mode with a listening modem is what the screen opens on', () => {
  const modems = [modem(1, 'ardop'), modem(2, 'vara'), modem(3, 'data2g')];
  // Only VARA answers: it wins over ARDOP, which is merely listed first.
  assert.equal(chooseSessionMode({ kinds, modems, running: { 1: false, 2: true, 3: false }, saved: null }), 'vara');
});

test('the remembered mode leads when its modem is listening', () => {
  const modems = [modem(1, 'ardop'), modem(2, 'vara'), modem(3, 'data2g')];
  // Two are listening; the browser's last choice is the better guess.
  assert.equal(chooseSessionMode({ kinds, modems, running: { 2: true, 3: true }, saved: 'data2g' }), 'data2g');
});

test('nothing listening falls back to the remembered mode, then to the first offered', () => {
  const modems = [modem(1, 'ardop'), modem(3, 'data2g')];
  assert.equal(chooseSessionMode({ kinds, modems, running: { 1: false, 3: false }, saved: 'data2g' }), 'data2g');
  assert.equal(chooseSessionMode({ kinds, modems, running: {}, saved: null }), 'ardop');
  // A remembered mode the station no longer offers is not chosen.
  const narrow: ModemKind[] = ['ardop', 'data2g'];
  assert.equal(chooseSessionMode({ kinds: narrow, modems, running: {}, saved: 'mercury' }), 'ardop');
});

test('an unknown port state is not a listening modem, and a disabled one does not count', () => {
  // `running` has no entry for modem 1: the status answer is missing, not "true".
  assert.equal(chooseSessionMode({ kinds, modems: [modem(1, 'ardop')], running: {}, saved: null }), 'ardop');
  // With VARA answering, a disabled VARA modem must not make VARA the choice.
  const disabled = [modem(1, 'ardop'), modem(2, 'vara', false)];
  assert.equal(chooseSessionMode({ kinds, modems: disabled, running: { 1: false, 2: true }, saved: null }), 'ardop');
});

test('VARA and XARA are interchangeable, so either counts as a listening modem', () => {
  const modems = [modem(1, 'vara'), modem(2, 'ardop')];
  assert.equal(chooseSessionMode({ kinds, modems, running: { 1: true }, saved: 'xara' }), 'xara');
});

test('a station with no modes at all falls back rather than throwing', () => {
  assert.equal(chooseSessionMode({ kinds: [], modems: [], running: {}, saved: null }), 'ardop');
  assert.equal(chooseSessionMode({ kinds: [], modems: [], running: {}, saved: null, fallback: 'vara' }), 'vara');
});

test('a channel tagged for one modem belongs to that modem, whatever its mode string says', () => {
  // The case that matters on the air: YO4CIL-5 publishes SupportedModes "VARA" with the
  // service code DATA2G, and the row reads "VARA (DATA2G)". It is a Data2G channel.
  assert.equal(modemForChannel('vara', 'DATA2G'), 'data2g');
  assert.equal(modemForChannel('vara', 'XARA'), 'xara');
  assert.equal(modemForChannel('vara', 'MERCURY'), 'mercury');
  assert.equal(modemForChannel('vara', 'data2g'), 'data2g', 'the code is not case-sensitive');

  // Untagged channels fall back to the waveform.
  assert.equal(modemForChannel('vara', null), 'vara');
  assert.equal(modemForChannel('vara', 'PUBLIC'), 'vara');
  assert.equal(modemForChannel('vara', 'EMCOMM'), 'vara');
  assert.equal(modemForChannel('vara-fm', null), 'vara-fm');
  assert.equal(modemForChannel('ardop', 'PUBLIC'), 'ardop');
});
