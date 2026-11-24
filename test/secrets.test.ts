import assert from 'node:assert/strict';
import test from 'node:test';
import { openSecret, sealSecret, secretEquals } from '@rfmail/server';

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER = Buffer.alloc(32, 4).toString('base64');

test('seals and opens a secret', () => {
	const blob = sealSecret('hunter2', KEY);
	assert.match(blob, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/);
	assert.ok(!blob.includes('hunter2'), 'the plaintext must not appear in the blob');
	assert.equal(openSecret(blob, KEY), 'hunter2');
});

test('the same plaintext seals to a different blob each time', () => {
	assert.notEqual(sealSecret('same', KEY), sealSecret('same', KEY));
});

test('a tampered or foreign blob opens to null, never to garbage', () => {
	const blob = sealSecret('hunter2', KEY);
	const parts = blob.split('.');
	const flipped = `${parts[0]}.${parts[1]}.${parts[2]}.${Buffer.from('x').toString('base64url')}`;
	assert.equal(openSecret(flipped, KEY), null, 'tampered ciphertext');
	assert.equal(openSecret(blob, OTHER), null, 'wrong key');
	assert.equal(openSecret('garbage', KEY), null, 'not a blob');
	assert.equal(openSecret('v2.a.b.c', KEY), null, 'unknown version');
});

test('secretEquals compares without an early exit', () => {
	assert.equal(secretEquals('abc', 'abc'), true);
	assert.equal(secretEquals('abc', 'abd'), false);
	assert.equal(secretEquals('abc', 'abcd'), false);
});
