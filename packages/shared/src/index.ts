// Types shared by the backend and the browser client.
//
// This module must stay free of Node built-ins: the SPA imports it directly
// (via a Vite alias) and must not pull in anything server-only.

export type Role = 'admin' | 'user';

export type FolderKind =
  | 'inbox'
  | 'outbox'
  | 'sent'
  | 'archive'
  | 'trash'
  | 'custom';

/** Folder kinds created for every user, in display order. */
export const DEFAULT_FOLDERS: ReadonlyArray<{ name: string; kind: FolderKind }> = [
  { name: 'INBOX', kind: 'inbox' },
  { name: 'OUTBOX', kind: 'outbox' },
  { name: 'SENT', kind: 'sent' },
  { name: 'ARCHIVE', kind: 'archive' },
  { name: 'TRASH', kind: 'trash' },
];

// Message flags. Stored as an integer bit field.
export const FLAG_UNREAD = 1;
export const FLAG_FLAGGED = 2;
export const FLAG_ANSWERED = 4;
/** IMAP \Deleted: hidden until EXPUNGE removes it. */
export const FLAG_DELETED = 8;
/**
 * Collected by the station over the air (a post-office session), so the same mail
 * is not offered again. Internal to this station: it has no IMAP name, and the
 * message stays in the mailbox — collecting is not deleting (decision 27).
 */
export const FLAG_COLLECTED = 16;

export interface User {
  id: number;
  role: Role;
  enabled: boolean;
  quotaBytes: number;
  /**
   * The account's identity: its callsign, which is also the login at every door
   * — the browser, POP3, IMAP and SMTP (decision 25). One callsign is one
   * account; `null` only on a row that has not been given one yet.
   */
  callsign: string | null;
  /** Maidenhead grid square of this station, `JO70AA`; the origin of distances. */
  locator: string | null;
  hasPassword: boolean;
  /** Whether the primary callsign has a Winlink (CMS) password stored. */
  hasWinlinkPassword: boolean;
  /**
   * Whether the account has a post-office password stored: the credential a
   * non-Winlink station authenticates with when it collects mail from this
   * post office (decision 27).
   */
  hasPostOfficePassword: boolean;
  /** Whether this account is the post office's owner: the station's own identity. */
  isPostOffice: boolean;
  /** ISO 8601, UTC. */
  createdAt: string;
}

export interface Folder {
  id: number;
  name: string;
  kind: FolderKind;
  uidvalidity: number;
  uidnext: number;
}

export interface FolderWithCounts extends Folder {
  total: number;
  unread: number;
}

export interface AttachmentMeta {
  id: number;
  name: string;
  contentType: string;
  size: number;
}

export interface MessageSummary {
  id: number;
  folderId: number;
  uid: number;
  mid: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** ISO 8601, UTC. */
  date: string;
  size: number;
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
}

export interface MessageDetail extends MessageSummary {
  body: string;
  /** Sanitised HTML body, when the message carried a text/html part. */
  bodyHtml?: string;
  charset: string;
  attachments: AttachmentMeta[];
  headers: Array<[string, string]>;
  peer: string | null;
  direction: 'in' | 'out';
}

/**
 * The client type a Winlink session presents. Measured against a production CMS (HB9AK,
 * 25 Nov 2026): it refuses a client type it does not know — "Unknown client types are not
 * allowed on production servers" — and accepts RMS Express. The exchange is ours; the SID's
 * client field is the only place the claim appears, and it costs nothing a peer can use
 * against the station.
 */
export const WINLINK_CLIENT_IDENTITY = 'RMS Express-1.8.6.0';

/** What rigctld reports about the radio behind it: its identity, its interface, its live readout. */
export interface RadioRig {
  model: string | null;
  /** The Hamlib build answering, and its backend version. */
  hamlib: string | null;
  frequencyHz: number | null;
  mode: string | null;
  /** Filter width in hertz, when the rig reports one. */
  filterHz: number | null;
  /** The IF shift the rig reports in the data mode; 1500 Hz is centred. */
  shiftHz: number | null;
  /** `filterHz` minus how far the shift has moved off centre — what a centred signal can use. */
  usableHz: number | null;
  /** The RFPOWER setting as a fraction of the rig's maximum, 0…1. */
  rfPower: number | null;
  /** True when rigctld answered a query about the rig just now. */
  active: boolean;
}

/**
 * The station's radio interface, as the Radio screen shows it: the address it talks to, the
 * state of that link, and what the radio behind it says about itself. `active` is the
 * radio-to-rigctld side: rigctld may be reachable while the rig is not answering.
 */
export interface RadioStatus {
  interface: { host: string; port: number } | null;
  /** Which connector transmits: the rear input a modem feeds, the front mic, or automatic. */
  pttInput: PttInput | null;
  /**
   * The serial line rigctld serves, as recorded by the operator — device and speed. The
   * protocol never reports either, so this is a note about the daemon, not a reading of it.
   */
  serial: { device: string | null; speed: number | null } | null;
  /** True while the station's own TCP link to rigctld is open. */
  connected: boolean;
  error: string | null;
  rig: RadioRig | null;
}

export interface RadioRequest {
  /** Address or host name; empty means `localhost`. */
  host?: string;
  /** 1…65535; empty means 4532. */
  port?: number;
  /** The serial device rigctld serves, recorded for display; empty means "not recorded". */
  serialPort?: string | null;
  /** Its speed in baud; null or absent means "not recorded". */
  serialSpeed?: number | null;
}

/**
 * What the operator sets on the radio itself, as opposed to where it answers: the power it
 * transmits with, and which connector the audio comes from. Both apply while the link lives;
 * the connector is also stored with the interface, because it is the station's wiring.
 */
export interface RadioPatchRequest {
  /** 0…1 of the rig's maximum. */
  rfPower?: number;
  pttInput?: PttInput;
}

/** The LAN names the station could find for the addresses it talks to, by address. */
export interface HostNamesResponse {
  names: Record<string, string | null>;
}

/** The mail-access protocols a mail program can reach this station through. */
export type MailInterfaceName = 'pop3' | 'smtp' | 'imap';

export const MAIL_INTERFACE_NAMES: readonly MailInterfaceName[] = ['pop3', 'smtp', 'imap'];

/**
 * One mail-access interface, as the operator sees it: whether the configuration offers
 * an address for it at all, whether it is listening now, and why it is not.
 */
export interface MailInterface {
  name: MailInterfaceName;
  /** The configuration names an address: only such an interface can be switched on. */
  configured: boolean;
  /** The bound address while running, the configured one while stopped, null when absent. */
  address: string | null;
  running: boolean;
  /** Why the last attempt to start it failed; null when there was none. */
  error: string | null;
}

/** The three interfaces together, the shape both mail-interface routes answer with. */
export interface MailInterfacesResponse {
  interfaces: MailInterface[];
  /**
   * True when this station has a post office owner. The interfaces belong to the post
   * office: with no owner the station is a Winlink client, they are not started, and only
   * stopping one is allowed.
   */
  postOffice: boolean;
}

export interface MailInterfaceRequest {
  name: MailInterfaceName;
  /** True to start listening, false to stop and close every connection. */
  on: boolean;
}

/**
 * Who may reach the station's doors — the HTTP API and POP3, SMTP and IMAP. `strict`
 * admits loopback and the configured CIDRs; `very strict` admits loopback alone.
 */
export type AccessMode = 'strict' | 'very strict';

/**
 * The access posture as the header needs it. `exposed` is the awkward state: a listener
 * bound beyond loopback while the policy admits only loopback, so the station answers the
 * wire with a refusal — open ports that nobody may use. `listeners` counts the mail doors
 * that are actually listening, because a policy guards nothing while they are all shut.
 */
export interface NetworkAccessSummary {
  mode: AccessMode;
  exposed: boolean;
  /** Mail interfaces listening right now: 0 leaves only the web UI to guard. */
  listeners: number;
  summary: string;
}

/** The full posture, with the CIDRs the operator set and the HTTP listener it applies to. */
export interface NetworkAccess extends NetworkAccessSummary {
  cidrs: string[];
  listen: string;
}

export interface NetworkAccessRequest {
  mode: AccessMode;
  /** Read only for `strict`; blank entries are dropped. */
  cidrs: string[];
}

export interface StatusResponse {
  app: 'rfmail';
  version: string;
  /** 'setup' before the first user exists, 'ready' afterwards. */
  state: 'setup' | 'ready';
  database: string;
  /** Who may reach the station at all; details behind /api/network/access. */
  network: NetworkAccessSummary;
  /** POP3, SMTP and IMAP: one door, three protocols (see MailInterface). */
  mailInterfaces: MailInterface[];
}

export interface Me {
  user: User;
  folders: FolderWithCounts[];
  csrf: string;
  /**
   * True when this session was opened as the post office owner. It is a property of the
   * session, not of the account: the login form asks, and only such a session sees the
   * post office at all. Always false until the post office is built again.
   */
  postOffice: boolean;
}

export interface LoginRequest {
  /** The callsign, in any case: it is the account's one name (decision 25). */
  callsign: string;
  password?: string;
  /**
   * Open the session as the post office owner. The account must hold that role, and the
   * post office must exist: today the request is refused rather than half-granted.
   */
  postOffice?: boolean;
}

export interface SetupRequest {
  /** The station's first account: the callsign, which becomes the login. */
  callsign: string;
}

/**
 * An account a user makes for themselves from the sign-in page, in client mode. The
 * Winlink password is the one thing the station cannot invent: it is what this callsign
 * answers a peer's `;PQ` challenge with, and it is sealed at rest, never hashed or shown.
 */
export interface RegisterRequest {
  callsign: string;
  winlinkPassword: string;
}

export interface CreateUserRequest {
  /** The new account's callsign, which is also its login. */
  callsign: string;
  /** Empty or omitted: the account starts without a password. */
  password?: string;
  role?: Role;
  /** Maidenhead (WW) locator of that station, e.g. `JO70AA`. */
  locator?: string;
}

export interface UpdateUserRequest {
  role?: Role;
  enabled?: boolean;
  /** null clears it; a different value drops the stored Winlink credential. */
  callsign?: string | null;
  /**
   * The post-office password of that account, which an administrator may reset.
   * Stored sealed; the API answers only `hasPostOfficePassword`.
   */
  postOfficePassword?: string | null;
  /** Makes this account the post office's owner; only one account can be. */
  isPostOffice?: boolean;
  /** Maidenhead (WW) locator; null clears it. */
  locator?: string | null;
  quotaBytes?: number;
}

/** A configured modem, as the settings screen shows it. */
export interface Modem {
  id: number;
  name: string;
  kind: ModemKind;
  host: string;
  commandPort: number | null;
  dataPort: number | null;
  kissPort: number | null;
  /** The transceiver mode while this modem runs. */
  rigMode: string;
  /** The transceiver it is wired to, or null when it drives an external one. */
  transceiverId: number | null;
  enabled: boolean;
  createdAt: string;
}

export interface CreateModemRequest {
  name: string;
  kind: ModemKind;
  host: string;
  commandPort?: number | null;
  dataPort?: number | null;
  kissPort?: number | null;
  rigMode?: string;
  transceiverId?: number | null;
}

export interface UpdateModemRequest {
  name?: string;
  kind?: ModemKind;
  host?: string;
  commandPort?: number | null;
  dataPort?: number | null;
  kissPort?: number | null;
  rigMode?: string;
  transceiverId?: number | null;
  enabled?: boolean;
}

/** Which connector the transmitter takes its audio from (R2.2.1). */
export type PttInput = 'rear' | 'front' | 'auto';

export interface TransceiverLink {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  error: string | null;
  frequencyHz: number | null;
  mode: string | null;
  passbandHz: number | null;
  ptt: boolean | null;
  pttValue: number | null;
  fellBackToFront: boolean;
  /** What rigctld says about the radio: its model, its interface, its live readout. */
  rig: RadioRig | null;
  changedAt: string;
}

export interface Transceiver {
  id: number;
  name: string;
  host: string;
  port: number;
  pttInput: PttInput;
  /** The serial device rigctld serves, as recorded; null when not recorded. */
  serialPort: string | null;
  /** Its speed in baud, as recorded; null when not recorded. */
  serialSpeed: number | null;
  /** When this interface was last used; the newest one is the station's current interface. */
  lastUsedAt: string;
  launchCommand: string | null;
  launchArgs: string[];
  idleMode: string;
  idlePassbandHz: number;
  timeoutMs: number;
  enabled: boolean;
  link: TransceiverLink;
}

export interface CreateTransceiverRequest {
  name: string;
  host: string;
  port?: number;
  pttInput?: PttInput;
  serialPort?: string | null;
  serialSpeed?: number | null;
  launchCommand?: string | null;
  launchArgs?: string[];
  idleMode?: string;
  idlePassbandHz?: number;
  timeoutMs?: number;
  enabled?: boolean;
}

export type UpdateTransceiverRequest = Partial<CreateTransceiverRequest>;

/**
 * The amateur bands, in hertz. One table for the whole program: the server decides
 * which band a catalogue channel belongs to, the client decides which unit to show
 * the dial in, and both must agree.
 */
export interface BandRange {
  name: string;
  lowHz: number;
  highHz: number;
}

export const BAND_RANGES: readonly BandRange[] = [
  { name: '160m', lowHz: 1_800_000, highHz: 2_000_000 },
  { name: '80m', lowHz: 3_500_000, highHz: 4_000_000 },
  { name: '60m', lowHz: 5_250_000, highHz: 5_450_000 },
  { name: '40m', lowHz: 7_000_000, highHz: 7_300_000 },
  { name: '30m', lowHz: 10_100_000, highHz: 10_150_000 },
  { name: '20m', lowHz: 14_000_000, highHz: 14_350_000 },
  { name: '17m', lowHz: 18_068_000, highHz: 18_168_000 },
  { name: '15m', lowHz: 21_000_000, highHz: 21_450_000 },
  { name: '12m', lowHz: 24_890_000, highHz: 24_990_000 },
  { name: '10m', lowHz: 28_000_000, highHz: 29_700_000 },
  { name: '6m', lowHz: 50_000_000, highHz: 54_000_000 },
  { name: '2m', lowHz: 144_000_000, highHz: 148_000_000 },
  { name: '70cm', lowHz: 430_000_000, highHz: 450_000_000 }
];

export const BAND_NAMES: readonly string[] = BAND_RANGES.map((band) => band.name);

export function bandOf(frequencyHz: number): string {
  return BAND_RANGES.find((band) => frequencyHz >= band.lowHz && frequencyHz <= band.highHz)?.name ?? 'unknown';
}

/**
 * A client identity in the shape a B2F SID carries: `NAME-VERSION`, as in
 * `[RMS Express-1.8.6.0-B2FHM$]`. The station's own identity is `RF Mail-0.1`; an operator
 * may present another program's instead, and this is the rule that decides whether the
 * string can go into a SID line at all.
 */
export interface ClientIdentity {
  application: string;
  version: string;
}

/**
 * Parses and validates a SID identity. Null means "do not use it": the brackets and the
 * flags share the line, so a name containing `[` or `]`, a control character, or anything
 * that is not `NAME-VERSION` would corrupt the handshake for both stations. Deliberately
 * strict — the version is digits and dots, the name is one to thirty-one printable
 * characters starting with a letter, and one hyphen separates them.
 */
export function parseClientIdentity(value: string): ClientIdentity | null {
  const text = value.trim();
  if (text === '' || text.length > 63) return null;
  if (/[[\]\r\n]/.test(text)) return null;
  const match = /^([A-Za-z][A-Za-z0-9 ._+!?]{0,30})-([0-9]+(?:\.[0-9]+){0,3})$/.exec(text);
  if (!match) return null;
  return { application: match[1]!, version: match[2]! };
}

/**
 * What a modem says it is.
 *
 * VARA, XARA, Data2G and Mercury share the same TCP ports and largely the same command
 * set, so a port number cannot tell them apart — and the digital mode to run (and the
 * transceiver's mode with it) depends on which program is actually answering. `VERSION`
 * is the one command that answers it: VARA returns its own version string, XARA and
 * Mercury answer in the same shape, Data2G names itself (measured: `VERSION Data2G 0.5.3`).
 * Old VARA builds answer `WRONG`; then the program is VARA-dialect but unnamed.
 */
export interface ModemIdentity {
  /** The program that answered, or null when the reply names something we do not know. */
  kind: ModemKind | null;
  /** The words it answered with, for the operator and the log. */
  version: string | null;
  /** The line as it arrived, newlines folded, for the record. */
  line: string;
}

export function parseModemVersion(reply: string): ModemIdentity {
  const line = reply.replace(/[\r\n]+/g, ' ').trim();
  const match = /^VERSION\b\s*(.*)$/i.exec(line);
  if (!match) return { kind: null, version: null, line };
  const version = (match[1] ?? '').trim();
  const upper = version.toUpperCase();
  const kind: ModemKind | null = /DATA\s*-?\s*2\s*G/.test(upper)
    ? 'data2g'
    : /XARA/.test(upper)
      ? 'xara'
      : /VARA\s*FM/.test(upper)
        ? 'vara-fm'
        : /VARA/.test(upper)
          ? 'vara'
          : /MERCURY/.test(upper)
            ? 'mercury'
            : null;
  return { kind, version, line };
}

/**
 * The Winlink catalogue publishes the frequency of a channel's **AF carrier** — the audio
 * centre inside the passband, 1500 Hz above the suppressed carrier — while a transceiver
 * is tuned to the dial frequency. Dialling the published number would put every signal
 * 1.5 kHz off centre in the modem, so a channel is turned into a dial by subtracting it.
 */
export const AF_CARRIER_OFFSET_HZ = 1500;

/** The transceiver dial for a channel the catalogue publishes as an AF carrier. */
export function dialFromCarrier(carrierHz: number): number {
  return Math.max(0, carrierHz - AF_CARRIER_OFFSET_HZ);
}

export function bandContains(band: string, frequencyHz: number): boolean {
  const range = BAND_RANGES.find((entry) => entry.name === band);
  return range ? frequencyHz >= range.lowHz && frequencyHz <= range.highHz : true;
}

/**
 * The modems the station can drive. A modem is a program speaking a TCP interface
 * on this machine or another one; the ports below are the vendor defaults, not
 * guesses: ARDOP's TNC listens on 8515 for its single host interface, VARA and
 * XARA take commands on 8300 and hand audio data over on 8301, and Direwolf's KISS
 * port is 8001. Data2G and Mercury are left without defaults because their
 * interface is the operator's to declare.
 */
/** What a catalogue channel's mode belongs to: a modulation family. */
export type ModeFamily =
  | 'ardop'
  | 'vara'
  | 'vara-fm'
  | 'pactor'
  | 'packet'
  | 'robust-packet'
  | 'other';

export interface ModemKindInfo {
  kind: ModemKind;
  label: string;
  /**
   * The mode families this modem can work among *ordinary* (PUBLIC) channels. Empty
   * for a modem whose waveform is its own: Data2G and Mercury work no PUBLIC channel
   * at all, only the ones a gateway lists under their own service code.
   */
  families: ModeFamily[];
  commandPort: number | null;
  dataPort: number | null;
  kissPort: number | null;
  /** The transceiver mode the modem expects by default. */
  rigMode: string;
  /**
   * The bandwidths this modem lets you choose, in hertz, or null where they are not
   * recorded. These are the modem's own numbers, not a general VARA set: Data2G takes
   * BW500, BW1200, BW2300 and BW2750, VARA HF 500, 2300 and 2750, ARDOP 200 to 2000.
   */
  bandwidths: number[] | null;
  /**
   * The catalogue service code under which gateways advertise this modem, or null
   * when it has none. `PUBLIC` is the ordinary open-to-all class; `EMCOMM` marks a
   * station that is open for emergency traffic only and is therefore never offered
   * for routine mail.
   */
  serviceCode: string | null;
  /**
   * Every service code this modem may use on top of PUBLIC. A VARA client can work a
   * channel a gateway listed for XARA, because the two speak the same interface; a
   * Data2G client can work only the channels listed for Data2G, because its waveform
   * is not VARA's.
   */
  serviceCodes: string[];
  note: string;
}

export const MODEM_KINDS: readonly ModemKindInfo[] = [
  {
    kind: 'ardop',
    label: 'ARDOP',
    families: ['ardop'],
    bandwidths: [200, 500, 1000, 2000],
    commandPort: 8515,
    dataPort: 8516,
    kissPort: null,
    rigMode: 'PKTUSB',
    serviceCode: null,
    serviceCodes: [],
    note: 'ardopcf or ARDOP_Win: commands on 8515, data on 8516.'
  },
  {
    kind: 'vara',
    label: 'VARA HF',
    families: ['vara'],
    bandwidths: [500, 2300, 2750],
    commandPort: 8300,
    dataPort: 8301,
    kissPort: null,
    rigMode: 'PKTUSB',
    serviceCode: null,
    serviceCodes: ['XARA'],
    note: 'VARA HF: commands on 8300, audio data on 8301.'
  },
  {
    kind: 'vara-fm',
    label: 'VARA FM',
    families: ['vara-fm'],
    bandwidths: [500, 2300, 2750],
    commandPort: 8300,
    dataPort: 8301,
    kissPort: null,
    rigMode: 'FM',
    serviceCode: null,
    serviceCodes: [],
    note: 'VARA FM: commands on 8300, audio data on 8301.'
  },
  {
    kind: 'xara',
    label: 'XARA',
    families: ['vara'],
    bandwidths: [500, 2300, 2750],
    commandPort: 8300,
    dataPort: 8301,
    kissPort: null,
    rigMode: 'PKTUSB',
    serviceCode: 'XARA',
    serviceCodes: ['XARA'],
    note: 'XARA speaks the VARA interface; gateways list channels for it under service code XARA.'
  },
  {
    kind: 'data2g',
    label: 'Data2G',
    families: [],
    // Its host protocol takes BW500, BW1200, BW2300 and BW2750 (data2g/host.py).
    bandwidths: [500, 1200, 2300, 2750],
    commandPort: null,
    dataPort: null,
    kissPort: null,
    rigMode: 'PKTUSB',
    serviceCode: 'DATA2G',
    serviceCodes: ['DATA2G'],
    note: 'Data2G works the channels a gateway lists under service code DATA2G; enter the ports your build listens on.'
  },
  {
    kind: 'mercury',
    label: 'Mercury',
    families: [],
    bandwidths: null,
    commandPort: null,
    dataPort: null,
    kissPort: null,
    rigMode: 'PKTUSB',
    serviceCode: 'MERCURY',
    serviceCodes: ['MERCURY'],
    note: 'Mercury works the channels a gateway lists under service code MERCURY; enter the ports your build listens on.'
  },
  {
    kind: 'direwolf',
    label: 'Direwolf',
    families: [],
    bandwidths: null,
    // AGWPE on 8000, KISS on 8001, and the sound data port on UDP 7355 by default.
    commandPort: 8000,
    dataPort: 7355,
    kissPort: 8001,
    rigMode: 'PKTUSB',
    serviceCode: null,
    serviceCodes: [],
    note: 'Direwolf, the software packet modem: KISS and AGWPE are TCP interfaces with different command sets, and SND carries the channel audio over UDP. Registered here; a session driver for packet radio is not built yet.'
  }
];

/** Transceiver modes rigctld understands, for the mode the modem needs. */
export const RIG_MODES: readonly string[] = [
  'USB',
  'LSB',
  'PKTUSB',
  'PKTLSB',
  'PKTFM',
  'AM',
  'FM',
  'CW',
  'CWR',
  'RTTY',
  'DV'
];

/**
 * The service codes the station asks the catalogue for. `PUBLIC` is the ordinary
 * class; `XARA`, `MERCURY` and `DATA2G` are how gateways list a channel for one of
 * the newer modems; `EMCOMM` marks a station open for emergency traffic only.
 *
 * The emergency class is fetched with the rest so that asking for it costs no
 * second download, but it is filtered out of every list unless the operator ticks
 * the emergency box — routine mail must never be offered such a station first.
 */
export const CATALOGUE_SERVICE_CODES: readonly string[] = [
  'PUBLIC',
  'XARA',
  'MERCURY',
  'DATA2G',
  'EMCOMM'
];

/** The class of stations open only for emergency traffic. */
export const EMCOMM_SERVICE_CODE = 'EMCOMM';

export function modemKindInfo(kind: ModemKind): ModemKindInfo {
  return MODEM_KINDS.find((entry) => entry.kind === kind) ?? MODEM_KINDS[0]!;
}

/**
 * Which configured modems can run a session of a given digital mode.
 *
 * This is not the same question as "which gateways can this modem reach": an ARDOP
 * modem reaches ARDOP gateways, while a Data2G modem also reaches ARDOP gateways —
 * but they are different programs and only one of them is the Data2G modem. The one
 * real equivalence is VARA and XARA, which speak the same interface, so either can
 * run a VARA session.
 */
const SESSIONS_BY_MODEM: Record<ModemKind, ModemKind[]> = {
  ardop: ['ardop'],
  vara: ['vara', 'xara'],
  'vara-fm': ['vara-fm'],
  xara: ['vara', 'xara'],
  data2g: ['data2g'],
  mercury: ['mercury'],
  // Packet radio has no session driver yet, so a Direwolf modem runs nothing for now.
  direwolf: []
};

export function modemsForMode(mode: ModemKind): ModemKind[] {
  return SESSIONS_BY_MODEM[mode] ?? [mode];
}

/** Can a configured modem of this kind run that session mode? */
/**
 * The modem a catalogue channel belongs to.
 *
 * A gateway advertises its waveform in `SupportedModes` (`VARA`, `ARDOP`, …) and, for a
 * modem whose waveform is its own, adds a service code — `DATA2G`, `XARA`, `MERCURY`. The
 * mode string therefore lies about the modem in exactly those cases: `VARA (DATA2G)` is a
 * Data2G channel, and picking it must set Data2G or the session would dial a modem that
 * cannot work the signal. The service code wins; the mode family is the fallback.
 */
export function modemForChannel(family: string, serviceCode: string | null | undefined): ModemKind {
  const code = (serviceCode ?? '').toUpperCase();
  const tagged = MODEM_KINDS.find((entry) => entry.serviceCode !== null && entry.serviceCode === code);
  if (tagged) return tagged.kind;
  if (family === 'vara-fm') return 'vara-fm';
  if (family === 'ardop') return 'ardop';
  return 'vara';
}

export function modemDrivesMode(modem: ModemKind, mode: ModemKind): boolean {
  return modemsForMode(mode).includes(modem);
}

/** One port a modem may expose, with the name and the transport that modem gives it. */
export interface ModemPortSpec {
  field: 'commandPort' | 'dataPort' | 'kissPort';
  /** `CMD`, `DATA`, `KISS`, `AGW`, `SND` — the short form a tile has room for. */
  label: string;
  /** The same port in the form's words: `Command`, `AGWPE`, `Sound (UDP)`. */
  title: string;
  transport: 'TCP' | 'UDP';
}

const COMMAND: ModemPortSpec = { field: 'commandPort', label: 'CMD', title: 'Command', transport: 'TCP' };
const DATA: ModemPortSpec = { field: 'dataPort', label: 'DATA', title: 'Data', transport: 'TCP' };
const KISS: ModemPortSpec = { field: 'kissPort', label: 'KISS', title: 'KISS', transport: 'TCP' };
const AGW: ModemPortSpec = { field: 'commandPort', label: 'AGWPE', title: 'AGWPE', transport: 'TCP' };
const SND: ModemPortSpec = { field: 'dataPort', label: 'SND', title: 'Sound', transport: 'UDP' };

/**
 * The ports one modem has, in the order they are shown. A modem only lists the ports it
 * actually uses: VARA, XARA and ARDOP have a command and a data port and no KISS; Data2G has
 * all three; Direwolf's three are AGWPE and KISS over TCP plus the sound data port over UDP.
 */
export function modemPortsOf(kind: ModemKind): readonly ModemPortSpec[] {
  switch (kind) {
    case 'vara':
    case 'vara-fm':
    case 'xara':
    case 'ardop':
      return [COMMAND, DATA];
    case 'direwolf':
      return [AGW, KISS, SND];
    default:
      // Data2G, Mercury: a build of either can expose all three, so all three are offered.
      return [COMMAND, DATA, KISS];
  }
}

/** The digital modes the station can drive (R3.1). */
export type ModemKind = 'ardop' | 'vara' | 'vara-fm' | 'xara' | 'data2g' | 'mercury' | 'direwolf';

export interface SessionOptions {
  modems: Array<{ kind: ModemKind; label: string; families: string[] }>;
  bands: string[];
}

/** One gateway channel, as the session screen lists it. */
export interface GatewayChannelView {
  callsign: string;
  /** The catalogue's own mode string, e.g. `VARA 2750`. */
  mode: string;
  family: string;
  frequencyHz: number;
  band: string;
  gridsquare: string;
  /** The catalogue class the channel is listed under: PUBLIC, XARA, MERCURY, DATA2G. */
  serviceCode: string;
  distanceKm: number | null;
  /** Initial great-circle bearing in degrees from the operator's locator. */
  bearingDeg: number | null;
  hours: string;
  openNow: boolean;
  baud: string;
  radioRangeKm: number | null;
  lastStatus: string;
  hoursSinceStatus: number | null;
  /** 0…1 estimate: would the path carry data? Band against distance. */
  quality: number;
  /** 0…1 estimate: is the gateway likely to answer? Recency and open hours. */
  reliability: number;
}

export interface GatewayList {
  channels: GatewayChannelView[];
  /** How many channels the filter matches before the limit. */
  total: number;
  fetchedAt: string;
  /** True when the list is older than the refresh interval. */
  stale: boolean;
  source: 'network' | 'cache' | 'none';
  error: string | null;
  /** The account's grid square, the origin of every distance. */
  origin: string | null;
  /** Whether emergency-only stations were included in this answer. */
  includeEmcomm: boolean;
}

/**
 * A gateway this station has called, on the dial it used, and how often (R3.13). The pair is
 * the identity: one gateway reached on two dials is two ways to call it, ranked separately.
 */
export interface SessionTarget {
  callsign: string;
  frequencyHz: number;
  /** The digital mode the session used, or null for an entry recorded before modes were kept. */
  kind: ModemKind | null;
  /** The kind of session that ran there, or null for an entry recorded before types were kept. */
  sessionMode: SessionMode | null;
  uses: number;
  lastUsedAt: number;
}

export interface SessionTargetsResponse {
  targets: SessionTarget[];
}

/** The live view of a running session, carried over `/api/session/ws` (decision 51). */
export type SessionEvent =
  | { t: 'state'; state: 'dialing' | 'connected' | 'exchange' | 'closing' | 'done'; detail: string | null }
  | { t: 'modem'; dir: '>' | '<'; text: string; atMs: number }
  | { t: 'line'; dir: '>' | '<'; text: string; atMs: number }
  /** Data that is not text — a compressed message, a binary block: head bytes and length. */
  | { t: 'hex'; dir: '>' | '<'; hex: string; count: number; atMs: number }
  | { t: 'end'; result: string; message: string };

/** What the one control did: the link was asked to come down, or it was cut. */
export interface SessionStopResponse {
  phase: 'idle' | 'disconnecting' | 'aborted';
}

/** Whether a configured modem is actually listening, as of the last check. */
/** Whether a modem is armed to accept inbound calls (`LISTEN ON`). */
export interface ModemListenRequest {
  on: boolean;
}

export interface ModemListenResponse {
  modemId: number;
  listening: boolean;
  /** What the modem answered, for the operator: `OK`, `WRONG`, or the reason it failed. */
  answer: string;
}

export interface ModemStatus {
  id: number;
  running: boolean;
  error: string | null;
  /**
   * The program whose `VERSION` came back on the command port, when it named itself.
   * Ports are shared by VARA, XARA, Data2G and Mercury, so this is the only reliable way
   * to know which modem a session will actually talk to.
   */
  reportedKind?: ModemKind | null;
  /** Its version words, e.g. "Data2G 0.5.3". */
  reportedVersion?: string | null;
  /** The record says one thing and the program on the port another. */
  mismatch?: boolean;
  /**
   * Whether this modem has been armed for inbound calls from here, or null when nothing
   * has asked it yet. It is the last value we set, not a reading: the host protocol has
   * no command that queries listening.
   */
  listening?: boolean | null;
}

export interface ModemStatusResponse {
  statuses: ModemStatus[];
  checkedAt: string;
}

/** A connect test: dial the gateway, report what the modem said, hang up. */
export interface SessionTestRequest {
  modemId: number;
  /** The gateway callsign. */
  target: string;
  /** The dial frequency, in hertz, that the transceiver is tuned to first. */
  frequencyHz: number;
  /** Wanted bandwidth in hertz; taken from the chosen channel's mode. */
  bandwidthHz?: number;
}

export type SessionTestResult = 'connected' | 'failed' | 'error' | 'cancelled';

export interface SessionTestResponse {
  result: SessionTestResult;
  message: string;
  /** The modem's own lines, in order. */
  log: string[];
  elapsedMs: number;
  modemName: string;
  transceiverName: string | null;
  frequencyHz: number;
  bandwidthHz: number;
  /** What the radio reported after being tuned, when it could be read. */
  rig: { frequencyHz: number; mode: string } | null;
}

/**
 * What the far end is, and therefore how the session is run: a Winlink gateway, another
 * operator's station, or a post office that holds mail instead of relaying.
 */
export type SessionMode = 'cms' | 'p2p' | 'postoffice';

export interface SessionRunRequest extends SessionTestRequest {
  /** Defaults to `cms`: a Winlink RMS gateway or the CMS. */
  mode?: SessionMode;
  /** The id of the live view this session reports to (decision 51). */
  streamId?: string;
}

/** One protocol line of a session, in the direction it travelled. */
export interface SessionLogLine {
  direction: '>' | '<';
  text: string;
}

export interface SessionRunResponse {
  /** `complete` when both sides quit; the exchange itself succeeded. */
  result: 'complete' | 'failed' | 'aborted' | 'error';
  message: string;
  /** How the dial ended: only `connected` puts the call in what was called before (R3.13). */
  dialResult: 'connected' | 'failed' | 'error' | 'cancelled' | null;
  /** MIDs transmitted and moved to SENT. */
  sent: string[];
  /** MIDs that arrived and are now in INBOX. */
  received: string[];
  /** MIDs the peer asked to be offered again; they stay in OUTBOX. */
  deferred: string[];
  /** MIDs that arrived damaged, with the reason. */
  failed: Array<{ mid: string; reason: string }>;
  /** What the modem said while dialling. */
  dialLog: string[];
  /** The B2 exchange, line by line. */
  log: SessionLogLine[];
  remoteSid: string;
  elapsedMs: number;
  modemName: string;
  transceiverName: string | null;
  frequencyHz: number;
  bandwidthHz: number;
  rig: { frequencyHz: number; mode: string } | null;
}

export interface UpdateAccountRequest {
  /** The single session callsign; null clears it. */
  callsign?: string | null;
  /**
   * The Winlink secure-login password, which is not the mail password: the CMS
   * asks for it during a radio session. Empty string or null clears it.
   */
  winlinkPassword?: string | null;
  /**
   * The post-office password: what a station without a Winlink password answers
   * this station's `;PQ` challenge with (decision 27). Empty string or null
   * clears it. Stored sealed, never returned.
   */
  postOfficePassword?: string | null;
  /** Only an administrator sets this; it is the station's own post-office identity. */
  isPostOffice?: boolean;
  /** Maidenhead grid square of this station; null clears it. */
  locator?: string | null;
}

/**
 * Arming the post office: it answers calls on one modem, on one dial frequency,
 * as the owner account's callsign. The mode is the modem's own rig mode.
 */
export interface ArmPostOfficeRequest {
  modemId: number;
  /** The dial frequency in hertz (the station's carrier, not the AF centre). */
  frequencyHz: number;
}

/** An inbound session the post office ran or is running. */
export interface PostOfficeSession {
  peer: string;
  startedAt: string;
  elapsedMs: number;
  /** null while the session is still up. */
  result: 'complete' | 'failed' | 'aborted' | 'error' | null;
  sent: number;
  received: number;
  reason: string | null;
}

export interface PostOfficeStatus {
  armed: boolean;
  /** A call is up right now, as opposed to merely listening. */
  busy: boolean;
  /** The accounting owning the station's post-office identity, or null. */
  owner: string | null;
  modemId: number | null;
  modemName: string | null;
  frequencyHz: number | null;
  /** Why it stopped, when it is not armed after being armed once. */
  error: string | null;
  /** The session in progress, or the most recent finished ones, newest first. */
  sessions: PostOfficeSession[];
}

export interface PasswordRequest {
  /** Required when the account already has a password and the caller sets their own. */
  currentPassword?: string;
  /** Empty string clears the password. */
  password: string;
}

export interface ComposeRequest {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments?: Array<{ name: string; contentType: string; dataBase64: string }>;
}

export interface PatchMessageRequest {
  unread?: boolean;
  flagged?: boolean;
  answered?: boolean;
  folderId?: number;
}

export interface MessageListResponse {
  messages: MessageSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface ApiError {
  error: string;
  /** Present for a 401 that needs a password before the login can proceed. */
  passwordRequired?: boolean;
  /** Field-level validation messages, keyed by field name. */
  fields?: Record<string, string>;
}

export interface Logger {
  /** Optional: only the backend's own logger emits trace detail. */
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** RFC 2047 / address helpers are the backend's job; these stay textual. */
export function isB2FMid(value: string): boolean {
  return /^[A-Z2-7]{3,12}$/.test(value);
}

// -- the post office application (decision 57) ------------------------------
//
// Two principals, and neither is the other (decision 58): a *mailbox* is a callsign
// with its sealed credentials and its folders — it never signs in to a browser — and
// an *administrator* is a person with a local password and no callsign. The types
// below keep the two apart all the way to the screen, so no view can offer a mailbox
// a login or an administrator a mailbox.

/** The station as the post office sees itself before anybody signs in. */
export interface PoStatus {
  app: string;
  version: string;
  /** `setup` until the first administrator and the station callsign exist. */
  state: 'setup' | 'ready';
  /** The callsign the station answers as, or null before setup. */
  callsign: string | null;
}

export interface PoAdministrator {
  id: number;
  name: string;
  /** The separate permission to read other mailboxes' envelope metadata (default off). */
  canInspect: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface PoMe {
  administrator: PoAdministrator;
  /** The station's identity, which is a mailbox — not the signed-in person. */
  callsign: string | null;
  csrf: string;
}

export interface CreatePoAdministratorRequest {
  name: string;
  password: string;
  canInspect?: boolean;
}

export interface UpdatePoAdministratorRequest {
  enabled?: boolean;
  canInspect?: boolean;
  password?: string;
}

/** One mailbox the station holds mail for: a callsign, never a person's login. */
export interface PoMailbox {
  id: number;
  callsign: string;
  enabled: boolean;
  quotaBytes: number;
  /** Bytes its messages and attachments occupy. */
  bytes: number;
  messages: number;
  /** Whether a post-office password is set (never the value). */
  hasPassword: boolean;
  createdAt: number;
  /** The mailbox the station answers as; it cannot be deleted. */
  isStation: boolean;
}

export interface CreatePoMailboxRequest {
  callsign: string;
  /** The post-office password; sealed, verified by recomputation, never returned. */
  password?: string;
  quotaBytes?: number;
}

export interface UpdatePoMailboxRequest {
  enabled?: boolean;
  /** Set or replace the post-office password. */
  password?: string;
  quotaBytes?: number;
}

/** The first start: the station's callsign and the first administrator, in one act. */
export interface PoSetupRequest {
  callsign: string;
  name: string;
  password: string;
  locator?: string;
}

export interface PoLoginRequest {
  name: string;
  password: string;
}

/** One call the station answered, as the record keeps it (decision 66). */
export interface PoCall {
  id: number;
  peer: string;
  /** Epoch milliseconds, UTC. */
  startedAt: number;
  elapsedMs: number;
  result: 'complete' | 'failed' | 'aborted';
  sent: number;
  received: number;
  reason: string | null;
}

/** The station screen: what is armed, what it is doing, and what it has heard. */
export interface PoStation {
  callsign: string | null;
  armed: boolean;
  busy: boolean;
  modemId: number | null;
  modemName: string | null;
  frequencyHz: number | null;
  /** Why the modem stopped listening, when it is not armed after being armed once. */
  error: string | null;
  /** The call in progress (a session that has not finished), or null. */
  current: PostOfficeSession | null;
  /** The modems the station can answer on. */
  modems: Array<{ id: number; name: string; kind: string; host: string; commandPort: number | null; dataPort: number | null }>;
  recent: PoCall[];
}

export interface PoArmRequest {
  modemId: number;
  /** Recorded for the report; the radio is tuned by the operator until rig control lands. */
  frequencyHz?: number;
}

export interface PoCallsResponse {
  calls: PoCall[];
}
