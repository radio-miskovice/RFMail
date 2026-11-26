<script lang="ts">
	import { onMount } from 'svelte';
	import type { Me } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';
	import { formatDateTime } from '../format';

	let { me, onchanged }: { me: Me; onchanged: (me: Me) => void } = $props();

	let callsign = $state('');
	let locator = $state('');
	let winlinkPassword = $state('');
	let hasWinlinkPassword = $state(false);
	let clearWinlink = $state(false);
	let postOfficePassword = $state('');
	let hasPostOfficePassword = $state(false);
	let clearPostOffice = $state(false);
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let hasPassword = $state(false);
	/** The login-password form is folded away: setting a password is a rare act. */
	let passwordOpen = $state(false);

	onMount(() => {
		callsign = me.user.callsign ?? '';
		locator = me.user.locator ?? '';
		hasPassword = me.user.hasPassword;
		hasWinlinkPassword = me.user.hasWinlinkPassword;
		hasPostOfficePassword = me.user.hasPostOfficePassword;
	});
	let busy = $state(false);
	let notice = $state('');
	let errors = $state<Record<string, string>>({});

	async function saveStation(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		busy = true;
		notice = '';
		errors = {};
		try {
			const patch: {
				callsign: string | null;
				locator: string | null;
				winlinkPassword?: string | null;
				postOfficePassword?: string | null;
			} = {
				callsign: callsign.trim() || null,
				locator: locator.trim().toUpperCase() || null
			};
			if (clearWinlink) patch.winlinkPassword = null;
			else if (winlinkPassword.length > 0) patch.winlinkPassword = winlinkPassword;
			if (clearPostOffice) patch.postOfficePassword = null;
			else if (postOfficePassword.length > 0) patch.postOfficePassword = postOfficePassword;
			const updated = await api.updateAccount(patch);
			callsign = updated.user.callsign ?? '';
			locator = updated.user.locator ?? '';
			hasWinlinkPassword = updated.user.hasWinlinkPassword;
			hasPostOfficePassword = updated.user.hasPostOfficePassword;
			winlinkPassword = '';
			clearWinlink = false;
			postOfficePassword = '';
			clearPostOffice = false;
			onchanged(updated);
			notice = 'Station settings saved.';
		} catch (err) {
			if (err instanceof ApiRequestError) errors = err.fields ?? { callsign: err.message };
			else errors = { callsign: 'Could not save.' };
		} finally {
			busy = false;
		}
	}

	async function savePassword(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		busy = true;
		notice = '';
		errors = {};
		if (newPassword !== confirmPassword) {
			errors = { confirm: 'The passwords do not match.' };
			busy = false;
			return;
		}
		try {
			const result = await api.changePassword({
				...(hasPassword ? { currentPassword } : {}),
				password: newPassword
			});
			hasPassword = result.hasPassword;
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
			onchanged({ ...me, user: { ...me.user, hasPassword: result.hasPassword } });
			notice = result.hasPassword ? 'Password changed.' : 'Password removed.';
		} catch (err) {
			if (err instanceof ApiRequestError) {
				errors = err.fields ?? { password: err.message };
			} else {
				errors = { password: 'Could not save.' };
			}
		} finally {
			busy = false;
		}
	}
</script>

<div class="panel">
	<header>
		<h1>Account</h1>
		<p class="muted">
			Signed in as <strong>{me.user.callsign ?? '—'}</strong> · {me.user.role} · created {formatDateTime(me.user.createdAt)}
		</p>
	</header>

	{#if notice}
		<p class="notice" role="status">{notice}</p>
	{/if}

	<section>
		<h2>
			Callsign and Winlink password
			{#if !hasWinlinkPassword}
				<span
					class="nonwl"
					title="No Winlink password is stored for this callsign: the account is non-WL and cannot collect mail from an RMS gateway"
					>non-WL</span
				>
			{/if}
		</h2>
		<p class="muted small">
			The callsign is this account: it is the name you sign in with here and from a mail program, the
			originator of everything the account sends, and the mailbox that incoming mail is addressed to, so
			one callsign is one account. Changing it changes the login with it, and drops the stored Winlink
			password, which belonged to the old callsign. The Winlink password is the one
			registered with the Winlink Development Team for that callsign — the CMS asks for it during a radio
			session. It is <strong>not</strong> the mail password below, and it is kept sealed, never shown again.
			The post-office password is what this station answers another station's challenge with when it collects
			mail from that station's post office — for a station that has no Winlink registration yet, it is the only
			credential there is. It is sealed like the Winlink one, never shown again, and dropping the callsign
			drops it too. The WW-Locator is the station's Maidenhead grid square: gateway lists are ordered by
			distance from it.
		</p>
		<form class="station-form" onsubmit={saveStation}>
			<div class="station">
				<label class="field">
					<span>Callsign</span>
					<input type="text" name="callsign" bind:value={callsign} placeholder="OK1ABC" autocomplete="off" />
				</label>
				<label class="field">
					<span>WW-Locator</span>
					<input
						type="text"
						name="locator"
						bind:value={locator}
						placeholder="JO70AA"
						autocomplete="off"
						spellcheck="false"
						title="Maidenhead grid square of this station, e.g. JO70AA"
					/>
				</label>
				<label class="field">
					<span>
						Winlink password
						{#if hasWinlinkPassword && !clearWinlink}<span class="set" title="A Winlink password is stored">stored</span>{/if}
					</span>
					<input
						type="password"
						name="winlinkPassword"
						autocomplete="off"
						bind:value={winlinkPassword}
						disabled={clearWinlink}
						placeholder={hasWinlinkPassword ? 'unchanged' : 'CMS secure-login password'}
					/>
				</label>
				<label class="field">
					<span>
						Post-office password
						{#if hasPostOfficePassword && !clearPostOffice}<span class="set" title="A post-office password is stored">stored</span>{/if}
					</span>
					<input
						type="password"
						name="postOfficePassword"
						autocomplete="off"
						bind:value={postOfficePassword}
						disabled={clearPostOffice}
						placeholder={hasPostOfficePassword ? 'unchanged' : 'what this station answers with'}
					/>
				</label>
			</div>
			{#if hasPostOfficePassword}
				<label class="check">
					<input type="checkbox" name="clearPostOffice" bind:checked={clearPostOffice} />
					<span>Remove the stored post-office password</span>
				</label>
			{/if}
			{#if errors['postOfficePassword']}
				<p class="error">{errors['postOfficePassword']}</p>
			{/if}
			{#if hasWinlinkPassword}
				<label class="check">
					<input type="checkbox" name="clearWinlink" bind:checked={clearWinlink} />
					<span>Remove the stored Winlink password</span>
				</label>
			{/if}
			{#if errors['locator']}
				<p class="error">{errors['locator']}</p>
			{/if}
			{#if errors['winlinkPassword']}
				<p class="error">{errors['winlinkPassword']}</p>
			{:else if errors['callsign']}
				<p class="error">{errors['callsign']}</p>
			{/if}
			<button class="btn primary" type="submit" disabled={busy}>Save station settings</button>
		</form>
	</section>

	<section class="login-password">
		<h2>
			<button
				class="disclosure"
				type="button"
				aria-expanded={passwordOpen}
				onclick={() => (passwordOpen = !passwordOpen)}
			>
				<span class="chevron" class:open={passwordOpen}>▸</span>
				Login password
				<span class="state">{hasPassword ? 'set' : 'none'}</span>
			</button>
		</h2>
		<p class="muted small">
			{hasPassword
				? 'The web client asks for this password. It is not the Winlink password above.'
				: 'No login password: signing in accepts an empty password from allowed addresses. Set one before the station is reachable from the LAN.'}
		</p>
		{#if passwordOpen}
		<form onsubmit={savePassword}>
			{#if hasPassword}
				<label class="field">
					<span>Current password</span>
					<input type="password" name="currentPassword" autocomplete="current-password" bind:value={currentPassword} />
				</label>
				{#if errors['currentPassword']}<p class="error">{errors['currentPassword']}</p>{/if}
			{/if}
			<label class="field">
				<span>New password</span>
				<input type="password" name="newPassword" autocomplete="new-password" bind:value={newPassword} />
			</label>
			<label class="field">
				<span>Repeat new password</span>
				<input type="password" name="confirmPassword" autocomplete="new-password" bind:value={confirmPassword} />
			</label>
			{#if errors['password']}<p class="error">{errors['password']}</p>{/if}
			{#if errors['confirm']}<p class="error">{errors['confirm']}</p>{/if}
			<div class="row">
				<button class="btn primary" type="submit" disabled={busy || newPassword.length === 0}>
					{busy ? 'Saving…' : 'Change password'}
				</button>
				{#if hasPassword}
					<button
						class="btn"
						type="button"
						disabled={busy}
						onclick={async () => {
							busy = true;
							try {
								const result = await api.changePassword({
									currentPassword,
									password: ''
								});
								hasPassword = result.hasPassword;
								onchanged({ ...me, user: { ...me.user, hasPassword: false } });
								notice = 'Password removed.';
							} catch (err) {
								errors = err instanceof ApiRequestError ? (err.fields ?? { password: err.message }) : {};
							} finally {
								busy = false;
							}
						}}
					>
						Remove password
					</button>
				{/if}
			</div>
		</form>
		{/if}
	</section>
</div>

<style>
	.panel {
		padding: 1.5rem;
		overflow-y: auto;
		min-height: 0;
		max-width: 44rem;
	}

	h1 {
		font-size: 1.2rem;
		margin: 0 0 0.3rem;
	}

	header {
		margin-bottom: 1.25rem;
	}

	section {
		border-top: 1px solid var(--line);
		padding-top: 1.1rem;
		margin-top: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}

	h2 {
		font-size: 0.95rem;
		margin: 0;
		letter-spacing: 0.02em;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		max-width: 26rem;
	}

	form.station-form {
		max-width: 40rem;
	}

	.disclosure {
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.chevron {
		display: inline-block;
		font-size: 0.8rem;
		color: var(--muted);
		transition: transform 120ms ease;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.login-password h2 {
		margin-bottom: 0.3rem;
	}

	.state {
		font-size: 0.7rem;
		font-weight: 400;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0 0.35rem;
	}

	h2 {
		font-size: 0.95rem;
	}

	.station {
		display: grid;
		grid-template-columns: minmax(9rem, 1fr) minmax(8rem, 0.7fr) minmax(11rem, 1.2fr);
		gap: 0.75rem;
	}

	.station .field {
		max-width: none;
	}

	.set {
		margin-left: 0.4rem;
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--ok);
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
		border-radius: 999px;
		padding: 0 0.35rem;
	}

	/* Non-WL: no Winlink password, so no mail collection from a gateway. */
	.nonwl {
		margin-left: 0.5rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		border: 1px dashed color-mix(in oklab, var(--danger) 45%, var(--line));
		color: var(--danger);
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		vertical-align: middle;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.82rem;
		color: var(--muted);
	}

	@media (max-width: 700px) {
		.disclosure {
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.chevron {
		display: inline-block;
		font-size: 0.8rem;
		color: var(--muted);
		transition: transform 120ms ease;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.login-password h2 {
		margin-bottom: 0.3rem;
	}

	.state {
		font-size: 0.7rem;
		font-weight: 400;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0 0.35rem;
	}

	h2 {
		font-size: 0.95rem;
	}

	.station {
			grid-template-columns: 1fr;
		}

		form.station-form {
			max-width: 26rem;
		}
	}

	.row {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.small {
		font-size: 0.82rem;
		margin: 0;
	}

	.notice {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
		background: color-mix(in oklab, var(--ok) 12%, transparent);
		border-radius: 8px;
		font-size: 0.88rem;
	}
</style>
