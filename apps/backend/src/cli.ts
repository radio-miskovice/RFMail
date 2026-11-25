#!/usr/bin/env node
// Administrative CLI: account management and RFC 822 import.
//
// The web UI is the primary surface; this exists for the first account on a
// headless box, for password resets, and for loading mail into the store.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  createLogger,
  defaultConfigPath,
  ensureSecret,
  loadConfig,
} from '@rfmail/server';
import { parseRfc822, generateMid } from '@rfmail/core-b2f';
import { FLAG_UNREAD } from '@rfmail/shared';
import { SqliteStore, hashPassword } from '@rfmail/store';

const USAGE = `rfmail - Winlink radio mail server

usage:
  rfmail info
  rfmail user list [CALLSIGN]
  rfmail user add <callsign> [--admin] [--password PW]
  rfmail user passwd <callsign> [--password PW]   (omit --password to clear)
  rfmail import <file.eml> --user <callsign> [--folder INBOX]

global options:
  --config PATH   configuration file (default: ${defaultConfigPath()})
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string' },
      user: { type: 'string' },
      folder: { type: 'string', default: 'INBOX' },
      password: { type: 'string' },
      admin: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return;
  }

  const logger = createLogger('warn', (line) => process.stderr.write(`${line}\n`));
  const loaded = loadConfig(values.config ?? process.env['RFMAIL_CONFIG'] ?? defaultConfigPath());
  const config = ensureSecret(loaded.config, loaded.path);
  const store = new SqliteStore({ path: config.database.path });
  await store.migrate();

  try {
    const [group, action, ...rest] = positionals;

    if (group === 'info') {
      const users = await store.countUsers();
      process.stdout.write(
        [
          `config:   ${loaded.path}`,
          `database: ${config.database.path}`,
          `access:   ${config.mail.access}`,
          `pop3:     ${config.mail.pop3 || 'disabled'}`,
          `accounts: ${users}`,
        ].join('\n') + '\n',
      );
      return;
    }

    if (group === 'user' && action === 'list') {
      const login = rest[0];
      if (login) {
        const user = await store.findUserByLogin(login);
        if (!user) throw new Error(`no such account: ${login}`);
        process.stdout.write(formatUser(user) + '\n');
        return;
      }
      // There is no listUsers yet; enumerate through the database file's own
      // users by name is not possible, so this stays a per-account view plus a
      // count. account enumeration from the API is deliberately absent.
      process.stdout.write(`${await store.countUsers()} account(s)\n`);
      return;
    }

    if (group === 'user' && action === 'add') {
      // The callsign is the account and the login (decision 25).
      const callsign = (rest[0] ?? '').trim().toUpperCase();
      if (!callsign) throw new Error('user add needs a callsign');
      if (await store.findUserByCallsign(callsign)) throw new Error(`account already exists: ${callsign}`);
      const password = values.password ?? (await promptPassword());
      const user = await store.createUser({
        callsign,
        pwHash: password ? hashPassword(password) : null,
        role: values.admin ? 'admin' : 'user',
      });
      process.stdout.write(`created ${user.login} (${user.role})${password ? '' : ' with no password'}\n`);
      return;
    }

    if (group === 'user' && action === 'passwd') {
      const login = rest[0];
      if (!login) throw new Error('user passwd needs a callsign');
      const user = await store.findUserByLogin(login);
      if (!user) throw new Error(`no such account: ${login}`);
      const password = values.password ?? '';
      await store.setUserPassword(user.id, password ? hashPassword(password) : null);
      process.stdout.write(password ? `password updated for ${login}\n` : `password cleared for ${login}\n`);
      return;
    }

    if (group === 'import') {
      const file = action;
      const login = values.user;
      if (!file || !login) throw new Error('import needs <file.eml> --user <login>');
      const user = await store.findUserByLogin(login);
      if (!user) throw new Error(`no such account: ${login}`);
      const folder = await store.findFolder(user.id, values.folder ?? 'INBOX');
      if (!folder) throw new Error(`no such folder: ${values.folder}`);
      const raw = readFileSync(file);
      const message = parseRfc822(raw, { mid: generateMid(user.callsign ?? user.login) });
      const inserted = await store.insertMessage(user.id, folder.id, message, {
        direction: 'in',
        flags: FLAG_UNREAD,
      });
      process.stdout.write(
        `imported ${file} into ${folder.name} as id ${inserted.id} (${message.subject || 'no subject'})\n`,
      );
      return;
    }

    process.stdout.write(USAGE);
    process.exitCode = 1;
  } finally {
    await store.close();
    void logger;
  }
}

function formatUser(user: {
  id: number;
  login: string;
  role: string;
  enabled: boolean;
  callsign: string | null;
  pwHash: string | null;
}): string {
  // The login is the callsign, so it is named once.
  return [
    `id:        ${user.id}`,
    `callsign:  ${user.callsign ?? user.login}`,
    `role:      ${user.role}`,
    `enabled:   ${user.enabled}`,
    `password:  ${user.pwHash ? 'set' : 'none'}`,
  ].join('\n');
}

async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('password (empty for none): ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`rfmail: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
