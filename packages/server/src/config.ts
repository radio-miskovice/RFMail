// Configuration: one TOML file, created with defaults on first start.
//
// Secrets live here (mode 0600), users live in the database. Relative paths in
// the file are resolved against the directory containing the file itself, so a
// whole installation can be moved as a folder.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'smol-toml';
import type { AccessMode } from '@rfmail/mailservers';
import { defaultDataDir } from './platform.ts';

export interface ServerConfig {
  listen: string;
  /** Session signing key. Rotating it signs everybody out. */
  secret: string;
  /** Key that seals stored credentials (Winlink passwords) at rest. Rotating
   *  it makes them unreadable, so they have to be entered again. */
  storeKey: string;
  tls: 'off' | 'files';
  cert: string;
  key: string;
  uiDir: string;
}

export interface MailConfig {
  access: AccessMode;
  cidrs: string[];
  /** "host:port", or empty to disable. */
  pop3: string;
  smtp: string;
  imap: string;
}

export interface DatabaseConfig {
  driver: 'sqlite';
  path: string;
}

export interface Config {
  server: ServerConfig;
  mail: MailConfig;
  database: DatabaseConfig;
}

export interface LoadedConfig {
  config: Config;
  path: string;
  /** True when the file did not exist and defaults were written. */
  created: boolean;
}

const DEFAULT_ACCESS: AccessMode = 'very strict';

function template(secret: string, storeKey: string, databasePath: string): string {
  return `# rfmail configuration
#
# Secrets live in this file (keep it mode 0600); user accounts live in the
# database. Relative paths resolve against this file's directory.

[server]
# HTTP listener for the API and the web UI.
listen = "127.0.0.1:8080"
# Session signing secret, generated on first start. Changing it logs everybody out.
secret = "${secret}"
# Key that seals the Winlink passwords at rest, generated on first start.
# Changing it makes the stored Winlink passwords unreadable: enter them again.
store_key = "${storeKey}"
# "off" or "files" (TLS for the web UI; POP3/SMTP/IMAP follow the same pattern later).
tls = "off"
cert = ""
key = ""
# Directory holding the built web UI. Empty means the copy shipped with rfmail.
ui_dir = ""

[mail]
# "very strict" accepts only loopback peers; "strict" accepts the CIDRs listed below.
access = "${DEFAULT_ACCESS}"
cidrs = []
# Ports below 1024 need privileges (setcap or root). Defaults stay unprivileged.
pop3 = "127.0.0.1:1110"
smtp = ""
imap = ""

[database]
driver = "sqlite"
path = "${databasePath}"
`;
}

export function defaultSecret(): string {
  return randomBytes(32).toString('hex');
}

/** Creates the file (and its directory) if missing, then loads it. */
export function loadConfig(path: string): LoadedConfig {
  const absolute = resolve(path);
  let created = false;
  if (!existsSync(absolute)) {
    const dataDir = defaultDataDir();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, template(defaultSecret(), randomBytes(32).toString('base64'), join(dataDir, 'rfmail.db')), { mode: 0o600 });
    created = true;
  }

  const text = readFileSync(absolute, 'utf8');
  const parsed = parse(text) as Record<string, unknown>;
  const config = normalise(parsed, dirname(absolute));
  return { config, path: absolute, created };
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

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function resolvePath(value: string, base: string): string {
  if (!value) return '';
  return isAbsolute(value) ? value : resolve(base, value);
}

function normalise(raw: Record<string, unknown>, baseDir: string): Config {
  const server = section(raw, 'server');
  const mail = section(raw, 'mail');
  const database = section(raw, 'database');

  const accessRaw = str(mail['access'], DEFAULT_ACCESS).toLowerCase();
  const access: AccessMode =
    accessRaw === 'strict' ? 'strict' : accessRaw === 'very strict' ? 'very strict' : (() => {
      throw new Error(`invalid [mail] access mode: ${accessRaw}`);
    })();

  const cidrsRaw = mail['cidrs'];
  const cidrs = Array.isArray(cidrsRaw)
    ? cidrsRaw.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const tlsRaw = str(server['tls'], 'off').toLowerCase();
  const tls: 'off' | 'files' = tlsRaw === 'files' ? 'files' : 'off';

  return {
    server: {
      listen: str(server['listen'], '127.0.0.1:8080'),
      secret: str(server['secret'], ''),
      storeKey: str(server['store_key'], ''),
      tls,
      cert: resolvePath(str(server['cert'], ''), baseDir),
      key: resolvePath(str(server['key'], ''), baseDir),
      uiDir: resolvePath(str(server['ui_dir'], ''), baseDir),
    },
    mail: {
      access,
      cidrs,
      pop3: str(mail['pop3'], ''),
      smtp: str(mail['smtp'], ''),
      imap: str(mail['imap'], ''),
    },
    database: {
      driver: 'sqlite',
      path: resolvePath(str(database['path'], 'rfmail.db'), baseDir),
    },
  };
}

export interface Address {
  host: string;
  port: number;
}

/** Parses "host:port", "[::1]:110" or "0.0.0.0:8080". Empty or "off" means disabled. */
export function parseAddress(value: string): Address | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'off') return null;
  const ipv6 = /^\[(.+)\]:(\d+)$/.exec(trimmed);
  if (ipv6) {
    return { host: ipv6[1] ?? '::', port: Number(ipv6[2]) };
  }
  const index = trimmed.lastIndexOf(':');
  if (index === -1) {
    throw new Error(`address needs host:port, got ${value}`);
  }
  const host = trimmed.slice(0, index);
  const port = Number(trimmed.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port in address: ${value}`);
  }
  return { host: host || '127.0.0.1', port };
}

/**
 * Fills in the two generated keys. Both live in the same 0600 file: `secret`
 * signs session cookies, `store_key` seals Winlink passwords at rest. They are
 * separate keys so that rotating one does not invalidate the other.
 */
export function ensureSecret(config: Config, path: string): Config {
  if (config.server.secret && config.server.storeKey) return config;
  const secret = config.server.secret || defaultSecret();
  const storeKey = config.server.storeKey || randomBytes(32).toString('base64');
  const next: Config = { ...config, server: { ...config.server, secret, storeKey } };
  let text = readFileSync(path, 'utf8');
  text = text.replace(/^secret\s*=\s*".*"$/m, `secret = "${secret}"`);
  if (/^store_key\s*=.*$/m.test(text)) {
    text = text.replace(/^store_key\s*=.*$/m, `store_key = "${storeKey}"`);
  } else {
    // A file written by an older build: add the line right under the secret.
    text = text.replace(/^(secret\s*=\s*".*")$/m, `$1\nstore_key = "${storeKey}"`);
  }
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return next;
}
