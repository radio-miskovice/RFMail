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
  transceiverConfigOf,
  createLogger,
  defaultConfigPath,
  ensureSecret,
  loadConfig,
  parseAddress,
  openSecret,
  PostOffice,
} from '@rfmail/server';
import { MailEvents, MailInterfaces, PeerPolicy, type MailInterfaceAddress, type MailInterfaceName } from '@rfmail/mailservers';
import { TransceiverLinks, setRigTrace } from '@rfmail/rig';
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
  let boundHttp = '';
  const events = new MailEvents();
  const links = new TransceiverLinks();

  // `RFMAIL_RIG_TRACE=1` logs every line the station sends to rigctld. A setting that moved on
  // the radio can then be traced to a command the station sent — or to the absence of one,
  // which is the answer when a daemon or another program is driving the rig.
  if (process.env['RFMAIL_RIG_TRACE']) {
    setRigTrace((line) => logger.info('rig command', { line }));
    logger.info('rig trace on', { note: 'every command sent to rigctld is logged' });
  }

  // POP3, SMTP and IMAP as one switchable door (mailservers/interfaces.ts). The
  // configuration decides which addresses exist; the switches decide what is listening.
  const mailSpecs: Partial<Record<MailInterfaceName, MailInterfaceAddress>> = {};
  for (const [name, value] of [
    ['pop3', config.mail.pop3],
    ['smtp', config.mail.smtp],
    ['imap', config.mail.imap],
  ] as const) {
    const parsed = parseAddress(value);
    if (parsed) mailSpecs[name] = parsed;
  }
  const mailInterfaces = new MailInterfaces({ store, policy, events, logger, specs: mailSpecs });

  try {
    // The interfaces serve mail programs, so they belong to the post office (decision 31).
    // A station used as a Winlink client listens on none of them. A protocol that cannot
    // bind is reported in the UI and logged either way; it does not stop the station,
    // because the screen that shows the fault has to be up.
    const postOfficeOwner = await store.findPostOfficeOwner();
    const mailState = postOfficeOwner ? await mailInterfaces.startAll() : mailInterfaces.status();
    if (!postOfficeOwner) logger.info('mail interfaces stay down: this station is a Winlink client');

    // The answering half of the B2F exchange: armed and disarmed from the API,
    // never started by itself (decision 26).
    const postOffice = new PostOffice({
      store,
      logger,
      openSecret: (blob) => openSecret(blob, config.server.storeKey),
    });

    const api = createApi({
      store,
      sessions,
      policy,
      logger,
      events,
      uiDir,
      httpListen: `${address.host}:${address.port}`,
      storeKey: config.server.storeKey,
      links,
      postOffice,
      // The catalogue cache sits beside the database, so a restart does not have to
      // ask Winlink again before the session screen can be filled.
      cacheDir: dirname(resolve(config.database.path)),
      mailInterfaces,
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

    // The radio interface is the station's, not a screen's: dial at start-up, keep it
    // dialled, retry a failed link after a pause (decision 37). A screen only reads it.
    let radioPolling = false;
    const pollRadio = (): Promise<void> =>
      store
        .listTransceivers()
        .then((rows) => links.keepAlive(rows.filter((row) => row.enabled).map(transceiverConfigOf)));
    const radioLoop: ReturnType<typeof setInterval> = setInterval(() => {
      if (radioPolling) return;
      radioPolling = true;
      void pollRadio()
        .catch((err: unknown) =>
          logger.warn('radio link poll failed', { error: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => {
          radioPolling = false;
        });
    }, 5000);
    // The interval must not be a reason for the process to stay alive.
    (radioLoop as unknown as { unref?: () => void }).unref?.();
    void pollRadio().catch(() => undefined);
    logger.info('rfmail started', {
      version: APP_VERSION,
      http: `${scheme}://${boundHttp}`,
      config: loaded.path,
      database: config.database.path,
      access: policy.describe(),
      mail: mailState.map((entry) => ({
        interface: entry.name,
        address: entry.address,
        running: entry.running,
        error: entry.error,
      })),
      accounts: users,
    });
    process.stdout.write(
      [
        '',
        `rfmail ${APP_VERSION}`,
        `  web UI   ${scheme}://${boundHttp}`,
        `  config   ${loaded.path}`,
        `  database ${config.database.path}`,
        `  mail     ${mailState
          .map((entry) => `${entry.name.toUpperCase()} ${entry.running ? (entry.address ?? '') : 'off'}`)
          .join('  ')}`,
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
      await mailInterfaces.closeAll();
      links.closeAll();
      clearInterval(radioLoop);
      await store.close();
      clearTimeout(force);
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (err) {
    await mailInterfaces.closeAll();
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
