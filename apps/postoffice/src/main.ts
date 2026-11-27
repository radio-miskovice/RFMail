#!/usr/bin/env node
// The post office application's entry point (decision 57).
//
// It starts three things and nothing else: the console (HTTP + built UI), the store,
// and the answering half of the B2F exchange. There is no mail-access door here — a
// post office's users collect over the radio — and no outbound session: the operator
// arms one modem and the station waits for calls.
//
// First start writes a configuration with generated keys and opens the console on
// loopback; the console's first screen asks for the station callsign and the first
// administrator, which is the only act that makes the station exist.

import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  APP_VERSION,
  HttpError,
  PostOffice,
  Sessions,
  createLogger,
  defaultPostOfficeConfigPath,
  openSecret,
  parseAddress,
  sealSecret,
} from '@rfmail/server';
import { PeerPolicy } from '@rfmail/mailservers';
import { SqliteStore } from '@rfmail/store';
import { ensurePostOfficeSecret, loadPostOfficeConfig } from './config.ts';
import { createPoApi } from './api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_UI_DIR = resolve(join(HERE, '../../postoffice-web/build'));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      listen: { type: 'string' },
      port: { type: 'string' },
      log: { type: 'string', default: 'info' },
    },
    allowPositionals: false,
  });

  const logger = createLogger(
    values.log === 'debug' || values.log === 'warn' || values.log === 'error' ? values.log : 'info',
  );

  const configPath = values.config ?? process.env['RFMAIL_POSTOFFICE_CONFIG'] ?? defaultPostOfficeConfigPath();
  const loaded = loadPostOfficeConfig(configPath);
  const config = ensurePostOfficeSecret(loaded.config, loaded.path);
  if (loaded.created) logger.info('wrote default configuration', { path: loaded.path });

  // `--listen` names a full host:port; `--port` only moves the port and keeps loopback.
  const listenSpec = values.listen ?? (values.port ? `127.0.0.1:${values.port}` : config.server.listen);
  const address = parseAddress(listenSpec);
  if (!address) throw new Error(`invalid listen address: ${listenSpec}`);

  let policy: PeerPolicy;
  try {
    policy = new PeerPolicy(config.access.mode, config.access.cidrs);
  } catch (err) {
    // A policy that cannot be expressed is a configuration the operator did not finish.
    throw new Error(err instanceof Error ? err.message : String(err));
  }

  const store = new SqliteStore({ path: config.database.path, postOffice: true });
  await store.migrate();
  const sessions = new Sessions(config.server.secret);
  const uiDir = config.server.uiDir || DEFAULT_UI_DIR;
  const storeKey = config.server.storeKey;

  // The call log is written from the session's own ending, so a call is recorded once
  // and survives a restart of the console (decision 66).
  const postOffice = new PostOffice({
    store,
    logger,
    openSecret: (blob) => openSecret(blob, storeKey),
    onCall: (session) => {
      const startedAt = Date.parse(session.startedAt);
      void store
        .recordCall({
          peer: session.peer,
          startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
          elapsedMs: session.elapsedMs,
          result: session.result === 'complete' || session.result === 'aborted' ? session.result : 'failed',
          sent: session.sent,
          received: session.received,
          reason: session.reason,
        })
        .catch((err: unknown) =>
          logger.warn('call log write failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    },
  });

  const api = createPoApi({
    store,
    sessions,
    policy,
    logger,
    storeKey,
    postOffice,
    uiDir,
    secureCookies: config.server.tls === 'files',
    appVersion: APP_VERSION,
    seal: (plaintext) => sealSecret(plaintext, storeKey),
  });

  let httpServer: Server | null = null;
  try {
    if (config.server.tls === 'files') {
      if (!config.server.cert || !config.server.key) {
        throw new Error('tls = "files" needs cert and key in [server]');
      }
      httpServer = createHttpsServer(
        { cert: readFileSync(config.server.cert), key: readFileSync(config.server.key) },
        (req, res) => void api.handle(req, res),
      );
    } else {
      httpServer = createHttpServer((req, res) => void api.handle(req, res));
    }

    await new Promise<void>((ready, fail) => {
      const server = httpServer;
      if (!server) {
        fail(new Error('http server was not created'));
        return;
      }
      server.once('error', fail);
      server.listen(address.port, address.host, () => {
        server.off('error', fail);
        ready();
      });
    });

    const actual = httpServer.address();
    const bound = typeof actual === 'object' && actual ? `${actual.address}:${actual.port}` : listenSpec;
    const scheme = config.server.tls === 'files' ? 'https' : 'http';
    const admins = await store.countAdministrators();
    const station = await store.findPostOfficeOwner();

    logger.info('post office started', {
      version: APP_VERSION,
      http: `${scheme}://${bound}`,
      config: loaded.path,
      database: config.database.path,
      access: policy.describe(),
      callsign: station?.callsign ?? null,
      administrators: admins,
    });
    process.stdout.write(
      [
        '',
        `rfmail post office ${APP_VERSION}`,
        `  console  ${scheme}://${bound}`,
        `  config   ${loaded.path}`,
        `  database ${config.database.path}`,
        `  station  ${station?.callsign ?? '(not configured yet)'}`,
        `  access   ${policy.describe()}`,
        admins === 0 ? '  first run: open the console and name the station and its administrator' : '',
        '',
      ]
        .filter((line) => line !== '')
        .join('\n') + '\n',
    );

    if (config.server.listen.startsWith('0.0.0.0') && policy.mode === 'very strict') {
      logger.warn('console bound to all interfaces but access mode is "very strict"', {
        note: 'remote peers will be refused; bind 127.0.0.1 or use "strict" with CIDRs',
      });
    }

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('shutting down', { signal });
      const force = setTimeout(() => {
        logger.warn('shutdown timed out, exiting');
        process.exit(0);
      }, 6000);
      force.unref();
      // A station left listening is a station left answering: disarm first, which also
      // tells the modem to stop and waits for the link to come down.
      await postOffice.disarm().catch(() => undefined);
      const server = httpServer;
      if (server) {
        server.closeAllConnections?.();
        await new Promise<void>((done) => server.close(() => done()));
      }
      await store.close();
      clearTimeout(force);
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (err) {
    await postOffice.disarm().catch(() => undefined);
    await store.close();
    if (err instanceof HttpError) {
      logger.error('startup failed', { error: err.message, status: err.status });
    } else {
      logger.error('startup failed', { error: err instanceof Error ? err.message : String(err) });
    }
    process.exitCode = 1;
  }
}

void main();
