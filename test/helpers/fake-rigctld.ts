// A rigctld that answers the commands this station sends, plus a way to misbehave.
//
// Shared by the rig client's own tests and by anything that drives a link — the post
// office's arm path included, which tunes a radio before it keys a modem.

import { createServer, type Server, type Socket } from 'node:net';

/** A rigctld that answers the commands this client sends, plus a way to misbehave. */
export async function fakeRigctld(options: {
	behaviour?: 'normal' | 'error' | 'drop-once' | 'silent' | 'no-rear-ptt' | 'no-power';
	/** The two digits the rig answers `SH;` and `SL;` with. */
	ifShift?: string;
	filter?: string;
} = {}): Promise<{
	port: number;
	received: string[];
	close: () => Promise<void>;
}> {
	const received: string[] = [];
	let dropped = false;
	const sockets = new Set<Socket>();
	let frequency = 7_040_000;
	let mode = 'USB';
	let passband = 2700;
	let ptt = false;
	let power = 0.35;

	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		let buffer = '';
		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1');
			let index = buffer.indexOf('\n');
			while (index !== -1) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				received.push(line);

				if (options.behaviour === 'silent') {
					index = buffer.indexOf('\n');
					continue;
				}
				if (options.behaviour === 'drop-once' && !dropped) {
					dropped = true;
					sockets.delete(socket);
					socket.destroy();
					index = buffer.indexOf('\n');
					continue;
				}
				if (options.behaviour === 'error' && line.startsWith('\\set_freq')) {
					socket.write('RPRT -8\n');
					index = buffer.indexOf('\n');
					continue;
				}

				if (line.startsWith('+')) {
					// The extended protocol: echo, labelled values, terminating RPRT.
					const cmd = line.slice(1);
					if (cmd === '\\get_freq') socket.write(`get_freq:\nFrequency: ${frequency}\nRPRT 0\n`);
					else if (cmd === '\\get_mode') socket.write(`get_mode:\nMode: ${mode}\nPassband: ${passband}\nRPRT 0\n`);
					else if (cmd === '\\get_ptt') socket.write(`get_ptt:\nPTT: ${ptt ? 1 : 0}\nRPRT 0\n`);
					else if (cmd === '\\get_split_vfo')
						socket.write('get_split_vfo:\nSplit: 0\nTX VFO: VFOA\nRPRT 0\n');
					else if (cmd === '\\dump_caps')
						socket.write(
							[
								'dump_caps:',
								'Caps dump for model: 2031',
								'Model name:	TS-590S',
								'Mfg name:	Kenwood',
								'Port type:	RS-232',
								'Serial speed:	4800..115200 baud, 8N1, ctrl=CTS/RTS',
								'Hamlib version:	Hamlib 4.6.3',
								'RPRT 0',
							].join('\n') + '\n',
						);
					else if (cmd === '\\get_level RFPOWER')
						socket.write(
							options.behaviour === 'no-power'
								? 'get_level: RFPOWER\nRPRT -11\n'
								: `get_level: RFPOWER\n${power}\nRPRT 0\n`,
						);
					else socket.write('RPRT -11\n');
					index = buffer.indexOf('\n');
					continue;
				}
				if (line === '\\get_rig_info')
					socket.write(
						[
							`VFO=VFOA Freq=${frequency} Mode=${mode} Width=${passband} RX=1 TX=1`,
							'VFO=VFOB Freq=0 Mode=None Width=0 RX=0 TX=0',
							'Split=0 SatMode=0',
							'Rig=TS-590S',
							'App=Hamlib',
							'Version=20241103 1.1.0',
							'Model=2031',
							'CRC=0x269e8082',
							'',
						].join('\n') + '\n',
					);
				else if (line === '\\get_freq') socket.write(`${frequency}\n`);
				else if (line.startsWith('\\set_freq')) {
					frequency = Number(line.split(' ')[1]);
					socket.write('RPRT 0\n');
				} else if (line === '\\get_mode') socket.write(`${mode}\n${passband}\n`);
				else if (line.startsWith('\\set_mode')) {
					const parts = line.split(/\s+/);
					mode = parts[1] ?? mode;
					// -1 is RIG_PASSBAND_NOCHANGE: the rig keeps the filter it had.
					const asked = Number(parts[2] ?? passband);
					if (asked >= 0) passband = asked;
					socket.write('RPRT 0\n');
				} else if (line.startsWith('\\set_level RFPOWER')) {
					power = Number(line.split(/\s+/)[2] ?? power);
					socket.write('RPRT 0\n');
				} else if (line.startsWith('\\set_ptt')) {
					if (options.behaviour === 'no-rear-ptt' && line.endsWith('3')) {
						socket.write('RPRT -8\n');
					} else {
						ptt = !line.endsWith('0');
						socket.write('RPRT 0\n');
					}
				} else if (line === '\\get_ptt') socket.write(`${ptt ? 1 : 0}\n`);
				else if (line === 'w SH;') socket.write(`SH${options.ifShift ?? '05'};\0`);
				else if (line === 'w SL;') socket.write(`SL${options.filter ?? '13'};\0`);
				else if (line === '\\chk_vfo') socket.write('CHKVFO 1\n');
				else socket.write('RPRT -11\n');

				index = buffer.indexOf('\n');
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	return {
		port,
		received,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
