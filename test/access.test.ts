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

test('set() replaces the policy in one step, and a rejected change changes nothing', () => {
	const policy = new PeerPolicy('strict', ['192.168.1.0/24']);
	assert.equal(policy.allows('192.168.1.55'), true);

	policy.set('very strict', []);
	assert.equal(policy.mode, 'very strict');
	assert.deepEqual(policy.cidrs, []);
	assert.equal(policy.allows('192.168.1.55'), false);
	assert.equal(policy.allows('127.0.0.1'), true);

	// The rules are the ones start-up enforces: strict needs a CIDR, and a CIDR must parse.
	assert.throws(() => policy.set('strict', []), /requires at least one CIDR/);
	assert.equal(policy.mode, 'very strict', 'a refused mode must not be installed');
	assert.throws(() => policy.set('strict', ['10.0.0.0/33']), /invalid CIDR/);
	assert.equal(policy.mode, 'very strict');
	assert.deepEqual(policy.cidrs, []);

	// Blank lines are what a textarea produces; they are dropped, and the rest applies.
	policy.set('strict', ['10.0.0.0/8', '  ', '']);
	assert.equal(policy.mode, 'strict');
	assert.deepEqual(policy.cidrs, ['10.0.0.0/8']);
	assert.equal(policy.allows('10.1.2.3'), true);
	assert.equal(policy.allows('192.168.1.55'), false, 'the replaced CIDR is gone');
	assert.match(policy.describe(), /1 CIDR: 10\.0\.0\.0\/8/);
});
