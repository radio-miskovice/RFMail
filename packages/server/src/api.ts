// HTTP API for the web client.
//
// Authentication is a signed session cookie; every state-changing route also
// requires the CSRF nonce from the session, echoed in X-CSRF-Token. Routes are
// registered explicitly, so a new endpoint has to say whether it wants a user.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_FOLDERS,
  FLAG_ANSWERED,
  FLAG_FLAGGED,
  FLAG_UNREAD,
  type ArmPostOfficeRequest,
  type ComposeRequest,
  type CreateUserRequest,
  type FolderWithCounts,
  type LoginRequest,
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
  type ModemListenRequest,
  type SessionMode,
  type SessionRunRequest,
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
import { findUserByCredential, type MailEvents, type PeerPolicy } from '@rfmail/mailservers';
import type { TransceiverConfig, TransceiverLinks } from '@rfmail/rig';
import { sanitiseHtml } from './html.ts';
import { SESSION_COOKIE, parseCookies, type Sessions } from './auth.ts';
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
import { createStaticHandler } from './static.ts';
import type { Logger } from '@rfmail/shared';

export const APP_VERSION = '0.1.0';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

export interface ApiServices {
  store: Store;
  sessions: Sessions;
  policy: PeerPolicy;
  logger: Logger;
  events: MailEvents;
  uiDir: string;
  accessMode: string;
  pop3Address: string | null;
  smtpAddress: string | null;
  imapAddress: string | null;
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

export function createApi(services: ApiServices): {
  router: Router;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  loginAttempts: Map<string, { count: number; resetAt: number }>;
} {
  const { store, sessions, policy, logger, storeKey, links, postOffice } = services;
  const router = new Router();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  const meResponse = async (uid: number, csrf: string): Promise<Me> => {
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
    return { user: toUser(user), folders, csrf };
  };

  // -- public ---------------------------------------------------------------

  router.add('GET', '/api/status', async (ctx) => {
    const users = await store.countUsers();
    const status: StatusResponse = {
      app: 'rfmail',
      version: APP_VERSION,
      state: users === 0 ? 'setup' : 'ready',
      database: 'sqlite',
      accessMode: services.accessMode,
      pop3: services.pop3Address ? { enabled: true, address: services.pop3Address } : null,
      smtp: services.smtpAddress ? { enabled: true, address: services.smtpAddress } : null,
      imap: services.imapAddress ? { enabled: true, address: services.imapAddress } : null,
    };
    sendJson(ctx.res, 200, status);
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
    const { token, payload } = sessions.issue(user.id);
    ctx.res.setHeader('Set-Cookie', sessions.cookieHeader(token, services.secureCookies));
    logger.info('login', { callsign: user.callsign ?? user.login, remote: ctx.remote });
    sendJson(ctx.res, 200, await meResponse(user.id, payload.csrf));
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

  const transceiverConfig = (record: TransceiverRecord): TransceiverConfig => ({
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
        return {
          id: record.id,
          running: probe.running,
          error: probe.error,
          listening: listenStates.get(record.id) ?? null,
          // The program that answered, or null when it did not say.
          reportedKind: probe.identity?.kind ?? null,
          reportedVersion: probe.identity?.version ?? null,
          // The record's kind and the program that answered disagree.
          mismatch: probe.identity?.kind != null && probe.identity.kind !== record.kind,
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
    const created = await store.createModem({ ...input, name: input.name, kind: input.kind, host: input.host });
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
    const created = await store.createTransceiver({ ...input, name: input.name, host: input.host });
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
    const updated = await store.updateTransceiver(id, input);
    if (!updated) throw new HttpError(404, 'transceiver not found');
    // A changed address or timeout cannot apply to an open link.
    if (['host', 'port', 'timeoutMs', 'pttInput'].some((key) => key in body)) {
      links.disconnect(id);
    }
    sendJson(ctx.res, 200, toTransceiver(updated));
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
    if (modem.transceiverId === null) {
      throw new HttpError(409, 'the modem has no transceiver assigned, so the dial cannot be set', {
        transceiverId: 'missing',
      });
    }
    const radio = await store.getTransceiver(modem.transceiverId);
    transceiverName = radio?.name ?? null;
    if (!radio) {
      throw new HttpError(400, 'the modem names a transceiver that no longer exists', {
        modemId: 'stale',
      });
    }
    try {
      const tuned = await links.tune(radio.id, frequencyHz, modem.rigMode);
      rig = { frequencyHz: tuned.frequencyHz, mode: tuned.mode };
    } catch (error) {
      throw new HttpError(
        409,
        `the transceiver ${radio.name} is not connected: ${error instanceof Error ? error.message : String(error)}`,
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
      fakeClient: typeof body.fakeClient === 'string' && body.fakeClient.trim() !== '' ? body.fakeClient : null,
      logger,
    });

    logger.info('session ended', {
      modem: modem.name,
      target,
      mode,
      fakeClient: body.fakeClient ?? null,
      result: report.result,
      sent: report.sent.length,
      received: report.received.length,
      // Why it ended the way it did, when there is a reason to give.
      reason: report.result === 'complete' ? null : report.message,
      dialResult: report.dial?.result ?? null,
    });

    sendJson(ctx.res, 200, {
      result: report.result,
      message: report.message,
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
    requireLogin(ctx);
    sendJson(ctx.res, 200, await postOfficeStatus());
  });

  /**
   * Arms the station's post office: the radio is tuned first, then the modem is
   * told to listen. An inbound call cannot be tuned for, so a station that keys a
   * carrier without a dial set is not acceptable here for the same reason a dial
   * refuses it (R4.4.05).
   */
  router.add('POST', '/api/postoffice/arm', async (ctx) => {
    const authed = requireLogin(ctx);
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
    if (modem.transceiverId === null) {
      throw new HttpError(409, 'the modem has no transceiver assigned, so the dial cannot be set', {
        transceiverId: 'missing',
      });
    }
    const radio = await store.getTransceiver(modem.transceiverId);
    if (!radio) {
      throw new HttpError(400, 'the modem names a transceiver that no longer exists', {
        modemId: 'stale',
      });
    }
    try {
      await links.tune(radio.id, frequencyHz, modem.rigMode);
    } catch (error) {
      throw new HttpError(
        409,
        `the transceiver ${radio.name} is not connected: ${error instanceof Error ? error.message : String(error)}`,
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
    const authed = requireLogin(ctx);
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

  return { router, handle, loginAttempts };
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
/** One callsign per account: an empty value clears it, anything else must look
 *  like a call sign (letters, digits, optionally one SSID). */
function normaliseCallsign(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') {
    throw new HttpError(400, 'the callsign must be a string', { callsign: 'invalid' });
  }
  const value = input.trim().toUpperCase();
  if (!value) return null;
  if (!/^[A-Z0-9]{1,10}([-/][A-Z0-9]{1,3})?$/.test(value)) {
    throw new HttpError(400, `invalid callsign: ${input}`, { callsign: 'invalid' });
  }
  if (/^[0-9]+$/.test(value)) {
    throw new HttpError(400, `invalid callsign: ${input}`, { callsign: 'invalid' });
  }
  return value;
}

/** A grid square locator (`JO70AA` or the four-character `JO70`), or null. */
function normaliseLocator(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') {
    throw new HttpError(400, 'the locator must be a string', { locator: 'invalid' });
  }
  const value = input.trim().toUpperCase();
  if (!value) return null;
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(value)) {
    throw new HttpError(400, `invalid locator: ${input} (expected a grid square like JO70AA)`, {
      locator: 'invalid',
    });
  }
  return value;
}

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