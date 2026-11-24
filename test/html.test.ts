import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitiseHtml } from '@rfmail/server';

test('removes scripts, handlers and dangerous schemes', () => {
	const dirty = [
		'<p onclick="steal()">Hello <strong>there</strong></p>',
		'<script>fetch("https://evil")</script>',
		'<iframe src="https://evil"></iframe>',
		'<a href="javascript:alert(1)">click</a>',
		'<img src="x" onerror="alert(1)">',
		'<style>body{background:url(https://evil)}</style>'
	].join('');
	const clean = sanitiseHtml(dirty);
	assert.ok(!clean.includes('<script'));
	assert.ok(!clean.includes('onclick'));
	assert.ok(!clean.includes('onerror'));
	assert.ok(!clean.includes('<iframe'));
	assert.ok(!clean.includes('javascript:'));
	assert.ok(!clean.includes('<style'));
	assert.ok(clean.includes('<strong>there</strong>'));
});

test('links open in a new tab without a referrer', () => {
	const clean = sanitiseHtml('<a href="https://example.org/x">site</a>');
	assert.match(clean, /rel="noopener noreferrer"/);
	assert.match(clean, /target="_blank"/);
});

test('images are held back until the reader asks for them', () => {
	const clean = sanitiseHtml('<p>Logo <img src="https://example.org/logo.png" alt="logo" width="10"></p>');
	assert.ok(clean.includes('data-src="https://example.org/logo.png"'), clean);
	assert.ok(!/\ssrc="/.test(clean), 'the image must not load by itself');
	assert.ok(clean.includes('alt="logo"'));
});

test('keeps ordinary formatting', () => {
	const clean = sanitiseHtml('<h1>Title</h1><ul><li>a</li><li>b</li></ul><table><tr><td>c</td></tr></table>');
	for (const tag of ['<h1>', '<ul>', '<li>', '<table>', '<tr>', '<td>']) {
		assert.ok(clean.includes(tag), `expected ${tag} to survive`);
	}
});
