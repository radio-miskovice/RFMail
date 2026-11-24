// Display helpers shared by the mail views.

import type { MessageDetail } from '@rfmail/shared';

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fullFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function formatDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	const now = new Date();
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	if (sameDay) return timeFormat.format(date);
	if (date.getFullYear() === now.getFullYear()) return dayFormat.format(date);
	return fullFormat.format(date);
}

export function formatDateTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return `${fullFormat.format(date)} ${timeFormat.format(date)}`;
}

/** `"Doe, Jane" <jane@example.cz>` -> `Doe, Jane`; `bob@example.cz` -> `bob`. */
export function senderName(from: string): string {
	const angle = /^(.*)<[^>]*>\s*$/.exec(from);
	if (angle && angle[1]) {
		const name = angle[1].trim().replace(/^"|"$/g, '').trim();
		if (name) return name;
	}
	const address = addressOnly(from);
	return address.split('@')[0] ?? address;
}

export function addressOnly(value: string): string {
	const angle = /<([^>]*)>/.exec(value);
	if (angle && angle[1]) return angle[1].trim();
	return value.replace(/\([^)]*\)/g, '').trim();
}

/** Quoted reply text, in the plain form the message model stores. */
export function quoteForReply(message: MessageDetail): string {
	const quoted = message.body
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n');
	const when = new Date(message.date).toUTCString();
	return `\n\nOn ${when}, ${message.from} wrote:\n${quoted}\n`;
}
