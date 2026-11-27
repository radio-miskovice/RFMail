// The post office installation's configuration: one TOML file, created with
// defaults on first start (decision 57).
//
// It is deliberately a different file, in a different directory, from the client
// station's `rfmail.toml`. The two applications may run on one machine and must
// never share a database: one holds a person's mailbox, the other holds other
// people's mailboxes and the station's administrators.
//
// The file decides what exists — the listener, the TLS material, the paths and the
// access policy. Everything the station *has* (its callsign, its mailboxes, its
// modems) lives in the database, so the file can stay a small thing an operator
// reads and edits by hand.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'smol-toml';
import { defaultPostOfficeDataDir, defaultSecret } from '@rfmail/server';
import type { AccessMode } from '@rfmail/mailservers';

export interface PostOfficeServerConfig {
  listen: string;
  /** Session signing key. Rotating it signs every administrator out. */
  secret: string;
  /** Key that seals the mailboxes' post-office passwords at rest. */
  storeKey: string;
  tls: 'off' | 'files';
  cert: string;
  key: string;
  /** The built console; empty means the copy shipped with the application. */
  uiDir: string;
}

export interface PostOfficeAccessConfig {
  mode: AccessMode;
  cidrs: string[];
}

export interface PostOfficeConfig {
  server: PostOfficeServerConfig;
  access: PostOfficeAccessConfig;
  database: { driver: 'sqlite'; path: string };
}

export interface LoadedPostOfficeConfig {
  config: PostOfficeConfig;
  path: string;
  /** True when the file did not exist and defaults were written. */
  created: boolean;
}

const DEFAULT_LISTEN = '127.0.0.1:8090';
const DEFAULT_ACCESS: AccessMode = 'very strict';

function template(databasePath: string): string {
  return `# rfmail post office configuration
#
# Secrets live in this file (keep it mode 0600). Mailboxes, administrators and the
# station's callsign live in the database. Relative paths resolve against this
# file's directory.

[server]
# The console's listener. The post office has no other door: mail arrives over the
# radio, and mailboxes themselves never sign in to a browser.
listen = "${DEFAULT_LISTEN}"
# Session signing secret, generated on first start. Changing it signs everybody out.
secret = "${defaultSecret()}"
# Key that seals the mailboxes' post-office passwords at rest, generated on first
# start. Changing it makes those passwords unreadable: set them again.
store_key = "${randomBytes(32).toString('base64')}"
# "off" or "files" (TLS for the console).
tls = "off"
cert = ""
key = ""
# Directory holding the built console. Empty means the copy shipped with the app.
ui_dir = ""

[access]
# Who may reach the console at all. "very strict" is loopback only; "strict" also
# admits the CIDRs below. This policy is enforced on every accepted connection.
mode = "${DEFAULT_ACCESS}"
cidrs = []

[database]
driver = "sqlite"
path = "${databasePath}"
`;
}

/** Creates the file (and its directory) if missing, then loads it. */
export function loadPostOfficeConfig(path: string): LoadedPostOfficeConfig {
  const absolute = resolve(path);
  let created = false;
  if (!existsSync(absolute)) {
    const dataDir = defaultPostOfficeDataDir();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, template(resolve(dataDir, 'postoffice.db')), { mode: 0o600 });
    created = true;
  }

  const text = readFileSync(absolute, 'utf8');
  const parsed = parse(text) as Record<string, unknown>;
  return { config: normalise(parsed, dirname(absolute)), path: absolute, created };
}

function section(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = raw[name];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function resolvePath(value: string, base: string): string {
  if (!value) return '';
  return isAbsolute(value) ? value : resolve(base, value);
}

function normalise(raw: Record<string, unknown>, baseDir: string): PostOfficeConfig {
  const server = section(raw, 'server');
  const accessSection = section(raw, 'access');
  const database = section(raw, 'database');

  const accessRaw = str(accessSection['mode'], DEFAULT_ACCESS).trim().toLowerCase();
  if (accessRaw !== 'strict' && accessRaw !== 'very strict') {
    throw new Error(`invalid [access] mode: ${accessRaw}`);
  }
  const cidrsRaw = accessSection['cidrs'];
  const cidrs = Array.isArray(cidrsRaw)
    ? cidrsRaw.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const tlsRaw = str(server['tls'], 'off').toLowerCase();
  if (tlsRaw !== 'off' && tlsRaw !== 'files') {
    throw new Error(`invalid [server] tls: ${tlsRaw}`);
  }

  return {
    server: {
      listen: str(server['listen'], DEFAULT_LISTEN),
      secret: str(server['secret'], ''),
      storeKey: str(server['store_key'], ''),
      tls: tlsRaw,
      cert: resolvePath(str(server['cert'], ''), baseDir),
      key: resolvePath(str(server['key'], ''), baseDir),
      uiDir: resolvePath(str(server['ui_dir'], ''), baseDir),
    },
    access: { mode: accessRaw, cidrs },
    database: {
      driver: 'sqlite',
      path: resolvePath(str(database['path'], 'postoffice.db'), baseDir),
    },
  };
}

/**
 * Fills in the two generated keys. Both live in the same 0600 file: `secret` signs
 * the console's session cookies, `store_key` seals the mailboxes' post-office
 * passwords. They are separate so that rotating one does not destroy the other.
 */
export function ensurePostOfficeSecret(config: PostOfficeConfig, path: string): PostOfficeConfig {
  if (config.server.secret && config.server.storeKey) return config;
  const secret = config.server.secret || defaultSecret();
  const storeKey = config.server.storeKey || randomBytes(32).toString('base64');
  const next: PostOfficeConfig = { ...config, server: { ...config.server, secret, storeKey } };
  let text = readFileSync(path, 'utf8');
  text = text.replace(/^secret\s*=\s*".*"$/m, `secret = "${secret}"`);
  if (/^store_key\s*=.*$/m.test(text)) {
    text = text.replace(/^store_key\s*=.*$/m, `store_key = "${storeKey}"`);
  } else {
    text = text.replace(/^(secret\s*=\s*".*")$/m, `$1\nstore_key = "${storeKey}"`);
  }
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return next;
}
