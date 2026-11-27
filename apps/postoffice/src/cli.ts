#!/usr/bin/env node
// The post office's command line.
//
// A postmaster starts with a list: callsigns and the post-office password each user was
// given. Typing that into a form one mailbox at a time is how a list gets mistyped, so
// the list is the input and this seals it into the store.
//
//   node apps/postoffice/src/cli.ts mailboxes --file mailboxes.yaml
//
// The file is one mailbox per line, `CALLSIGN: password`. Blank lines and lines starting
// with `#` are ignored, the split is on the first colon (a callsign cannot contain one and
// a password can), and surrounding quotes keep leading or trailing spaces.
//
//     OK1RAA: another good password
//     OK2XYZ: " leading space is preserved "
//
// It holds plaintext passwords: delete it once the mailboxes are loaded.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HttpError, defaultPostOfficeConfigPath, normaliseCallsign, sealSecret } from '@rfmail/server';
import { SqliteStore, type Store, type UserRecord } from '@rfmail/store';
import { ensurePostOfficeSecret, loadPostOfficeConfig } from './config.ts';

/** The shortest password the console accepts, and therefore this as well. */
const MIN_PASSWORD = 8;

export interface MailboxSeed {
  callsign: string;
  password: string;
  /** 1-based, for a message that names the line to fix. */
  line: number;
}

export interface SeedProblem {
  line: number;
  message: string;
}

export interface ParsedList {
  seeds: MailboxSeed[];
  problems: SeedProblem[];
}

/**
 * Reads the list. Problems are collected rather than thrown one at a time: a file with
 * three bad lines should report three, not send the operator round the loop three times.
 */
export function parseMailboxList(text: string): ParsedList {
  const seeds: MailboxSeed[] = [];
  const problems: SeedProblem[] = [];
  const seen = new Map<string, number>();

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      problems.push({ line, message: 'expected "CALLSIGN: password"' });
      return;
    }

    let callsign: string | null;
    try {
      callsign = normaliseCallsign(trimmed.slice(0, colon));
    } catch (err) {
      problems.push({ line, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!callsign) {
      problems.push({ line, message: 'a callsign is required' });
      return;
    }

    let password = trimmed.slice(colon + 1).trim();
    if (password.length >= 2) {
      const first = password[0];
      const last = password[password.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        password = password.slice(1, -1);
      }
    }
    if (password === '') {
      problems.push({ line, message: `${callsign} has no password` });
      return;
    }
    if (password.length < MIN_PASSWORD) {
      problems.push({
        line,
        message: `${callsign}'s password is shorter than ${MIN_PASSWORD} characters`,
      });
      return;
    }

    const earlier = seen.get(callsign);
    if (earlier !== undefined) {
      problems.push({ line, message: `${callsign} is already listed on line ${earlier}` });
      return;
    }
    seen.set(callsign, line);
    seeds.push({ callsign, password, line });
  });

  return { seeds, problems };
}

export interface LoadOptions {
  /** Replace a password a mailbox already has. Without it, an existing one is left alone. */
  replace?: boolean;
  /** Say what would happen and write nothing. */
  dryRun?: boolean;
}

export interface LoadedMailbox {
  callsign: string;
  outcome: 'created' | 'updated' | 'unchanged';
}

export interface LoadReport {
  mailboxes: LoadedMailbox[];
  /** Created here and left without a password, because `seal` failed for it. */
  failed: Array<{ callsign: string; reason: string }>;
}

export type Sealer = (plaintext: string) => string;

/**
 * Creates or updates the mailboxes. A mailbox is not an account: it gets no password
 * hash and could not sign in anywhere even if it had one. `seal` is the installation's
 * key, injected so the test does not need one.
 */
export async function loadMailboxes(
  store: Store,
  seeds: readonly MailboxSeed[],
  seal: Sealer,
  options: LoadOptions = {},
): Promise<LoadReport> {
  const report: LoadReport = { mailboxes: [], failed: [] };

  for (const seed of seeds) {
    const existing: UserRecord | null = await store.findUserByCallsign(seed.callsign);
    if (!existing) {
      if (options.dryRun === true) {
        report.mailboxes.push({ callsign: seed.callsign, outcome: 'created' });
        continue;
      }
      const created = await store.createUser({ callsign: seed.callsign, pwHash: null, role: 'user' });
      try {
        await store.setPostOfficeSecret(created.id, seal(seed.password));
      } catch (err) {
        // A mailbox that exists and cannot answer a challenge is a mailbox nobody can
        // collect from; say so rather than reporting it created.
        report.failed.push({
          callsign: seed.callsign,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      report.mailboxes.push({ callsign: created.callsign ?? seed.callsign, outcome: 'created' });
      continue;
    }

    if (existing.postOfficeSecret !== null && options.replace !== true) {
      report.mailboxes.push({ callsign: seed.callsign, outcome: 'unchanged' });
      continue;
    }
    if (options.dryRun === true) {
      report.mailboxes.push({ callsign: seed.callsign, outcome: 'updated' });
      continue;
    }
    try {
      await store.setPostOfficeSecret(existing.id, seal(seed.password));
    } catch (err) {
      report.failed.push({
        callsign: seed.callsign,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    report.mailboxes.push({ callsign: seed.callsign, outcome: 'updated' });
  }

  return report;
}

function usage(): string {
  return [
    'rfmail post office',
    '',
    '  mailboxes --file LIST [options]',
    '',
    '    --file FILE      the list: one "CALLSIGN: password" per line',
    '    --config FILE    the installation to load into (default: the station\'s own)',
    '    --replace        replace a password a mailbox already has',
    '    --dry-run        say what would happen; write nothing',
    '',
    'The list holds plaintext passwords: delete it once the mailboxes are loaded.',
  ].join('\n');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string' },
      file: { type: 'string' },
      replace: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const command = positionals[0];
  if (values.help === true || command === undefined) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = command === undefined && values.help !== true ? 2 : 0;
    return;
  }
  if (command !== 'mailboxes') {
    process.stderr.write(`unknown command: ${command}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (values.file === undefined) {
    process.stderr.write('mailboxes needs --file\n');
    process.exitCode = 2;
    return;
  }

  const configPath = values.config ?? process.env['RFMAIL_POSTOFFICE_CONFIG'] ?? defaultPostOfficeConfigPath();
  const loaded = loadPostOfficeConfig(configPath);
  const config = ensurePostOfficeSecret(loaded.config, loaded.path);

  let text: string;
  try {
    text = readFileSync(resolve(values.file), 'utf8');
  } catch (err) {
    process.stderr.write(`cannot read ${values.file}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const { seeds, problems } = parseMailboxList(text);
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${values.file}:${problem.line}: ${problem.message}\n`);
    }
    process.stderr.write(`\n${problems.length} line(s) refused; nothing was loaded.\n`);
    process.exitCode = 1;
    return;
  }
  if (seeds.length === 0) {
    process.stderr.write(`${values.file} holds no mailboxes.\n`);
    process.exitCode = 1;
    return;
  }

  const store = new SqliteStore({ path: config.database.path, postOffice: true });
  await store.migrate();
  try {
    const report = await loadMailboxes(
      store,
      seeds,
      (plaintext) => sealSecret(plaintext, config.server.storeKey),
      { replace: values.replace === true, dryRun: values['dry-run'] === true },
    );

    const lines: string[] = [];
    for (const mailbox of report.mailboxes) {
      lines.push(`  ${mailbox.callsign.padEnd(10)} ${mailbox.outcome}`);
    }
    for (const failure of report.failed) {
      lines.push(`  ${failure.callsign.padEnd(10)} FAILED: ${failure.reason}`);
    }
    process.stdout.write(
      [
        '',
        `rfmail post office — ${values['dry-run'] === true ? 'dry run, nothing written' : config.database.path}`,
        ...lines,
        '',
        `${report.mailboxes.filter((entry) => entry.outcome === 'created').length} created, ` +
          `${report.mailboxes.filter((entry) => entry.outcome === 'updated').length} updated, ` +
          `${report.mailboxes.filter((entry) => entry.outcome === 'unchanged').length} unchanged` +
          (report.failed.length > 0 ? `, ${report.failed.length} failed` : ''),
        values['dry-run'] === true ? '' : 'Delete the list: it holds plaintext passwords.',
        '',
      ]
        .filter((line) => line !== '')
        .join('\n') + '\n',
    );
    process.exitCode = report.failed.length > 0 ? 1 : 0;
  } finally {
    await store.close();
  }
}

// Only when run, not when imported by a test.
if (process.argv[1] !== undefined && /cli\.ts$|cli\.js$/.test(process.argv[1])) {
  void main().catch((err: unknown) => {
    const message = err instanceof HttpError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
    process.stderr.write(`rfmail post office: ${message}\n`);
    process.exitCode = 1;
  });
}
