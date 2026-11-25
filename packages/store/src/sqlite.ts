import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { serialiseRfc822, type MailMessage } from '@rfmail/core-b2f';
import {
  DEFAULT_FOLDERS,
  FLAG_UNREAD,
  type FolderKind,
  type Role,
} from '@rfmail/shared';
import {
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
  MIGRATION_005,
  MIGRATION_006,
  MIGRATION_007,
  MIGRATION_008,
  SCHEMA_VERSION,
} from './schema.ts';
import type {
  AttachmentRecord,
  CreateTransceiverInput,
  TransceiverRecord,
  CreateModemInput,
  ModemRecord,
  CreateUserInput,
  FolderCounts,
  FolderRecord,
  InsertOptions,
  InsertResult,
  ListOptions,
  MessageEnvelope,
  MessageRecord,
  Store,
  UserRecord,
} from './types.ts';
import type { ModemKind } from '@rfmail/shared';

interface UserRow {
  id: number;
  login: string;
  callsign: string | null;
  locator: string | null;
  winlink_secret: string | null;
  post_office_secret: string | null;
  is_post_office: number;
  pw_hash: string | null;
  role: string;
  enabled: number;
  quota_bytes: number;
  created_at: number;
}

interface TransceiverRow {
  id: number;
  name: string;
  host: string;
  port: number;
  ptt_input: string;
  launch_command: string | null;
  launch_args: string;
  idle_mode: string;
  idle_passband: number;
  timeout_ms: number;
  enabled: number;
  created_at: number;
}

interface ModemRow {
  id: number;
  name: string;
  kind: string;
  host: string;
  command_port: number | null;
  data_port: number | null;
  kiss_port: number | null;
  rig_mode: string;
  transceiver_id: number | null;
  enabled: number;
  created_at: number;
}

interface FolderRow {
  id: number;
  user_id: number;
  name: string;
  kind: string;
  uidvalidity: number;
  uidnext: number;
}

interface MessageRow {
  id: number;
  user_id: number;
  folder_id: number;
  uid: number;
  mid: string;
  message_id: string;
  direction: string;
  peer: string | null;
  from_addr: string;
  subject: string;
  date_utc: number;
  received_at: number;
  size: number;
  charset: string;
  body: string;
  headers_json: string;
  flags: number;
}

interface AttachmentRow {
  id: number;
  message_id: number;
  name: string;
  content_type: string;
  size: number;
}

export interface SqliteStoreOptions {
  /** Path to the database file, or ':memory:' for tests. */
  path: string;
  /** Echo statements to a logger (development aid). */
  trace?: (sql: string) => void;
}

export class SqliteStore implements Store {
  private db: DatabaseSync;
  private trace: ((sql: string) => void) | undefined;

  constructor(options: SqliteStoreOptions) {
    this.db = new DatabaseSync(options.path);
    this.trace = options.trace;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.restrictPermissions(options.path);
  }

  /**
   * The database holds sealed Winlink credentials and scrypt hashes, so it is
   * readable by its owner only — the WAL and shared-memory files SQLite creates
   * beside it inherit the umask otherwise, and they carry the same rows.
   */
  private restrictPermissions(path: string): void {
    if (path === ':memory:') return;
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(candidate, 0o600);
      } catch {
        // A -wal file appears on the first write; the next start catches it.
      }
    }
  }

  private run(sql: string, ...params: Array<string | number | null | Uint8Array>): {
    changes: number;
    lastInsertRowid: number;
  } {
    this.trace?.(sql);
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  private get<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
    this.trace?.(sql);
    const stmt = this.db.prepare(sql);
    return stmt.get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: Array<string | number | null>): T[] {
    this.trace?.(sql);
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async migrate(): Promise<void> {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const applied = this.all<{ version: number }>('SELECT version FROM schema_migrations');
    const seen = new Set(applied.map((row) => row.version));
    const migrations: Array<[number, string]> = [
      [1, MIGRATION_001],
      [2, MIGRATION_002],
      [3, MIGRATION_003],
      [4, MIGRATION_004],
      [5, MIGRATION_005],
      [6, MIGRATION_006],
      [7, MIGRATION_007],
      [8, MIGRATION_008],
    ];
    for (const [version, sql] of migrations) {
      if (seen.has(version)) continue;
      this.transaction(() => {
        this.db.exec(sql);
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', version, Date.now());
      });
    }
    const max = this.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations');
    if ((max?.version ?? 0) > SCHEMA_VERSION) {
      throw new Error(
        `database schema is newer (${max?.version}) than this build supports (${SCHEMA_VERSION})`,
      );
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // -- users ---------------------------------------------------------------

  async countUsers(): Promise<number> {
    const row = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    return row?.n ?? 0;
  }

  private userFrom(row: UserRow): UserRecord {
    return {
      id: row.id,
      login: row.login,
      role: row.role === 'admin' ? 'admin' : 'user',
      enabled: row.enabled !== 0,
      quotaBytes: row.quota_bytes,
      pwHash: row.pw_hash,
      callsign: row.callsign,
      locator: row.locator,
      winlinkSecret: row.winlink_secret,
      postOfficeSecret: row.post_office_secret,
      isPostOffice: row.is_post_office === 1,
      createdAt: row.created_at,
    };
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const now = Date.now();
    // One identity: the login is the callsign (decision 25). Both columns are
    // written here so a caller cannot create an account whose two names differ.
    const callsign = input.callsign.trim().toUpperCase();
    if (callsign === '') throw new Error('an account needs a callsign');
    const id = this.transaction(() => {
      const result = this.run(
        `INSERT INTO users (login, callsign, pw_hash, role, enabled, quota_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
        callsign,
        callsign,
        input.pwHash,
        input.role,
        now,
        now,
      );
      const uidvalidity = Math.floor(now / 1000);
      DEFAULT_FOLDERS.forEach((folder, index) => {
        this.run(
          'INSERT INTO folders (user_id, name, kind, uidvalidity, uidnext) VALUES (?, ?, ?, ?, 1)',
          result.lastInsertRowid,
          folder.name,
          folder.kind,
          uidvalidity + index,
        );
      });
      return result.lastInsertRowid;
    });
    const user = await this.getUser(id);
    if (!user) throw new Error('user creation failed');
    return user;
  }

  async findUserByLogin(login: string): Promise<UserRecord | null> {
    // The login is the callsign; matching is case-insensitive because a station is
    // told its callsign in whatever case the operator typed (decision 25).
    const name = login.trim();
    const row = this.get<UserRow>(
      'SELECT * FROM users WHERE login = ? COLLATE NOCASE OR callsign = ? COLLATE NOCASE',
      name,
      name,
    );
    return row ? this.userFrom(row) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const rows = this.all<UserRow>('SELECT * FROM users ORDER BY login COLLATE NOCASE');
    return rows.map((row) => this.userFrom(row));
  }

  async updateUser(
    id: number,
    patch: { role?: Role; enabled?: boolean; quotaBytes?: number },
  ): Promise<UserRecord | null> {
    const fields: string[] = [];
    const params: Array<string | number> = [];
    if (patch.role !== undefined) {
      fields.push('role = ?');
      params.push(patch.role);
    }
    if (patch.enabled !== undefined) {
      fields.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.quotaBytes !== undefined) {
      fields.push('quota_bytes = ?');
      params.push(Math.max(0, Math.trunc(patch.quotaBytes)));
    }
    if (fields.length > 0) {
      fields.push('updated_at = ?');
      params.push(Date.now());
      this.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...params, id);
    }
    return this.getUser(id);
  }

  async deleteUser(id: number): Promise<boolean> {
    const result = this.run('DELETE FROM users WHERE id = ?', id);
    return result.changes > 0;
  }

  async getUser(id: number): Promise<UserRecord | null> {
    const row = this.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return row ? this.userFrom(row) : null;
  }

  async setUserPassword(id: number, pwHash: string | null): Promise<void> {
    this.run('UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?', pwHash, Date.now(), id);
  }

  async setCallsign(userId: number, callsign: string | null): Promise<void> {
    const next = callsign ? callsign.trim().toUpperCase() : null;
    const current = this.get<{ callsign: string | null }>(
      'SELECT callsign FROM users WHERE id = ?',
      userId,
    );
    const changed = (current?.callsign ?? null) !== next;
    this.run(
      // The sealed credential belongs to the callsign, so a different callsign
      // must not inherit it. `login` follows the callsign: one identity per
      // account, so renaming the station renames the sign-in (decision 25).
      `UPDATE users SET callsign = ?, login = COALESCE(?, login),
         winlink_secret = CASE WHEN ? THEN NULL ELSE winlink_secret END,
         post_office_secret = CASE WHEN ? THEN NULL ELSE post_office_secret END,
         updated_at = ?
       WHERE id = ?`,
      next,
      next,
      changed ? 1 : 0,
      changed ? 1 : 0,
      Date.now(),
      userId,
    );
  }

  async setLocator(userId: number, locator: string | null): Promise<void> {
    this.run('UPDATE users SET locator = ?, updated_at = ? WHERE id = ?', locator, Date.now(), userId);
  }

  async findUserByCallsign(callsign: string): Promise<UserRecord | null> {
    const row = this.get<UserRow>(
      'SELECT * FROM users WHERE callsign = ? COLLATE NOCASE',
      callsign.trim(),
    );
    return row ? this.userFrom(row) : null;
  }

  async getWinlinkSecret(userId: number): Promise<string | null> {
    const row = this.get<{ winlink_secret: string | null }>(
      'SELECT winlink_secret FROM users WHERE id = ?',
      userId,
    );
    return row?.winlink_secret ?? null;
  }

  async setWinlinkSecret(userId: number, secret: string | null): Promise<boolean> {
    const row = this.get<{ callsign: string | null }>('SELECT callsign FROM users WHERE id = ?', userId);
    if (!row?.callsign) return false;
    this.run('UPDATE users SET winlink_secret = ?, updated_at = ? WHERE id = ?', secret, Date.now(), userId);
    return true;
  }

  async getPostOfficeSecret(userId: number): Promise<string | null> {
    const row = this.get<{ post_office_secret: string | null }>(
      'SELECT post_office_secret FROM users WHERE id = ?',
      userId,
    );
    return row?.post_office_secret ?? null;
  }

  async setPostOfficeSecret(userId: number, secret: string | null): Promise<boolean> {
    // Like the Winlink credential, it belongs to a callsign: without one there is
    // nobody for a station to authenticate as.
    const row = this.get<{ callsign: string | null }>('SELECT callsign FROM users WHERE id = ?', userId);
    if (!row?.callsign) return false;
    this.run(
      'UPDATE users SET post_office_secret = ?, updated_at = ? WHERE id = ?',
      secret,
      Date.now(),
      userId,
    );
    return true;
  }

  async findPostOfficeOwner(): Promise<UserRecord | null> {
    const row = this.get<UserRow>('SELECT * FROM users WHERE is_post_office = 1');
    return row ? this.userFrom(row) : null;
  }

  async setPostOfficeOwner(userId: number | null): Promise<boolean> {
    if (userId === null) {
      this.run('UPDATE users SET is_post_office = 0 WHERE is_post_office = 1');
      return true;
    }
    const row = this.get<{ callsign: string | null }>('SELECT callsign FROM users WHERE id = ?', userId);
    if (!row?.callsign) return false;
    // The station answers as one callsign, so one account owns the role. Clearing
    // the previous owner first also satisfies the partial unique index.
    this.transaction(() => {
      this.run('UPDATE users SET is_post_office = 0 WHERE is_post_office = 1 AND id <> ?', userId);
      this.run('UPDATE users SET is_post_office = 1, updated_at = ? WHERE id = ?', Date.now(), userId);
    });
    return true;
  }

  // -- transceivers (the rig registry, R2.2) --------------------------------

  private transceiverFrom(row: TransceiverRow): TransceiverRecord {
    let launchArgs: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.launch_args);
      if (Array.isArray(parsed)) launchArgs = parsed.filter((entry): entry is string => typeof entry === 'string');
    } catch {
      launchArgs = [];
    }
    const pttInput = row.ptt_input === 'front' || row.ptt_input === 'auto' ? row.ptt_input : 'rear';
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      pttInput,
      launchCommand: row.launch_command,
      launchArgs,
      idleMode: row.idle_mode,
      idlePassbandHz: row.idle_passband,
      timeoutMs: row.timeout_ms,
      enabled: row.enabled !== 0,
      createdAt: row.created_at,
    };
  }

  async listTransceivers(): Promise<TransceiverRecord[]> {
    return this.all<TransceiverRow>('SELECT * FROM transceivers ORDER BY name COLLATE NOCASE').map(
      (row) => this.transceiverFrom(row),
    );
  }

  async getTransceiver(id: number): Promise<TransceiverRecord | null> {
    const row = this.get<TransceiverRow>('SELECT * FROM transceivers WHERE id = ?', id);
    return row ? this.transceiverFrom(row) : null;
  }

  async createTransceiver(input: CreateTransceiverInput): Promise<TransceiverRecord> {
    const now = Date.now();
    const result = this.run(
      `INSERT INTO transceivers
         (name, host, port, ptt_input, launch_command, launch_args, idle_mode,
          idle_passband, timeout_ms, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.host,
      input.port ?? 4532,
      input.pttInput ?? 'rear',
      input.launchCommand ?? null,
      JSON.stringify(input.launchArgs ?? []),
      input.idleMode ?? 'PKTUSB',
      input.idlePassbandHz ?? 2000,
      input.timeoutMs ?? 5000,
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
    const created = await this.getTransceiver(Number(result.lastInsertRowid));
    if (!created) throw new Error('transceiver creation failed');
    return created;
  }

  async updateTransceiver(
    id: number,
    patch: Partial<CreateTransceiverInput>,
  ): Promise<TransceiverRecord | null> {
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null): void => {
      fields.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.host !== undefined) set('host', patch.host);
    if (patch.port !== undefined) set('port', patch.port);
    if (patch.pttInput !== undefined) set('ptt_input', patch.pttInput);
    if (patch.launchCommand !== undefined) set('launch_command', patch.launchCommand ?? null);
    if (patch.launchArgs !== undefined) set('launch_args', JSON.stringify(patch.launchArgs));
    if (patch.idleMode !== undefined) set('idle_mode', patch.idleMode);
    if (patch.idlePassbandHz !== undefined) set('idle_passband', patch.idlePassbandHz);
    if (patch.timeoutMs !== undefined) set('timeout_ms', patch.timeoutMs);
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (fields.length === 0) return this.getTransceiver(id);
    set('updated_at', Date.now());
    this.run(`UPDATE transceivers SET ${fields.join(', ')} WHERE id = ?`, ...params, id);
    return this.getTransceiver(id);
  }

  // -- modems (R3) ---------------------------------------------------------

  async listModems(): Promise<ModemRecord[]> {
    const rows = this.all<ModemRow>('SELECT * FROM modems ORDER BY name COLLATE NOCASE');
    return rows.map((row) => this.modemFrom(row));
  }

  async getModem(id: number): Promise<ModemRecord | null> {
    const row = this.get<ModemRow>('SELECT * FROM modems WHERE id = ?', id);
    return row ? this.modemFrom(row) : null;
  }

  async createModem(input: CreateModemInput): Promise<ModemRecord> {
    const now = Date.now();
    const result = this.run(
      `INSERT INTO modems
         (name, kind, host, command_port, data_port, kiss_port, rig_mode, transceiver_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.kind,
      input.host,
      input.commandPort ?? null,
      input.dataPort ?? null,
      input.kissPort ?? null,
      input.rigMode ?? 'PKTUSB',
      input.transceiverId ?? null,
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
    const created = await this.getModem(Number(result.lastInsertRowid));
    if (!created) throw new Error('the modem was not stored');
    return created;
  }

  async updateModem(id: number, patch: Partial<CreateModemInput>): Promise<ModemRecord | null> {
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null): void => {
      fields.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.kind !== undefined) set('kind', patch.kind);
    if (patch.host !== undefined) set('host', patch.host);
    if (patch.commandPort !== undefined) set('command_port', patch.commandPort);
    if (patch.dataPort !== undefined) set('data_port', patch.dataPort);
    if (patch.kissPort !== undefined) set('kiss_port', patch.kissPort);
    if (patch.rigMode !== undefined) set('rig_mode', patch.rigMode);
    if (patch.transceiverId !== undefined) set('transceiver_id', patch.transceiverId);
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (fields.length > 0) {
      fields.push('updated_at = ?');
      params.push(Date.now());
      this.run(`UPDATE modems SET ${fields.join(', ')} WHERE id = ?`, ...params, id);
    }
    return this.getModem(id);
  }

  async deleteModem(id: number): Promise<boolean> {
    const result = this.run('DELETE FROM modems WHERE id = ?', id);
    return result.changes > 0;
  }

  private modemFrom(row: ModemRow): ModemRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as ModemKind,
      host: row.host,
      commandPort: row.command_port,
      dataPort: row.data_port,
      kissPort: row.kiss_port,
      rigMode: row.rig_mode,
      transceiverId: row.transceiver_id,
      enabled: row.enabled !== 0,
      createdAt: row.created_at,
    };
  }

  async deleteTransceiver(id: number): Promise<boolean> {
    const result = this.run('DELETE FROM transceivers WHERE id = ?', id);
    return Number(result.changes) > 0;
  }

  // -- folders -------------------------------------------------------------

  private folderFrom(row: FolderRow): FolderRecord {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      kind: row.kind as FolderKind,
      uidvalidity: row.uidvalidity,
      uidnext: row.uidnext,
    };
  }

  async listFolders(userId: number): Promise<Array<FolderRecord & FolderCounts>> {
    const rows = this.all<FolderRow & { total: number; unread: number }>(
      `SELECT f.*,
              (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id) AS total,
              (SELECT COALESCE(SUM(CASE WHEN (m.flags & 1) <> 0 THEN 1 ELSE 0 END), 0)
                 FROM messages m WHERE m.folder_id = f.id) AS unread
         FROM folders f
        WHERE f.user_id = ?
        ORDER BY f.id`,
      userId,
    );
    return rows.map((row) => ({
      ...this.folderFrom(row),
      total: row.total,
      unread: row.unread,
    }));
  }

  async getFolder(userId: number, folderId: number): Promise<FolderRecord | null> {
    const row = this.get<FolderRow>(
      'SELECT * FROM folders WHERE id = ? AND user_id = ?',
      folderId,
      userId,
    );
    return row ? this.folderFrom(row) : null;
  }

  async findFolder(userId: number, name: string): Promise<FolderRecord | null> {
    const row = this.get<FolderRow>(
      'SELECT * FROM folders WHERE user_id = ? AND name = ? COLLATE NOCASE',
      userId,
      name,
    );
    return row ? this.folderFrom(row) : null;
  }

  async createFolder(userId: number, name: string, kind: FolderKind): Promise<FolderRecord> {
    const uidvalidity = Math.floor(Date.now() / 1000);
    const result = this.run(
      'INSERT INTO folders (user_id, name, kind, uidvalidity, uidnext) VALUES (?, ?, ?, ?, 1)',
      userId,
      name,
      kind,
      uidvalidity,
    );
    const folder = await this.getFolder(userId, result.lastInsertRowid);
    if (!folder) throw new Error('folder creation failed');
    return folder;
  }

  // -- messages ------------------------------------------------------------

  async insertMessage(
    userId: number,
    folderId: number,
    message: MailMessage,
    options: InsertOptions,
  ): Promise<InsertResult> {
    const size = serialiseRfc822(message).length;
    const flags = options.flags ?? (options.direction === 'in' ? FLAG_UNREAD : 0);
    const receivedAt = Date.now();

    return this.transaction(() => {
      const folder = this.get<FolderRow>(
        'SELECT * FROM folders WHERE id = ? AND user_id = ?',
        folderId,
        userId,
      );
      if (!folder) throw new Error('folder not found');
      const uid = folder.uidnext;

      const inserted = this.run(
        `INSERT INTO messages
           (user_id, folder_id, uid, mid, message_id, direction, peer, from_addr, subject,
            date_utc, received_at, size, charset, body, headers_json, flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId,
        folderId,
        uid,
        message.mid,
        message.messageId,
        options.direction,
        options.peer ?? null,
        message.from,
        message.subject,
        message.dateUtc,
        receivedAt,
        size,
        message.charset,
        message.body,
        JSON.stringify(message.headers),
        flags,
      );
      const messageId = inserted.lastInsertRowid;
      this.run('UPDATE folders SET uidnext = ? WHERE id = ?', uid + 1, folderId);

      for (const addr of message.to) {
        this.run('INSERT INTO recipients (message_id, kind, addr) VALUES (?, ?, ?)', messageId, 'to', addr);
      }
      for (const addr of message.cc) {
        this.run('INSERT INTO recipients (message_id, kind, addr) VALUES (?, ?, ?)', messageId, 'cc', addr);
      }
      for (const attachment of message.attachments) {
        this.run(
          'INSERT INTO attachments (message_id, name, content_type, size, data) VALUES (?, ?, ?, ?, ?)',
          messageId,
          attachment.name,
          attachment.contentType,
          attachment.data.length,
          attachment.data,
        );
      }
      return { id: messageId, uid };
    });
  }

  private envelopeFrom(row: MessageRow, attachmentCount: number, to: string[], cc: string[]): MessageEnvelope {
    return {
      id: row.id,
      folderId: row.folder_id,
      uid: row.uid,
      mid: row.mid,
      from: row.from_addr,
      to,
      cc,
      subject: row.subject,
      dateUtc: row.date_utc,
      size: row.size,
      flags: row.flags,
      attachmentCount,
    };
  }

  async findMessageByMid(userId: number, mid: string): Promise<MessageEnvelope | null> {
    const row = this.get<MessageRow>(
      'SELECT * FROM messages WHERE user_id = ? AND mid = ?',
      userId,
      mid.toUpperCase(),
    );
    if (!row) return null;
    const { to, cc } = this.recipients(row.id);
    const count = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?', row.id);
    return this.envelopeFrom(row, count?.n ?? 0, to, cc);
  }

  async findReceivedByMid(
    mid: string,
  ): Promise<{ userId: number; envelope: MessageEnvelope } | null> {
    // The station's duplicate check: a post office answers a proposal before it
    // knows who the message is for, so the MID is matched across every mailbox —
    // but only against mail that arrived. A copy in somebody's OUTBOX is a message
    // this station is sending, and answering `-` for it would drop the peer's.
    const row = this.get<MessageRow>(
      "SELECT * FROM messages WHERE mid = ? AND direction = 'in' LIMIT 1",
      mid.toUpperCase(),
    );
    if (!row) return null;
    const { to, cc } = this.recipients(row.id);
    const count = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?', row.id);
    return { userId: row.user_id, envelope: this.envelopeFrom(row, count?.n ?? 0, to, cc) };
  }

  async listMessages(
    userId: number,
    folderId: number,
    options?: ListOptions,
  ): Promise<{ total: number; messages: MessageEnvelope[] }> {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 500);
    const offset = Math.max(options?.offset ?? 0, 0);
    const search = (options?.search ?? '').trim();
    const like = `%${search}%`;
    const filter = search
      ? 'AND (subject LIKE ? OR from_addr LIKE ?)'
      : '';
    const params: Array<string | number> = search
      ? [userId, folderId, like, like]
      : [userId, folderId];

    const countRow = this.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND folder_id = ? ${filter}`,
      ...params,
    );
    const rows = this.all<MessageRow>(
      `SELECT * FROM messages WHERE user_id = ? AND folder_id = ? ${filter}
        ORDER BY date_utc DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const messages = rows.map((row) => {
      const { to, cc } = this.recipients(row.id);
      const count = this.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?',
        row.id,
      );
      return this.envelopeFrom(row, count?.n ?? 0, to, cc);
    });
    return { total: countRow?.n ?? 0, messages };
  }

  private recipients(messageId: number): { to: string[]; cc: string[] } {
    const rows = this.all<{ kind: string; addr: string }>(
      'SELECT kind, addr FROM recipients WHERE message_id = ?',
      messageId,
    );
    return {
      to: rows.filter((r) => r.kind === 'to').map((r) => r.addr),
      cc: rows.filter((r) => r.kind === 'cc').map((r) => r.addr),
    };
  }

  private attachments(messageId: number): AttachmentRecord[] {
    return this.all<AttachmentRow>(
      'SELECT id, message_id, name, content_type, size FROM attachments WHERE message_id = ? ORDER BY id',
      messageId,
    ).map((row) => ({
      id: row.id,
      messageId: row.message_id,
      name: row.name,
      contentType: row.content_type,
      size: row.size,
    }));
  }

  async getMessage(userId: number, messageId: number): Promise<MessageRecord | null> {
    const row = this.get<MessageRow>(
      'SELECT * FROM messages WHERE id = ? AND user_id = ?',
      messageId,
      userId,
    );
    if (!row) return null;
    const { to, cc } = this.recipients(row.id);
    const attachments = this.attachments(row.id);
    let headers: Array<[string, string]> = [];
    try {
      const parsed: unknown = JSON.parse(row.headers_json);
      if (Array.isArray(parsed)) headers = parsed as Array<[string, string]>;
    } catch {
      headers = [];
    }
    return {
      ...this.envelopeFrom(row, attachments.length, to, cc),
      messageId: row.message_id,
      direction: row.direction === 'out' ? 'out' : 'in',
      peer: row.peer,
      receivedAt: row.received_at,
      charset: row.charset,
      body: row.body,
      headers,
      attachments,
    };
  }

  async getMailMessage(userId: number, messageId: number): Promise<MailMessage | null> {
    const record = await this.getMessage(userId, messageId);
    if (!record) return null;
    const attachments = [];
    for (const meta of record.attachments) {
      const found = await this.getAttachment(userId, record.id, meta.id);
      if (found) {
        attachments.push({
          name: found.meta.name,
          contentType: found.meta.contentType,
          data: found.data,
        });
      }
    }
    return {
      mid: record.mid,
      messageId: record.messageId,
      from: record.from,
      to: record.to,
      cc: record.cc,
      subject: record.subject,
      dateUtc: record.dateUtc,
      body: record.body,
      charset: record.charset,
      headers: record.headers,
      attachments,
    };
  }

  async getAttachment(
    userId: number,
    messageId: number,
    attachmentId: number,
  ): Promise<{ meta: AttachmentRecord; data: Uint8Array } | null> {
    const row = this.get<AttachmentRow & { data: Uint8Array }>(
      `SELECT a.id, a.message_id, a.name, a.content_type, a.size, a.data
         FROM attachments a
         JOIN messages m ON m.id = a.message_id
        WHERE a.id = ? AND a.message_id = ? AND m.user_id = ?`,
      attachmentId,
      messageId,
      userId,
    );
    if (!row) return null;
    return {
      meta: {
        id: row.id,
        messageId: row.message_id,
        name: row.name,
        contentType: row.content_type,
        size: row.size,
      },
      data: row.data,
    };
  }

  async setFlags(userId: number, messageId: number, flags: number): Promise<void> {
    this.run('UPDATE messages SET flags = ? WHERE id = ? AND user_id = ?', flags, messageId, userId);
  }

  async moveMessage(userId: number, messageId: number, folderId: number): Promise<boolean> {
    return this.transaction(() => {
      const folder = this.get<FolderRow>(
        'SELECT * FROM folders WHERE id = ? AND user_id = ?',
        folderId,
        userId,
      );
      if (!folder) return false;
      const uid = folder.uidnext;
      const result = this.run(
        'UPDATE messages SET folder_id = ?, uid = ? WHERE id = ? AND user_id = ?',
        folderId,
        uid,
        messageId,
        userId,
      );
      if (result.changes === 0) return false;
      this.run('UPDATE folders SET uidnext = ? WHERE id = ?', uid + 1, folderId);
      return true;
    });
  }

  async deleteMessage(userId: number, messageId: number): Promise<boolean> {
    const result = this.run('DELETE FROM messages WHERE id = ? AND user_id = ?', messageId, userId);
    return result.changes > 0;
  }

  async usage(userId: number): Promise<number> {
    const row = this.get<{ total: number | null }>(
      `SELECT
         (SELECT COALESCE(SUM(size), 0) FROM messages WHERE user_id = ?) +
         (SELECT COALESCE(SUM(a.size), 0) FROM attachments a
            JOIN messages m ON m.id = a.message_id WHERE m.user_id = ?) AS total`,
      userId,
      userId,
    );
    return row?.total ?? 0;
  }
}

export type { Role };
