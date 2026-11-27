<script lang="ts">
	import type { PoMe } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';

	let {
		mode,
		statusLine,
		onauthenticated
	}: {
		/** `setup` until the station has a callsign and an administrator. */
		mode: 'setup' | 'login';
		statusLine: string;
		onauthenticated: (me: PoMe) => void;
	} = $props();

	let callsign = $state('');
	let name = $state('');
	let password = $state('');
	let locator = $state('');
	let error = $state('');
	let busy = $state(false);

	/** Field codes are not sentences; the ones this form can cause are named. */
	function messageFor(err: ApiRequestError): string {
		const fields = err.fields ?? {};
		if (fields['callsign'] === 'duplicate') return 'That callsign already has a mailbox here.';
		if (fields['callsign']) return 'That is not a callsign.';
		if (fields['name'] === 'duplicate') return 'That administrator name is already taken.';
		if (fields['name']) return 'An administrator name is required.';
		if (fields['password'] === 'short') return 'The password needs at least eight characters.';
		if (fields['locator']) return 'That is not a grid square (JO70AA, or JO70).';
		return err.message;
	}

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		error = '';
		busy = true;
		try {
			const me =
				mode === 'setup'
					? await api.setup({
							callsign: callsign.trim(),
							name: name.trim(),
							password,
							...(locator.trim() ? { locator: locator.trim() } : {})
						})
					: await api.login(name.trim(), password);
			onauthenticated(me);
		} catch (err) {
			error =
				err instanceof ApiRequestError
					? messageFor(err)
					: 'Cannot reach the post office. Is it running?';
		} finally {
			busy = false;
		}
	}
</script>

<div class="screen">
	<main class="card">
		<div class="mark">rfmail post office</div>
		<h1>{mode === 'setup' ? 'Name this station' : 'Sign in'}</h1>
		<p class="lede">
			{#if mode === 'setup'}
				Two things, and they are not the same thing: the callsign the station answers as — its mailbox —
				and the first administrator, which is a person with a password and no mailbox of its own.
			{:else}
				The console belongs to the station's administrators. Mailboxes held here never sign in.
			{/if}
		</p>

		<form onsubmit={submit}>
			{#if mode === 'setup'}
				<label class="field">
					<span>Station callsign</span>
					<input type="text" bind:value={callsign} autocomplete="off" spellcheck="false" required />
				</label>
			{/if}
			<label class="field">
				<span>Administrator</span>
				<input type="text" bind:value={name} autocomplete="username" spellcheck="false" required />
			</label>
			<label class="field">
				<span>Password</span>
				<input
					type="password"
					bind:value={password}
					autocomplete={mode === 'setup' ? 'new-password' : 'current-password'}
					required
				/>
			</label>
			{#if mode === 'setup'}
				<label class="field">
					<span>Locator <em>optional</em></span>
					<input type="text" bind:value={locator} autocomplete="off" spellcheck="false" />
				</label>
			{/if}

			{#if error}<p class="error" role="alert">{error}</p>{/if}

			<div class="actions">
				<button class="btn primary" type="submit" disabled={busy}>
					{mode === 'setup' ? 'Create the station' : 'Sign in'}
				</button>
				<span class="muted">{statusLine}</span>
			</div>
		</form>
	</main>
</div>

<style>
	.screen {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}
	.card {
		width: min(30rem, 100%);
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		padding: 1.6rem 1.7rem 1.7rem;
	}
	.mark {
		font-size: 0.78rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent);
		font-weight: 700;
	}
	h1 {
		margin: 0.35rem 0 0.5rem;
		font-size: 1.35rem;
	}
	.lede {
		margin: 0 0 1.1rem;
		color: var(--muted);
		font-size: 0.92rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}
	.field em {
		font-style: normal;
		text-transform: none;
		letter-spacing: 0;
		color: var(--faint);
	}
	.actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.3rem;
	}
</style>
