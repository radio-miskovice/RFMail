// Typed client for the post office's HTTP API.
//
// One function per endpoint, one error type, and the CSRF nonce from the session
// attached to every mutating request — the same shape as the client station's, because
// the two consoles are built from the same house style.

import type {
	ApiError,
	CreatePoAdministratorRequest,
	CreatePoMailboxRequest,
	Modem,
	PoAdministrator,
	PoCall,
	PoCallsResponse,
	PoMailbox,
	PoMe,
	PoStation,
	PoStatus,
	UpdatePoAdministratorRequest,
	UpdatePoMailboxRequest
} from '@rfmail/shared';

export class ApiRequestError extends Error {
	readonly status: number;
	readonly fields: Record<string, string> | undefined;

	constructor(message: string, status: number, fields?: Record<string, string>) {
		super(message);
		this.name = 'ApiRequestError';
		this.status = status;
		this.fields = fields;
	}
}

let csrfToken = '';

export function setCsrf(token: string): void {
	csrfToken = token;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { accept: 'application/json' };
	if (body !== undefined) headers['content-type'] = 'application/json';
	if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

	const response = await fetch(path, {
		method,
		headers,
		credentials: 'same-origin',
		body: body === undefined ? undefined : JSON.stringify(body)
	});

	const text = await response.text();
	let parsed: unknown = null;
	if (text) {
		try {
			parsed = JSON.parse(text) as unknown;
		} catch {
			parsed = null;
		}
	}
	if (!response.ok) {
		const payload = (parsed ?? {}) as Partial<ApiError>;
		throw new ApiRequestError(payload.error ?? response.statusText, response.status, payload.fields);
	}
	return parsed as T;
}

export const api = {
	status: (): Promise<PoStatus> => request('GET', '/api/status'),

	setup: async (input: {
		callsign: string;
		name: string;
		password: string;
		locator?: string;
	}): Promise<PoMe> => {
		const me = await request<PoMe>('POST', '/api/setup', input);
		setCsrf(me.csrf);
		return me;
	},

	login: async (name: string, password: string): Promise<PoMe> => {
		const me = await request<PoMe>('POST', '/api/login', { name, password });
		setCsrf(me.csrf);
		return me;
	},

	logout: async (): Promise<void> => {
		await request('POST', '/api/logout');
		csrfToken = '';
	},

	me: async (): Promise<PoMe> => {
		const me = await request<PoMe>('GET', '/api/me');
		setCsrf(me.csrf);
		return me;
	},

	mailboxes: (): Promise<{ mailboxes: PoMailbox[] }> => request('GET', '/api/mailboxes'),

	createMailbox: (body: CreatePoMailboxRequest): Promise<PoMailbox> =>
		request('POST', '/api/mailboxes', body),

	updateMailbox: (id: number, body: UpdatePoMailboxRequest): Promise<PoMailbox> =>
		request('PATCH', `/api/mailboxes/${id}`, body),

	deleteMailbox: (id: number): Promise<{ ok: boolean }> => request('DELETE', `/api/mailboxes/${id}`),

	administrators: (): Promise<{
		administrators: Array<PoAdministrator & { self: boolean }>;
	}> => request('GET', '/api/admins'),

	createAdministrator: (body: CreatePoAdministratorRequest): Promise<PoAdministrator> =>
		request('POST', '/api/admins', body),

	updateAdministrator: (id: number, body: UpdatePoAdministratorRequest): Promise<PoAdministrator> =>
		request('PATCH', `/api/admins/${id}`, body),

	deleteAdministrator: (id: number): Promise<{ ok: boolean }> => request('DELETE', `/api/admins/${id}`),

	station: (): Promise<PoStation> => request('GET', '/api/station'),

	arm: (modemId: number): Promise<PoStation> => request('POST', '/api/station/arm', { modemId }),

	disarm: (): Promise<PoStation> => request('POST', '/api/station/disarm'),

	calls: (limit = 100): Promise<PoCallsResponse> => request('GET', `/api/calls?limit=${limit}`),

	modems: (): Promise<{ modems: Modem[] }> => request('GET', '/api/modems'),

	createModem: (body: {
		kind: string;
		host: string;
		commandPort?: number;
		dataPort?: number;
	}): Promise<Modem> => request('POST', '/api/modems', body),

	deleteModem: (id: number): Promise<{ ok: boolean }> => request('DELETE', `/api/modems/${id}`)
};
