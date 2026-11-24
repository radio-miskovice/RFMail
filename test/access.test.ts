import assert from 'node:assert/strict';
import test from 'node:test';
import { PeerPolicy, isLoopback, normalisePeer } from '@rfmail/mailservers';

test('very strict allows only loopback', () => {
	const policy = new PeerPolicy('very strict');
	assert.equal(policy.allows('127.0.0.1'), true);
	assert.equal(policy.allows('::1'), true);
	assert.equal(policy.allows('::ffff:127.0.0.1'), true);
	assert.equal(policy.allows('192.168.1.7'), false);
	assert.equal(policy.allows('10.0.0.1'), false);
	assert.equal(policy.allows(undefined), false);
});

test('strict accepts configured CIDRs and still allows loopback', () => {
	const policy = new PeerPolicy('strict', ['192.168.1.0/24', 'fd00::/8']);
	assert.equal(policy.allows('192.168.1.55'), true);
	assert.equal(policy.allows('192.168.2.55'), false);
	assert.equal(policy.allows('127.0.0.1'), true);
	assert.equal(policy.allows('fd12:3456::1'), true);
	assert.equal(policy.allows('fe80::1'), false);
});

test('strict without CIDRs is a configuration error', () => {
	assert.throws(() => new PeerPolicy('strict', []), /requires at least one CIDR/);
	assert.throws(() => new PeerPolicy('strict', ['not-a-cidr']), /invalid CIDR/);
});

test('address normalisation maps IPv4-mapped IPv6 onto IPv4', () => {
	assert.equal(normalisePeer('::ffff:192.168.0.1'), '192.168.0.1');
	assert.equal(isLoopback('::ffff:127.0.0.1'), true);
	assert.equal(isLoopback('192.168.0.1'), false);
	assert.equal(isLoopback('0:0:0:0:0:0:0:1'), true);
});

test('describe() names the mode and the CIDRs', () => {
	assert.match(new PeerPolicy('very strict').describe(), /very strict/);
	assert.match(new PeerPolicy('strict', ['10.0.0.0/8']).describe(), /10\.0\.0\.0\/8/);
});
