<script lang="ts">
	import { onMount } from 'svelte';
	import type { FolderWithCounts, Me, MessageDetail, MessageSummary, StatusResponse } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';
	import AccountView from './AccountView.svelte';
	import RadioControl from './RadioControl.svelte';
	import RadioView from './RadioView.svelte';
	import SessionView from './SessionView.svelte';
	import ModemView from './ModemView.svelte';
	import Composer from './Composer.svelte';
	import MessageList from './MessageList.svelte';
	import ModemControl from './ModemControl.svelte';
	import Reader from './Reader.svelte';
	import UsersView from './UsersView.svelte';

	let {
		me,
		status,
		onlogout,
		onmechange
	}: {
		me: Me;
		status: StatusResponse;
		onlogout: () => void;
		onmechange: (me: Me) => void;
	} = $props();

	type View = 'mail' | 'users' | 'account' | 'radio' | 'modems' | 'session';
	let view = $state<View>('mail');

	let folders = $state<FolderWithCounts[]>([]);
	let activeFolderId = $state(0);
	let messages = $state<MessageSummary[]>([]);
	let total = $state(0);
	let loading = $state(false);
	let error = $state('');
	let search = $state('');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let selected = $state<MessageDetail | null>(null);
	let showReader = $state(false);
	let composerOpen = $state(false);
	let replyTo = $state<MessageDetail | null>(null);

	const activeFolder = $derived(folders.find((folder) => folder.id === activeFolderId) ?? null);
	/**
	 * OUTBOX and SENT are mail *this* station sent, so every row has the same sender;
	 * listing the recipient is what makes the list readable. DRAFTS are not a folder kind
	 * here — an unsent message sits in OUTBOX until a session takes it.
	 */
	const listShowsRecipient = $derived(activeFolder?.kind === 'outbox' || activeFolder?.kind === 'sent');
	const unreadTotal = $derived(folders.reduce((sum, folder) => sum + (folder.kind === 'inbox' ? folder.unread : 0), 0));

	onMount(() => {
		folders = me.folders;
		activeFolderId = me.folders.find((folder) => folder.kind === 'inbox')?.id ?? me.folders[0]?.id ?? 0;
		void loadMessages();
		void loadFolders();
	});

	async function loadFolders(): Promise<void> {
		try {
			folders = await api.folders();
		} catch {
			// the folder counts are decoration; the list keeps working
		}
	}

	async function loadMessages(): Promise<void> {
		if (!activeFolderId) return;
		loading = true;
		error = '';
		try {
			const response = await api.messages(activeFolderId, { limit: 100, search: search.trim() });
			messages = response.messages;
			total = response.total;
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not load messages.';
		} finally {
			loading = false;
		}
	}

	async function selectFolder(folderId: number): Promise<void> {
		activeFolderId = folderId;
		selected = null;
		showReader = false;
		search = '';
		await loadMessages();
	}

	async function openMessage(id: number): Promise<void> {
		try {
			const message = await api.message(id);
			selected = message;
			showReader = true;
			if (message.unread) {
				const updated = await api.patchMessage(id, { unread: false });
				selected = updated;
				messages = messages.map((row) => (row.id === id ? { ...row, unread: false } : row));
				await loadFolders();
			}
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not open the message.';
		}
	}

	async function toggleFlag(message: MessageDetail): Promise<void> {
		const updated = await api.patchMessage(message.id, { flagged: !message.flagged });
		selected = updated;
		messages = messages.map((row) => (row.id === message.id ? { ...row, flagged: updated.flagged } : row));
	}

	async function markUnread(message: MessageDetail): Promise<void> {
		await api.patchMessage(message.id, { unread: true });
		messages = messages.map((row) => (row.id === message.id ? { ...row, unread: true } : row));
		selected = null;
		showReader = false;
		await loadFolders();
		await loadMessages();
	}

	async function removeMessage(message: MessageDetail): Promise<void> {
		const confirmed = window.confirm(
			`Delete “${message.subject || 'this message'}”? It moves to TRASH (a second delete removes it).`
		);
		if (!confirmed) return;
		await api.deleteMessage(message.id);
		selected = null;
		showReader = false;
		await loadFolders();
		await loadMessages();
	}

	function startCompose(): void {
		replyTo = null;
		composerOpen = true;
	}

	function startReply(message: MessageDetail): void {
		replyTo = message;
		composerOpen = true;
	}

	async function handleSent(created: MessageDetail): Promise<void> {
		composerOpen = false;
		replyTo = null;
		await loadFolders();
		if (created.folderId === activeFolderId) await loadMessages();
	}

	function onSearchInput(event: Event): void {
		const value = (event.currentTarget as HTMLInputElement).value;
		search = value;
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => void loadMessages(), 220);
	}

	async function signOut(): Promise<void> {
		try {
			await api.logout();
		} finally {
			onlogout();
		}
	}
</script>

<div class="app">
	<header class="top">
		<span class="mark">rfmail</span>
		<nav class="nav" aria-label="Sections">
			<button class="btn ghost" class:active={view === 'mail'} type="button" onclick={() => (view = 'mail')}>
				Mail
			</button>
			{#if me.user.role === 'admin'}
				<button class="btn ghost" class:active={view === 'users'} type="button" onclick={() => (view = 'users')}>
					Accounts
				</button>
			{/if}
			<button class="btn ghost" class:active={view === 'radio'} type="button" onclick={() => (view = 'radio')}>
				Radio
			</button>
			<button class="btn ghost" class:active={view === 'modems'} type="button" onclick={() => (view = 'modems')}>
				Modems
			</button>
			<button class="btn ghost" class:active={view === 'session'} type="button" onclick={() => (view = 'session')}>
				Session
			</button>
			<button class="btn ghost" class:active={view === 'account'} type="button" onclick={() => (view = 'account')}>
				Account
			</button>
		</nav>
		{#if unreadTotal > 0}
			<span class="badge accent">{unreadTotal} unread</span>
		{/if}
		<span class="spacer"></span>
		<span class="badge hide-narrow" title="Mail access policy">{status.accessMode}</span>
		{#if status.pop3}
			<span class="badge hide-narrow">POP3 {status.pop3.address}</span>
		{/if}
		{#if status.smtp}
			<span class="badge hide-narrow">SMTP {status.smtp.address}</span>
		{/if}
		{#if status.imap}
			<span class="badge hide-narrow">IMAP {status.imap.address}</span>
		{/if}
		<ModemControl />
		<RadioControl onopenconfig={() => (view = 'radio')} />
	</header>

	{#if view === 'radio'}
		<RadioView />
	{:else if view === 'modems'}
		<ModemView />
	{:else if view === 'session'}
		<SessionView onSent={() => void loadFolders()} />
	{:else if view === 'users'}
		<UsersView {me} onmechanged={onmechange} />
	{:else if view === 'account'}
		<AccountView {me} onchanged={onmechange} />
	{:else}
	<div class="body">
		<aside class="folders" aria-label="Folders">
			<!-- Whose mailbox this is: the callsign is the Winlink identity, the
			     login is the account name the mail program asks for. -->
			<div class="mailbox-owner" title="Callsign and account of this mailbox">
				{#if me.user.callsign}
					<span class="owner-call">{me.user.callsign}</span>
				{/if}
				<span class="owner-row">
					<span class="owner-login">{me.user.login}</span>
					<button class="change-user" type="button" onclick={signOut}>Change user</button>
				</span>
			</div>

			{#each folders as folder (folder.id)}
				<button
					type="button"
					class="folder"
					class:active={folder.id === activeFolderId}
					aria-current={folder.id === activeFolderId ? 'true' : undefined}
					onclick={() => selectFolder(folder.id)}
				>
					<span class="name">{folder.name}</span>
					{#if folder.unread > 0}
						<span class="count accent">{folder.unread}</span>
					{:else if folder.total > 0}
						<span class="count">{folder.total}</span>
					{/if}
				</button>
			{/each}

			<p class="aside-note">
				The rig is controlled from the header above. Radio delivery — the B2F session that moves queued
				mail over the air — still has to be built, so messages wait in OUTBOX.
			</p>
		</aside>

		<section class="pane-list" aria-label="Messages">
			<div class="toolbar">
				<span class="owner-mobile">{me.user.callsign ?? me.user.login}</span>
				<select
					class="folder-select"
					aria-label="Folder"
					value={activeFolderId}
					onchange={(event) => void selectFolder(Number((event.currentTarget as HTMLSelectElement).value))}
				>
					{#each folders as folder (folder.id)}
						<option value={folder.id}>{folder.name}{folder.unread > 0 ? ` (${folder.unread})` : ''}</option>
					{/each}
				</select>

				<h1 class="folder-title">
					{activeFolder?.name ?? 'Mailbox'}
					<span class="count-note">{total} message{total === 1 ? '' : 's'}</span>
				</h1>

				<input
					class="search"
					type="search"
					placeholder="Search subject or sender"
					aria-label="Search messages"
					value={search}
					oninput={onSearchInput}
				/>
				<button class="btn primary compose" type="button" onclick={startCompose}>Compose</button>
			</div>

			{#if error}
				<p class="error banner" role="alert">{error}</p>
			{/if}

			<MessageList
				{messages}
				selectedId={selected?.id ?? null}
				{loading}
				showRecipient={listShowsRecipient}
				onselect={openMessage}
			/>
		</section>

		<div class="pane-reader" class:open={showReader}>
			<Reader
				message={selected}
				onreply={startReply}
				ondelete={removeMessage}
				onflag={toggleFlag}
				onunread={markUnread}
				onclose={() => {
					showReader = false;
				}}
			/>
		</div>
	</div>
	{/if}
</div>

{#if composerOpen}
	<Composer {replyTo} onclose={() => (composerOpen = false)} onsent={handleSent} />
{/if}

<style>
	.app {
		display: grid;
		grid-template-rows: 56px minmax(0, 1fr);
		height: 100vh;
		overflow: hidden;
	}

	.top {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0 1rem;
		border-bottom: 1px solid var(--line);
		background: var(--bg-panel);
	}

	.mark {
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent);
		font-size: 0.85rem;
	}

	.nav {
		display: flex;
		gap: 0.15rem;
		margin-left: 0.5rem;
	}

	.nav .btn {
		padding: 0.3rem 0.65rem;
		font-size: 0.85rem;
		color: var(--muted);
	}

	.nav .btn.active {
		color: var(--text);
		background: var(--bg-raised);
		border-color: var(--line);
	}

	.spacer {
		flex: 1 1 auto;
	}

	.badge.accent {
		color: var(--accent);
		border-color: color-mix(in oklab, var(--accent) 40%, var(--line));
		background: var(--accent-soft);
	}

	.body {
		display: grid;
		grid-template-columns: 216px minmax(300px, 390px) minmax(0, 1fr);
		min-height: 0;
	}

	.folders {
		border-right: 1px solid var(--line);
		background: var(--bg-panel);
		padding: 0.75rem 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow-y: auto;
	}

	.mailbox-owner {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.15rem 0.5rem 0.6rem;
		margin-bottom: 0.35rem;
		border-bottom: 1px solid var(--line);
	}

	.owner-call {
		font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
		font-size: 0.95rem;
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.owner-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.change-user {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 0.7rem;
		color: var(--muted);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
		white-space: nowrap;
	}

	.change-user:hover {
		color: var(--accent);
	}

	.owner-mobile {
		display: none;
		font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
		font-size: 0.8rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.owner-login {
		font-size: 0.76rem;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.folder {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 0.45rem 0.6rem;
		color: var(--muted);
		font-size: 0.88rem;
	}

	.folder:hover {
		background: var(--bg-hover);
		color: var(--text);
	}

	.folder.active {
		background: var(--bg-raised);
		border-color: var(--line);
		color: var(--text);
		font-weight: 600;
	}

	.folder .name {
		flex: 1 1 auto;
		letter-spacing: 0.02em;
	}

	.count {
		font-size: 0.72rem;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}

	.count.accent {
		color: var(--accent);
		font-weight: 700;
	}

	.aside-note {
		margin: auto 0.6rem 0.25rem;
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--faint);
	}

	.pane-list {
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr);
		min-height: 0;
		background: var(--bg);
		border-right: 1px solid var(--line);
	}

	.toolbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.45rem 0.6rem;
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid var(--line);
	}

	.folder-select {
		display: none;
	}

	.folder-title {
		grid-column: 1;
		grid-row: 1;
		font-size: 0.95rem;
		margin: 0;
		letter-spacing: 0.03em;
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.count-note {
		font-size: 0.75rem;
		color: var(--faint);
		font-weight: 400;
	}

	.search {
		grid-column: 1 / -1;
		grid-row: 2;
		width: 100%;
		padding: 0.35rem 0.6rem;
		font-size: 0.85rem;
	}

	.compose {
		grid-column: 2;
		grid-row: 1;
		padding: 0.35rem 0.8rem;
		font-size: 0.85rem;
	}

	.banner {
		margin: 0;
		padding: 0.5rem 0.9rem;
		border-bottom: 1px solid var(--line);
		background: color-mix(in oklab, var(--danger) 12%, transparent);
	}

	.pane-reader {
		min-height: 0;
	}

	@media (max-width: 1000px) {
		.body {
			grid-template-columns: minmax(0, 1fr);
		}

		.folders {
			display: none;
		}

		.folder-select {
			display: block;
			grid-column: 1;
			grid-row: 1;
			background: var(--bg-raised);
			border: 1px solid var(--line);
			border-radius: 8px;
			padding: 0.35rem 0.5rem;
			font-size: 0.85rem;
		}

		.folder-title {
			display: none;
		}

		.pane-list {
			border-right: none;
		}

		.pane-reader {
			position: fixed;
			inset: 56px 0 0 0;
			background: var(--bg-panel);
			z-index: 30;
			transform: translateX(101%);
			transition: transform 160ms ease;
		}

		.pane-reader.open {
			transform: none;
		}

		.hide-narrow {
			display: none;
		}
	}
</style>
