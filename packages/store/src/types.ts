import type { FolderKind, ModemKind, Role } from '@rfmail/shared';
import type { MailAttachment, MailMessage } from '@rfmail/core-b2f';

export interface UserRecord {
  id: number;
  /**
   * The account's identity, which is its callsign: `login` mirrors `callsign`
   * (upper-case) and exists as the sign-in key, so the two can never name two
   * different people. A row written before decision 25 may still hold a login
   * of its own until a callsign is set on it.
   */
  login: string;
  role: Role;
  enabled: boolean;
  quotaBytes: number;
  /** null means the account has no password (first-run accounts). */
  pwHash: string | null;
  /**
   * The station callsign, which is the originator of every message this account
   * sends. One callsign is one mailbox, so it is unique across accounts; it is
   * also the login, so there is no second name for the same person.
   */
  callsign: string | null;
  /** Maidenhead grid square of the operator's station, e.g. `JO70AA`. */
  locator: string | null;
  /**
   * Sealed Winlink secure-login password for that callsign, or null.
   * Never serialised to a client: `toUser` exposes only a boolean.
   */
  winlinkSecret: string | null;
  /**
   * Sealed post-office password: the credential a station without a Winlink
   * password answers this station's challenge with (decision 27). Sealed rather
   * than hashed because `;PR` is verified by recomputation.
   */
  postOfficeSecret: string | null;
  /** Whether this account is the station's post-office identity (at most one). */
  isPostOffice: boolean;
  createdAt: number;
}

/**
 * One row of the transceiver registry. PTT input names the connector the audio
 * is transmitted from: `rear` (the input a modem feeds) or `front` (microphone),
 * with `auto` trying the rear first (R2.2.1).
 */
export interface TransceiverRecord {
  id: number;
  name: string;
  host: string;
  port: number;
  pttInput: 'rear' | 'front' | 'auto';
  launchCommand: string | null;
  launchArgs: string[];
  idleMode: string;
  idlePassbandHz: number;
  timeoutMs: number;
  enabled: boolean;
  createdAt: number;
}

export interface CreateTransceiverInput {
  name: string;
  host: string;
  port?: number;
  pttInput?: 'rear' | 'front' | 'auto';
  launchCommand?: string | null;
  launchArgs?: string[];
  idleMode?: string;
  idlePassbandHz?: number;
  timeoutMs?: number;
  enabled?: boolean;
}

/**
 * A configured modem (R3): how to reach the program, which radio it drives, and
 * the mode that radio must be in while it runs.
 */
export interface ModemRecord {
  id: number;
  name: string;
  kind: ModemKind;
  host: string;
  /** The port commands go to; every modem has one. */
  commandPort: number | null;
  /** The audio-data port, where the modem splits it from commands (VARA, XARA). */
  dataPort: number | null;
  /** The KISS port, for packet modems. */
  kissPort: number | null;
  /** The transceiver mode while this modem runs: PKTUSB, FM, … */
  rigMode: string;
  transceiverId: number | null;
  enabled: boolean;
  createdAt: number;
}

export interface CreateModemInput {
  name: string;
  kind: ModemKind;
  host: string;
  commandPort?: number | null;
  dataPort?: number | null;
  kissPort?: number | null;
  rigMode?: string;
  transceiverId?: number | null;
  enabled?: boolean;
}

export interface FolderRecord {
  id: number;
  userId: number;
  name: string;
  kind: FolderKind;
  uidvalidity: number;
  uidnext: number;
}

export interface FolderCounts {
  total: number;
  unread: number;
}

export interface AttachmentRecord {
  id: number;
  messageId: number;
  name: string;
  contentType: string;
  size: number;
}

export interface MessageEnvelope {
  id: number;
  folderId: number;
  uid: number;
  mid: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** Epoch milliseconds, UTC. */
  dateUtc: number;
  size: number;
  flags: number;
  attachmentCount: number;
}

export interface MessageRecord extends MessageEnvelope {
  messageId: string;
  direction: 'in' | 'out';
  peer: string | null;
  receivedAt: number;
  charset: string;
  body: string;
  headers: Array<[string, string]>;
  attachments: AttachmentRecord[];
}

export interface ListOptions {
  offset?: number;
  limit?: number;
  search?: string;
}

export interface InsertOptions {
  direction: 'in' | 'out';
  peer?: string | null;
  /** Defaults to FLAG_UNREAD for inbound, 0 for outbound. */
  flags?: number;
}

export interface InsertResult {
  id: number;
  uid: number;
}

export interface CreateUserInput {
  /**
   * The account's identity: a Winlink station has one callsign, and the account
   * is that callsign, so it is also the login (stored upper-case, matched
   * without regard to case). Required — an account without a callsign can
   * neither send nor receive mail.
   */
  callsign: string;
  pwHash: string | null;
  role: Role;
}

/**
 * Storage contract. One adapter today (SQLite via node:sqlite); MariaDB and
 * PostgreSQL adapters implement the same interface in a later milestone.
 *
 * Every method is scoped by user where user data is involved: there is no
 * "fetch by id" that ignores ownership, so a caller cannot forget the scope.
 */
export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;

  countUsers(): Promise<number>;
  listUsers(): Promise<UserRecord[]>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  findUserByLogin(login: string): Promise<UserRecord | null>;
  getUser(id: number): Promise<UserRecord | null>;
  updateUser(
    id: number,
    patch: { role?: Role; enabled?: boolean; quotaBytes?: number },
  ): Promise<UserRecord | null>;
  deleteUser(id: number): Promise<boolean>;
  setUserPassword(id: number, pwHash: string | null): Promise<void>;
  /**
   * Sets (or clears) the account's single callsign. Changing it to a different
   * callsign drops the sealed Winlink credential, which belonged to the old one.
   */
  setCallsign(userId: number, callsign: string | null): Promise<void>;
  setLocator(userId: number, locator: string | null): Promise<void>;
  findUserByCallsign(callsign: string): Promise<UserRecord | null>;
  /** Sealed Winlink credential of the account, or null. */
  getWinlinkSecret(userId: number): Promise<string | null>;
  /** Stores or clears the sealed credential; false if the account has no callsign. */
  setWinlinkSecret(userId: number, secret: string | null): Promise<boolean>;
  /** Sealed post-office credential of the account, or null. */
  getPostOfficeSecret(userId: number): Promise<string | null>;
  /** Stores or clears it; false if the account has no callsign. */
  setPostOfficeSecret(userId: number, secret: string | null): Promise<boolean>;
  /**
   * The account whose callsign the post office answers as, or null. At most one
   * account is the owner; making one the owner unseats the previous one.
   */
  findPostOfficeOwner(): Promise<UserRecord | null>;
  /** Makes the account the owner (null clears it); false if it has no callsign. */
  setPostOfficeOwner(userId: number | null): Promise<boolean>;

  listTransceivers(): Promise<TransceiverRecord[]>;
  getTransceiver(id: number): Promise<TransceiverRecord | null>;
  createTransceiver(input: CreateTransceiverInput): Promise<TransceiverRecord>;

  listModems(): Promise<ModemRecord[]>;
  getModem(id: number): Promise<ModemRecord | null>;
  createModem(input: CreateModemInput): Promise<ModemRecord>;
  updateModem(id: number, patch: Partial<CreateModemInput>): Promise<ModemRecord | null>;
  deleteModem(id: number): Promise<boolean>;
  updateTransceiver(
    id: number,
    patch: Partial<CreateTransceiverInput>,
  ): Promise<TransceiverRecord | null>;
  deleteTransceiver(id: number): Promise<boolean>;

  listFolders(userId: number): Promise<Array<FolderRecord & FolderCounts>>;
  getFolder(userId: number, folderId: number): Promise<FolderRecord | null>;
  findFolder(userId: number, name: string): Promise<FolderRecord | null>;
  createFolder(userId: number, name: string, kind: FolderKind): Promise<FolderRecord>;

  insertMessage(
    userId: number,
    folderId: number,
    message: MailMessage,
    options: InsertOptions,
  ): Promise<InsertResult>;
  listMessages(
    userId: number,
    folderId: number,
    options?: ListOptions,
  ): Promise<{ total: number; messages: MessageEnvelope[] }>;
  getMessage(userId: number, messageId: number): Promise<MessageRecord | null>;
  /**
   * The message carrying this MID anywhere in the account's mailbox, or null.
   * The B2 exchange asks before accepting a proposal: a peer that offers a MID
   * already stored is offering something this station has.
   */
  findMessageByMid(userId: number, mid: string): Promise<MessageEnvelope | null>;
  /**
   * The *received* message holding this MID in any mailbox, with its owner. A post
   * office decides a proposal before it knows who the message is for, so its
   * duplicate check is the station's, not one mailbox's (decision 28) — and it
   * matches only mail that has arrived: a message sitting in somebody's OUTBOX is
   * one this station is sending, not one it already has, and rejecting a peer's
   * proposal for it would lose the peer's message.
   */
  findReceivedByMid(mid: string): Promise<{ userId: number; envelope: MessageEnvelope } | null>;
  /** A message with its attachment bytes, ready for serialisation. */
  getMailMessage(userId: number, messageId: number): Promise<MailMessage | null>;
  getAttachment(
    userId: number,
    messageId: number,
    attachmentId: number,
  ): Promise<{ meta: AttachmentRecord; data: Uint8Array } | null>;

  setFlags(userId: number, messageId: number, flags: number): Promise<void>;
  moveMessage(userId: number, messageId: number, folderId: number): Promise<boolean>;
  deleteMessage(userId: number, messageId: number): Promise<boolean>;

  /** Bytes used by a user's messages and attachments. */
  usage(userId: number): Promise<number>;
}

export type { MailAttachment, MailMessage };
