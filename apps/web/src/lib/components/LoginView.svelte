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

	let callsignTyped = $state('');

	onMount(() => {
		// Arriving through "Change user" means the field starts empty: the point is
		// to type a different callsign, not to keep the last one.
		if (fresh) return;
		try {
			callsignTyped = localStorage.getItem('rfmail.callsign') ?? '';
		} catch {
			callsignTyped = '';
		}
	});
	let password = $state('');
	let needsPassword = $state(false);
	/** The sign-in page can create an account for a callsign: client mode only. */
	let registering = $state(false);
	let winlinkPassword = $state('');
	let error = $state('');
	let busy = $state(false);

	/** Field codes from the API are not sentences; the ones the form can cause are named. */
	function messageFor(err: ApiRequestError): string {
		const fields = err.fields ?? {};
		if (fields['callsign'] === 'duplicate') return 'That callsign already has a mailbox here — sign in instead.';
		if (fields['callsign']) return 'That is not a callsign.';
		if (fields['winlinkPassword'] === 'required') return 'The Winlink password is required.';
		if (fields['winlinkPassword'] === 'too long') return 'That Winlink password is too long.';
		return err.message;
	}

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		error = '';
		busy = true;
		try {
			const callsign = callsignTyped.trim();
			const me =
				mode === 'setup'
					? await api.setup(callsign)
					: registering
						? await api.register(callsign, winlinkPassword)
						: await api.login(callsign, needsPassword ? password : undefined);
			try {
				localStorage.setItem('rfmail.callsign', me.user.callsign ?? callsign);
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
					error = messageFor(err);
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
		<h1>
			{mode === 'setup'
				? 'Create the station account'
				: registering
					? 'Create an account'
					: fresh
						? 'Change user'
						: 'Sign in'}
		</h1>
		<p class="lede">
			{#if mode === 'setup'}
				This is the first start. Type the callsign of this station, which is also the account: the callsign
				signs in, receives its own mail and is the originator of everything the station sends. No password is
				set at this stage — mail access from this machine is enough for now, and one can be added later.
			{:else if registering}
				Type the callsign you want a mailbox for, and its Winlink password. The password is what this
				station answers another station's challenge with; it is stored sealed on this machine, never shown
				again, and can be changed later on the account page.
			{:else if fresh}
				Type the callsign whose mailbox you want. {needsPassword
					? 'This account has a password.'
					: 'An account without a password needs nothing else.'}
			{:else}
				Type your callsign. {needsPassword ? 'This account also has a password.' : ''}
			{/if}
		</p>

		<form onsubmit={submit}>
			<label class="field">
				<span>Callsign</span>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					type="text"
					name="callsign"
					autocomplete="username"
					bind:value={callsignTyped}
					required
					autofocus
					placeholder="OK4RM"
				/>
			</label>

			{#if registering}
				<label class="field">
					<span>Winlink password</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						type="password"
						name="winlinkPassword"
						autocomplete="off"
						bind:value={winlinkPassword}
						autofocus
					/>
				</label>
			{:else if needsPassword}
				<label class="field">
					<span>Password</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input type="password" name="password" autocomplete="current-password" bind:value={password} autofocus />
				</label>
			{/if}

			{#if error}
				<p class="error" role="alert">{error}</p>
			{/if}

			<button
				class="btn primary submit"
				type="submit"
				disabled={busy || !callsignTyped.trim() || (registering && winlinkPassword.trim() === '')}
			>
				{busy
					? 'Working…'
					: mode === 'setup'
						? 'Create account'
						: registering
							? 'Create account and sign in'
							: 'Sign in'}
			</button>

			{#if mode === 'login'}
				<p class="alt">
					{#if registering}
						Already have a mailbox here?
						<button
							class="link"
							type="button"
							onclick={() => {
								registering = false;
								error = '';
							}}>Sign in</button
						>
					{:else}
						No mailbox here yet?
						<button
							class="link"
							type="button"
							onclick={() => {
								registering = true;
								needsPassword = false;
								error = '';
							}}>Create an account</button
						>
					{/if}
				</p>
			{/if}
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

	.alt {
		margin: 0;
		font-size: 0.82rem;
		color: var(--muted);
		text-align: center;
	}

	.link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--accent);
		cursor: pointer;
	}

	.link:hover {
		text-decoration: underline;
	}

	.status {
		margin: 1.25rem 0 0;
		font-size: 0.78rem;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}
</style>
