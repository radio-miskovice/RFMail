<script lang="ts">
	import { onMount } from 'svelte';
	import type { Me, Role, User } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';
	import { formatDateTime } from '../format';

	let { me, onmechanged }: { me: Me; onmechanged: (me: Me) => void } = $props();

	let users = $state<User[]>([]);
	let loading = $state(false);
	let error = $state('');
	let notice = $state('');

	let newCallsign = $state('');
	let newLocator = $state('');
	let newRole = $state<Role>('user');
	let newPassword = $state('');
	let creating = $state(false);
	let createError = $state('');

	onMount(() => void load());

	async function load(): Promise<void> {
		loading = true;
		try {
			users = await api.users();
			error = '';
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not load accounts.';
		} finally {
			loading = false;
		}
	}

	async function create(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		creating = true;
		createError = '';
		notice = '';
		try {
			await api.createUser({
				callsign: newCallsign.trim(),
				role: newRole,
				...(newPassword ? { password: newPassword } : {}),
				...(newLocator.trim() ? { locator: newLocator.trim() } : {})
			});
			newCallsign = '';
			newLocator = '';
			newPassword = '';
			newRole = 'user';
			notice = 'Account created.';
			await load();
		} catch (err) {
			createError =
				err instanceof ApiRequestError
					? (Object.values(err.fields ?? {})[0] ?? err.message)
					: 'Could not create the account.';
		} finally {
			creating = false;
		}
	}

	async function toggleEnabled(user: User): Promise<void> {
		notice = '';
		error = '';
		try {
			await api.updateUser(user.id, { enabled: !user.enabled });
			await load();
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not update the account.';
		}
	}

	async function changeRole(user: User): Promise<void> {
		notice = '';
		error = '';
		try {
			await api.updateUser(user.id, { role: user.role === 'admin' ? 'user' : 'admin' });
			await load();
			const refreshed = await api.me();
			onmechanged(refreshed);
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not change the role.';
		}
	}

	async function resetPassword(user: User): Promise<void> {
		const value = window.prompt(`New password for ${user.callsign ?? 'this account'} (leave empty to remove the password):`, '');
		if (value === null) return;
		notice = '';
		error = '';
		try {
			const result = await api.resetPassword(user.id, value);
			notice = result.hasPassword
				? `Password set for ${user.callsign}.`
				: `Password removed for ${user.callsign}.`;
			await load();
		} catch (err) {
			error = err instanceof ApiRequestError ? (Object.values(err.fields ?? {})[0] ?? err.message) : 'Failed.';
		}
	}

	async function toggleOwner(user: User): Promise<void> {
		notice = '';
		error = '';
		try {
			await api.updateUser(user.id, { isPostOffice: !user.isPostOffice });
			notice = user.isPostOffice
				? `The post office no longer answers as ${user.callsign}.`
				: `The post office now answers as ${user.callsign}.`;
			await load();
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not change the post office owner.';
		}
	}

	async function resetPostOfficePassword(user: User): Promise<void> {
		const value = window.prompt(
			`Post-office password for ${user.callsign ?? 'this account'} — what it answers another station's challenge with (leave empty to remove):`,
			''
		);
		if (value === null) return;
		notice = '';
		error = '';
		try {
			const updated = await api.updateUser(user.id, { postOfficePassword: value });
			notice = updated.hasPostOfficePassword
				? `Post-office password set for ${user.callsign}.`
				: `Post-office password removed for ${user.callsign}.`;
			await load();
		} catch (err) {
			error = err instanceof ApiRequestError ? (Object.values(err.fields ?? {})[0] ?? err.message) : 'Failed.';
		}
	}

	async function remove(user: User): Promise<void> {
		if (!window.confirm(`Delete the account ${user.callsign ?? 'this account'} and its mailbox? This cannot be undone.`)) return;
		notice = '';
		error = '';
		try {
			await api.deleteUser(user.id);
			notice = `Account ${user.callsign} deleted.`;
			await load();
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not delete the account.';
		}
	}
</script>

<div class="panel">
	<header>
		<h1>Accounts</h1>
		<p class="muted small">
			Each account owns one mailbox and one session callsign — one callsign is one mailbox, so a club or
			expedition callsign gets its own account here. Every account may configure the radios, modems and
			sessions; only creating and administering accounts is reserved to the account that owns the station.
		</p>
	</header>

	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	<div class="table" aria-busy={loading}>
		<div class="head row">
			<span>Callsign</span>
			<span>WW-Locator</span>
			<span>Role</span>
			<span>Password</span>
			<span>Created</span>
			<span></span>
		</div>
		{#each users as user (user.id)}
			<div class="row" class:disabled={!user.enabled}>
				<span class="login">
					{user.callsign ?? '—'}
					{#if user.id === me.user.id}<span class="you">you</span>{/if}
					{#if !user.enabled}<span class="off">disabled</span>{/if}
					{#if user.isPostOffice}<span class="owner" title="This account's callsign is what the post office answers as">post office</span>{/if}
				</span>
				<span class="mono">{user.locator ?? '—'}</span>
				<button class="btn ghost small-btn" type="button" onclick={() => changeRole(user)} title="Toggle role">
					{user.role}
				</button>
				<span>{user.hasPassword ? 'set' : 'none'}</span>
				<span class="muted">{formatDateTime(user.createdAt)}</span>
				<span class="actions">
					<button class="btn ghost small-btn" type="button" onclick={() => resetPassword(user)}>Password</button>
					<button
						class="btn ghost small-btn"
						type="button"
						title="The password this account answers a post office's challenge with"
						onclick={() => resetPostOfficePassword(user)}
					>
						Post-office pw
					</button>
					<button
						class="btn ghost small-btn"
						type="button"
						title={user.isPostOffice
							? 'Stop answering calls as this account'
							: 'Make this account the station the post office answers as'}
						disabled={!user.callsign}
						onclick={() => toggleOwner(user)}
					>
						{user.isPostOffice ? 'Unown' : 'Make owner'}
					</button>
					<button class="btn ghost small-btn" type="button" onclick={() => toggleEnabled(user)}>
						{user.enabled ? 'Disable' : 'Enable'}
					</button>
					<button
						class="btn ghost small-btn danger"
						type="button"
						disabled={user.id === me.user.id}
						onclick={() => remove(user)}
					>
						Delete
					</button>
				</span>
			</div>
		{/each}
		{#if users.length === 0 && !loading}
			<p class="muted">No accounts.</p>
		{/if}
	</div>

	<section>
		<h2>New account</h2>
		<form onsubmit={create}>
			<div class="fields">
				<label class="field">
					<span>Callsign</span>
					<input type="text" name="callsign" bind:value={newCallsign} placeholder="OK1ABC" required />
				</label>
				<label class="field">
					<span>WW-Locator (optional)</span>
					<input
						type="text"
						name="locator"
						bind:value={newLocator}
						placeholder="JO70AA"
						title="Maidenhead grid square of that station"
					/>
				</label>
				<label class="field">
					<span>Role</span>
					<select name="role" bind:value={newRole}>
						<option value="user">user</option>
						<option value="admin">admin</option>
					</select>
				</label>
				<label class="field">
					<span>Password (optional)</span>
					<input type="password" name="password" autocomplete="new-password" bind:value={newPassword} />
				</label>
			</div>
			{#if createError}<p class="error" role="alert">{createError}</p>{/if}
			<button class="btn primary" type="submit" disabled={creating || !newCallsign.trim()}>
				{creating ? 'Creating…' : 'Create account'}
			</button>
		</form>
	</section>
</div>

<style>
	.panel {
		padding: 1.5rem;
		overflow-y: auto;
		min-height: 0;
	}

	h1 {
		font-size: 1.2rem;
		margin: 0 0 0.3rem;
	}

	header {
		margin-bottom: 1rem;
	}

	.small {
		font-size: 0.82rem;
		margin: 0;
		max-width: 46rem;
	}

	.table {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--line);
		border-radius: 10px;
		overflow: hidden;
	}

	.row {
		display: grid;
		grid-template-columns:
			minmax(8rem, 1.2fr) minmax(6rem, 1fr) minmax(6rem, 0.8fr) 6rem 6rem minmax(8rem, 1fr)
			auto;
		gap: 0.6rem;
		align-items: center;
		padding: 0.55rem 0.8rem;
		border-top: 1px solid var(--line);
		font-size: 0.88rem;
	}

	.row:first-child {
		border-top: none;
	}

	.head {
		background: var(--bg-raised);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.row.disabled .login {
		text-decoration: line-through;
		color: var(--muted);
	}

	.owner {
		margin-left: 0.4rem;
		padding: 0.05rem 0.35rem;
		border-radius: 0.25rem;
		border: 1px solid var(--accent);
		color: var(--accent);
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.login {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: 600;
	}

	.you,
	.off {
		font-size: 0.68rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--faint);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0.05rem 0.4rem;
	}

	.off {
		color: var(--danger);
		border-color: color-mix(in oklab, var(--danger) 40%, var(--line));
	}

	.mono {
		font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
		font-size: 0.82rem;
	}

	.actions {
		display: flex;
		gap: 0.25rem;
		justify-content: flex-end;
		flex-wrap: wrap;
	}

	.small-btn {
		font-size: 0.78rem;
		padding: 0.2rem 0.5rem;
	}

	.danger {
		color: var(--danger);
	}

	section {
		border-top: 1px solid var(--line);
		margin-top: 1.25rem;
		padding-top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	h2 {
		font-size: 0.95rem;
		margin: 0;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		align-items: flex-start;
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.75rem;
		width: 100%;
		max-width: 46rem;
	}

	select {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.55rem 0.7rem;
		color: var(--text);
	}

	.notice {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
		background: color-mix(in oklab, var(--ok) 12%, transparent);
		border-radius: 8px;
		font-size: 0.88rem;
	}

	@media (max-width: 1100px) {
		.row {
			grid-template-columns: 1fr;
			gap: 0.25rem;
		}

		.head {
			display: none;
		}

		.actions {
			justify-content: flex-start;
		}
	}
</style>
