// Schema for schema version 1, written in portable SQL: no triggers, no
// stored procedures, no native ENUM, timestamps as epoch milliseconds in
// INTEGER columns. Later dialect adapters reproduce this shape exactly.

export const SCHEMA_VERSION = 13;

export const MIGRATION_001 = `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  login         TEXT    NOT NULL,
  pw_hash       TEXT,
  role          TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  quota_bytes   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_login ON users (login COLLATE NOCASE);

CREATE TABLE user_callsigns (
  callsign   TEXT    NOT NULL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE folders (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  uidvalidity INTEGER NOT NULL,
  uidnext     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX folders_user_name ON folders (user_id, name);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid         INTEGER NOT NULL,
  mid         TEXT    NOT NULL,
  message_id  TEXT    NOT NULL DEFAULT '',
  direction   TEXT    NOT NULL,
  peer        TEXT,
  from_addr   TEXT    NOT NULL DEFAULT '',
  subject     TEXT    NOT NULL DEFAULT '',
  date_utc    INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  charset     TEXT    NOT NULL DEFAULT 'ISO-8859-1',
  body        TEXT    NOT NULL DEFAULT '',
  headers_json TEXT   NOT NULL DEFAULT '[]',
  flags       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX messages_folder_uid ON messages (folder_id, uid);
CREATE UNIQUE INDEX messages_user_mid ON messages (user_id, mid);
CREATE INDEX messages_folder_date ON messages (folder_id, date_utc DESC);
CREATE INDEX messages_user_subject ON messages (user_id, subject);

CREATE TABLE recipients (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  addr       TEXT    NOT NULL
);
CREATE INDEX recipients_message ON recipients (message_id);

CREATE TABLE attachments (
  id           INTEGER PRIMARY KEY,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  content_type TEXT    NOT NULL,
  size         INTEGER NOT NULL,
  data         BLOB    NOT NULL
);
CREATE INDEX attachments_message ON attachments (message_id);

CREATE TABLE settings (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// The Winlink (CMS) secure-login password is per callsign, not per account,
// because one account may hold several callsigns with separate registrations.
// It cannot be hashed like the mail password: the client has to send it to the
// CMS, so it is stored sealed (see packages/server/src/secrets.ts).
// The column holds an opaque sealed blob; the store never interprets it.
export const MIGRATION_002 = `
ALTER TABLE user_callsigns ADD COLUMN winlink_secret TEXT;
`;

// A Winlink client session has exactly one originator callsign: one callsign is
// one mailbox, so several callsigns are several accounts. The callsign therefore
// moves onto the account and `user_callsigns` disappears; the sealed Winlink
// credential travels with it. Mail for further addresses is a separate concept
// (auxiliary addresses, R7.3.5), not a list of session callsigns.
export const MIGRATION_003 = `
ALTER TABLE users ADD COLUMN callsign TEXT;
ALTER TABLE users ADD COLUMN winlink_secret TEXT;
UPDATE users SET
  callsign = (SELECT c.callsign FROM user_callsigns c WHERE c.user_id = users.id AND c.is_primary = 1),
  winlink_secret = (SELECT c.winlink_secret FROM user_callsigns c WHERE c.user_id = users.id AND c.is_primary = 1)
WHERE EXISTS (SELECT 1 FROM user_callsigns c WHERE c.user_id = users.id);
CREATE UNIQUE INDEX users_callsign ON users (callsign);
DROP TABLE user_callsigns;
`;

// The transceiver registry (R2.2). A transceiver is configuration, not state:
// whether a link is up belongs to the running process, so nothing here records
// a connection. `ptt_input` is the connector the audio is transmitted from —
// 'rear' is the input a modem feeds, 'front' the microphone — because on a
// TS-590 the wrong choice transmits silence (R2.2.1).
export const MIGRATION_004 = `
CREATE TABLE transceivers (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL,
  host           TEXT    NOT NULL,
  port           INTEGER NOT NULL DEFAULT 4532,
  ptt_input      TEXT    NOT NULL DEFAULT 'rear',
  launch_command TEXT,
  launch_args    TEXT    NOT NULL DEFAULT '[]',
  idle_mode      TEXT    NOT NULL DEFAULT 'PKTUSB',
  idle_passband  INTEGER NOT NULL DEFAULT 2000,
  timeout_ms     INTEGER NOT NULL DEFAULT 5000,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX transceivers_name ON transceivers (name COLLATE NOCASE);
`;

// The operator's location, as a Maidenhead grid square. A gateway list is only
// useful when it says how far away each gateway is, and the distance is measured
// from here. It sits on the account rather than in the config file because a club
// or expedition callsign works from a different place than its owner (decision 13).
export const MIGRATION_005 = `
ALTER TABLE users ADD COLUMN locator TEXT;
`;

// The modem registry (R3). A modem is a program speaking a TCP interface, so what
// the station stores is how to reach it and what the radio must do while it runs:
// the ports (a command port for every modem, a data port only for those that split
// them, a KISS port for packet), the transceiver it is wired to, and the mode that
// transceiver must be in. Three ports rather than one number because they are
// different things — VARA hands commands and audio over separate sockets, ARDOP
// uses one for both.
export const MIGRATION_006 = `
CREATE TABLE modems (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  host           TEXT    NOT NULL,
  command_port   INTEGER,
  data_port      INTEGER,
  kiss_port      INTEGER,
  rig_mode       TEXT    NOT NULL DEFAULT 'PKTUSB',
  transceiver_id INTEGER REFERENCES transceivers(id) ON DELETE SET NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX modems_name ON modems (name COLLATE NOCASE);
`;

// One identity per account (decision 25): a Winlink station has one callsign, so
// the account IS that callsign and there is no second name for the same person.
// `login` becomes the callsign, upper-case, and stays in step with it: the sign-in
// form, POP3, IMAP and SMTP all ask for the callsign, and an address resolves to
// the same row. Accounts made before this migration copy their callsign into the
// login; a row that never had a callsign keeps its old login until one is set on
// it (a callsign is never invented for an account). The callsign index becomes
// case-insensitive, so `ok4rm` and `OK4RM` cannot become two accounts.
export const MIGRATION_007 = `
UPDATE users SET callsign = UPPER(TRIM(callsign))
WHERE callsign IS NOT NULL AND callsign <> UPPER(TRIM(callsign));
UPDATE users SET login = callsign WHERE callsign IS NOT NULL;
DROP INDEX IF EXISTS users_callsign;
CREATE UNIQUE INDEX users_callsign ON users (callsign COLLATE NOCASE);
`;

// The post office (decisions 27, 28). Two columns on the account and nothing else:
//   post_office_secret  the sealed credential a station without a Winlink password
//                       answers this station's `;PQ` challenge with. Sealed, not
//                       hashed, because `;PR` is checked by recomputation.
//   is_post_office      the account whose callsign the station answers as. A
//                       partial unique index makes "at most one owner" a database
//                       fact rather than a rule somebody remembers to enforce.
export const MIGRATION_008 = `
ALTER TABLE users ADD COLUMN post_office_secret TEXT;
ALTER TABLE users ADD COLUMN is_post_office INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX users_post_office_owner ON users (is_post_office) WHERE is_post_office = 1;
`;

// The serial line the daemon serves (decision 39). rigctld does not report the device it
// was started with or the speed it uses — the capability dump gives the rig model's supported
// range, never the configured value — so a station that wants to show the real line has to
// be told it. Both columns are display facts: the station never opens a serial port.
export const MIGRATION_009 = `
ALTER TABLE transceivers ADD COLUMN serial_port TEXT;
ALTER TABLE transceivers ADD COLUMN serial_speed INTEGER;
`;

// Which interface was used last (decision 40). A station may have several rigctld instances —
// one per rig, or one per serial line — and the header has to show one of them. "Last used"
// is a fact the station can keep without a setting table: it is bumped whenever an interface
// is created, edited or switched on, and the most recent one is the current interface.
export const MIGRATION_010 = `
ALTER TABLE transceivers ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;
`;

// Which gateways this station has called, and how often (decision 44). The RMS catalogue is
// not the whole of Winlink: an operator who types a callsign and a dial from a bulletin or a
// sked has found a gateway the catalogue may not list, and the station should not make him
// remember the number. The pair is the key — one gateway on two dials is two entries — and
// `uses` is the rank: a gateway called every night outranks one tried once.
export const MIGRATION_011 = `
CREATE TABLE session_targets (
  id           INTEGER PRIMARY KEY,
  callsign     TEXT    NOT NULL,
  frequency_hz INTEGER NOT NULL,
  uses         INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX session_targets_pair ON session_targets (callsign COLLATE NOCASE, frequency_hz);
CREATE INDEX session_targets_rank ON session_targets (uses DESC, last_used_at DESC);
`;

// The digital mode belongs to the entry (decision 49). The same gateway on the same dial can be
// reached with VARA or with ARDOP, and which one was used is half of what the operator chose, so
// the mode joins the key: the same pair reached two ways is two entries, ranked apart, and
// picking one puts the mode back in the form. Entries recorded before this column existed keep
// an empty mode, which the next successful use fills in rather than leaving a duplicate behind.
export const MIGRATION_012 = `
ALTER TABLE session_targets ADD COLUMN kind TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS session_targets_pair;
CREATE UNIQUE INDEX session_targets_pair ON session_targets (callsign COLLATE NOCASE, frequency_hz, kind);
`;

// The kind of session belongs to the entry as well (decision 50). The same station on the same
// dial can be called as a Winlink gateway, as a peer, or as the post office of this station, and
// each is a different conversation — so the session type joins the key beside the mode.
// Entries from before the column keep an empty type and are claimed by the next use.
export const MIGRATION_013 = `
ALTER TABLE session_targets ADD COLUMN session_mode TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS session_targets_pair;
CREATE UNIQUE INDEX session_targets_pair
  ON session_targets (callsign COLLATE NOCASE, frequency_hz, kind, session_mode);
`;

// The post office application's own tables (decision 57). They are applied only when a
// store is opened for the post office, so a client station's database never grows tables
// it has no use for. Two principals that are not accounts: a mailbox is a row in `users`
// (a callsign, its sealed credentials, its folders) and an administrator is one of these —
// a local name and a password, with no callsign and no mailbox (decision 58).
//
// `po_calls` is the station's record of the calls it answered: who called, when, for how
// long, what the exchange did and why it stopped. It is the first place a postmaster looks
// when a user says a message never arrived, and it carries no message content at all.
export const MIGRATION_014 = `
CREATE TABLE administrators (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  pw_hash     TEXT    NOT NULL,
  can_inspect INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX administrators_name ON administrators (name COLLATE NOCASE);

CREATE TABLE po_calls (
  id         INTEGER PRIMARY KEY,
  peer       TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  result     TEXT    NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  received   INTEGER NOT NULL DEFAULT 0,
  reason     TEXT
);
CREATE INDEX po_calls_started ON po_calls (started_at DESC);
`;

/**
 * The version a post office database reaches: the client's schema plus its own tables.
 * A client build refuses a database newer than its own version, which is what stops a
 * client from half-reading a post office's file if the two were ever pointed at one path.
 */
export const POSTOFFICE_SCHEMA_VERSION = 14;
