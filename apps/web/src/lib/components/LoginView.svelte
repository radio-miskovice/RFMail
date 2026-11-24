<script lang="ts">
	import { onMount } from 'svelte';
	import type { Me } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';

	let {
		mode,
		statusLine,
		onauthenticated,
		fresh = false
	}: {
		mode: 'setup' | 'login';
		statusLine: string;
		onauthenticated: (me: Me) => void;
		/** Arrived through "Change user": start empty rather than prefill the last one. */
		fresh?: boolean;
	} = $props();

	let login = $state('');

	onMount(() => {
		// Arriving through "Change user" means the field starts empty: the point is
		// to type a different callsign, not to keep the last one.
		if (fresh) return;
		try {
			login = localStorage.getItem('rfmail.login') ?? '';
		} catch {
			login = '';
		}
	});
	let password = $state('');
	let needsPassword = $state(false);
	let error = $state('');
	let busy = $state(false);

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		error = '';
		busy = true;
		try {
			const name = login.trim();
			const me = mode === 'setup' ? await api.setup(name) : await api.login(name, needsPassword ? password : undefined);
			try {
				localStorage.setItem('rfmail.login', me.user.login);
			} catch {
				// private mode: remembering the name is a convenience, not a requirement
			}
			onauthenticated(me);
		} catch (err) {
			if (err instanceof ApiRequestError) {
				if (err.passwordRequired) {
					needsPassword = true;
					error = 'This account has a password.';
				} else {
					error = err.fields?.['login'] ?? err.message;
				}
			} else {
				error = 'Cannot reach the backend.';
			}
		} finally {
			busy = false;
		}
	}
</script>

<div class="screen">
	<main class="card">
		<div class="mark">rfmail</div>
		<h1>{mode === 'setup' ? 'Create the station account' : fresh ? 'Change user' : 'Sign in'}</h1>
		<p class="lede">
			{#if mode === 'setup'}
				This is the first start. Choose the account name for the operator of this station. No password is set
				at this stage — mail access from this machine is enough for now, and a password can be added later.
			{:else if fresh}
				Type the callsign whose mailbox you want. {needsPassword
					? 'This account has a password.'
					: 'An account without a password needs nothing else.'}
			{:else}
				Enter the callsign or the account name. {needsPassword ? 'This account also has a password.' : ''}
			{/if}
		</p>

		<form onsubmit={submit}>
			<label class="field">
				<span>Callsign</span>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					type="text"
					name="login"
					autocomplete="username"
					bind:value={login}
					required
					autofocus
					placeholder="OK4RM"
				/>
			</label>

			{#if needsPassword}
				<label class="field">
					<span>Password</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input type="password" name="password" autocomplete="current-password" bind:value={password} autofocus />
				</label>
			{/if}

			{#if error}
				<p class="error" role="alert">{error}</p>
			{/if}

			<button class="btn primary submit" type="submit" disabled={busy || !login.trim()}>
				{busy ? 'Working…' : mode === 'setup' ? 'Create account' : 'Sign in'}
			</button>
		</form>

		<p class="status">{statusLine}</p>
	</main>
</div>

<style>
	.screen {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 2rem 1rem;
		background:
			radial-gradient(1200px 600px at 50% -10%, rgb(242 166 64 / 0.09), transparent 70%),
			var(--bg);
	}

	.card {
		width: min(26rem, 100%);
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: 16px;
		padding: 1.75rem;
		box-shadow: var(--shadow);
	}

	.mark {
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--accent);
		font-size: 0.85rem;
		text-transform: uppercase;
	}

	h1 {
		font-size: 1.35rem;
		margin: 0.4rem 0 0.5rem;
	}

	.lede {
		color: var(--muted);
		font-size: 0.92rem;
		margin: 0 0 1.25rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.submit {
		justify-content: center;
		padding: 0.6rem 1rem;
		margin-top: 0.25rem;
	}

	.status {
		margin: 1.25rem 0 0;
		font-size: 0.78rem;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}
</style>
