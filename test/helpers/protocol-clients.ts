// Minimal clients for the protocol tests, so the servers are exercised over a
// real socket rather than by calling their internals.
//
// Line decoding uses latin1 so that a literal's bytes survive unchanged; these
// protocols are ASCII on the command channel.

import { connect, type Socket } from 'node:net';

class ByteChannel {
	protected socket: Socket;
	private buffer = Buffer.alloc(0);
	private readonly iterator: AsyncIterator<Buffer>;
	private closed = false;

	constructor(port: number, host = '127.0.0.1') {
		this.socket = connect(port, host);
		this.iterator = this.socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
		this.socket.on('error', () => {
			this.closed = true;
		});
		this.socket.on('close', () => {
			this.closed = true;
		});
	}

	protected async fill(): Promise<boolean> {
		if (this.closed) return false;
		const next = await Promise.race([
			this.iterator.next(),
			new Promise<IteratorResult<Buffer>>((_, reject) =>
				setTimeout(() => reject(new Error('socket read timed out')), 5000),
			),
		]);
		if (next.done) {
			this.closed = true;
			return false;
		}
		this.buffer = Buffer.concat([this.buffer, next.value]);
		return true;
	}

	async line(): Promise<string> {
		for (;;) {
			const index = this.buffer.indexOf('\r\n');
			if (index !== -1) {
				const line = this.buffer.subarray(0, index).toString('latin1');
				this.buffer = this.buffer.subarray(index + 2);
				return line;
			}
			if (!(await this.fill())) throw new Error('connection closed');
		}
	}

	async bytes(length: number): Promise<Buffer> {
		while (this.buffer.length < length) {
			if (!(await this.fill())) throw new Error('connection closed mid-literal');
		}
		const data = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return data;
	}

	write(text: string | Uint8Array): void {
		this.socket.write(typeof text === 'string' ? Buffer.from(text, 'latin1') : Buffer.from(text));
	}

	close(): void {
		this.socket.destroy();
	}
}

export class SmtpTestClient extends ByteChannel {
	async greeting(): Promise<string> {
		return this.line();
	}

	/** Sends a command and returns the final line of a possibly multi-line reply. */
	async cmd(line: string): Promise<string> {
		this.write(`${line}\r\n`);
		let reply = await this.line();
		while (/^\d{3}-/.test(reply)) {
			reply = await this.line();
		}
		return reply;
	}

	/** Sends the whole DATA payload (dot-stuffing lines that begin with a dot). */
	async data(payload: string): Promise<string> {
		this.write('DATA\r\n');
		const ready = await this.line();
		if (!ready.startsWith('354')) return ready;
		for (const line of payload.split('\r\n')) {
			this.write(`${line.startsWith('.') ? `.${line}` : line}\r\n`);
		}
		this.write('.\r\n');
		return this.line();
	}
}

export interface ImapReply {
	tag: string;
	status: string;
	lines: string[];
	literals: Buffer[];
}

export class ImapTestClient extends ByteChannel {
	private tagCounter = 0;

	async greeting(): Promise<string> {
		return this.line();
	}

	async command(command: string, options: { literal?: string } = {}): Promise<ImapReply> {
		this.tagCounter += 1;
		const tag = `T${this.tagCounter}`;
		if (options.literal !== undefined) {
			const bytes = Buffer.from(options.literal, 'utf8');
			this.write(`${tag} ${command} {${bytes.length}}\r\n`);
			const continuation = await this.line();
			if (!continuation.startsWith('+')) throw new Error(`no continuation: ${continuation}`);
			this.write(bytes);
			this.write('\r\n');
		} else {
			this.write(`${tag} ${command}\r\n`);
		}

		const lines: string[] = [];
		const literals: Buffer[] = [];
		for (;;) {
			const line = await this.line();
			if (line.startsWith(`${tag} `)) {
				const status = line.slice(tag.length + 1).split(' ')[0] ?? '';
				return { tag, status, lines, literals };
			}
			if (line.startsWith('+')) {
				// Unexpected continuation prompt: answer with an empty line.
				this.write('\r\n');
				continue;
			}
			const marker = /\{(\d+)\}$/.exec(line);
			if (marker) {
				const length = Number(marker[1]);
				literals.push(await this.bytes(length));
				lines.push(`${line} <${length} bytes>`);
				continue;
			}
			lines.push(line);
		}
	}
}
