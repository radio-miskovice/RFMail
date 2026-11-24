#!/usr/bin/env node
// rfmail backend entry point.
//
// Starts the HTTP API + web UI, the mail access servers configured in the file,
// and the store. First start writes a default config with a generated secret.

import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  APP_VERSION,
  HttpError,
  Sessions,
  createApi,
  createLogger,
  defaultConfigPath,
  ensureSecret,
  loadConfig,
  parseAddress,
} from '@rfmail/server';
import { ImapServer, MailEvents, PeerPolicy, Pop3Server, SmtpServer } from '@rfmail/mailservers';
import { TransceiverLinks } from '@rfmail/rig';
import { SqliteStore } from '@rfmail/store';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_UI_DIR = resolve(join(HERE, '../../../apps/web/build'));

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
    (values.log === 'debug' || values.log === 'warn' || values.log === 'error' ? values.log : 'info'),
  );

  const configPath = values.config ?? process.env['RFMAIL_CONFIG'] ?? defaultConfigPath();
  const loaded = loadConfig(configPath);
  const config = ensureSecret(loaded.config, loaded.path);
  if (loaded.created) logger.info('wrote default configuration', { path: loaded.path });

  // --listen names a full host:port (0.0.0.0:8080 for the LAN); --port only
  // moves the port and keeps loopback, which is what a headless test wants.
  const listenSpec = values.listen ?? (values.port ? `127.0.0.1:${values.port}` : config.server.listen);
  const address = parseAddress(listenSpec);
  if (!address) throw new Error(`invalid listen address: ${listenSpec}`);

  const store = new SqliteStore({ path: config.database.path });
  await store.migrate();

  const policy = new PeerPolicy(config.mail.access, config.mail.cidrs);
  const sessions = new Sessions(config.server.secret);
  const uiDir = config.server.uiDir || DEFAULT_UI_DIR;

  let httpServer: Server | null = null;
  let pop3: Pop3Server | null = null;
  let smtp: SmtpServer | null = null;
  let imap: ImapServer | null = null;
  let boundHttp = '';
  let boundPop3: string | null = null;
  let boundSmtp: string | null = null;
  let boundImap: string | null = null;
  const events = new MailEvents();
  const links = new TransceiverLinks();

  try {
    const pop3Address = parseAddress(config.mail.pop3);
    if (pop3Address) {
      pop3 = new Pop3Server({
        store,
        policy,
        host: pop3Address.host,
        port: pop3Address.port,
        logger,
      });
      await pop3.listen();
      boundPop3 = pop3.address;
    }

    const smtpAddress = parseAddress(config.mail.smtp);
    if (smtpAddress) {
      smtp = new SmtpServer({
        store,
        policy,
        events,
        host: smtpAddress.host,
        port: smtpAddress.port,
        logger,
      });
      await smtp.listen();
      boundSmtp = smtp.address;
    }

    const imapAddress = parseAddress(config.mail.imap);
    if (imapAddress) {
      imap = new ImapServer({
        store,
        policy,
        events,
        host: imapAddress.host,
        port: imapAddress.port,
        logger,
      });
      await imap.listen();
      boundImap = imap.address;
    }

    const api = createApi({
      store,
      sessions,
      policy,
      logger,
      events,
      uiDir,
      accessMode: policy.describe(),
      storeKey: config.server.storeKey,
      links,
      // The catalogue cache sits beside the database, so a restart does not have to
      // ask Winlink again before the session screen can be filled.
      cacheDir: dirname(resolve(config.database.path)),
      pop3Address: boundPop3,
      smtpAddress: boundSmtp,
      imapAddress: boundImap,
      secureCookies: config.server.tls === 'files',
    });

    if (config.server.tls === 'files') {
      if (!config.server.cert || !config.server.key) {
        throw new Error('tls = "files" needs cert and key in [server]');
      }
      httpServer = createHttpsServer(
        {
          cert: readFileSync(config.server.cert),
          key: readFileSync(config.server.key),
        },
        (req, res) => void api.handle(req, res),
      );
    } else {
      httpServer = createHttpServer((req, res) => void api.handle(req, res));
    }

    await new Promise<void>((resolveReady, reject) => {
      const server = httpServer;
      if (!server) {
        reject(new Error('http server was not created'));
        return;
      }
      server.once('error', reject);
      server.listen(address.port, address.host, () => {
        server.off('error', reject);
        resolveReady();
      });
    });

    const actual = httpServer.address();
    boundHttp = typeof actual === 'object' && actual ? `${actual.address}:${actual.port}` : config.server.listen;

    const users = await store.countUsers();
    const scheme = config.server.tls === 'files' ? 'https' : 'http';
    logger.info('rfmail started', {
      version: APP_VERSION,
      http: `${scheme}://${boundHttp}`,
      config: loaded.path,
      database: config.database.path,
      access: policy.describe(),
      pop3: boundPop3 ?? 'disabled',
      smtp: boundSmtp ?? 'disabled',
      imap: boundImap ?? 'disabled',
      accounts: users,
    });
    process.stdout.write(
      [
        '',
        `rfmail ${APP_VERSION}`,
        `  web UI   ${scheme}://${boundHttp}`,
        `  config   ${loaded.path}`,
        `  database ${config.database.path}`,
        `  mail     ${[
          boundPop3 ? `POP3 ${boundPop3}` : 'POP3 off',
          boundSmtp ? `SMTP ${boundSmtp}` : 'SMTP off',
          boundImap ? `IMAP ${boundImap}` : 'IMAP off'
        ].join('  ')}`,
        `  access   ${policy.describe()}`,
        users === 0
          ? '  first run: open the web UI and create the account'
          : `  ${users} account(s)`,
        '',
      ].join('\n'),
    );

    if (config.server.listen.startsWith('0.0.0.0') && policy.mode === 'very strict') {
      logger.warn('listener bound to all interfaces but access mode is "very strict"', {
        note: 'remote peers will be refused; bind 127.0.0.1 or use "strict" with CIDRs',
      });
    }

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('shutting down', { signal });
      // A keep-alive client must not be able to hold the process open.
      const force = setTimeout(() => {
        logger.warn('shutdown timed out, exiting');
        process.exit(0);
      }, 4000);
      force.unref();
      const server = httpServer;
      if (server) {
        server.closeAllConnections?.();
        await new Promise<void>((done) => server.close(() => done()));
      }
      if (pop3) await pop3.close();
      if (smtp) await smtp.close();
      if (imap) await imap.close();
      await store.close();
      clearTimeout(force);
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (err) {
    if (pop3) await pop3.close();
    if (smtp) await smtp.close();
    if (imap) await imap.close();
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
