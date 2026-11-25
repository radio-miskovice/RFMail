// Typed client for the rfmail HTTP API.
//
// One function per endpoint, one error type. The CSRF nonce comes from the
// session (/api/me) and is attached to every mutating request.

import type {
	ApiError,
	ComposeRequest,
	CreateUserRequest,
	FolderWithCounts,
	GatewayList,
	LoginRequest,
	Me,
	MessageDetail,
	MessageListResponse,
	Modem,
	ModemListenResponse,
	ModemStatusResponse,
	CreateModemRequest,
	UpdateModemRequest,
	ModemKind,
	PatchMessageRequest,
	PasswordRequest,
	CreateTransceiverRequest,
	SessionOptions,
	SessionRunRequest,
	SessionRunResponse,
	SessionTestRequest,
	SessionTestResponse,
	SetupRequest,
	StatusResponse,
	Transceiver,
	UpdateAccountRequest,
	UpdateTransceiverRequest,
	UpdateUserRequest,
	User
} from '@rfmail/shared';

export class ApiRequestError extends Error {
	readonly status: number;
	readonly fields: Record<string, string> | undefined;
	readonly passwordRequired: boolean;

	constructor(message: string, status: number, fields?: Record<string, string>, passwordRequired = false) {
		super(message);
		this.name = 'ApiRequestError';
		this.status = status;
		this.fields = fields;
		this.passwordRequired = passwordRequired;
	}
}

let csrfToken = '';

export function setCsrf(token: string): void {
	csrfToken = token;
}

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
	init: { signal?: AbortSignal } = {}
): Promise<T> {
	const headers: Record<string, string> = { accept: 'application/json' };
	if (body !== undefined) headers['content-type'] = 'application/json';
	if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

	const response = await fetch(path, {
		method,
		headers,
		credentials: 'same-origin',
		body: body === undefined ? undefined : JSON.stringify(body),
		...(init.signal ? { signal: init.signal } : {})
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
		throw new ApiRequestError(
			payload.error ?? response.statusText,
			response.status,
			payload.fields,
			payload.passwordRequired === true
		);
	}
	return parsed as T;
}

export const api = {
	status: (): Promise<StatusResponse> => request('GET', '/api/status'),

	setup: async (login: string): Promise<Me> => {
		const me = await request<Me>('POST', '/api/setup', { login } satisfies SetupRequest);
		setCsrf(me.csrf);
		return me;
	},

	login: async (login: string, password?: string): Promise<Me> => {
		const payload: LoginRequest = password === undefined ? { login } : { login, password };
		const me = await request<Me>('POST', '/api/login', payload);
		setCsrf(me.csrf);
		return me;
	},

	logout: async (): Promise<void> => {
		await request('POST', '/api/logout');
		csrfToken = '';
	},

	me: async (): Promise<Me> => {
		const me = await request<Me>('GET', '/api/me');
		setCsrf(me.csrf);
		return me;
	},

	folders: (): Promise<FolderWithCounts[]> => request('GET', '/api/folders'),

	messages: (folderId: number, options: { offset?: number; limit?: number; search?: string } = {}): Promise<MessageListResponse> => {
		const params = new URLSearchParams();
		if (options.offset !== undefined) params.set('offset', String(options.offset));
		if (options.limit !== undefined) params.set('limit', String(options.limit));
		if (options.search) params.set('search', options.search);
		const query = params.toString();
		return request('GET', `/api/folders/${folderId}/messages${query ? `?${query}` : ''}`);
	},

	message: (id: number): Promise<MessageDetail> => request('GET', `/api/messages/${id}`),

	patchMessage: (id: number, patch: PatchMessageRequest): Promise<MessageDetail> =>
		request('PATCH', `/api/messages/${id}`, patch),

	deleteMessage: (id: number): Promise<{ ok: boolean; movedToTrash: boolean }> =>
		request('DELETE', `/api/messages/${id}`),

	compose: (message: ComposeRequest): Promise<MessageDetail> => request('POST', '/api/messages', message),

	rawUrl: (id: number): string => `/api/messages/${id}/raw`,

	attachmentUrl: (messageId: number, attachmentId: number): string =>
		`/api/messages/${messageId}/attachments/${attachmentId}`,

	users: (): Promise<User[]> => request('GET', '/api/users'),

	createUser: (body: CreateUserRequest): Promise<User> => request('POST', '/api/users', body),

	updateUser: (id: number, body: UpdateUserRequest): Promise<User> =>
		request('PATCH', `/api/users/${id}`, body),

	deleteUser: (id: number): Promise<{ ok: boolean }> => request('DELETE', `/api/users/${id}`),

	resetPassword: (id: number, password: string): Promise<{ ok: boolean; hasPassword: boolean }> =>
		request('POST', `/api/users/${id}/password`, { password }),

	changePassword: (body: PasswordRequest): Promise<{ ok: boolean; hasPassword: boolean }> =>
		request('POST', '/api/account/password', body),

	updateAccount: (body: UpdateAccountRequest): Promise<Me> => request('PATCH', '/api/account', body),

	// -- transceivers (R2.2) --

	transceivers: (): Promise<Transceiver[]> => request('GET', '/api/transceivers'),

	createTransceiver: (body: CreateTransceiverRequest): Promise<Transceiver> =>
		request('POST', '/api/transceivers', body),

	updateTransceiver: (id: number, body: UpdateTransceiverRequest): Promise<Transceiver> =>
		request('PATCH', `/api/transceivers/${id}`, body),

	deleteTransceiver: (id: number): Promise<{ ok: boolean }> => request('DELETE', `/api/transceivers/${id}`),

	// -- modems (R3) --

	modems: (): Promise<Modem[]> => request('GET', '/api/modems'),

	/** Which configured modems are actually listening: a TCP connect, nothing more. */
	modemStatus: (): Promise<ModemStatusResponse> => request('GET', '/api/modems/status'),

	createModem: (body: CreateModemRequest): Promise<Modem> => request('POST', '/api/modems', body),

	updateModem: (id: number, body: UpdateModemRequest): Promise<Modem> =>
		request('PATCH', `/api/modems/${id}`, body),

	deleteModem: (id: number): Promise<{ ok: boolean }> => request('DELETE', `/api/modems/${id}`),

	// -- sessions (R4) --

	sessionOptions: (): Promise<SessionOptions> => request('GET', '/api/session/options'),

	/** The RMS gateway catalogue, filtered by modem and band, and ordered. */
	gateways: (params: {
		modem?: ModemKind | null;
		band?: string | null;
		sort?: 'quality' | 'distance' | 'callsign';
		limit?: number;
		refresh?: boolean;
		emcomm?: boolean;
	}): Promise<GatewayList> => {
		const query = new URLSearchParams();
		if (params.modem) query.set('modem', params.modem);
		if (params.band) query.set('band', params.band);
		if (params.sort) query.set('sort', params.sort);
		if (params.limit) query.set('limit', String(params.limit));
		if (params.refresh) query.set('refresh', '1');
		if (params.emcomm) query.set('emcomm', '1');
		return request('GET', `/api/gateways?${query.toString()}`);
	},

	/** Dials the gateway through a modem and hangs up, to prove the chain answers. */
	testSession: (body: SessionTestRequest): Promise<SessionTestResponse> =>
		request('POST', '/api/session/test', body),

	/** The exchange itself: dial, move mail both ways, file it away, hang up. */
	runSession: (body: SessionRunRequest): Promise<SessionRunResponse> =>
		request('POST', '/api/session/run', body),

	/** Arms or disarms a modem for inbound calls: `LISTEN ON` / `LISTEN OFF`. */
	setModemListening: (id: number, on: boolean): Promise<ModemListenResponse> =>
		request('POST', `/api/modems/${id}/listen`, { on }),

	/** Opens the rig link; a 502 carries the reason the LED is red. */
	connectTransceiver: (id: number): Promise<{ transceiver: Transceiver; error: string | null }> =>
		request('POST', `/api/transceivers/${id}/connect`),

	disconnectTransceiver: (id: number): Promise<{ transceiver: Transceiver }> =>
		request('POST', `/api/transceivers/${id}/disconnect`)
};
