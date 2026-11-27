// The post office console's HTTP API.
//
// Two principals, and the API keeps them apart all the way down (decision 58):
//
//   *administrator*  the only thing that can sign in here. A local name and a
//                     scrypt password, a session cookie, a CSRF nonce, and the one
//                     optional permission to read other mailboxes' envelopes.
//   *mailbox*         a callsign the station holds mail for. It has no password
//                     hash, no session and no route: nothing in this file lets one
//                     sign in, and the session's `uid` is an administrator id, never
//                     a mailbox id — `store.getUser(session.uid)` is deliberately
//                     never called.
//
// The station's identity is a mailbox too, the one the post office answers as. It
// appears in the list, marked, and cannot be deleted from here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HttpError,
  Router,
  SESSION_COOKIE,
  Sessions,
  createStaticHandler,
  normaliseCallsign,
  normaliseLocator,
  parseCookies,
  readJson,
  sendError,
  sendJson,
  type Ctx,
  type Handler,
} from '@rfmail/server';
import type { PeerPolicy } from '@rfmail/mailservers';
import {
  hashPassword,
  verifyPassword,
  type AdministratorRecord,
  type PostOfficeCallRecord,
  type Store,
  type UserRecord,
} from '@rfmail/store';
import type { PostOffice } from '@rfmail/server';
import {
  MODEM_KINDS,
  type CreatePoAdministratorRequest,
  type CreatePoMailboxRequest,
  type Logger,
  type ModemKind,
  type PoAdministrator,
  type PoArmRequest,
  type PoCall,
  type PoCallsResponse,
  type PoLoginRequest,
  type PoMailbox,
  type PoMe,
  type PoSetupRequest,
  type PoStation,
  type PoStatus,
  type UpdatePoAdministratorRequest,
  type UpdatePoMailboxRequest,
} from '@rfmail/shared';

/** What the API needs from the running station. */
export interface PoApiServices {
  store: Store;
  sessions: Sessions;
  policy: PeerPolicy;
  logger: Logger;
  storeKey: string;
  postOffice: PostOffice;
  uiDir: string;
  secureCookies: boolean;
  appVersion: string;
  /** Seals a credential with the installation's store key. */
  seal(plaintext: string): string;
}

/** How many sign-in failures one address may make before it has to wait. */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPTS = 5;

export interface PoApi {
  router: Router;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  loginAttempts: Map<string, { count: number; resetAt: number }>;
}

export function createPoApi(services: PoApiServices): PoApi {
  const { store, sessions, policy, logger, postOffice } = services;
  const router = new Router();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  router.setFallback(createStaticHandler(services.uiDir));

  const administratorDto = (admin: AdministratorRecord): PoAdministrator => ({
    id: admin.id,
    name: admin.name,
    canInspect: admin.canInspect,
    enabled: admin.enabled,
    createdAt: admin.createdAt,
  });

  const callDto = (call: PostOfficeCallRecord): PoCall => ({
    id: call.id,
    peer: call.peer,
    startedAt: call.startedAt,
    elapsedMs: call.elapsedMs,
    result: call.result,
    sent: call.sent,
    received: call.received,
    reason: call.reason,
  });

  const stationCallsign = async (): Promise<string | null> => {
    const owner = await store.findPostOfficeOwner();
    return owner?.callsign ?? null;
  };

  const mailboxDto = async (mailbox: UserRecord, stationId: number | null): Promise<PoMailbox> => {
    const folders = await store.listFolders(mailbox.id);
    return {
      id: mailbox.id,
      callsign: mailbox.callsign ?? mailbox.login,
      enabled: mailbox.enabled,
      quotaBytes: mailbox.quotaBytes,
      bytes: await store.usage(mailbox.id),
      messages: folders.reduce((total, folder) => total + folder.total, 0),
      hasPassword: mailbox.postOfficeSecret !== null,
      createdAt: mailbox.createdAt,
      isStation: mailbox.id === stationId,
    };
  };

  const requireAdministrator = async (ctx: Ctx, csrf: boolean): Promise<AdministratorRecord> => {
    if (!ctx.session) throw new HttpError(401, 'sign in first');
    const admin = await store.getAdministrator(ctx.session.uid);
    if (!admin || !admin.enabled) throw new HttpError(401, 'administrator no longer active');
    if (csrf) {
      const sent = ctx.req.headers['x-csrf-token'];
      if (typeof sent !== 'string' || sent !== ctx.session.csrf) {
        throw new HttpError(403, 'invalid CSRF token');
      }
    }
    return admin;
  };

  const meResponse = async (admin: AdministratorRecord, csrf: string): Promise<PoMe> => ({
    administrator: administratorDto(admin),
    callsign: await stationCallsign(),
    csrf,
  });

  const setSession = (res: ServerResponse, admin: AdministratorRecord): PoMe => {
    const { token, payload } = sessions.issue(admin.id);
    res.setHeader('Set-Cookie', sessions.cookieHeader(token, services.secureCookies));
    return {
      administrator: administratorDto(admin),
      callsign: null,
      csrf: payload.csrf,
    };
  };

  const stationResponse = async (): Promise<PoStation> => {
    const snapshot = postOffice.snapshot();
    const owner = await store.findPostOfficeOwner();
    const modems = await store.listModems();
    const recent = await store.listCalls(20);
    return {
      callsign: owner?.callsign ?? snapshot.owner,
      armed: snapshot.armed,
      busy: snapshot.busy,
      modemId: snapshot.modemId,
      modemName: snapshot.modemName,
      frequencyHz: snapshot.frequencyHz,
      error: snapshot.error,
      current: snapshot.sessions.length > 0 && snapshot.busy ? (snapshot.sessions[0] ?? null) : null,
      modems: modems.map((modem) => ({
        id: modem.id,
        name: modem.name,
        kind: modem.kind,
        host: modem.host,
        commandPort: modem.commandPort,
        dataPort: modem.dataPort,
      })),
      recent: recent.map(callDto),
    };
  };

  // -- public -----------------------------------------------------------------

  router.add('GET', '/api/status', async (ctx) => {
    const admins = await store.countAdministrators();
    const status: PoStatus = {
      app: 'rfmail post office',
      version: services.appVersion,
      state: admins === 0 ? 'setup' : 'ready',
      callsign: await stationCallsign(),
    };
    sendJson(ctx.res, 200, status);
  });

  /**
   * The first start, in one act: the callsign the station answers as, and the person
   * who administers it. Both are needed before anything can happen — a post office
   * with no callsign has no identity, one with no administrator has no operator — and
   * the two are still two rows: a mailbox and an administrator.
   */
  router.add('POST', '/api/setup', async (ctx) => {
    if ((await store.countAdministrators()) > 0) {
      throw new HttpError(409, 'this station already has an administrator');
    }
    const body = await readJson<PoSetupRequest>(ctx.req);
    const callsign = normaliseCallsign(body.callsign);
    if (!callsign) throw new HttpError(400, 'a callsign is required', { callsign: 'required' });
    const locator = normaliseLocator(body.locator);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') throw new HttpError(400, 'an administrator name is required', { name: 'required' });
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) {
      throw new HttpError(400, 'the password needs at least eight characters', { password: 'short' });
    }

    let mailbox: UserRecord;
    try {
      // A mailbox, not an account: no password hash, and nothing in this application
      // can sign it in.
      mailbox = await store.createUser({ callsign, pwHash: null, role: 'user' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(message)) {
        throw new HttpError(409, `${callsign} already has a mailbox here`, { callsign: 'duplicate' });
      }
      throw err;
    }

    try {
      await store.setPostOfficeOwner(mailbox.id);
      if (locator) await store.setLocator(mailbox.id, locator);
      const admin = await store.createAdministrator({
        name,
        pwHash: hashPassword(password),
        canInspect: false,
      });
      logger.info('post office configured', { callsign, administrator: admin.name });
      const me = setSession(ctx.res, admin);
      me.callsign = callsign;
      sendJson(ctx.res, 201, me);
    } catch (err) {
      // A half-made installation is worse than none: the callsign would be taken and
      // nobody could administer it.
      await store.deleteUser(mailbox.id).catch(() => undefined);
      throw err;
    }
  });

  router.add('POST', '/api/login', async (ctx) => {
    const remote = ctx.remote;
    const now = Date.now();
    const entry = loginAttempts.get(remote);
    if (entry && entry.resetAt > now && entry.count >= LOGIN_ATTEMPTS) {
      logger.warn('post office sign-in rate limited', { remote });
      throw new HttpError(429, 'too many sign-in attempts; try again later');
    }
    const body = await readJson<PoLoginRequest>(ctx.req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const admin = name === '' ? null : await store.findAdministrator(name);
    const ok = admin !== null && admin.enabled && verifyPassword(password, admin.pwHash);
    if (!ok) {
      // Uniform on the wire, specific in the log: the spelling that arrived is the only
      // thing that tells an operator why their own name did not get in.
      const current = loginAttempts.get(remote);
      loginAttempts.set(remote, {
        count: current && current.resetAt > now ? current.count + 1 : 1,
        resetAt: current && current.resetAt > now ? current.resetAt : now + LOGIN_WINDOW_MS,
      });
      logger.warn('post office sign-in refused', { remote, name, known: admin !== null });
      throw new HttpError(401, 'invalid name or password');
    }
    logger.info('post office sign-in', { remote, administrator: admin.name });
    const me = setSession(ctx.res, admin);
    me.callsign = await stationCallsign();
    sendJson(ctx.res, 200, me);
  });

  router.add('POST', '/api/logout', async (ctx) => {
    await requireAdministrator(ctx, true);
    ctx.res.setHeader('Set-Cookie', sessions.clearCookieHeader(services.secureCookies));
    sendJson(ctx.res, 200, { ok: true });
  });

  router.add('GET', '/api/me', async (ctx) => {
    const admin = await requireAdministrator(ctx, false);
    const session = ctx.session;
    if (!session) throw new HttpError(401, 'sign in first');
    const me = await meResponse(admin, session.csrf);
    sendJson(ctx.res, 200, me);
  });

  // -- mailboxes ---------------------------------------------------------------

  router.add('GET', '/api/mailboxes', async (ctx) => {
    await requireAdministrator(ctx, false);
    const owner = await store.findPostOfficeOwner();
    const rows = await store.listUsers();
    const mailboxes = await Promise.all(rows.map((row) => mailboxDto(row, owner?.id ?? null)));
    mailboxes.sort((a, b) => a.callsign.localeCompare(b.callsign));
    sendJson(ctx.res, 200, { mailboxes });
  });

  router.add('POST', '/api/mailboxes', async (ctx) => {
    const admin = await requireAdministrator(ctx, true);
    const body = await readJson<CreatePoMailboxRequest>(ctx.req);
    const callsign = normaliseCallsign(body.callsign);
    if (!callsign) throw new HttpError(400, 'a callsign is required', { callsign: 'required' });
    const password = typeof body.password === 'string' ? body.password : '';
    if (password !== '' && password.length < 8) {
      throw new HttpError(400, 'the password needs at least eight characters', { password: 'short' });
    }
    let mailbox: UserRecord;
    try {
      mailbox = await store.createUser({
        callsign,
        pwHash: null,
        role: 'user',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(message)) {
        throw new HttpError(409, `${callsign} already has a mailbox here`, { callsign: 'duplicate' });
      }
      throw err;
    }
    if (typeof body.quotaBytes === 'number' && body.quotaBytes >= 0) {
      await store.updateUser(mailbox.id, { quotaBytes: Math.trunc(body.quotaBytes) });
    }
    if (password !== '') {
      const sealed = services.seal(password);
      await store.setPostOfficeSecret(mailbox.id, sealed);
    }
    logger.info('post office mailbox created', { callsign, by: admin.name, password: password !== '' });
    const owner = await store.findPostOfficeOwner();
    const fresh = (await store.getUser(mailbox.id)) ?? mailbox;
    sendJson(ctx.res, 201, await mailboxDto(fresh, owner?.id ?? null));
  });

  router.add('PATCH', '/api/mailboxes/:id', async (ctx) => {
    const admin = await requireAdministrator(ctx, true);
    const id = Number(ctx.params['id']);
    const mailbox = await store.getUser(id);
    if (!mailbox) throw new HttpError(404, 'mailbox not found');
    const body = await readJson<UpdatePoMailboxRequest>(ctx.req);
    const owner = await store.findPostOfficeOwner();
    if (mailbox.id === owner?.id && body.enabled === false) {
      throw new HttpError(409, 'the station cannot stop answering as itself', { enabled: 'station' });
    }
    if (body.enabled !== undefined) await store.updateUser(id, { enabled: body.enabled });
    if (typeof body.quotaBytes === 'number' && body.quotaBytes >= 0) {
      await store.updateUser(id, { quotaBytes: Math.trunc(body.quotaBytes) });
    }
    if (body.password !== undefined) {
      const password = typeof body.password === 'string' ? body.password : '';
      if (password !== '' && password.length < 8) {
        throw new HttpError(400, 'the password needs at least eight characters', { password: 'short' });
      }
      // An empty string clears it; the post office then refuses that mailbox's callers
      // rather than admitting anybody who types the callsign.
      await store.setPostOfficeSecret(id, password === '' ? null : services.seal(password));
    }
    const fresh = (await store.getUser(id)) ?? mailbox;
    logger.info('post office mailbox changed', {
      callsign: fresh.callsign,
      by: admin.name,
      enabled: fresh.enabled,
      password: body.password !== undefined,
    });
    sendJson(ctx.res, 200, await mailboxDto(fresh, owner?.id ?? null));
  });

  router.add('DELETE', '/api/mailboxes/:id', async (ctx) => {
    const admin = await requireAdministrator(ctx, true);
    const id = Number(ctx.params['id']);
    const owner = await store.findPostOfficeOwner();
    if (owner?.id === id) {
      throw new HttpError(409, 'the station\'s own mailbox cannot be deleted', { id: 'station' });
    }
    const mailbox = await store.getUser(id);
    if (!mailbox) throw new HttpError(404, 'mailbox not found');
    await store.deleteUser(id);
    logger.info('post office mailbox deleted', { callsign: mailbox.callsign, by: admin.name });
    sendJson(ctx.res, 200, { ok: true });
  });

  // -- administrators ----------------------------------------------------------

  router.add('GET', '/api/admins', async (ctx) => {
    const admin = await requireAdministrator(ctx, false);
    const admins = await store.listAdministrators();
    sendJson(ctx.res, 200, {
      administrators: admins.map((row) => ({
        ...administratorDto(row),
        self: row.id === admin.id,
      })),
    });
  });

  router.add('POST', '/api/admins', async (ctx) => {
    const actor = await requireAdministrator(ctx, true);
    const body = await readJson<CreatePoAdministratorRequest>(ctx.req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') throw new HttpError(400, 'a name is required', { name: 'required' });
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) {
      throw new HttpError(400, 'the password needs at least eight characters', { password: 'short' });
    }
    let created: AdministratorRecord;
    try {
      created = await store.createAdministrator({
        name,
        pwHash: hashPassword(password),
        canInspect: body.canInspect === true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(message)) {
        throw new HttpError(409, `there is already an administrator called ${name}`, { name: 'duplicate' });
      }
      throw err;
    }
    logger.info('post office administrator created', { administrator: created.name, by: actor.name });
    sendJson(ctx.res, 201, administratorDto(created));
  });

  router.add('PATCH', '/api/admins/:id', async (ctx) => {
    const actor = await requireAdministrator(ctx, true);
    const id = Number(ctx.params['id']);
    const target = await store.getAdministrator(id);
    if (!target) throw new HttpError(404, 'administrator not found');
    const body = await readJson<UpdatePoAdministratorRequest>(ctx.req);

    if (body.enabled === false && target.id === actor.id) {
      throw new HttpError(409, 'you cannot disable the administrator you are signed in as', {
        enabled: 'self',
      });
    }
    // "Last administrator" is computed from the state after the change: removing a
    // disabled administrator is harmless, demoting the last enabled one locks the
    // station out.
    if (body.enabled === false || body.canInspect === true || body.password !== undefined) {
      if (body.enabled === false) {
        const enabled = (await store.listAdministrators()).filter((row) => row.enabled && row.id !== id);
        if (enabled.length === 0) {
          throw new HttpError(409, 'this is the last enabled administrator', { enabled: 'last' });
        }
      }
    }
    let pwHash: string | undefined;
    if (body.password !== undefined) {
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 8) {
        throw new HttpError(400, 'the password needs at least eight characters', { password: 'short' });
      }
      pwHash = hashPassword(password);
    }
    const updated = await store.updateAdministrator(id, {
      ...(pwHash === undefined ? {} : { pwHash }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.canInspect === undefined ? {} : { canInspect: body.canInspect === true }),
    });
    if (!updated) throw new HttpError(404, 'administrator not found');
    logger.info('post office administrator changed', {
      administrator: updated.name,
      by: actor.name,
      enabled: updated.enabled,
      canInspect: updated.canInspect,
      password: pwHash !== undefined,
    });
    sendJson(ctx.res, 200, administratorDto(updated));
  });

  router.add('DELETE', '/api/admins/:id', async (ctx) => {
    const actor = await requireAdministrator(ctx, true);
    const id = Number(ctx.params['id']);
    if (id === actor.id) {
      throw new HttpError(409, 'you cannot delete the administrator you are signed in as', { id: 'self' });
    }
    const target = await store.getAdministrator(id);
    if (!target) throw new HttpError(404, 'administrator not found');
    const remaining = (await store.listAdministrators()).filter((row) => row.enabled && row.id !== id);
    if (remaining.length === 0) {
      throw new HttpError(409, 'this is the last enabled administrator', { id: 'last' });
    }
    await store.deleteAdministrator(id);
    logger.info('post office administrator deleted', { administrator: target.name, by: actor.name });
    sendJson(ctx.res, 200, { ok: true });
  });

  // -- the station -------------------------------------------------------------

  router.add('GET', '/api/station', async (ctx) => {
    await requireAdministrator(ctx, false);
    sendJson(ctx.res, 200, await stationResponse());
  });

  /**
   * Arms the modem: `MYCALL` and `LISTEN ON` on the station's one modem. Until the
   * radio screen lands the operator tunes the transceiver; the dial is recorded for
   * the call log and nothing is written to a rig.
   */
  router.add('POST', '/api/station/arm', async (ctx) => {
    const admin = await requireAdministrator(ctx, true);
    const body = await readJson<PoArmRequest>(ctx.req);
    if (postOffice.isArmed) {
      throw new HttpError(409, 'the post office is already armed; disarm it first', { armed: 'already' });
    }
    const owner = await store.findPostOfficeOwner();
    if (!owner || !owner.callsign) {
      throw new HttpError(409, 'this station has no callsign yet');
    }
    const modem = await store.getModem(Number(body.modemId));
    if (!modem) throw new HttpError(404, 'modem not found');
    if (!modem.commandPort) {
      throw new HttpError(400, 'this modem has no command port', { modemId: 'noport' });
    }
    if (!modem.dataPort) {
      throw new HttpError(400, 'this modem has no data port, so a call has nowhere to run', {
        modemId: 'nodata',
      });
    }
    const frequencyHz = typeof body.frequencyHz === 'number' && body.frequencyHz > 0 ? body.frequencyHz : 0;
    try {
      await postOffice.arm({
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(
        502,
        `the modem did not answer at ${modem.host}:${modem.commandPort}: ${reason}`,
        { modemId: 'unreachable' },
      );
    }
    logger.info('post office armed', { by: admin.name, modem: modem.name, frequencyHz });
    sendJson(ctx.res, 200, await stationResponse());
  });

  router.add('POST', '/api/station/disarm', async (ctx) => {
    const admin = await requireAdministrator(ctx, true);
    const modemName = postOffice.snapshot().modemName;
    await postOffice.disarm();
    logger.info('post office disarmed', { by: admin.name, modem: modemName });
    sendJson(ctx.res, 200, await stationResponse());
  });

  router.add('GET', '/api/calls', async (ctx) => {
    await requireAdministrator(ctx, false);
    const limit = Number(ctx.url.searchParams.get('limit') ?? '100');
    const calls = await store.listCalls(Number.isFinite(limit) ? limit : 100);
    const response: PoCallsResponse = { calls: calls.map(callDto) };
    sendJson(ctx.res, 200, response);
  });

  // -- modems ------------------------------------------------------------------

  router.add('GET', '/api/modems', async (ctx) => {
    await requireAdministrator(ctx, false);
    const modems = await store.listModems();
    sendJson(ctx.res, 200, { modems: modems.map((modem) => ({ ...modem })) });
  });

  router.add('POST', '/api/modems', async (ctx) => {
    const admin = await requireAdministrator(ctx, true);
    const body = await readJson<{
      name?: unknown;
      kind?: unknown;
      host?: unknown;
      commandPort?: unknown;
      dataPort?: unknown;
    }>(ctx.req);
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    if (host === '') throw new HttpError(400, 'a host is required', { host: 'required' });
    const known = MODEM_KINDS.find((entry) => entry.kind === body.kind);
    if (!known) {
      throw new HttpError(400, 'unknown modem kind', { kind: 'invalid' });
    }
    const portOf = (value: unknown, fallback: number | null): number | null => {
      if (value === null || value === undefined || value === '') return fallback;
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new HttpError(400, 'a port must be between 1 and 65535', { port: 'invalid' });
      }
      return port;
    };
    const commandPort = portOf(body.commandPort, known.commandPort);
    const dataPort = portOf(body.dataPort, known.dataPort);
    if (commandPort === null) {
      throw new HttpError(400, 'this modem kind needs a command port', { commandPort: 'required' });
    }
    const name =
      typeof body.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : `${known.label} ${host}:${commandPort}`;
    const modem = await store.createModem({
      name,
      kind: known.kind as ModemKind,
      host,
      commandPort,
      dataPort,
      kissPort: known.kissPort,
      rigMode: known.rigMode,
      transceiverId: null,
      enabled: true,
    });
    logger.info('post office modem added', { modem: modem.name, host, port: commandPort, by: admin.name });
    sendJson(ctx.res, 201, modem);
  });

  router.add('DELETE', '/api/modems/:id', async (ctx) => {
    const admin = await requireAdministrator(ctx, true);
    const id = Number(ctx.params['id']);
    if (postOffice.modemId === id) {
      throw new HttpError(409, 'that modem is answering calls; disarm it first', { id: 'armed' });
    }
    const modem = await store.getModem(id);
    if (!modem) throw new HttpError(404, 'modem not found');
    await store.deleteModem(id);
    logger.info('post office modem removed', { modem: modem.name, by: admin.name });
    sendJson(ctx.res, 200, { ok: true });
  });

  // -- the request path ---------------------------------------------------------

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const remote = req.socket.remoteAddress ?? '';
    if (!policy.allows(remote)) {
      logger.warn('post office connection refused by access policy', { remote });
      sendError(res, 403, 'access denied from this address');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const session = token ? sessions.verify(token) : null;
    const ctx: Ctx = { req, res, url, params: {}, session, remote };
    try {
      const handled = await router.dispatch(ctx);
      if (!handled || (!res.headersSent && !res.writableEnded)) sendError(res, 404, 'not found');
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
      logger.error('unhandled post office API error', {
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      sendError(res, 500, 'internal error');
    }
  };

  return { router, handle, loginAttempts };
}

export type { Handler };
