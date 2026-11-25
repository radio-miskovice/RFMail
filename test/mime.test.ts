import assert from 'node:assert/strict';
import test from 'node:test';
import { findMimePart, parseMimeTree } from '@rfmail/core-b2f';

const MESSAGE = Buffer.from(
	[
		'From: OK4RM@winlink.org',
		'To: OK2XYZ@winlink.org',
		'Subject: Structure',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="outer"',
		'',
		'Preamble text.',
		'--outer',
		'Content-Type: multipart/alternative; boundary="inner"',
		'',
		'--inner',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'plain body',
		'--inner',
		'Content-Type: text/html; charset=utf-8',
		'',
		'<p>html body</p>',
		'--inner--',
		'--outer',
		'Content-Type: text/plain; name="note.txt"',
		'Content-Disposition: attachment; filename="note.txt"',
		'Content-Transfer-Encoding: base64',
		'',
		'bm90ZSBib2R5',
		'--outer--',
		'',
	].join('\r\n'),
	'latin1',
);

test('sections follow RFC 3501 numbering, including nested multiparts', () => {
	const tree = parseMimeTree(MESSAGE);
	assert.equal(tree.contentType, 'multipart/mixed');
	assert.deepEqual(tree.children.map((child) => child.section), ['1', '2']);
	assert.equal(tree.children[0]?.contentType, 'multipart/alternative');
	assert.deepEqual(tree.children[0]?.children.map((child) => child.section), ['1.1', '1.2']);
	assert.equal(tree.children[1]?.contentType, 'text/plain');

	assert.equal(findMimePart(tree, '1.2')?.body.toString('latin1'), '<p>html body</p>');
	assert.equal(findMimePart(tree, '2')?.body.toString('latin1'), 'bm90ZSBib2R5');
	assert.match(findMimePart(tree, '2')?.headers.toString('latin1') ?? '', /filename="note\.txt"/);
	assert.equal(findMimePart(tree, '9'), null);
});

test('the preamble and the closing boundary are not parts', () => {
	const tree = parseMimeTree(MESSAGE);
	const bodies = tree.children.map((child) => child.body.toString('latin1'));
	assert.ok(!bodies.some((body) => body.includes('Preamble text.')), 'the preamble is dropped');
	assert.ok(!bodies.some((body) => body.includes('--outer--')), 'the epilogue is dropped');
});
