// IMAP4rev1 subset for the mail store.
//
// Implemented: CAPABILITY, NOOP, LOGIN, AUTHENTICATE PLAIN, LIST, LSUB, SELECT,
// EXAMINE, STATUS, FETCH (FLAGS, UID, INTERNALDATE, RFC822.SIZE, ENVELOPE,
// BODYSTRUCTURE, BODY[...]/RFC822*), STORE, SEARCH, COPY, APPEND, EXPUNGE,
// CLOSE, IDLE, LOGOUT, and the UID variants of FETCH/STORE/SEARCH/COPY.
//
// Not implemented (clients cope): SUBSCRIBE/UNSUBSCRIBE bookkeeping is accepted
// and ignored, STARTTLS, CONDSTORE/QRESYNC/UTF8=ACCEPT extensions.

import { createServer, type Server, type Socket } from 'node:net';
import {
	FLAG_ANSWERED,
	FLAG_DELETED,
	FLAG_FLAGGED,
	FLAG_UNREAD,
	type Logger,
} from '@rfmail/shared';
import {
	encodeWords,
	expandAddressList,
	findMimePart,
	generateMid,
	parseMimeTree,
	parseRfc822,
	serialiseRfc822,
	toFullAddress,
	toWinlinkAddress,
} from '@rfmail/core-b2f';
import { findUserByCredential } from './identity.ts';
import {
	verifyPassword,
	type FolderRecord,
	type MessageEnvelope,
	type MessageRecord,
	type Store,
	type UserRecord,
} from '@rfmail/store';
import type { PeerPolicy } from './access.ts';
import type { MailEvents } from './events.ts';

export interface ImapOptions {
	store: Store;
	policy: PeerPolicy;
	events: MailEvents;
	host: string;
	port: number;
	logger: Logger;
	hostname?: string;
	idleTimeoutMs?: number;
}

type Token =
	| { kind: 'atom'; value: string }
	| { kind: 'string'; value: string }
	| { kind: 'literal'; value: Buffer }
	| { kind: 'list'; items: Token[] };

interface Selected {
	folder: FolderRecord;
	messages: MessageEnvelope[];
	readOnly: boolean;
	records: Map<number, MessageRecord>;
}

interface Session {
	user: UserRecord | null;
	selected: Selected | null;
}

// ---------------------------------------------------------------------------
// Socket reader

class Reader {
	private buffer = Buffer.alloc(0);
	private readonly iterator: AsyncIterator<Buffer>;

	constructor(socket: Socket) {
		this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
	}

	private async fill(): Promise<boolean> {
		const next = await this.iterator.next();
		if (next.done) return false;
		this.buffer = Buffer.concat([this.buffer, next.value]);
		return true;
	}

	async readLine(): Promise<string | null> {
		for (;;) {
			const crlf = this.buffer.indexOf('\r\n');
			const lf = this.buffer.indexOf('\n');
			if (crlf !== -1 || lf !== -1) {
				const end = crlf !== -1 && (lf === -1 || crlf <= lf) ? crlf : lf;
				const width = end === crlf ? 2 : 1;
				const line = this.buffer.subarray(0, end).toString('utf8');
				this.buffer = this.buffer.subarray(end + width);
				return line;
			}
			if (!(await this.fill())) return null;
		}
	}

	async readBytes(length: number): Promise<Buffer | null> {
		while (this.buffer.length < length) {
			if (!(await this.fill())) return null;
		}
		const data = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return data;
	}
}

// ---------------------------------------------------------------------------
// Command parsing

interface ParsedLine {
	tokens: Token[];
	literal: { length: number; nonSync: boolean } | null;
}

function parseLine(line: string): ParsedLine {
	let text = line;
	let literal: ParsedLine['literal'] = null;
	const marker = /\{(\d+)(\+)?\}\s*$/.exec(text);
	if (marker) {
		literal = { length: Number(marker[1]), nonSync: Boolean(marker[2]) };
		text = text.slice(0, marker.index);
	}

	let index = 0;

	const skipSpace = (): void => {
		while (index < text.length && text[index] === ' ') index += 1;
	};

	const parseQuoted = (): string => {
		index += 1; // opening quote
		let value = '';
		while (index < text.length) {
			const ch = text[index];
			index += 1;
			if (ch === '\\') {
				value += text[index] ?? '';
				index += 1;
				continue;
			}
			if (ch === '"') break;
			value += ch ?? '';
		}
		return value;
	};

	const parseAtom = (): string => {
		let value = '';
		while (index < text.length) {
			const ch = text[index] ?? '';
			if (ch === '[') {
				// A body section keeps its brackets (and the parentheses inside
				// HEADER.FIELDS) as part of the atom.
				let depth = 0;
				do {
					const current = text[index] ?? '';
					value += current;
					index += 1;
					if (current === '[') depth += 1;
					else if (current === ']') depth -= 1;
				} while (index < text.length && depth > 0);
				continue;
			}
			if (ch === ' ' || ch === '(' || ch === ')') break;
			value += ch;
			index += 1;
		}
		return value;
	};

	const parseSequence = (stopAtClose: boolean): Token[] => {
		const tokens: Token[] = [];
		for (;;) {
			skipSpace();
			if (index >= text.length) break;
			const ch = text[index];
			if (ch === ')') {
				if (stopAtClose) {
					index += 1;
					break;
				}
				index += 1;
				continue;
			}
			if (ch === '(') {
				index += 1;
				tokens.push({ kind: 'list', items: parseSequence(true) });
				continue;
			}
			if (ch === '"') {
				tokens.push({ kind: 'string', value: parseQuoted() });
				continue;
			}
			const atom = parseAtom();
			if (atom === '') {
				index += 1; // stray character; skip it rather than loop forever
				continue;
			}
			tokens.push({ kind: 'atom', value: atom });
		}
		return tokens;
	};

	return { tokens: parseSequence(false), literal };
}

function text(token: Token | undefined): string {
	if (!token) return '';
	if (token.kind === 'atom' || token.kind === 'string') return token.value;
	if (token.kind === 'literal') return token.value.toString('latin1');
	return '';
}

function literalBytes(token: Token | undefined): Buffer | null {
	return token && token.kind === 'literal' ? token.value : null;
}

// ---------------------------------------------------------------------------
// Flags and formatting

function flagsToImap(flags: number): string {
	const out: string[] = [];
	if ((flags & FLAG_ANSWERED) !== 0) out.push('\\Answered');
	if ((flags & FLAG_FLAGGED) !== 0) out.push('\\Flagged');
	if ((flags & FLAG_DELETED) !== 0) out.push('\\Deleted');
	if ((flags & FLAG_UNREAD) === 0) out.push('\\Seen');
	return `(${out.join(' ')})`;
}

function flagBits(names: string[]): number {
	let bits = 0;
	for (const name of names) {
		switch (name.toLowerCase()) {
			case '\\seen':
				bits &= ~FLAG_UNREAD;
				break;
			case '\\flagged':
				bits |= FLAG_FLAGGED;
				break;
			case '\\answered':
				bits |= FLAG_ANSWERED;
				break;
			case '\\deleted':
				bits |= FLAG_DELETED;
				break;
			default:
				break;
		}
	}
	return bits;
}

function quote(value: string): string {
	if (/["\\\r\n]/.test(value)) {
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}
	return `"${value}"`;
}

function imapDate(epochMs: number): string {
	const date = new Date(epochMs);
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const day = String(date.getUTCDate()).padStart(2, '0');
	const month = months[date.getUTCMonth()] ?? 'Jan';
	const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
		.map((n) => String(n).padStart(2, '0'))
		.join(':');
	return `${day}-${month}-${date.getUTCFullYear()} ${time} +0000`;
}

function parseAddress(value: string): { name: string; mailbox: string; host: string } {
	const angle = /^(.*)<([^>]*)>\s*$/.exec(value);
	const name = angle && angle[1] ? angle[1].trim().replace(/^"|"$/g, '') : '';
	const address = (angle && angle[2] ? angle[2] : value).trim();
	const at = address.lastIndexOf('@');
	if (at === -1) return { name, mailbox: address, host: '' };
	return { name, mailbox: address.slice(0, at), host: address.slice(at + 1) };
}

function addressList(addresses: string[]): string {
	if (addresses.length === 0) return 'NIL';
	const entries = addresses.map((value) => {
		const { name, mailbox, host } = parseAddress(value);
		const namePart = name ? quote(encodeWords(name)) : 'NIL';
		return `(${namePart} NIL ${quote(mailbox)} ${host ? quote(host) : 'NIL'})`;
	});
	return `(${entries.join('')})`;
}

/**
 * `BODY[HEADER.FIELDS (From Subject)]`: the message headers, keeping only the
 * named ones (or, with `.NOT`, dropping them). Continuation lines travel with
 * their header.
 */
function selectHeaderFields(raw: Buffer, fields: string[], excludes: boolean): Buffer {
	const split = raw.indexOf('\r\n\r\n');
	const headerBlock = split === -1 ? raw.toString('latin1') : raw.subarray(0, split + 2).toString('latin1');
	const kept: string[] = [];
	for (const line of headerBlock.split('\r\n')) {
		if (line === '') continue;
		if (/^[ \t]/.test(line)) {
			if (kept.length > 0 && !excludes) kept[kept.length - 1] += `\r\n${line}`;
			continue;
		}
		const name = (line.split(':')[0] ?? '').toUpperCase();
		const named = fields.includes(name);
		if (excludes ? !named : named) kept.push(line);
	}
	return Buffer.from(`${kept.join('\r\n')}\r\n\r\n`, 'latin1');
}

/**
 * The bytes an IMAP section asks for: `''` is the whole message, `HEADER` and
 * `TEXT` its halves, `1`/`2.1` a MIME part's content, and `1.MIME` that part's
 * own headers. `HEADER.FIELDS (...)` is handled by the caller.
 */
function sectionBytes(raw: Buffer, section: string): Buffer | null {
	const trimmed = section.trim();
	if (trimmed === '') return raw;
	const tree = parseMimeTree(raw);
	const headEnd = raw.indexOf('\r\n\r\n');
	const headers = headEnd === -1 ? raw : raw.subarray(0, headEnd + 4);
	const body = headEnd === -1 ? Buffer.alloc(0) : raw.subarray(headEnd + 4);

	const upper = trimmed.toUpperCase();
	if (upper === 'HEADER') return headers;
	if (upper === 'TEXT') return body;

	if (upper.endsWith('.MIME')) {
		const part = findMimePart(tree, trimmed.slice(0, -5));
		return part ? part.headers : null;
	}
	if (upper.endsWith('.HEADER')) {
		const part = findMimePart(tree, trimmed.slice(0, -7));
		return part ? part.headers : null;
	}
	if (upper.endsWith('.TEXT')) {
		const part = findMimePart(tree, trimmed.slice(0, -5));
		return part ? part.body : null;
	}
	if (/^\d+(\.\d+)*$/.test(trimmed)) {
		// A message that is not multipart has a section 1: its own body.
		if (tree.children.length === 0 && trimmed === '1') return body;
		const part = findMimePart(tree, trimmed);
		return part ? part.body : null;
	}
	return null;
}

function envelope(envelope: MessageEnvelope): string {
	// Clients see Winlink addresses with a domain; the store keeps them bare.
	const from = addressList([toFullAddress(envelope.from)]);
	return (
		'(' +
		[
			quote(imapDate(envelope.dateUtc)),
			quote(encodeWords(envelope.subject)),
			from,
			from,
			from,
			addressList(expandAddressList(envelope.to)),
			addressList(expandAddressList(envelope.cc)),
			'NIL',
			'NIL',
			quote(`<${envelope.mid.toLowerCase()}.rfmail>`),
		].join(' ') +
		')'
	);
}

function bodyStructure(record: MessageRecord): string {
	const textPart =
		'("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ' +
		`${Buffer.byteLength(record.body, 'utf8')} ${record.body.split('\n').length})`;
	if (record.attachments.length === 0) return textPart;
	const parts = [textPart];
	for (const attachment of record.attachments) {
		const type = attachment.contentType.split('/');
		const main = (type[0] ?? 'application').toUpperCase();
		const sub = (type[1] ?? 'octet-stream').toUpperCase();
		parts.push(
			`("${main}" "${sub}" ("NAME" ${quote(encodeWords(attachment.name))}) NIL NIL "BASE64" ${attachment.size} NIL)`,
		);
	}
	return `(${parts.join('')} "MIXED")`;
}

/** "1", "1:3", "*", "1,4:6" -> sorted unique indices (0-based). */
function resolveSet(spec: string, count: number, uidToIndex?: Map<number, number>): number[] {
	const out = new Set<number>();
	for (const part of spec.split(',')) {
		const [fromRaw = '', toRaw = ''] = part.split(':');
		const resolve = (value: string): number | null => {
			if (value === '*') return count - 1;
			const n = Number(value);
			if (!Number.isInteger(n)) return null;
			if (uidToIndex) {
				const index = uidToIndex.get(n);
				return index === undefined ? null : index;
			}
			return n - 1;
		};
		const from = resolve(fromRaw.trim());
		if (from === null) continue;
		const to = toRaw === '' ? from : resolve(toRaw.trim());
		if (to === null) {
			if (uidToIndex) continue;
			continue;
		}
		const [low, high] = from <= to ? [from, to] : [to, from];
		for (let i = low; i <= high; i += 1) {
			if (i >= 0 && i < count) out.add(i);
		}
	}
	return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------

export class ImapServer {
	private readonly opts: ImapOptions;
	private server: Server | null = null;
	private readonly connections = new Set<Socket>();

	constructor(options: ImapOptions) {
		this.opts = options;
	}

	get address(): string {
		if (!this.server) return `${this.opts.host}:${this.opts.port}`;
		const found = this.server.address();
		if (found && typeof found === 'object') return `${found.address}:${found.port}`;
		return `${this.opts.host}:${this.opts.port}`;
	}

	/** True only while a socket is bound; a failed listen leaves this false. */
	get listening(): boolean {
		return this.server?.listening === true;
	}

	async listen(): Promise<void> {
		if (this.server) return;
		const server = createServer((socket) => void this.handle(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error): void => {
				server.off('listening', onListening);
				// A socket that never bound must not look bound: a later start has to try again.
				this.server = null;
				reject(err);
			};
			const onListening = (): void => {
				server.off('error', onError);
				resolve();
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(this.opts.port, this.opts.host);
		});
		this.opts.logger.info('imap listening', { address: this.address, access: this.opts.policy.describe() });
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = null;
		for (const socket of this.connections) socket.destroy();
		this.connections.clear();
		if (!server) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 2000);
			timer.unref();
			server.close(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private async handle(socket: Socket): Promise<void> {
		const remote = socket.remoteAddress ?? '';
		const hostname = this.opts.hostname ?? 'rfmail';
		if (!this.opts.policy.allows(remote)) {
			this.opts.logger.warn('imap connection refused by access policy', { remote });
			socket.end('* BYE service not available from this address\r\n');
			return;
		}

		this.connections.add(socket);
		socket.setNoDelay(true);
		socket.setTimeout(this.opts.idleTimeoutMs ?? 30 * 60 * 1000);
		socket.on('timeout', () => socket.destroy());
		socket.on('error', () => socket.destroy());

		const reader = new Reader(socket);
		const session: Session = { user: null, selected: null };
		// The transcript is only emitted at debug level; it carries no secrets,
		// but a long literal is cut short so the log stays readable.
		const preview = (chunk: string | Buffer): string => {
			const raw = typeof chunk === 'string' ? chunk : chunk.toString('latin1');
			return raw.replace(/\r\n/g, ' | ').slice(0, 300);
		};
		const write = (chunk: string | Buffer): void => {
			if (!socket.destroyed) socket.write(chunk);
			this.opts.logger.debug?.('imap response', { remote, data: preview(chunk) });
		};

		this.opts.logger.debug?.('imap client connected', { remote });
		socket.on('close', () => this.opts.logger.debug?.('imap client disconnected', { remote }));

		write(`* OK [CAPABILITY IMAP4rev1 LITERAL+ AUTH=PLAIN IDLE] ${hostname} ready\r\n`);

		try {
			for (;;) {
				const line = await reader.readLine();
				if (line === null) break;
				if (line.trim() === '') continue;

				const first = parseLine(line);
				const tokens = [...first.tokens];
				// Every command is logged with its arguments, except the ones that
				// carry a secret: those keep only the verb.
				const verbToken: Token | undefined = tokens[1];
				const verb = text(verbToken).toUpperCase();
				const secrets = verb === 'LOGIN' || verb === 'AUTHENTICATE';
				const describe = (token: Token): string =>
					token.kind === 'list'
						? `(${token.items.map(describe).join(' ')})`
						: text(token);
				this.opts.logger.debug?.('imap command', {
					remote,
					tag: text(tokens[0]),
					command: verb,
					args: secrets ? ['***'] : tokens.slice(2).map(describe),
				});
				let pending = first;
				let aborted = false;
				while (pending.literal) {
					const marker = pending.literal;
					if (!marker.nonSync) write('+ Ready for literal data\r\n');
					const data = await reader.readBytes(marker.length);
					if (!data) {
						aborted = true;
						break;
					}
					tokens.push({ kind: 'literal', value: data });
					const next = await reader.readLine();
					if (next === null) {
						aborted = true;
						break;
					}
					pending = parseLine(next);
					tokens.push(...pending.tokens);
				}
				if (aborted) break;

				const tag = text(tokens[0]);
				const name = text(tokens[1]).toUpperCase();
				const args = tokens.slice(2);
				if (!tag) {
					write('* BAD missing tag\r\n');
					continue;
				}

				const close = await this.dispatch(write, reader, session, tag, name, args);
				if (close) break;
			}
		} catch (err) {
			this.opts.logger.warn('imap session error', {
				remote,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.connections.delete(socket);
			socket.destroy();
		}
	}

	/** Returns true when the connection should close. */
	private async dispatch(
		write: (chunk: string | Buffer) => void,
		reader: Reader,
		session: Session,
		tag: string,
		name: string,
		args: Token[],
	): Promise<boolean> {
		const ok = (textValue = 'completed'): void => write(`${tag} OK ${textValue}\r\n`);
		const no = (textValue: string): void => write(`${tag} NO ${textValue}\r\n`);
		const bad = (textValue: string): void => write(`${tag} BAD ${textValue}\r\n`);

		switch (name) {
			case 'CAPABILITY':
				write('* CAPABILITY IMAP4rev1 LITERAL+ AUTH=PLAIN IDLE\r\n');
				ok('CAPABILITY completed');
				return false;

			case 'NOOP':
				ok('NOOP completed');
				return false;

			case 'LOGOUT':
				write('* BYE rfmail signing off\r\n');
				ok('LOGOUT completed');
				return true;

			case 'LOGIN': {
				const login = text(args[0]);
				const password = literalBytes(args[1])?.toString('utf8') ?? text(args[1]);
				return this.authenticate(write, session, tag, login, password);
			}

			case 'AUTHENTICATE': {
				const mechanism = text(args[0]).toUpperCase();
				if (mechanism !== 'PLAIN') {
					no('unsupported authentication mechanism');
					return false;
				}
				write('+ \r\n');
				const answer = await reader.readLine();
				if (answer === null) return true;
				const decoded = Buffer.from(answer.trim(), 'base64').toString('utf8');
				const parts = decoded.split('\u0000');
				const login = parts[1] ?? parts[0] ?? '';
				const password = parts[2] ?? '';
				return this.authenticate(write, session, tag, login, password);
			}

			case 'SUBSCRIBE':
			case 'UNSUBSCRIBE':
				ok(`${name} completed`);
				return false;

			case 'LIST':
			case 'LSUB': {
				if (!session.user) {
					bad('authenticate first');
					return false;
				}
				const pattern = text(args[1]) || '*';
				const folders = await this.opts.store.listFolders(session.user.id);
				for (const folder of folders) {
					if (pattern === '*' || pattern === '%' || folder.name.toUpperCase() === 'INBOX' || folder.name.toLowerCase().includes(pattern.toLowerCase())) {
						write(`* ${name} (\\HasNoChildren) "/" ${quote(folder.name)}\r\n`);
					}
				}
				ok(`${name} completed`);
				return false;
			}

			case 'STATUS': {
				if (!session.user) {
					bad('authenticate first');
					return false;
				}
				const user = session.user;
				const wanted = text(args[0]);
				const folder = await this.findFolder(user, wanted);
				if (!folder) {
					no('no such mailbox');
					return false;
				}
				const list = await this.opts.store.listMessages(user.id, folder.id, { limit: 20000 });
				const items = args[1]?.kind === 'list' ? args[1].items.map((item) => text(item).toUpperCase()) : [];
				const values: string[] = [];
				for (const item of items) {
					switch (item) {
						case 'MESSAGES':
							values.push(`MESSAGES ${list.total}`);
							break;
						case 'RECENT':
							values.push('RECENT 0');
							break;
						case 'UIDNEXT':
							values.push(`UIDNEXT ${folder.uidnext}`);
							break;
						case 'UIDVALIDITY':
							values.push(`UIDVALIDITY ${folder.uidvalidity}`);
							break;
						case 'UNSEEN': {
							const unseen = list.messages.filter((m) => (m.flags & FLAG_UNREAD) !== 0).length;
							values.push(`UNSEEN ${unseen}`);
							break;
						}
						default:
							break;
					}
				}
				write(`* STATUS ${quote(folder.name)} (${values.join(' ')})\r\n`);
				ok('STATUS completed');
				return false;
			}

			case 'SELECT':
			case 'EXAMINE': {
				if (!session.user) {
					bad('authenticate first');
					return false;
				}
				const user = session.user;
				const folder = await this.findFolder(user, text(args[0]));
				if (!folder) {
					no('no such mailbox');
					return false;
				}
				const list = await this.opts.store.listMessages(user.id, folder.id, { limit: 20000 });
				const messages = [...list.messages].sort((a, b) => a.uid - b.uid);
				session.selected = {
					folder,
					messages,
					readOnly: name === 'EXAMINE',
					records: new Map(),
				};
				write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
				write(`* ${messages.length} EXISTS\r\n`);
				write('* 0 RECENT\r\n');
				write(`* OK [UIDVALIDITY ${folder.uidvalidity}] UIDs valid\r\n`);
				write(`* OK [UIDNEXT ${folder.uidnext}] Predicted next UID\r\n`);
				write('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)] Limited\r\n');
				ok(name === 'EXAMINE' ? '[READ-ONLY] EXAMINE completed' : '[READ-WRITE] SELECT completed');
				return false;
			}

			case 'FETCH':
			case 'STORE':
			case 'SEARCH':
			case 'COPY':
				return this.mailboxCommand(write, session, tag, name, args, false);

			case 'UID': {
				const sub = text(args[0]).toUpperCase();
				if (!['FETCH', 'STORE', 'SEARCH', 'COPY'].includes(sub)) {
					bad('unsupported UID command');
					return false;
				}
				return this.mailboxCommand(write, session, tag, sub, args.slice(1), true);
			}

			case 'APPEND':
				return this.append(write, session, tag, args);

			case 'EXPUNGE':
				return this.expunge(write, session, tag, true);

			case 'CLOSE': {
				if (!session.selected) {
					bad('no mailbox selected');
					return false;
				}
				session.selected = null;
				ok('CLOSE completed');
				return false;
			}

			case 'IDLE': {
				if (!session.selected || !session.user) {
					bad('no mailbox selected');
					return false;
				}
				const user = session.user;
				const selected = session.selected;
				write('+ idling\r\n');
				const unsubscribe = this.opts.events.subscribe((event) => {
					if (event.userId !== user.id || event.folderId !== selected.folder.id) return;
					void (async () => {
						const list = await this.opts.store.listMessages(user.id, selected.folder.id, {
							limit: 20000,
						});
						selected.messages = [...list.messages].sort((a, b) => a.uid - b.uid);
						write(`* ${selected.messages.length} EXISTS\r\n`);
						write('* 0 RECENT\r\n');
					})();
				});
				try {
					const answer = await reader.readLine();
					if (answer === null) return true;
					if (answer.trim().toUpperCase() !== 'DONE') {
						bad('expected DONE');
						return false;
					}
				} finally {
					unsubscribe();
				}
				ok('IDLE terminated');
				return false;
			}

			default:
				bad(`unknown command ${name}`);
				return false;
		}
	}

	private async authenticate(
		write: (chunk: string | Buffer) => void,
		session: Session,
		tag: string,
		login: string,
		password: string,
	): Promise<boolean> {
		const user = login ? await findUserByCredential(this.opts.store, login) : null;
		if (!user || !user.enabled || !verifyPassword(password, user.pwHash)) {
			this.opts.logger.warn('imap login failed', { login });
			write(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials\r\n`);
			return false;
		}
		this.opts.logger.info('imap login', { callsign: user.callsign ?? user.login });
		session.user = user;
		write(`${tag} OK [CAPABILITY IMAP4rev1 LITERAL+ IDLE] logged in\r\n`);
		return false;
	}

	private async findFolder(user: UserRecord, name: string): Promise<FolderRecord | null> {
		if (!name) return null;
		return this.opts.store.findFolder(user.id, name);
	}

	private async mailboxCommand(
		write: (chunk: string | Buffer) => void,
		session: Session,
		tag: string,
		name: string,
		args: Token[],
		byUid: boolean,
	): Promise<boolean> {
		const selected = session.selected;
		const user = session.user;
		if (!selected || !user) {
			write(`${tag} BAD no mailbox selected\r\n`);
			return false;
		}

		const uidToIndex = new Map<number, number>();
		selected.messages.forEach((message, index) => uidToIndex.set(message.uid, index));
		const indices = resolveSet(text(args[0]) || '1:*', selected.messages.length, byUid ? uidToIndex : undefined);

		if (name === 'FETCH') {
			for (const index of indices) {
				await this.fetchOne(write, user, selected, index, args[1], byUid);
			}
			write(`${tag} OK FETCH completed\r\n`);
			return false;
		}

		if (name === 'STORE') {
			if (selected.readOnly) {
				write(`${tag} NO mailbox is read-only\r\n`);
				return false;
			}
			const item = text(args[1]).toUpperCase();
			const silent = item.endsWith('.SILENT');
			const operation = item.replace('.SILENT', '');
			const flagNames =
				args[2]?.kind === 'list'
					? args[2].items.map((entry) => text(entry))
					: [text(args[2])];
			const bits = flagBits(flagNames);
			const setSeen = flagNames.some((flag) => flag.toLowerCase() === '\\seen');

			for (const index of indices) {
				const message = selected.messages[index];
				if (!message) continue;
				let flags = message.flags;
				if (operation === '+FLAGS') {
					flags |= bits;
					if (setSeen) flags &= ~FLAG_UNREAD;
				} else if (operation === '-FLAGS') {
					flags &= ~bits;
					if (setSeen) flags |= FLAG_UNREAD;
				} else {
					// FLAGS replaces the set; a missing \Seen means unread.
					flags = bits | (setSeen ? 0 : FLAG_UNREAD);
				}
				await this.opts.store.setFlags(user.id, message.id, flags);
				message.flags = flags;
				selected.records.delete(message.id);
				if (!silent) {
					write(`* ${index + 1} FETCH (${byUid ? `UID ${message.uid} ` : ''}FLAGS ${flagsToImap(flags)})\r\n`);
				}
			}
			write(`${tag} OK STORE completed\r\n`);
			return false;
		}

		if (name === 'SEARCH') {
			const hits: number[] = [];
			for (let index = 0; index < selected.messages.length; index += 1) {
				const message = selected.messages[index];
				if (!message) continue;
				if (await this.matches(user.id, message, args)) hits.push(index + 1);
			}
			write(`* SEARCH${hits.length ? ` ${hits.join(' ')}` : ''}\r\n`);
			write(`${tag} OK SEARCH completed\r\n`);
			return false;
		}

		if (name === 'COPY') {
			const target = await this.findFolder(user, text(args[1]));
			if (!target) {
				write(`${tag} NO no such mailbox\r\n`);
				return false;
			}
			for (const index of indices) {
				const message = selected.messages[index];
				if (!message) continue;
				const full = await this.opts.store.getMailMessage(user.id, message.id);
				if (!full) continue;
				// A copy is a new local message; the RFC 822 Message-ID is kept so
				// clients still thread it, but the B2F MID is unique per user.
				await this.opts.store.insertMessage(
					user.id,
					target.id,
					{ ...full, mid: generateMid(user.callsign ?? user.login) },
					{ direction: 'in' },
				);
			}
			this.opts.events.notify({ userId: user.id, folderId: target.id, folder: target.name });
			write(`${tag} OK COPY completed\r\n`);
			return false;
		}

		write(`${tag} BAD unsupported command\r\n`);
		return false;
	}

	private async fetchOne(
		write: (chunk: string | Buffer) => void,
		user: UserRecord,
		selected: Selected,
		index: number,
		itemToken: Token | undefined,
		byUid: boolean,
	): Promise<void> {
		const message = selected.messages[index];
		if (!message) return;

		const items: Token[] =
			itemToken?.kind === 'list' ? itemToken.items : itemToken ? [itemToken] : [];
		const expanded: string[] = [];
		for (const item of items) {
			const value = text(item);
			const upper = value.toUpperCase();
			if (upper === 'ALL') expanded.push('FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE');
			else if (upper === 'FAST') expanded.push('FLAGS', 'INTERNALDATE', 'RFC822.SIZE');
			else if (upper === 'FULL') expanded.push('FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY');
			else expanded.push(value);
		}

		// RFC 3501 §6.4.8: a UID FETCH response carries the UID even when the
		// client did not ask for it. Thunderbird drops every message otherwise.
		if (byUid && !expanded.some((item) => item.toUpperCase() === 'UID')) {
			expanded.unshift('UID');
		}

		const parts: Array<string | Buffer> = [];
		let needsRecord = false;
		let peek = true;

		for (const item of expanded) {
			const upper = item.toUpperCase();
			if (upper === 'UID') {
				parts.push(`UID ${message.uid} `);
			} else if (upper === 'FLAGS') {
				parts.push(`FLAGS ${flagsToImap(message.flags)} `);
			} else if (upper === 'INTERNALDATE') {
				parts.push(`INTERNALDATE ${quote(imapDate(message.dateUtc))} `);
			} else if (upper === 'RFC822.SIZE') {
				parts.push(`RFC822.SIZE ${message.size} `);
			} else if (upper === 'ENVELOPE') {
				parts.push(`ENVELOPE ${envelope(message)} `);
			} else if (upper === 'BODY' || upper === 'BODYSTRUCTURE') {
				needsRecord = true;
				const record = await this.record(user, selected, message);
				parts.push(`${upper} ${record ? bodyStructure(record) : 'NIL'} `);
			} else if (upper === 'RFC822') {
				needsRecord = true;
				peek = false;
				const full = await this.serialised(user, message);
				parts.push(`RFC822 {${full.length}}\r\n`, full);
			} else if (upper === 'RFC822.HEADER') {
				const full = await this.serialised(user, message);
				const split = full.indexOf('\r\n\r\n');
				const head = split === -1 ? full : full.subarray(0, split + 4);
				parts.push(`RFC822.HEADER {${head.length}}\r\n`, head);
			} else if (upper === 'RFC822.TEXT') {
				needsRecord = true;
				const full = await this.serialised(user, message);
				const split = full.indexOf('\r\n\r\n');
				const bodyPart = split === -1 ? Buffer.alloc(0) : full.subarray(split + 4);
				parts.push(`RFC822.TEXT {${bodyPart.length}}\r\n`, bodyPart);
			} else if (upper.startsWith('BODY[') || upper.startsWith('BODY.PEEK[')) {
				const isPeek = upper.startsWith('BODY.PEEK[');
				if (!isPeek) peek = false;
				needsRecord = true;
				const open = item.indexOf('[');
				const close = item.indexOf(']', open);
				const section = item.slice(open + 1, close === -1 ? undefined : close);
				const partial = /<(\d+)\.(\d+)>/.exec(close === -1 ? '' : item.slice(close + 1));
				const full = await this.serialised(user, message);

				let slice: Buffer | null;
				const fieldsMatch = /^HEADER\.FIELDS\s*(?:\(([^)]*)\)|\.NOT)?/i.exec(section.trim());
				if (fieldsMatch) {
					const fields = (fieldsMatch[1] ?? '')
						.split(/\s+/)
						.filter(Boolean)
						.map((field) => field.toUpperCase());
					const excludes = /\.NOT/i.test(section);
					slice = selectHeaderFields(full, fields, excludes);
				} else {
					slice = sectionBytes(full, section);
				}

				const label = isPeek ? `BODY[${section}]` : `BODY[${section}]`;
				if (!slice) {
					parts.push(`${label} NIL `);
					continue;
				}
				if (partial) {
					const start = Number(partial[1]);
					const count = Number(partial[2]);
					const window = slice.subarray(start, start + count);
					parts.push(`${label}<${start}> {${window.length}}\r\n`, window);
				} else {
					parts.push(`${label} {${slice.length}}\r\n`, slice);
				}
			} else {
				parts.push(`X-UNKNOWN ${quote(item)} `);
			}
		}


		write(`* ${index + 1} FETCH (`);
		for (const part of parts) write(part);
		write(')\r\n');

		if (needsRecord || expanded.length === 0) {
			// Touch the record so a later body fetch is cheap.
			await this.record(user, selected, message);
		}

		if (!peek && (message.flags & FLAG_UNREAD) !== 0 && !selected.readOnly) {
			const flags = message.flags & ~FLAG_UNREAD;
			await this.opts.store.setFlags(user.id, message.id, flags);
			message.flags = flags;
			selected.records.delete(message.id);
			write(`* ${index + 1} FETCH (FLAGS ${flagsToImap(flags)})\r\n`);
		}
	}

	private async record(
		user: UserRecord,
		selected: Selected,
		message: MessageEnvelope,
	): Promise<MessageRecord | null> {
		const cached = selected.records.get(message.id);
		if (cached) return cached;
		const record = await this.opts.store.getMessage(user.id, message.id);
		if (record) selected.records.set(message.id, record);
		return record;
	}

	private async serialised(user: UserRecord, message: MessageEnvelope): Promise<Buffer> {
		const full = await this.opts.store.getMailMessage(user.id, message.id);
		if (!full) return Buffer.alloc(0);
		return Buffer.from(serialiseRfc822(full));
	}

	private async matches(
		userId: number,
		message: MessageEnvelope,
		args: Token[],
	): Promise<boolean> {
		if (args.length === 0) return true;
		let index = 0;
		let result = true;
		while (index < args.length) {
			const token = args[index];
			const key = text(token).toUpperCase();
			index += 1;
			const next = args[index];
			const value = text(next).toLowerCase();
			switch (key) {
				case 'ALL':
					break;
				case 'UNSEEN':
					result = result && (message.flags & FLAG_UNREAD) !== 0;
					break;
				case 'SEEN':
					result = result && (message.flags & FLAG_UNREAD) === 0;
					break;
				case 'FLAGGED':
					result = result && (message.flags & FLAG_FLAGGED) !== 0;
					break;
				case 'UNFLAGGED':
					result = result && (message.flags & FLAG_FLAGGED) === 0;
					break;
				case 'ANSWERED':
					result = result && (message.flags & FLAG_ANSWERED) !== 0;
					break;
				case 'DELETED':
					result = result && (message.flags & FLAG_DELETED) !== 0;
					break;
				case 'UNDELETED':
					result = result && (message.flags & FLAG_DELETED) === 0;
					break;
				case 'FROM': {
					// `FROM OK1ABC@winlink.org` has to match the stored `OK1ABC`.
					const wanted = toWinlinkAddress(value).toLowerCase();
					result = result && (message.from.toLowerCase().includes(wanted) || toFullAddress(message.from).toLowerCase().includes(value));
					index += 1;
					break;
				}
				case 'SUBJECT':
					result = result && message.subject.toLowerCase().includes(value);
					index += 1;
					break;
				case 'TO': {
					const wanted = toWinlinkAddress(value).toLowerCase();
					result =
						result &&
						(message.to.join(' ').toLowerCase().includes(wanted) ||
							expandAddressList(message.to).join(' ').toLowerCase().includes(value));
					index += 1;
					break;
				}
				case 'TEXT':
				case 'BODY': {
					const record = await this.opts.store.getMessage(userId, message.id);
					result = result && (record?.body.toLowerCase().includes(value) ?? false);
					index += 1;
					break;
				}
				case 'SINCE':
				case 'BEFORE':
				case 'ON': {
					const when = parseImapDate(text(next));
					index += 1;
					if (when !== null) {
						const day = 24 * 60 * 60 * 1000;
						const messageDay = Math.floor(message.dateUtc / day);
						const targetDay = Math.floor(when / day);
						if (key === 'SINCE') result = result && messageDay >= targetDay;
						else if (key === 'BEFORE') result = result && messageDay < targetDay;
						else result = result && messageDay === targetDay;
					}
					break;
				}
				case 'UID': {
					const set = text(next);
					index += 1;
					const values = new Set<number>();
					for (const part of set.split(',')) {
						const [fromRaw, toRaw] = part.split(':');
						const from = Number(fromRaw);
						const to = toRaw === undefined ? from : toRaw === '*' ? Number.MAX_SAFE_INTEGER : Number(toRaw);
						if (Number.isInteger(from) && Number.isInteger(to)) {
							for (let uid = from; uid <= Math.min(to, from + 100000); uid += 1) values.add(uid);
						}
					}
					result = result && values.has(message.uid);
					break;
				}
				default:
					// Unknown criteria are treated as no-ops rather than failing the search.
					break;
			}
		}
		return result;
	}

	private async append(
		write: (chunk: string | Buffer) => void,
		session: Session,
		tag: string,
		args: Token[],
	): Promise<boolean> {
		const user = session.user;
		if (!user) {
			write(`${tag} BAD authenticate first\r\n`);
			return false;
		}
		const folder = await this.findFolder(user, text(args[0]));
		if (!folder) {
			write(`${tag} NO [TRYCREATE] no such mailbox\r\n`);
			return false;
		}
		let literal: Buffer | null = null;
		let flagNames: string[] = [];
		for (const token of args.slice(1)) {
			if (token.kind === 'literal') literal = token.value;
			else if (token.kind === 'list') flagNames = token.items.map((item) => text(item));
		}
		if (!literal) {
			write(`${tag} BAD APPEND needs a message literal\r\n`);
			return false;
		}
		const message = parseRfc822(new Uint8Array(literal), { mid: generateMid(text(args[0]) || user.callsign || user.login) });
		let flags = flagBits(flagNames);
		if (!flagNames.some((flag) => flag.toLowerCase() === '\\seen')) flags |= FLAG_UNREAD;
		await this.opts.store.insertMessage(user.id, folder.id, message, {
			direction: folder.kind === 'outbox' || folder.kind === 'sent' ? 'out' : 'in',
			flags,
		});
		this.opts.events.notify({ userId: user.id, folderId: folder.id, folder: folder.name });
		write(`${tag} OK APPEND completed\r\n`);
		return false;
	}

	private async expunge(
		write: (chunk: string | Buffer) => void,
		session: Session,
		tag: string,
		respond: boolean,
	): Promise<boolean> {
		const selected = session.selected;
		const user = session.user;
		if (!selected || !user) {
			write(`${tag} BAD no mailbox selected\r\n`);
			return false;
		}
		let expunged = 0;
		const remaining: MessageEnvelope[] = [];
		for (let index = 0; index < selected.messages.length; index += 1) {
			const message = selected.messages[index];
			if (!message) continue;
			if ((message.flags & FLAG_DELETED) !== 0) {
				const sequence = index + 1 - expunged;
				await this.opts.store.deleteMessage(user.id, message.id);
				expunged += 1;
				if (respond) write(`* ${sequence} EXPUNGE\r\n`);
			} else {
				remaining.push(message);
			}
		}
		selected.messages = remaining;
		write(`${tag} OK EXPUNGE completed\r\n`);
		return false;
	}
}

function parseImapDate(value: string): number | null {
	const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(value);
	if (!match) return null;
	const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
	const month = months.indexOf((match[2] ?? '').toLowerCase());
	if (month === -1) return null;
	return Date.UTC(Number(match[3]), month, Number(match[1]));
}
