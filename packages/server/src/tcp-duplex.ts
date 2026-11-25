// A session's byte stream over a TCP socket.
//
// Two things use this: the modem's data port after a call is up, and a telnet
// connection to the CMS. A plain socket has no flush — bytes handed to the kernel
// are not bytes on the air — so `flush` resolves at once and the transport that
// does know (ARDOP's `flush` command) has to say so itself.

import type { Socket } from 'node:net';
import type { Duplex } from '@rfmail/core-b2f';

export function tcpDuplex(socket: Socket): Duplex {
  const chunks: Buffer[] = [];
  let ended = false;
  let failure: Error | null = null;
  let waiter: { resolve: (chunk: Uint8Array) => void; reject: (error: Error) => void } | null = null;

  const settle = (): void => {
    if (!waiter) return;
    if (chunks.length > 0) {
      const chunk = chunks.shift() as Buffer;
      const { resolve } = waiter;
      waiter = null;
      resolve(new Uint8Array(chunk));
      return;
    }
    if (failure) {
      const { reject } = waiter;
      waiter = null;
      reject(failure);
    }
  };

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    settle();
  });
  socket.on('end', () => {
    ended = true;
    if (!failure) failure = new Error('the peer closed the connection');
    settle();
  });
  socket.on('close', () => {
    ended = true;
    if (!failure) failure = new Error('the connection was closed');
    settle();
  });
  socket.on('error', (error: Error) => {
    failure = error;
    settle();
  });

  return {
    write(chunk: Uint8Array): void {
      if (socket.destroyed) throw new Error('the connection is closed');
      socket.write(Buffer.from(chunk));
    },
    async flush(): Promise<void> {
      // Nothing to wait on for a socket; the modem's own buffer is the next hop.
    },
    async close(): Promise<void> {
      if (!socket.destroyed) socket.destroy();
      ended = true;
    },
    read(): Promise<Uint8Array> {
      return new Promise<Uint8Array>((resolve, reject) => {
        if (chunks.length > 0) {
          const chunk = chunks.shift() as Buffer;
          resolve(new Uint8Array(chunk));
          return;
        }
        if (ended || failure) {
          reject(failure ?? new Error('the connection is closed'));
          return;
        }
        waiter = { resolve, reject };
      });
    },
  };
}
