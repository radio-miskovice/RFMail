import type { Socket } from 'node:net';

/**
 * Yields CRLF-terminated lines from a socket without losing pipelined input.
 * The terminating CRLF is not included.
 */
export async function* readLines(
	socket: Socket,
	encoding: 'utf8' | 'latin1' = 'utf8',
): AsyncGenerator<string> {
	let buffer = Buffer.alloc(0);
	for await (const chunk of socket) {
		buffer = Buffer.concat([buffer, chunk as Buffer]);
		for (;;) {
			const crlf = buffer.indexOf('\r\n');
			const lf = buffer.indexOf('\n');
			let end = -1;
			let width = 1;
			if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
				end = crlf;
				width = 2;
			} else if (lf !== -1) {
				end = lf;
			}
			if (end === -1) break;
			const line = buffer.subarray(0, end).toString(encoding);
			buffer = buffer.subarray(end + width);
			yield line;
			if (socket.destroyed) return;
		}
	}
	if (buffer.length > 0) yield buffer.toString(encoding);
}
