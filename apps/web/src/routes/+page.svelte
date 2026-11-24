<script lang="ts">
	import { onMount } from 'svelte';
	import type { Me, StatusResponse } from '@rfmail/shared';
	import { api } from '../lib/api/client';
	import LoginView from '../lib/components/LoginView.svelte';
	import MailView from '../lib/components/MailView.svelte';

	type Phase = 'loading' | 'error' | 'setup' | 'login' | 'mail';

	let status = $state<StatusResponse | null>(null);
	let me = $state<Me | null>(null);
	let phase = $state<Phase>('loading');
	let bootError = $state('');
	/** True when the sign-in screen was opened by "Change user", not by a restart. */
	let changingUser = $state(false);

	const statusLine = $derived(
		status
			? [
					`rfmail ${status.version}`,
					status.accessMode,
					status.pop3 ? `POP3 ${status.pop3.address}` : 'POP3 disabled'
				].join(' · ')
			: ''
	);

	onMount(async () => {
		try {
			status = await api.status();
			try {
				me = await api.me();
				phase = 'mail';
			} catch {
				phase = status.state === 'setup' ? 'setup' : 'login';
			}
		} catch {
			phase = 'error';
			bootError = 'The backend is not reachable. Start rfmail and reload.';
		}
	});

	function handleAuthenticated(authenticated: Me): void {
		me = authenticated;
		phase = 'mail';
		changingUser = false;
	}

	/**
	 * "Change user": sign out and go straight to the sign-in screen, empty and
	 * focused, so switching mailboxes is one action rather than three menus.
	 */
	async function handleChangeUser(): Promise<void> {
		try {
			await api.logout();
		} catch {
			// A backend that has forgotten the session is not a reason to stay signed in.
		}
		me = null;
		changingUser = true;
		phase = 'login';
	}
</script>

<svelte:head>
	<title>{phase === 'mail' ? 'rfmail — Mailbox' : 'rfmail'}</title>
</svelte:head>

{#if phase === 'loading'}
	<div class="splash" aria-live="polite"><span class="pulse"></span> Connecting…</div>
{:else if phase === 'error'}
	<div class="splash error" role="alert">{bootError}</div>
{:else if phase === 'mail' && me && status}
	<MailView {me} {status} onlogout={handleChangeUser} onmechange={(updated) => (me = updated)} />
{:else}
	<LoginView
		mode={phase === 'setup' ? 'setup' : 'login'}
		{statusLine}
		fresh={changingUser}
		onauthenticated={handleAuthenticated}
	/>
{/if}

<style>
	.splash {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.7rem;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.splash.error {
		color: var(--danger);
	}

	.pulse {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1.1s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 0.25;
			transform: scale(0.8);
		}
		50% {
			opacity: 1;
			transform: scale(1.15);
		}
	}
</style>
