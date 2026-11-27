// HTTP API for the web client.
//
// Authentication is a signed session cookie; every state-changing route also
// requires the CSRF nonce from the session, echoed in X-CSRF-Token. Routes are
// registered explicitly, so a new endpoint has to say whether it wants a user.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  DEFAULT_FOLDERS,
  FLAG_ANSWERED,
  FLAG_FLAGGED,
  FLAG_UNREAD,
  WINLINK_CLIENT_IDENTITY,
  type ArmPostOfficeRequest,
  type ComposeRequest,
  type CreateUserRequest,
  type FolderWithCounts,
  type LoginRequest,
  type MailInterfaceRequest,
  type Me,
  type MessageDetail,
  type MessageListResponse,
  type MessageSummary,
  type Modem,
  type CreateModemRequest,
  type UpdateModemRequest,
  MODEM_KINDS,
  modemKindInfo,
  RIG_MODES,
  type ModemKind,
  type PatchMessageRequest,
  type PasswordRequest,
  type PostOfficeStatus,
  type HostNamesResponse,
  type RadioPatchRequest,
  type RadioRequest,
  type RadioStatus,
  type RegisterRequest,
  type ModemListenRequest,
  type NetworkAccess,
  type NetworkAccessRequest,
  type NetworkAccessSummary,
  type SessionMode,
  type SessionRunRequest,
  type SessionTargetsResponse,
  type SessionTestRequest,
  type SetupRequest,
  type CreateTransceiverRequest,
  type StatusResponse,
  type Transceiver,
  type UpdateAccountRequest,
  type UpdateTransceiverRequest,
  type UpdateUserRequest,
  type User,
} from '@rfmail/shared';
import {
  addressOnly,
  canonicaliseAddressList,
  composeMessage,
  splitAddressList,
  toWinlinkAddress,
  toWinlinkHeader,
  generateMid,
  serialiseRfc822,
  validateMessage,
  type MailMessage,
} from '@rfmail/core-b2f';
import {
  hashPassword,
  verifyPassword,
  type CreateTransceiverInput,
  type TransceiverRecord,
  type MessageEnvelope,
  type MessageRecord,
  type Store,
  type UserRecord,
} from '@rfmail/store';
import type { CreateModemInput, ModemRecord } from '@rfmail/store';
import type { PostOffice } from './postoffice.ts';
import { lookupHostName } from './hostnames.ts';
import { findUserByCredential, isLoopback, type MailEvents, type MailInterfaces, type PeerPolicy } from '@rfmail/mailservers';
import type { TransceiverConfig, TransceiverLinks } from '@rfmail/rig';
import { sanitiseHtml } from './html.ts';
import { SESSION_COOKIE, parseCookies, type Sessions } from './auth.ts';
import { SessionStreams } from './session-stream.ts';
import { openSecret, sealSecret } from './secrets.ts';
import { bandwidthOfMode, dialModem, identifyModem, probeModem, setModemListening } from './modem-dial.ts';
import { runSession } from './session-run.ts';
import {
  MODEM_FAMILIES,
  MODEM_LABELS,
  BAND_NAMES,
  fetchCatalogue,
  gridsquareToLatLon,
  selectChannels,
} from './catalogue.ts';
import { HttpError, Router, readJson, sendBytes, sendError, sendJson, type Ctx, type Handler } from './http.ts';
import { normaliseCallsign, normaliseLocator } from './callsign.ts';
import { createStaticHandler } from './static.ts';
import type { Logger } from '@rfmail/shared';

export const APP_VERSION = '0.1.0';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
/** Self-registration is public to whoever the access policy admits; the rate is not. */
const REGISTRATION_WINDOW_MS = 10 * 60_000;
const REGISTRATION_MAX = 5;

export interface ApiServices {
  store: Store;
  sessions: Sessions;
  policy: PeerPolicy;
  logger: Logger;
  events: MailEvents;
  uiDir: string;
  /** The address the HTTP listener was asked to bind, for the access posture. */
  httpListen: string;
  /** POP3, SMTP and IMAP, with a switch on each; see mailservers/interfaces.ts. */
  mailInterfaces: MailInterfaces;
  secureCookies: boolean;
  /** Seals Winlink passwords at rest; see secrets.ts. */
  storeKey: string;
  /** Live rig links; configuration lives in the store, connection state here. */
  links: TransceiverLinks;
  /** The answering half of the B2F exchange: a running post office, if any. */
  postOffice: PostOffice;
  /** Directory holding the cached Winlink gateway catalogue; null disables the cache. */
  cacheDir?: string | null;
}

interface AuthedContext extends Ctx {
  user: UserRecord;
}

function isAuthed(ctx: Ctx): ctx is AuthedContext {
  return ctx.user !== undefined;
}

// ---------------------------------------------------------------------------
// DTO mapping

function toUser(user: UserRecord): User {
  return {
    id: user.id,
    role: user.role,
    enabled: user.enabled,
    quotaBytes: user.quotaBytes,
    callsign: user.callsign,
    locator: user.locator,
    hasPassword: user.pwHash !== null,
    hasWinlinkPassword: user.winlinkSecret !== null,
    hasPostOfficePassword: user.postOfficeSecret !== null,
    isPostOffice: user.isPostOffice,
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

function toSummary(message: MessageEnvelope): MessageSummary {
  return {
    id: message.id,
    folderId: message.folderId,
    uid: message.uid,
    mid: message.mid,
    from: toWinlinkHeader(message.from),
    to: message.to.map((address) => toWinlinkAddress(addressOnly(address))),
    cc: message.cc.map((address) => toWinlinkAddress(addressOnly(address))),
    subject: message.subject,
    date: new Date(message.dateUtc).toISOString(),
    size: message.size,
    unread: (message.flags & FLAG_UNREAD) !== 0,
    flagged: (message.flags & FLAG_FLAGGED) !== 0,
    answered: (message.flags & FLAG_ANSWERED) !== 0,
    hasAttachments: message.attachmentCount > 0,
    attachmentCount: message.attachmentCount,
  };
}

function toDetail(message: MessageRecord): MessageDetail {
  return {
    ...toSummary(message),
    body: message.body,
    charset: message.charset,
    attachments: message.attachments.map((a) => ({
      id: a.id,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
    })),
    headers: message.headers,
    peer: message.peer,
    direction: message.direction,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers

function requireLogin(ctx: Ctx): AuthedContext {
  if (!isAuthed(ctx)) throw new HttpError(401, 'authentication required');
  return ctx;
}

function requireCsrf(ctx: Ctx): void {
  const token = ctx.req.headers['x-csrf-token'];
  const provided = Array.isArray(token) ? token[0] : token;
  if (!ctx.session || !provided || provided !== ctx.session.csrf) {
    throw new HttpError(403, 'invalid CSRF token');
  }
}

function requireAdmin(ctx: Ctx): AuthedContext {
  const authed = requireLogin(ctx);
  if (authed.user.role !== 'admin') throw new HttpError(403, 'administrator role required');
  return authed;
}

/**
 * The post office is a seat taken at the door, not an account's property (decision 32):
 * a session opened from the sign-in form's "post office owner" box, and no other, reaches
 * its routes. The seat is closed while the post office is shelved, so today this always
 * refuses — the guard is here so that nothing else can quietly become the post office.
 */
function requirePostOffice(ctx: Ctx): AuthedContext {
  const authed = requireLogin(ctx);
  if (ctx.session?.postOffice !== true) {
    throw new HttpError(403, 'the post office is not open in this session');
  }
  return authed;
}

function requireCallsign(value: unknown): string {
  // The account's identity is the callsign (decision 25), so the field is both the
  // login and the station: one validator, and a missing value is a refusal, never a
  // guessed name.
  const callsign = normaliseCallsign(value);
  if (!callsign) {
    throw new HttpError(400, 'a callsign is required', { callsign: 'required' });
  }
  return callsign;
}

// ---------------------------------------------------------------------------

/** A stored transceiver as the rig client wants it; the start-up radio loop uses it too. */
export const transceiverConfigOf = (record: TransceiverRecord): TransceiverConfig => ({
  id: record.id,
  name: record.name,
  host: record.host,
  port: record.port,
  pttInput: record.pttInput,
  launchCommand: record.launchCommand,
  launchArgs: record.launchArgs,
  idleMode: record.idleMode,
  idlePassbandHz: record.idlePassbandHz,
  timeoutMs: record.timeoutMs,
});

export function createApi(services: ApiServices): {
  router: Router;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** The WebSocket upgrade for a running session's live view (decision 51). */
  handleUpgrade: (req: IncomingMessage, socket: Duplex) => Promise<void>;
  loginAttempts: Map<string, { count: number; resetAt: number }>;
} {
  const { store, sessions, policy, logger, storeKey, links, postOffice } = services;
  const router = new Router();
  /** Live session views, keyed by the id the screen made up before it started (decision 51). */
  const streams = new SessionStreams();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const registrations = new Map<string, { count: number; resetAt: number }>();

  const meResponse = async (uid: number, csrf: string, postOffice = false): Promise<Me> => {
    const user = await store.getUser(uid);
    if (!user) throw new HttpError(401, 'account no longer exists');
    const folders: FolderWithCounts[] = (await store.listFolders(uid)).map((folder) => ({
      id: folder.id,
      name: folder.name,
      kind: folder.kind,
      uidvalidity: folder.uidvalidity,
      uidnext: folder.uidnext,
      total: folder.total,
      unread: folder.unread,
    }));
    return { user: toUser(user), folders, csrf, postOffice };
  };

  // -- network access --------------------------------------------------------

  /** `host:port` to `host`, bracketed IPv6 included. */
  const hostOf = (address: string): string => {
    const trimmed = address.trim();
    if (trimmed.startsWith('[')) {
      const end = trimmed.indexOf(']');
      return end === -1 ? trimmed : trimmed.slice(1, end);
    }
    const index = trimmed.lastIndexOf(':');
    return index === -1 ? trimmed : trimmed.slice(0, index);
  };

  /**
   * The posture as one answer. `exposed` is the state worth a warning: some listener is
   * bound beyond loopback while the policy admits only loopback, so the station answers
   * the network with a refusal — ports open, nobody admitted, usually two settings made
   * with different intentions.
   */
  const networkAccess = (): NetworkAccess => {
    const interfaces = services.mailInterfaces.status();
    const addresses = [
      services.httpListen,
      ...interfaces.filter((entry) => entry.running).map((entry) => entry.address ?? ''),
    ];
    const exposed =
      policy.mode === 'very strict' &&
      addresses.some((address) => address !== '' && !isLoopback(hostOf(address)));
    return {
      mode: policy.mode,
      cidrs: policy.cidrs,
      listen: services.httpListen,
      listeners: interfaces.filter((entry) => entry.running).length,
      exposed,
      summary: policy.describe(),
    };
  };

  const networkSummary = (): NetworkAccessSummary => {
    const { mode, exposed, listeners, summary } = networkAccess();
    return { mode, exposed, listeners, summary };
  };

  // -- public ---------------------------------------------------------------

  router.add('GET', '/api/status', async (ctx) => {
    const users = await store.countUsers();
    const status: StatusResponse = {
      app: 'rfmail',
      version: APP_VERSION,
      state: users === 0 ? 'setup' : 'ready',
      database: 'sqlite',
      network: networkSummary(),
      mailInterfaces: services.mailInterfaces.status(),
    };
    sendJson(ctx.res, 200, status);
  });

  /**
   * The three mail-access interfaces behind one switch each. They serve mail programs, so
   * they belong to the post office: a station used as a Winlink client does not listen at
   * all, and the switches refuse to start one. Stopping is always allowed — an interface
   * left listening must be closable even after the post office is unseated.
   */
  router.add('GET', '/api/mail/interfaces', async (ctx) => {
    requireLogin(ctx);
    sendJson(ctx.res, 200, {
      interfaces: services.mailInterfaces.status(),
      postOffice: (await store.findPostOfficeOwner()) !== null,
    });
  });

  router.add('POST', '/api/mail/interfaces', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<MailInterfaceRequest>(ctx.req);
    const name = body.name;
    if (name !== 'pop3' && name !== 'smtp' && name !== 'imap') {
      throw new HttpError(400, 'name must be pop3, smtp or imap', { name: 'invalid' });
    }
    const on = body.on === true;
    const postOffice = (await store.findPostOfficeOwner()) !== null;
    if (on && !postOffice) {
      throw new HttpError(
        409,
        'the mail interfaces belong to the post office; this station is a Winlink client',
        { name: 'post office' },
      );
    }
    let switched;
    try {
      switched = await services.mailInterfaces.set(name, on);
    } catch (err) {
      // Only a protocol the configuration does not offer lands here.
      throw new HttpError(409, err instanceof Error ? err.message : String(err), { name: 'not configured' });
    }
    logger.info('mail interface switched', {
      interface: name,
      on,
      running: switched.running,
      error: switched.error,
      by: authed.user.callsign,
    });
    sendJson(ctx.res, 200, {
      interfaces: services.mailInterfaces.status(),
      postOffice,
    });
  });

  /**
   * Who may reach the station at all — the HTTP API and the three mail doors together.
   * Reading it is what any signed-in operator may do; changing it is an administrator's
   * act, because it decides who may reach every door at once, and a user who shut the LAN
   * out would shut the other users out with it. The change is runtime: the configuration
   * file decides again at the next start.
   */
  router.add('GET', '/api/network/access', async (ctx) => {
    requireLogin(ctx);
    sendJson(ctx.res, 200, networkAccess());
  });

  router.add('POST', '/api/network/access', async (ctx) => {
    const authed = requireAdmin(ctx);
    requireCsrf(ctx);
    const body = await readJson<NetworkAccessRequest>(ctx.req);
    const mode = body.mode;
    if (mode !== 'strict' && mode !== 'very strict') {
      throw new HttpError(400, 'mode must be "strict" or "very strict"', { mode: 'invalid' });
    }
    const raw = Array.isArray(body.cidrs) ? body.cidrs : [];
    if (raw.some((entry) => typeof entry !== 'string')) {
      throw new HttpError(400, 'cidrs must be a list of addresses', { cidrs: 'invalid' });
    }
    try {
      policy.set(mode, raw as string[]);
    } catch (err) {
      // The same rule as start-up: an invalid CIDR, or strict without one, changes nothing.
      throw new HttpError(400, err instanceof Error ? err.message : String(err), { cidrs: 'invalid' });
    }
    const after = networkAccess();
    logger.warn('access policy changed', {
      mode: after.mode,
      cidrs: after.cidrs,
      exposed: after.exposed,
      by: authed.user.callsign,
    });
    sendJson(ctx.res, 200, after);
  });

  router.add('POST', '/api/setup', async (ctx) => {
    if ((await store.countUsers()) > 0) {
      throw new HttpError(409, 'the first account has already been created');
    }
    const body = await readJson<SetupRequest>(ctx.req);
    const callsign = requireCallsign(body.callsign);
    const user = await store.createUser({ callsign, pwHash: null, role: 'admin' });
    const { token, payload } = sessions.issue(user.id);
    ctx.res.setHeader('Set-Cookie', sessions.cookieHeader(token, services.secureCookies));
    logger.info('first account created', { callsign, remote: ctx.remote });
    sendJson(ctx.res, 201, await meResponse(user.id, payload.csrf));
  });

  /**
   * An account made by its owner at the sign-in page (decision 34). The Winlink password
   * is what this callsign answers a peer's `;PQ` challenge with, so it is required — a
   * mailbox that cannot authenticate cannot collect mail — and it is sealed, never hashed
   * and never returned. The account is a plain client account: the callsign is the login,
   * no local password is set here, and it is never the post office.
   */
  router.add('POST', '/api/accounts', async (ctx) => {
    const now = Date.now();
    const seen = registrations.get(ctx.remote);
    if (seen && seen.resetAt > now && seen.count >= REGISTRATION_MAX) {
      throw new HttpError(429, 'too many accounts created from this address, try again later');
    }
    const body = await readJson<RegisterRequest>(ctx.req);
    const callsign = requireCallsign(body.callsign);
    const password = typeof body.winlinkPassword === 'string' ? body.winlinkPassword : '';
    if (password.trim() === '') {
      throw new HttpError(400, 'the Winlink password is required', { winlinkPassword: 'required' });
    }
    if (password.length > 128) {
      throw new HttpError(400, 'the Winlink password is too long', { winlinkPassword: 'too long' });
    }
    // The callsign is the account (decision 25): two mailboxes for one callsign would make
    // every address ambiguous, so an existing one is a refusal, not a second account.
    await assertCallsignFree(store, callsign, 0);
    const created = await store.createUser({ callsign, pwHash: null, role: 'user' });
    if (!(await store.setWinlinkSecret(created.id, sealSecret(password, storeKey)))) {
      // No callsign could be set: leave nothing half-made behind.
      await store.deleteUser(created.id);
      throw new HttpError(500, 'the account could not be given its Winlink password');
    }
    if (!seen || seen.resetAt <= now) registrations.set(ctx.remote, { count: 1, resetAt: now + REGISTRATION_WINDOW_MS });
    else seen.count += 1;
    const { token, payload } = sessions.issue(created.id);
    ctx.res.setHeader('Set-Cookie', sessions.cookieHeader(token, services.secureCookies));
    logger.info('account created by its owner', { callsign, remote: ctx.remote });
    sendJson(ctx.res, 201, await meResponse(created.id, payload.csrf));
  });

  router.add('POST', '/api/login', async (ctx) => {
    const body = await readJson<LoginRequest>(ctx.req);
    // The sign-in name is the callsign; any case is accepted (decision 25).
    const name = typeof body.callsign === 'string' ? body.callsign.trim() : '';
    if (!name) throw new HttpError(400, 'callsign required', { callsign: 'required' });

    const now = Date.now();
    const attempt = loginAttempts.get(ctx.remote);
    if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_MAX_ATTEMPTS) {
      throw new HttpError(429, 'too many failed attempts, try again in a minute');
    }

    const fail = (): never => {
      const record = loginAttempts.get(ctx.remote);
      if (!record || record.resetAt <= now) {
        loginAttempts.set(ctx.remote, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      } else {
        record.count += 1;
      }
      throw new HttpError(401, 'invalid login', {});
    };

    const user = await findUserByCredential(store, name);
    if (!user || !user.enabled) {
      fail();
      return;
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (user.pwHash !== null && !password) {
      throw new HttpError(401, 'this account has a password', undefined, {
        passwordRequired: true,
      });
    }
    // An account without a password takes an empty one and nothing else: skipping
    // the check would let any typed string through, which is not what "no
    // password" means on an instance reachable from the LAN.
    if (!verifyPassword(password, user.pwHash)) {
      fail();
      return;
    }
    loginAttempts.delete(ctx.remote);
    // The post office is a separate seat at this station, and the login form asks for it
    // (decision 32). Until the post office is built again the request is refused outright:
    // half-granting it would show a screen that cannot work.
    if (body.postOffice === true) {
      throw new HttpError(
        409,
        'the post office is not available yet: this station is a Winlink client',
        { postOffice: 'unavailable' },
      );
    }
    const { token, payload } = sessions.issue(user.id);
    ctx.res.setHeader('Set-Cookie', sessions.cookieHeader(token, services.secureCookies));
    logger.info('login', { callsign: user.callsign ?? user.login, remote: ctx.remote });
    sendJson(ctx.res, 200, await meResponse(user.id, payload.csrf, payload.postOffice === true));
  });

  router.add('POST', '/api/logout', async (ctx) => {
    ctx.res.setHeader('Set-Cookie', sessions.clearCookieHeader(services.secureCookies));
    sendJson(ctx.res, 200, { ok: true });
  });

  // -- session --------------------------------------------------------------

  router.add('GET', '/api/me', async (ctx) => {
    const authed = requireLogin(ctx);
    sendJson(ctx.res, 200, await meResponse(authed.user.id, ctx.session?.csrf ?? ''));
  });

  router.add('GET', '/api/folders', async (ctx) => {
    const authed = requireLogin(ctx);
    const folders = await store.listFolders(authed.user.id);
    sendJson(ctx.res, 200, folders);
  });

  router.add('POST', '/api/folders', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<{ name?: string }>(ctx.req);
    const name = (body.name ?? '').trim();
    if (!name || name.length > 64) {
      throw new HttpError(400, 'folder name required (max 64 characters)', { name: 'invalid' });
    }
    if (DEFAULT_FOLDERS.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, 'that folder name is reserved', { name: 'reserved' });
    }
    if (await store.findFolder(authed.user.id, name)) {
      throw new HttpError(409, 'a folder with that name exists', { name: 'duplicate' });
    }
    const folder = await store.createFolder(authed.user.id, name, 'custom');
    sendJson(ctx.res, 201, folder);
  });

  router.add('GET', '/api/folders/:id/messages', async (ctx) => {
    const authed = requireLogin(ctx);
    const folderId = Number(ctx.params['id']);
    const folder = await store.getFolder(authed.user.id, folderId);
    if (!folder) throw new HttpError(404, 'folder not found');
    const offset = Number(ctx.url.searchParams.get('offset') ?? '0');
    const limit = Number(ctx.url.searchParams.get('limit') ?? '50');
    // `OK4RM@winlink.org` in the search box finds the stored `OK4RM`; any other
    // text passes through unchanged.
    const search = toWinlinkAddress(ctx.url.searchParams.get('search') ?? '');
    const list = await store.listMessages(authed.user.id, folderId, { offset, limit, search });
    const response: MessageListResponse = {
      messages: list.messages.map(toSummary),
      total: list.total,
      offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
      limit: Number.isFinite(limit) ? limit : 50,
    };
    sendJson(ctx.res, 200, response);
  });

  router.add('GET', '/api/messages/:id', async (ctx) => {
    const authed = requireLogin(ctx);
    const message = await store.getMessage(authed.user.id, Number(ctx.params['id']));
    if (!message) throw new HttpError(404, 'message not found');
    const detail = toDetail(message);
    const htmlPart = message.attachments.find((a) => a.contentType.toLowerCase() === 'text/html');
    if (htmlPart) {
      const found = await store.getAttachment(authed.user.id, message.id, htmlPart.id);
      if (found) detail.bodyHtml = sanitiseHtml(Buffer.from(found.data).toString('utf8'));
    }
    sendJson(ctx.res, 200, detail);
  });

  router.add('POST', '/api/messages', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<ComposeRequest>(ctx.req, MAX_JSON_BYTES);

    const attachments: Array<{ name: string; contentType: string; data: Uint8Array }> = [];
    let attachmentBytes = 0;
    for (const item of body.attachments ?? []) {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const data = typeof item.dataBase64 === 'string' ? Buffer.from(item.dataBase64, 'base64') : Buffer.alloc(0);
      if (!name) throw new HttpError(400, 'attachment needs a name', { attachments: 'name required' });
      attachmentBytes += data.length;
      if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
        throw new HttpError(413, 'attachments exceed the size limit', { attachments: 'too large' });
      }
      attachments.push({
        name,
        contentType: typeof item.contentType === 'string' && item.contentType ? item.contentType : 'application/octet-stream',
        data,
      });
    }

    const sender = authed.user.callsign ?? authed.user.login;
    const message = composeMessage({
      from: toWinlinkAddress(sender),
      to: canonicaliseAddressList(splitAddressList(typeof body.to === 'string' ? body.to : '')).join(', '),
      cc: canonicaliseAddressList(splitAddressList(typeof body.cc === 'string' ? body.cc : '')).join(', '),
      subject: typeof body.subject === 'string' ? body.subject : '',
      body: typeof body.body === 'string' ? body.body : '',
      attachments,
      mid: generateMid(sender),
    });

    const validation = validateMessage(message);
    if (!validation.ok) throw new HttpError(400, 'message is not valid', validation.fields);

    const outbox = await store.findFolder(authed.user.id, 'OUTBOX');
    if (!outbox) throw new HttpError(500, 'OUTBOX folder is missing');
    const inserted = await store.insertMessage(authed.user.id, outbox.id, message, {
      direction: 'out',
      peer: null,
    });
    const stored = await store.getMessage(authed.user.id, inserted.id);
    if (!stored) throw new HttpError(500, 'message could not be stored');
    services.events.notify({ userId: authed.user.id, folderId: outbox.id, folder: outbox.name });
    sendJson(ctx.res, 201, toDetail(stored));
  });

  router.add('PATCH', '/api/messages/:id', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const id = Number(ctx.params['id']);
    const message = await store.getMessage(authed.user.id, id);
    if (!message) throw new HttpError(404, 'message not found');
    const body = await readJson<PatchMessageRequest>(ctx.req);

    let flags = message.flags;
    const set = (bit: number, enabled: boolean | undefined): void => {
      if (enabled === undefined) return;
      flags = enabled ? flags | bit : flags & ~bit;
    };
    set(FLAG_UNREAD, body.unread);
    set(FLAG_FLAGGED, body.flagged);
    set(FLAG_ANSWERED, body.answered);
    if (flags !== message.flags) await store.setFlags(authed.user.id, id, flags);

    if (typeof body.folderId === 'number' && body.folderId !== message.folderId) {
      const moved = await store.moveMessage(authed.user.id, id, body.folderId);
      if (!moved) throw new HttpError(400, 'target folder not found');
    }

    const updated = await store.getMessage(authed.user.id, id);
    if (!updated) throw new HttpError(404, 'message not found');
    sendJson(ctx.res, 200, toDetail(updated));
  });

  router.add('DELETE', '/api/messages/:id', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const id = Number(ctx.params['id']);
    const message = await store.getMessage(authed.user.id, id);
    if (!message) throw new HttpError(404, 'message not found');
    const trash = await store.findFolder(authed.user.id, 'TRASH');
    if (trash && message.folderId !== trash.id) {
      await store.moveMessage(authed.user.id, id, trash.id);
      sendJson(ctx.res, 200, { ok: true, movedToTrash: true });
      return;
    }
    await store.deleteMessage(authed.user.id, id);
    sendJson(ctx.res, 200, { ok: true, movedToTrash: false });
  });

  router.add('GET', '/api/messages/:id/raw', async (ctx) => {
    const authed = requireLogin(ctx);
    const message = await store.getMessage(authed.user.id, Number(ctx.params['id']));
    if (!message) throw new HttpError(404, 'message not found');
    const mail = await loadMailMessage(store, authed.user.id, message);
    const bytes = serialiseRfc822(mail);
    sendBytes(ctx.res, 200, 'message/rfc822', bytes, {
      'Content-Disposition': `attachment; filename="${safeFilename(message.mid)}.eml"`,
    });
  });

  router.add('GET', '/api/messages/:id/attachments/:attachmentId', async (ctx) => {
    const authed = requireLogin(ctx);
    const messageId = Number(ctx.params['id']);
    const attachmentId = Number(ctx.params['attachmentId']);
    const found = await store.getAttachment(authed.user.id, messageId, attachmentId);
    if (!found) throw new HttpError(404, 'attachment not found');
    sendBytes(ctx.res, 200, found.meta.contentType, found.data, {
      'Content-Disposition': `attachment; filename="${safeFilename(found.meta.name)}"`,
    });
  });

  // -- transceivers (R2.2) --------------------------------------------------

  const toTransceiver = (record: TransceiverRecord): Transceiver => {
    const link = links.status(record.id);
    return {
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      pttInput: record.pttInput,
      serialPort: record.serialPort,
      serialSpeed: record.serialSpeed,
      lastUsedAt: new Date(record.lastUsedAt).toISOString(),
      launchCommand: record.launchCommand,
      launchArgs: record.launchArgs,
      idleMode: record.idleMode,
      idlePassbandHz: record.idlePassbandHz,
      timeoutMs: record.timeoutMs,
      enabled: record.enabled,
      link: {
        state: link.state,
        error: link.error,
        frequencyHz: link.frequencyHz,
        mode: link.mode,
        passbandHz: link.passbandHz,
        ptt: link.ptt,
        pttValue: link.pttValue,
        fellBackToFront: link.fellBackToFront,
        rig: link.rig,
        changedAt: new Date(link.changedAt).toISOString(),
      },
    };
  };

  const toModem = (record: ModemRecord): Modem => ({
    id: record.id,
    name: record.name,
    kind: record.kind,
    host: record.host,
    commandPort: record.commandPort,
    dataPort: record.dataPort,
    kissPort: record.kissPort,
    rigMode: record.rigMode,
    transceiverId: record.transceiverId,
    enabled: record.enabled,
    createdAt: new Date(record.createdAt).toISOString(),
  });

  /**
   * Validates a modem's fields. A port is either absent, null, or 1…65535; the kind
   * must be one the station knows; the transceiver must exist, because a modem that
   * names a radio nobody configured cannot be started.
   */
  const modemInput = async (
    target: Store,
    body: Partial<CreateModemRequest | UpdateModemRequest>,
    creating: boolean,
  ): Promise<Partial<CreateModemInput>> => {
    const input: Partial<CreateModemInput> = {};

    if (body.name !== undefined || creating) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) throw new HttpError(400, 'the modem needs a name', { name: 'required' });
      input.name = name;
    }
    if (body.kind !== undefined || creating) {
      const kind = body.kind;
      if (!kind || !MODEM_KINDS.some((entry) => entry.kind === kind)) {
        throw new HttpError(400, 'unknown modem type', { kind: 'invalid' });
      }
      input.kind = kind;
    }
    if (body.host !== undefined || creating) {
      const host = typeof body.host === 'string' ? body.host.trim() : '';
      if (!host) throw new HttpError(400, 'the modem needs a host', { host: 'required' });
      if (!/^[A-Za-z0-9._:-]+$/.test(host)) {
        throw new HttpError(400, `invalid host: ${host}`, { host: 'invalid' });
      }
      input.host = host;
    }

    for (const field of ['commandPort', 'dataPort', 'kissPort'] as const) {
      const raw = body[field];
      if (raw === undefined) continue;
      if (raw === null) {
        input[field] = null;
        continue;
      }
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new HttpError(400, `${field} must be a port number`, { [field]: 'invalid' });
      }
      input[field] = port;
    }

    if (body.rigMode !== undefined) {
      const mode = String(body.rigMode).trim().toUpperCase();
      if (!RIG_MODES.includes(mode)) {
        throw new HttpError(400, `unknown transceiver mode: ${mode}`, { rigMode: 'invalid' });
      }
      input.rigMode = mode;
    }

    if (body.transceiverId !== undefined) {
      if (body.transceiverId === null) {
        input.transceiverId = null;
      } else {
        const id = Number(body.transceiverId);
        const radio = Number.isInteger(id) ? await target.getTransceiver(id) : null;
        if (!radio) throw new HttpError(400, 'that transceiver does not exist', { transceiverId: 'invalid' });
        input.transceiverId = id;
      }
    }

    if ('enabled' in body && body.enabled !== undefined) input.enabled = Boolean(body.enabled);
    return input;
  };

  /** A stored transceiver as the rig client wants it. Shared with the start-up radio loop. */
  const transceiverConfig = transceiverConfigOf;

  /** Validates the fields a create or update carries; unknown keys are ignored. */
  /**
   * A transceiver from a request body. Only the fields the request names are
   * returned, so a PATCH that moves a radio's address cannot blank its name — the
   * shape that always returns every field turns a one-field edit into a wipe.
   * `creating` makes the two required fields required.
   */
  const readTransceiverInput = (
    body: Partial<CreateTransceiverRequest>,
    creating = false,
  ): Partial<CreateTransceiverInput> => {
    const input: Partial<CreateTransceiverInput> = {};
    if (body.name !== undefined || creating) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) throw new HttpError(400, 'a name is required', { name: 'required' });
      input.name = name;
    }
    if (body.host !== undefined || creating) {
      const host = typeof body.host === 'string' ? body.host.trim() : '';
      if (!host) throw new HttpError(400, 'a host is required', { host: 'required' });
      if (host.length > 253 || /\s/.test(host)) {
        throw new HttpError(400, 'that is not an address or a host name', { host: 'invalid' });
      }
      input.host = host;
    }
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new HttpError(400, 'the port must be between 1 and 65535', { port: 'invalid' });
      }
      input.port = port;
    }
    if (body.pttInput !== undefined) {
      if (body.pttInput !== 'rear' && body.pttInput !== 'front' && body.pttInput !== 'auto') {
        throw new HttpError(400, 'choose the rear input, the front connector or automatic', {
          pttInput: 'invalid',
        });
      }
      input.pttInput = body.pttInput;
    }
    if (body.serialPort !== undefined) {
      const device = typeof body.serialPort === 'string' ? body.serialPort.trim() : '';
      if (device.length > 64 || /\s/.test(device)) {
        throw new HttpError(400, 'a serial device is a path or a COM name, with no spaces', {
          serialPort: 'invalid',
        });
      }
      input.serialPort = device || null;
    }
    if (body.serialSpeed !== undefined) {
      if (body.serialSpeed === null) {
        input.serialSpeed = null;
      } else {
        const speed = Number(body.serialSpeed);
        if (!Number.isInteger(speed) || speed < 300 || speed > 1_000_000) {
          throw new HttpError(400, 'the speed is a baud rate, from 300 to 1000000', {
            serialSpeed: 'invalid',
          });
        }
        input.serialSpeed = speed;
      }
    }
    if (body.launchCommand !== undefined) {
      input.launchCommand = typeof body.launchCommand === 'string' ? body.launchCommand.trim() || null : null;
    }
    if (body.launchArgs !== undefined) {
      if (!Array.isArray(body.launchArgs) || body.launchArgs.some((arg) => typeof arg !== 'string')) {
        throw new HttpError(400, 'launch arguments must be a list of strings', { launchArgs: 'invalid' });
      }
      input.launchArgs = body.launchArgs.map((arg) => String(arg));
    }
    if (body.idleMode !== undefined) input.idleMode = String(body.idleMode).trim();
    if (body.idlePassbandHz !== undefined) input.idlePassbandHz = Number(body.idlePassbandHz);
    if (body.timeoutMs !== undefined) {
      const timeout = Number(body.timeoutMs);
      if (!Number.isInteger(timeout) || timeout < 500 || timeout > 60000) {
        throw new HttpError(400, 'the timeout must be between 500 and 60000 ms', { timeoutMs: 'invalid' });
      }
      input.timeoutMs = timeout;
    }
    if (body.enabled !== undefined) input.enabled = body.enabled === true;
    return input;
  };

  // -- modems (R3) ---------------------------------------------------------
  //
  // A modem is a program behind a TCP interface: the station stores how to reach
  // it, which radio it drives and the mode that radio must be in. Any account may
  // configure one, as with the radios (decision 14).

  router.add('GET', '/api/modems', async (ctx) => {
    requireLogin(ctx);
    const records = await store.listModems();
    sendJson(ctx.res, 200, records.map(toModem));
  });

  /**
   * Which configured modems are actually running: a TCP connect to each command port,
   * nothing more. Configuration says how to reach a modem, never that it is there.
   */
  router.add('GET', '/api/modems/status', async (ctx) => {
    requireLogin(ctx);
    const records = await store.listModems();
    const statuses = await Promise.all(
      records.map(async (record) => {
        if (!record.commandPort) {
          return { id: record.id, running: false, error: 'no command port configured' };
        }
        // Ask who is listening, not merely whether something is: the same ports carry
        // VARA, XARA, Data2G and Mercury, and which one answers decides the digital mode.
        const probe = await identifyModem(record.host, record.commandPort);
        // Direwolf's AGWPE port does not answer VERSION at all: it speaks a different command
        // set, so for a packet modem the question is only whether the port is there.
        const reachable =
          record.kind === 'direwolf'
            ? await probeModem(record.host, record.commandPort)
            : probe;
        // A port that answers is not the same as this modem being there. A VARA record served
        // by Data2G is an unavailable VARA however cheerfully the socket connected, so the
        // program that named itself — not the connection — decides (decision 38).
        const mismatch = probe.identity?.kind != null && probe.identity.kind !== record.kind;
        const answered = probe.identity?.kind != null ? MODEM_LABELS[probe.identity.kind] : null;
        return {
          id: record.id,
          running: reachable.running && !mismatch,
          error: mismatch
            ? `${answered} is answering on this port, not ${MODEM_LABELS[record.kind]}`
            : reachable.error,
          listening: listenStates.get(record.id) ?? null,
          // The program that answered, or null when it did not say.
          reportedKind: probe.identity?.kind ?? null,
          reportedVersion: probe.identity?.version ?? null,
          // The record's kind and the program that answered disagree.
          mismatch,
        };
      }),
    );
    sendJson(ctx.res, 200, { statuses, checkedAt: new Date().toISOString() });
  });

  /**
   * `LISTEN ON` / `LISTEN OFF`: whether the modem accepts inbound calls. It is operator
   * state, not configuration, so it lives in memory beside the links and is forgotten on
   * restart — the modem's own state is the truth, and the host protocol cannot be asked.
   */
  const listenStates = new Map<number, boolean>();

  router.add('POST', '/api/modems/:id/listen', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const record = await store.getModem(Number(ctx.params.id));
    if (!record) throw new HttpError(404, 'modem not found');
    if (!record.commandPort) throw new HttpError(400, 'this modem has no command port');
    const body = await readJson<ModemListenRequest>(ctx.req);
    const on = body.on === true;

    const result = await setModemListening(record.host, record.commandPort, on);
    if (result.error) {
      throw new HttpError(502, `${record.name} did not answer: ${result.error}`, { modemId: 'offline' });
    }
    listenStates.set(record.id, on);
    logger.info('modem listening', { modem: record.name, listening: on, answer: result.answer, by: authed.user.callsign });
    sendJson(ctx.res, 200, { modemId: record.id, listening: on, answer: result.answer });
  });

  router.add('POST', '/api/modems', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<CreateModemRequest>(ctx.req);
    const input = (await modemInput(store, body, true)) as CreateModemInput & {
      name: string;
      kind: ModemKind;
      host: string;
    };
    const created = await store.createModem({
      ...input,
      name: input.name,
      kind: input.kind,
      host: input.host,
      // The vendor's own port numbers when the request does not name them, so an API client
      // and the form produce the same record (decision 41). An explicit null means "none".
      commandPort: input.commandPort ?? MODEM_KINDS.find((entry) => entry.kind === input.kind)?.commandPort ?? null,
      dataPort: input.dataPort ?? MODEM_KINDS.find((entry) => entry.kind === input.kind)?.dataPort ?? null,
      kissPort: input.kissPort ?? MODEM_KINDS.find((entry) => entry.kind === input.kind)?.kissPort ?? null,
    });
    logger.info('modem created', { name: created.name, kind: created.kind, by: authed.user.callsign });
    sendJson(ctx.res, 201, toModem(created));
  });

  router.add('PATCH', '/api/modems/:id', async (ctx) => {
    requireLogin(ctx);
    requireCsrf(ctx);
    const current = await store.getModem(Number(ctx.params['id']));
    if (!current) throw new HttpError(404, 'modem not found');
    const body = await readJson<UpdateModemRequest>(ctx.req);
    const input = await modemInput(store, body, false);
    const updated = await store.updateModem(current.id, input);
    sendJson(ctx.res, 200, toModem(updated ?? current));
  });

  router.add('DELETE', '/api/modems/:id', async (ctx) => {
    requireLogin(ctx);
    requireCsrf(ctx);
    const removed = await store.deleteModem(Number(ctx.params['id']));
    if (!removed) throw new HttpError(404, 'modem not found');
    sendJson(ctx.res, 200, { ok: true });
  });

  router.add('GET', '/api/transceivers', async (ctx) => {
    requireLogin(ctx);
    const records = await store.listTransceivers();
    sendJson(ctx.res, 200, records.map(toTransceiver));
  });

  router.add('POST', '/api/transceivers', async (ctx) => {
    // Any account may configure the station's radios: this is a personal station,
    // not a host with an operator class (decision 14).
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<CreateTransceiverRequest>(ctx.req);
    const input = readTransceiverInput(body, true);
    if (!input.name) throw new HttpError(400, 'a name is required', { name: 'required' });
    if (!input.host) throw new HttpError(400, 'a host is required', { host: 'required' });
    if (await store.listTransceivers().then((rows) => rows.some((row) => row.name.toLowerCase() === input.name?.toLowerCase()))) {
      throw new HttpError(409, 'a transceiver with that name exists', { name: 'duplicate' });
    }
    const created = await store.createTransceiver({ ...input, name: input.name, host: input.host, lastUsedAt: Date.now() });
    logger.info('transceiver created', {
      name: created.name,
      host: created.host,
      port: created.port,
      by: authed.user.callsign,
    });
    sendJson(ctx.res, 201, toTransceiver(created));
  });

  router.add('PATCH', '/api/transceivers/:id', async (ctx) => {
    requireLogin(ctx);
    requireCsrf(ctx);
    const id = Number(ctx.params['id']);
    const record = await store.getTransceiver(id);
    if (!record) throw new HttpError(404, 'transceiver not found');
    const body = await readJson<UpdateTransceiverRequest>(ctx.req);
    const input = readTransceiverInput(body);
    // Editing an interface is using it: it becomes the current one (decision 40).
    const updated = await store.updateTransceiver(id, { ...input, lastUsedAt: Date.now() });
    if (!updated) throw new HttpError(404, 'transceiver not found');
    // The transmit connector applies to the live link without reopening it; a changed
    // address or timeout cannot.
    if (body.pttInput !== undefined) links.setPttInput(id, updated.pttInput);
    if (['host', 'port', 'timeoutMs'].some((key) => key in body)) {
      links.disconnect(id);
    }
    sendJson(ctx.res, 200, toTransceiver(updated));
  });

  /** The interface the operator is using now; the header chip follows it. */
  router.add('POST', '/api/transceivers/:id/select', async (ctx) => {
    requireLogin(ctx);
    requireCsrf(ctx);
    const id = Number(ctx.params['id']);
    const record = await store.getTransceiver(id);
    if (!record) throw new HttpError(404, 'transceiver not found');
    const updated = (await store.updateTransceiver(id, { lastUsedAt: Date.now() })) ?? record;
    sendJson(ctx.res, 200, toTransceiver(updated));
  });

  /** The transmitter power for one interface: written to that rig and read straight back. */
  router.add('POST', '/api/transceivers/:id/power', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const id = Number(ctx.params['id']);
    const record = await store.getTransceiver(id);
    if (!record) throw new HttpError(404, 'transceiver not found');
    const body = await readJson<{ rfPower?: number }>(ctx.req);
    const fraction = Number(body.rfPower);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      throw new HttpError(400, 'the power is a fraction of the maximum, from 0 to 1', {
        rfPower: 'invalid',
      });
    }
    try {
      await links.setPower(id, fraction);
    } catch (error) {
      throw new HttpError(
        409,
        `the radio did not take the power setting: ${error instanceof Error ? error.message : String(error)}`,
        { rfPower: 'refused' },
      );
    }
    logger.info('transmit power', { transceiver: id, fraction, by: authed.user.callsign });
    sendJson(ctx.res, 200, toTransceiver(record));
  });

  router.add('DELETE', '/api/transceivers/:id', async (ctx) => {
    requireLogin(ctx);
    requireCsrf(ctx);
    const id = Number(ctx.params['id']);
    links.forget(id);
    const removed = await store.deleteTransceiver(id);
    if (!removed) throw new HttpError(404, 'transceiver not found');
    sendJson(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/transceivers/:id/connect', async (ctx) => {
    requireLogin(ctx);
    requireCsrf(ctx);
    const id = Number(ctx.params['id']);
    const record = await store.getTransceiver(id);
    if (!record) throw new HttpError(404, 'transceiver not found');
    if (!record.enabled) throw new HttpError(400, 'that transceiver is disabled', { enabled: 'disabled' });
    const status = await links.connect(transceiverConfig(record));
    logger.info('rig link', { transceiver: record.name, state: status.state, error: status.error });
    sendJson(ctx.res, status.state === 'connected' ? 200 : 502, {
      transceiver: toTransceiver(record),
      error: status.error,
    });
  });

  router.add('POST', '/api/transceivers/:id/disconnect', async (ctx) => {
    requireLogin(ctx);
    requireCsrf(ctx);
    const id = Number(ctx.params['id']);
    const record = await store.getTransceiver(id);
    if (!record) throw new HttpError(404, 'transceiver not found');
    links.disconnect(id);
    sendJson(ctx.res, 200, { transceiver: toTransceiver(record) });
  });

  // -- the radio interface (R2.2) -------------------------------------------
  //
  // A station has one radio interface, and the operator sets only where rigctld answers:
  // an address (empty means localhost) and a port (empty means 4532). Everything else on
  // the screen is what rigctld says about the radio — its model, how it is attached, the
  // frequency, mode, filter and power — or the state of the two links, the station to
  // rigctld and rigctld to the rig. The station dials by itself and stays dialled; the
  // screen is a reader, not a switch.

  const firstRadio = async (): Promise<TransceiverRecord | null> => {
    // The interface the operator used last, whatever order the registry is listed in
    // (decision 40): the header shows that one.
    const rows = await store.listTransceivers();
    return rows.reduce<TransceiverRecord | null>(
      (best, row) =>
        best === null || row.lastUsedAt > best.lastUsedAt || (row.lastUsedAt === best.lastUsedAt && row.id > best.id)
          ? row
          : best,
      null,
    );
  };

  /**
   * The radio a modem puts on the air. A modem may name one; since the station usually has a
   * single interface and the modem form no longer asks (decision 43), a modem that names none
   * takes the current interface — the same "current" the header shows.
   */
  const radioForModem = async (modem: ModemRecord): Promise<TransceiverRecord> => {
    if (modem.transceiverId !== null) {
      const named = await store.getTransceiver(modem.transceiverId);
      if (!named) {
        throw new HttpError(400, 'the modem names a transceiver that no longer exists', {
          modemId: 'stale',
        });
      }
      return named;
    }
    const current = await firstRadio();
    if (!current) {
      throw new HttpError(409, 'the station has no radio interface, so the dial cannot be set', {
        transceiverId: 'missing',
      });
    }
    return current;
  };

  const radioStatus = (record: TransceiverRecord | null): RadioStatus => {
    if (!record) {
      return { interface: null, pttInput: null, serial: null, connected: false, error: null, rig: null };
    }
    const link = links.status(record.id);
    return {
      interface: { host: record.host, port: record.port },
      pttInput: record.pttInput,
      // The daemon cannot be asked which device it serves, so this is what the operator
      // recorded about it — null when nobody has said (decision 39).
      serial:
        record.serialPort === null && record.serialSpeed === null
          ? null
          : { device: record.serialPort, speed: record.serialSpeed },
      connected: link.state === 'connected',
      error: link.error,
      rig: link.rig,
    };
  };

  /**
   * What to call the radio in a sentence. The model is rigctld's answer, decided when the
   * daemon was started; the name it replaced was typed by an operator and could only ever
   * agree with the rig by luck. Until the daemon has said, the address it answers at is the
   * honest name.
   */
  const radioLabel = (record: TransceiverRecord): string =>
    links.status(record.id).rig?.model ?? `${record.host}:${record.port}`;

  router.add('GET', '/api/radio', async (ctx) => {
    requireLogin(ctx);
    sendJson(ctx.res, 200, radioStatus(await firstRadio()));
  });

  /**
   * The LAN names of the hosts the station is configured to talk to (decision 42). NetBIOS
   * first — that is what a Windows PC answers — then an mDNS reverse query for the boxes that
   * publish `.local`. Cached for minutes, never fatal: a host that answers neither is null,
   * and the screen simply shows the address.
   */
  router.add('GET', '/api/hostnames', async (ctx) => {
    requireLogin(ctx);
    const [radios, modems] = await Promise.all([store.listTransceivers(), store.listModems()]);
    const hosts = [...new Set([...radios.map((row) => row.host), ...modems.map((row) => row.host)])];
    const names: Record<string, string | null> = {};
    await Promise.all(
      hosts.map(async (host) => {
        names[host] = await lookupHostName(host);
      }),
    );
    sendJson(ctx.res, 200, { names } satisfies HostNamesResponse);
  });

  // -- accounts -------------------------------------------------------------

  const ensureAnotherAdmin = async (target: UserRecord): Promise<void> => {
    // Only losing an *enabled* administrator can lock the station out.
    if (target.role !== 'admin' || !target.enabled) return;
    const others = (await store.listUsers()).filter(
      (user) => user.role === 'admin' && user.enabled && user.id !== target.id,
    );
    if (others.length === 0) {
      throw new HttpError(400, 'at least one administrator must remain', { role: 'last admin' });
    }
  };

  router.add('GET', '/api/users', async (ctx) => {
    requireAdmin(ctx);
    const users = await store.listUsers();
    sendJson(ctx.res, 200, users.map(toUser));
  });

  router.add('POST', '/api/users', async (ctx) => {
    const authed = requireAdmin(ctx);
    requireCsrf(ctx);
    const body = await readJson<CreateUserRequest>(ctx.req);
    // The callsign is the account: it is the login, the mailbox and the originator
    // of everything the account transmits (decision 25).
    const callsign = requireCallsign(body.callsign);
    await assertCallsignFree(store, callsign, 0);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password !== '' && password.length < 6) {
      throw new HttpError(400, 'password must be at least 6 characters', { password: 'too short' });
    }
    const role = body.role === 'admin' ? 'admin' : 'user';
    const created = await store.createUser({
      callsign,
      pwHash: password ? hashPassword(password) : null,
      role,
    });
    const locator = normaliseLocator(body.locator);
    if (locator) await store.setLocator(created.id, locator);
    logger.info('account created', { callsign, role, by: authed.user.callsign });
    const stored = await store.getUser(created.id);
    sendJson(ctx.res, 201, toUser(stored ?? created));
  });

  router.add('PATCH', '/api/users/:id', async (ctx) => {
    const authed = requireAdmin(ctx);
    requireCsrf(ctx);
    const target = await store.getUser(Number(ctx.params['id']));
    if (!target) throw new HttpError(404, 'account not found');
    const body = await readJson<UpdateUserRequest>(ctx.req);

    if (body.role !== undefined && body.role !== 'admin' && body.role !== 'user') {
      throw new HttpError(400, 'unknown role', { role: 'invalid' });
    }
    if (body.enabled === false && target.id === authed.user.id) {
      throw new HttpError(400, 'you cannot disable your own account', { enabled: 'self' });
    }
    if ((body.role === 'user' || body.enabled === false) && target.role === 'admin') {
      await ensureAnotherAdmin(target);
    }

    await store.updateUser(target.id, {
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.quotaBytes !== undefined ? { quotaBytes: body.quotaBytes } : {}),
    });
    if (body.callsign !== undefined) {
      const callsign = normaliseCallsign(body.callsign);
      await assertCallsignFree(store, callsign, target.id);
      await store.setCallsign(target.id, callsign);
    }
    if (body.locator !== undefined) {
      await store.setLocator(target.id, normaliseLocator(body.locator));
    }
    if (body.postOfficePassword !== undefined) {
      const password = body.postOfficePassword === null ? '' : body.postOfficePassword;
      if (typeof password !== 'string') {
        throw new HttpError(400, 'the post-office password must be a string', {
          postOfficePassword: 'invalid',
        });
      }
      if (password.length > 128) {
        throw new HttpError(400, 'the post-office password is too long', {
          postOfficePassword: 'too long',
        });
      }
      const stored = await store.setPostOfficeSecret(
        target.id,
        password.trim() === '' ? null : sealSecret(password, storeKey),
      );
      if (!stored) {
        throw new HttpError(400, 'that account has no callsign, so it cannot hold the password', {
          callsign: 'required',
        });
      }
      logger.info('post office password reset by administrator', {
        callsign: (await store.getUser(target.id))?.callsign ?? null,
        by: authed.user.callsign,
      });
    }
    if (body.isPostOffice !== undefined) {
      if (body.isPostOffice) {
        const made = await store.setPostOfficeOwner(target.id);
        if (!made) {
          throw new HttpError(400, 'that account has no callsign, so it cannot own the post office', {
            callsign: 'required',
          });
        }
        logger.info('post office owner set', {
          callsign: (await store.getUser(target.id))?.callsign ?? null,
          by: authed.user.callsign,
        });
      } else if (target.isPostOffice) {
        await store.setPostOfficeOwner(null);
        logger.info('post office owner cleared', { by: authed.user.callsign });
      }
    }
    const updated = await store.getUser(target.id);
    sendJson(ctx.res, 200, toUser(updated ?? target));
  });

  router.add('DELETE', '/api/users/:id', async (ctx) => {
    const authed = requireAdmin(ctx);
    requireCsrf(ctx);
    const target = await store.getUser(Number(ctx.params['id']));
    if (!target) throw new HttpError(404, 'account not found');
    if (target.id === authed.user.id) {
      throw new HttpError(400, 'you cannot delete your own account');
    }
    await ensureAnotherAdmin(target);
    await store.deleteUser(target.id);
    logger.info('account deleted', { callsign: target.callsign ?? target.login, by: authed.user.callsign });
    sendJson(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/users/:id/password', async (ctx) => {
    const authed = requireAdmin(ctx);
    requireCsrf(ctx);
    const target = await store.getUser(Number(ctx.params['id']));
    if (!target) throw new HttpError(404, 'account not found');
    const body = await readJson<PasswordRequest>(ctx.req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password !== '' && password.length < 6) {
      throw new HttpError(400, 'password must be at least 6 characters', { password: 'too short' });
    }
    await store.setUserPassword(target.id, password === '' ? null : hashPassword(password));
    logger.info('password reset by administrator', { callsign: target.callsign ?? target.login, by: authed.user.callsign });
    sendJson(ctx.res, 200, { ok: true, hasPassword: password !== '' });
  });

  /**
   * The shared front half of a session: the modem, a validated target, the dial
   * frequency and the radio tuned to it. Both the connect test and the exchange
   * start here, so neither can transmit wherever the dial was left.
   */
  async function prepareDial(authed: AuthedContext, body: SessionTestRequest): Promise<{
    modem: ModemRecord;
    target: string;
    frequencyHz: number;
    bandwidthHz: number;
    rig: { frequencyHz: number; mode: string } | null;
    transceiverName: string | null;
  }> {
    const modem = await store.getModem(Number(body.modemId));
    if (!modem) throw new HttpError(404, 'modem not found');
    if (!modem.commandPort) {
      throw new HttpError(400, 'this modem has no command port configured', { modemId: 'noport' });
    }
    if (postOffice.modemId === modem.id) {
      // One modem carries one session (R4.5.1), and an armed post office is using it.
      throw new HttpError(409, `${modem.name} is answering calls for the post office; disarm it first`, {
        modemId: 'postoffice',
      });
    }
    const target = String(body.target ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,10}([-/][A-Z0-9]{1,3})?$/.test(target)) {
      throw new HttpError(400, `not a callsign: ${body.target}`, { target: 'invalid' });
    }
    if (!authed.user.callsign) {
      throw new HttpError(400, 'this account has no callsign to put on the air', {
        callsign: 'required',
      });
    }
    const frequencyHz = Number(body.frequencyHz);
    if (!Number.isFinite(frequencyHz) || frequencyHz < 1_800_000 || frequencyHz > 450_000_000) {
      throw new HttpError(400, 'the dial frequency is outside every amateur band', {
        frequencyHz: 'invalid',
      });
    }
    const bandwidthHz = Number(body.bandwidthHz ?? bandwidthOfMode('VARA'));

    // The radio must be tuned before the modem transmits: a session that keys the
    // transmitter wherever the dial happened to be left is not acceptable.
    let rig: { frequencyHz: number; mode: string } | null = null;
    let transceiverName: string | null = null;
    const radio = await radioForModem(modem);
    transceiverName = radioLabel(radio);
    try {
      // Only the dial and the mode reach the radio. The session's bandwidth is the modem's
      // (it travels in `BW2300`/`ARQBW` to the modem, see modem-dial.ts): a passband is not a
      // thing this station can ask a rig for, and 2300 Hz is not a TS-590 filter anyway
      // (decision 45).
      const tuned = await links.tune(radio.id, frequencyHz, modem.rigMode);
      rig = { frequencyHz: tuned.frequencyHz, mode: tuned.mode };
    } catch (error) {
      throw new HttpError(
        409,
        `the radio ${transceiverName} is not connected: ${error instanceof Error ? error.message : String(error)}`,
        { transceiverId: 'offline' },
      );
    }

    return { modem, target, frequencyHz, bandwidthHz, rig, transceiverName };
  }

  /**
   * The connect test: tune the radio, dial the gateway through the chosen modem,
   * report what the modem said, and hang up again. No B2F exchange happens here —
   * this is a check that the chain modem → radio → gateway answers at all.
   */
  router.add('POST', '/api/session/test', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<SessionTestRequest>(ctx.req);
    const prepared = await prepareDial(authed, body);
    const { modem, target, frequencyHz, bandwidthHz, rig, transceiverName } = prepared;

    logger.info('connect test', { modem: modem.name, target, frequencyHz, by: authed.user.callsign });
    const outcome = await dialModem({
      host: modem.host,
      port: modem.commandPort ?? 0,
      dialect: modem.kind === 'ardop' ? 'ardop' : 'vara',
      hf: modem.kind !== 'vara-fm',
      plainVara: modem.kind === 'data2g' || modem.kind === 'mercury',
      bandwidthChoices: modemKindInfo(modem.kind).bandwidths,
      myCallsign: authed.user.callsign ?? '',
      target,
      bandwidthHz,
    });
    logger.info('connect test finished', {
      modem: modem.name,
      target,
      result: outcome.result,
      message: outcome.message,
    });

    sendJson(ctx.res, 200, {
      result: outcome.result,
      message: outcome.message,
      log: outcome.log,
      elapsedMs: outcome.elapsedMs,
      modemName: modem.name,
      transceiverName,
      frequencyHz,
      bandwidthHz: outcome.connectedBandwidthHz ?? bandwidthHz,
      rig,
    });
  });

  /**
   * The session itself: dial, run the B2 exchange over the modem's data port, and
   * put what arrived into INBOX and what was accepted into SENT.
   *
   * The request is held open for as long as the airtime takes — one session on HF
   * can be several minutes — which is honest for a single operator watching it and
   * is the first thing to change when sessions move to a queue (M7).
   */
  router.add('POST', '/api/session/run', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<SessionRunRequest>(ctx.req);
    const mode: SessionMode = body.mode ?? 'cms';
    // The screen that asked for this session gets the modem's words as they happen and the
    // one control that stops it (decision 51).
    const stream = body.streamId ? streams.open(body.streamId) : null;
    if (mode !== 'cms' && mode !== 'p2p' && mode !== 'postoffice') {
      return sendJson(ctx.res, 400, { error: 'mode must be cms, p2p or postoffice' });
    }
    const prepared = await prepareDial(authed, body);
    const { modem, target, frequencyHz, bandwidthHz, rig, transceiverName } = prepared;

    // What the far end will be answered with. A post office of this station may
    // challenge for either credential (decision 27); a CMS only for the Winlink one,
    // so that is preferred when both exist.
    const winlinkPassword = authed.user.winlinkSecret
      ? openSecret(authed.user.winlinkSecret, services.storeKey)
      : null;
    const postOfficePassword =
      mode === 'postoffice' && authed.user.postOfficeSecret
        ? openSecret(authed.user.postOfficeSecret, services.storeKey)
        : null;
    const secret = winlinkPassword ?? postOfficePassword;
    const startedAt = Date.now();
    logger.info('session start', { modem: modem.name, target, mode, frequencyHz, by: authed.user.callsign });

    stream?.publish({ t: 'state', state: 'dialing', detail: `${target} through ${modem.name}` });
    const report = await runSession({
      store,
      account: authed.user,
      modem: {
        name: modem.name,
        kind: modem.kind,
        host: modem.host,
        commandPort: modem.commandPort ?? 0,
        dataPort: modem.dataPort,
      },
      target,
      mode,
      bandwidthHz,
      password: secret,
      // The client identity is not the operator's choice (decision 36): a Winlink session
      // presents the type a CMS accepts — production servers refuse one they do not know,
      // measured against HB9AK on 25 Nov 2026 — and every other session sends this station's
      // own SID, which is what `localSid` defaults to.
      fakeClient: mode === 'cms' ? WINLINK_CLIENT_IDENTITY : null,
      logger,
      // Everything the modem says, and every line of the exchange, as it happens.
      onModemLine: (atMs, line) => stream?.publish({ t: 'modem', dir: '<', text: line, atMs }),
      onCommand: (atMs, command) => stream?.publish({ t: 'modem', dir: '>', text: command, atMs }),
      onLine: (direction, text) => stream?.publish({ t: 'line', dir: direction, text, atMs: Date.now() - startedAt }),
      onBinary: (direction, info) =>
        stream?.publish({ t: 'hex', dir: direction, hex: info.hex, count: info.count, atMs: Date.now() - startedAt }),
      onStage: (state, detail) => stream?.publish({ t: 'state', state, detail: detail ?? null }),
      // The screen's stop control, bound to the sockets this run owns.
      bindControl: (control) => stream?.bind(control),
    });

    stream?.publish({ t: 'end', result: report.result, message: report.message });
    if (body.streamId) {
      // The channel outlives its session by a minute, so a screen that reconnects after the end
      // still reads the closing lines; the backlog is dropped when the next session starts.
      const id = body.streamId;
      const timer = setTimeout(() => streams.forget(id), 60_000);
      timer.unref?.();
    }

    logger.info('session ended', {
      modem: modem.name,
      target,
      mode,
      result: report.result,
      sent: report.sent.length,
      received: report.received.length,
      // Why it ended the way it did, when there is a reason to give.
      reason: report.result === 'complete' ? null : report.message,
      dialResult: report.dial?.result ?? null,
    });

    // A gateway that answered is remembered with the dial it was called on, so the choice is
    // not limited to what the RMS catalogue lists (decision 44). A dial that never connected
    // proves nothing about the gateway and is not recorded.
    if (report.dial?.result === 'connected') {
      await store.recordSessionTarget({
        callsign: target.toUpperCase(),
        frequencyHz,
        kind: modem.kind,
        sessionMode: mode,
      });
    }

    sendJson(ctx.res, 200, {
      result: report.result,
      message: report.message,
      dialResult: report.dial?.result ?? null,
      sent: report.sent,
      received: report.received,
      deferred: report.exchange?.deferred ?? [],
      failed: report.exchange?.failed ?? [],
      dialLog: report.dial?.log ?? [],
      log: report.exchange?.log ?? [],
      remoteSid: report.exchange?.remoteSid ?? '',
      elapsedMs: Date.now() - startedAt,
      modemName: modem.name,
      transceiverName,
      frequencyHz,
      bandwidthHz: report.dial?.connectedBandwidthHz ?? bandwidthHz,
      rig,
    });
  });

  /**
   * The one control a running session has (decision 51). The first request asks the link to come
   * down; a second, while that is still happening, cuts it. The server decides which step it is
   * from the channel's own phase, so a screen cannot ask for an abort before a disconnect.
   */
  router.add('POST', '/api/session/stop', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<{ streamId?: string }>(ctx.req);
    const id = typeof body.streamId === 'string' ? body.streamId : '';
    const channel = id ? streams.get(id) : null;
    if (!channel) throw new HttpError(404, 'no session is running under that id');
    const phase = channel.stop();
    logger.info('session stop', { streamId: id, phase, by: authed.user.callsign });
    sendJson(ctx.res, 200, { phase });
  });

  /**
   * The gateways this station has called, most used first (decision 44). Not a setting: the
   * list is built from what the station did, so a gateway typed in from a bulletin appears
   * without anyone having to enter it twice.
   */
  router.add('GET', '/api/session/targets', async (ctx) => {
    requireLogin(ctx);
    const rows = await store.listSessionTargets(20);
    sendJson(ctx.res, 200, {
      targets: rows.map((row) => ({
        callsign: row.callsign,
        frequencyHz: row.frequencyHz,
        kind: row.kind as ModemKind | null,
        sessionMode: row.sessionMode as SessionMode | null,
        uses: row.uses,
        lastUsedAt: row.lastUsedAt,
      })),
    } satisfies SessionTargetsResponse);
  });

  /** What the session screen needs to offer a choice before a session exists. */
  router.add('GET', '/api/session/options', async (ctx) => {
    requireLogin(ctx);
    sendJson(ctx.res, 200, {
      modems: (Object.keys(MODEM_LABELS) as ModemKind[]).map((kind) => ({
        kind,
        label: MODEM_LABELS[kind],
        families: MODEM_FAMILIES[kind],
      })),
      bands: BAND_NAMES,
    });
  });

  /**
   * The RMS gateway catalogue, flattened to channels and ordered for one session
   * attempt: by estimated quality, or by distance when the operator knows the
   * neighbourhood better than the estimate (VHF/UHF especially).
   */
  // -- post office ------------------------------------------------------------

  /**
   * The role's state. While it is armed the callsign in force is the one it was
   * armed with; while it is not, the owner flag in the store is the answer.
   */
  async function postOfficeStatus(): Promise<PostOfficeStatus> {
    const snapshot = postOffice.snapshot();
    if (snapshot.armed) return snapshot;
    const owner = await store.findPostOfficeOwner();
    return { ...snapshot, owner: owner?.callsign ?? null };
  }

  router.add('GET', '/api/postoffice/status', async (ctx) => {
    requirePostOffice(ctx);
    sendJson(ctx.res, 200, await postOfficeStatus());
  });

  /**
   * Arms the station's post office: the radio is tuned first, then the modem is
   * told to listen. An inbound call cannot be tuned for, so a station that keys a
   * carrier without a dial set is not acceptable here for the same reason a dial
   * refuses it (R4.4.05).
   */
  router.add('POST', '/api/postoffice/arm', async (ctx) => {
    const authed = requirePostOffice(ctx);
    requireCsrf(ctx);
    const body = await readJson<ArmPostOfficeRequest>(ctx.req);

    const owner = await store.findPostOfficeOwner();
    if (!owner || !owner.callsign) {
      throw new HttpError(400, 'no account owns the post office: mark one on the accounts page', {
        owner: 'missing',
      });
    }
    if (postOffice.isArmed) {
      throw new HttpError(409, 'the post office is already armed; disarm it first', {
        armed: 'already',
      });
    }

    const modem = await store.getModem(Number(body.modemId));
    if (!modem) throw new HttpError(404, 'modem not found');
    if (!modem.commandPort) {
      throw new HttpError(400, 'this modem has no command port configured', { modemId: 'noport' });
    }
    if (postOffice.modemId === modem.id) {
      // One modem carries one session (R4.5.1), and an armed post office is using it.
      throw new HttpError(409, `${modem.name} is answering calls for the post office; disarm it first`, {
        modemId: 'postoffice',
      });
    }
    if (!modem.dataPort) {
      throw new HttpError(400, 'this modem has no data port, so a session has nowhere to run', {
        modemId: 'nodata',
      });
    }
    if (modem.kind === 'ardop') {
      throw new HttpError(400, 'ARDOP carries session data on its command port, which this build cannot yet carry', {
        modemId: 'ardop',
      });
    }
    const frequencyHz = Number(body.frequencyHz);
    if (!Number.isFinite(frequencyHz) || frequencyHz < 1_800_000 || frequencyHz > 450_000_000) {
      throw new HttpError(400, 'the dial frequency is outside every amateur band', {
        frequencyHz: 'invalid',
      });
    }
    const radio = await radioForModem(modem);
    try {
      await links.tune(radio.id, frequencyHz, modem.rigMode);
    } catch (error) {
      throw new HttpError(
        409,
        `the radio ${radioLabel(radio)} is not connected: ${error instanceof Error ? error.message : String(error)}`,
        { transceiverId: 'offline' },
      );
    }

    try {
      const status = await postOffice.arm({
        owner,
        modem: {
          id: modem.id,
          name: modem.name,
          host: modem.host,
          commandPort: modem.commandPort,
          dataPort: modem.dataPort,
        },
        frequencyHz,
      });
      logger.info('post office arm', {
        callsign: owner.callsign,
        modem: modem.name,
        frequencyHz,
        by: authed.user.callsign,
      });
      sendJson(ctx.res, 200, { ...status, owner: status.owner ?? owner.callsign });
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : String(error));
    }
  });

  router.add('POST', '/api/postoffice/disarm', async (ctx) => {
    const authed = requirePostOffice(ctx);
    requireCsrf(ctx);
    await postOffice.disarm();
    logger.info('post office disarm', { by: authed.user.callsign });
    sendJson(ctx.res, 200, await postOfficeStatus());
  });

  router.add('GET', '/api/gateways', async (ctx) => {
    const authed = requireLogin(ctx);
    const modemParam = ctx.url.searchParams.get('modem');
    const band = ctx.url.searchParams.get('band');
    const sortParam = ctx.url.searchParams.get('sort');
    const limitParam = Number(ctx.url.searchParams.get('limit') ?? '40');
    const force = ctx.url.searchParams.get('refresh') === '1';
    const includeEmcomm = ctx.url.searchParams.get('emcomm') === '1';

    const modems: ModemKind[] = modemParam
      ? modemParam
          .split(',')
          .map((value) => value.trim())
          .filter((value): value is ModemKind => value in MODEM_LABELS)
      : [];

    const position = authed.user.locator ? gridsquareToLatLon(authed.user.locator) : null;
    const catalogue = await fetchCatalogue({
      cacheDir: services.cacheDir ?? null,
      origin: position,
      force,
    });

    const channels = selectChannels(catalogue.channels, {
      modems,
      band: band && band !== 'any' ? band : null,
      sort: sortParam === 'distance' || sortParam === 'callsign' ? sortParam : 'quality',
      limit: Number.isFinite(limitParam) ? Math.min(200, Math.max(1, limitParam)) : 40,
      includeEmcomm,
    });

    const total = selectChannels(catalogue.channels, {
      modems,
      band: band && band !== 'any' ? band : null,
      limit: Number.MAX_SAFE_INTEGER,
      includeEmcomm,
    }).length;

    sendJson(ctx.res, 200, {
      channels,
      total,
      fetchedAt: catalogue.fetchedAt,
      stale: catalogue.stale,
      source: catalogue.source,
      error: catalogue.error,
      origin: authed.user.locator ?? null,
      includeEmcomm,
    });
  });

  router.add('PATCH', '/api/account', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<UpdateAccountRequest>(ctx.req);

    if (body.callsign !== undefined) {
      const callsign = normaliseCallsign(body.callsign);
      await assertCallsignFree(store, callsign, authed.user.id);
      await store.setCallsign(authed.user.id, callsign);
    }

    if (body.locator !== undefined) {
      const locator = normaliseLocator(body.locator);
      await store.setLocator(authed.user.id, locator);
    }

    if (body.postOfficePassword !== undefined) {
      const password = body.postOfficePassword === null ? '' : body.postOfficePassword;
      if (typeof password !== 'string') {
        throw new HttpError(400, 'the post-office password must be a string', {
          postOfficePassword: 'invalid',
        });
      }
      if (password.length > 128) {
        throw new HttpError(400, 'the post-office password is too long', {
          postOfficePassword: 'too long',
        });
      }
      const stored = await store.setPostOfficeSecret(
        authed.user.id,
        password.trim() === '' ? null : sealSecret(password, storeKey),
      );
      if (!stored) {
        throw new HttpError(400, 'set a callsign before a post-office password', {
          callsign: 'required',
        });
      }
      logger.info(
        password.trim() === '' ? 'post office password cleared' : 'post office password stored',
        { callsign: authed.user.callsign },
      );
    }

    if (body.winlinkPassword !== undefined) {
      const password = body.winlinkPassword === null ? '' : body.winlinkPassword;
      if (typeof password !== 'string') {
        throw new HttpError(400, 'the Winlink password must be a string', {
          winlinkPassword: 'invalid',
        });
      }
      if (password.length > 128) {
        throw new HttpError(400, 'the Winlink password is too long', {
          winlinkPassword: 'too long',
        });
      }
      if (password.trim().length === 0) {
        const cleared = await store.setWinlinkSecret(authed.user.id, null);
        if (!cleared) {
          throw new HttpError(400, 'set a callsign before a Winlink password', {
            callsign: 'required',
          });
        }
      } else {
        const stored = await store.setWinlinkSecret(
          authed.user.id,
          sealSecret(password, storeKey),
        );
        if (!stored) {
          throw new HttpError(400, 'set a callsign before a Winlink password', {
            callsign: 'required',
          });
        }
        logger.info('winlink password stored', { callsign: authed.user.callsign ?? authed.user.login });
      }
    }

    sendJson(ctx.res, 200, await meResponse(authed.user.id, ctx.session?.csrf ?? ''));
  });

  router.add('POST', '/api/account/password', async (ctx) => {
    const authed = requireLogin(ctx);
    requireCsrf(ctx);
    const body = await readJson<PasswordRequest>(ctx.req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (authed.user.pwHash !== null) {
      const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      if (!verifyPassword(current, authed.user.pwHash)) {
        throw new HttpError(403, 'current password is incorrect', { currentPassword: 'incorrect' });
      }
    }
    if (password !== '' && password.length < 6) {
      throw new HttpError(400, 'password must be at least 6 characters', { password: 'too short' });
    }
    await store.setUserPassword(authed.user.id, password === '' ? null : hashPassword(password));
    logger.info('password changed', { callsign: authed.user.callsign ?? authed.user.login });
    sendJson(ctx.res, 200, { ok: true, hasPassword: password !== '' });
  });

  // -- composition of the whole handler -------------------------------------

  const staticHandler = createStaticHandler(services.uiDir);
  router.setFallback(staticHandler);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const remote = req.socket.remoteAddress ?? '';
    if (!policy.allows(remote)) {
      logger.warn('http connection refused by access policy', { remote });
      sendError(res, 403, 'access denied from this address');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const session = token ? sessions.verify(token) : null;
    const user = session ? await store.getUser(session.uid) : null;
    const ctx: Ctx & { user?: UserRecord } = {
      req,
      res,
      url,
      params: {},
      session: user && user.enabled ? session : null,
      remote,
      ...(user && user.enabled ? { user } : {}),
    };

    try {
      const handled = await router.dispatch(ctx);
      if (!handled) sendError(res, 404, 'not found');
      else if (!res.headersSent && !res.writableEnded) sendError(res, 404, 'not found');
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.message, {
          ...(err.fields ? { fields: err.fields } : {}),
          ...(err.extra ?? {}),
        });
        return;
      }
      logger.error('unhandled API error', {
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      sendError(res, 500, 'internal error');
    }
  };

  /**
   * The live view of a session: a WebSocket on `/api/session/ws?id=…`. The cookie is the same
   * one the screens use, so a browser opens it with no extra credential; anything else is
   * refused before the handshake (decision 51).
   */
  const handleUpgrade = async (req: IncomingMessage, socket: Duplex): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/session/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const session = token ? sessions.verify(token) : null;
    const user = session ? await store.getUser(session.uid) : null;
    streams.handleUpgrade(req, socket, Boolean(user && user.enabled));
  };

  return { router, handle, handleUpgrade, loginAttempts };
}

async function loadMailMessage(store: Store, userId: number, record: MessageRecord): Promise<MailMessage> {
  const attachments = [];
  for (const meta of record.attachments) {
    const found = await store.getAttachment(userId, record.id, meta.id);
    if (found) {
      attachments.push({ name: found.meta.name, contentType: found.meta.contentType, data: found.data });
    }
  }
  return {
    mid: record.mid,
    messageId: record.messageId,
    from: toWinlinkHeader(record.from),
    to: record.to.map((address) => toWinlinkAddress(addressOnly(address))),
    cc: record.cc.map((address) => toWinlinkAddress(addressOnly(address))),
    subject: record.subject,
    dateUtc: record.dateUtc,
    body: record.body,
    charset: record.charset,
    headers: record.headers,
    attachments,
  };
}

function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
}

/**
 * Callsigns are stored upper case. A suffix such as `-10` or `/P` is allowed;
 * anything else is a validation error rather than a silent rewrite.
 */
/** A callsign belongs to exactly one mailbox; refuse to share it. */
async function assertCallsignFree(
  store: Store,
  callsign: string | null,
  exceptUserId: number,
): Promise<void> {
  if (!callsign) return;
  const owner = await store.findUserByCallsign(callsign);
  if (owner && owner.id !== exceptUserId) {
    throw new HttpError(409, `${callsign} already belongs to account ${owner.callsign ?? owner.login}`, {
      callsign: 'duplicate',
    });
  }
}

export type { Handler };