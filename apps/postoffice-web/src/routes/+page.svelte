<script lang="ts">
	import { onMount } from 'svelte';
	import type { PoAdministrator, PoCall, PoMailbox, PoMe, PoStation, PoStatus } from '@rfmail/shared';
	import { api, ApiRequestError } from '../lib/api/client';
	import SignIn from '../lib/components/SignIn.svelte';
	import StationView from '../lib/components/StationView.svelte';
	import MailboxesView from '../lib/components/MailboxesView.svelte';
	import CallsView from '../lib/components/CallsView.svelte';
	import AdminsView from '../lib/components/AdminsView.svelte';

	type Phase = 'loading' | 'error' | 'setup' | 'login' | 'app';
	type Section = 'station' | 'mailboxes' | 'calls' | 'admins';

	let status = $state<PoStatus | null>(null);
	let me = $state<PoMe | null>(null);
	let phase = $state<Phase>('loading');
	let bootError = $state('');
	let section = $state<Section>('station');
	let station = $state<PoStation | null>(null);
	let mailboxes = $state<PoMailbox[]>([]);
	let administrators = $state<Array<PoAdministrator & { self: boolean }>>([]);
	let calls = $state<PoCall[]>([]);
	let busy = $state(false);
	let error = $state('');

	const statusLine = $derived(status ? `rfmail post office ${status.version}` : '');

	function explain(err: unknown): string {
		if (!(err instanceof ApiRequestError)) return 'Cannot reach the post office.';
		const fields = err.fields ?? {};
		if (fields['callsign'] === 'duplicate') return 'That callsign already has a mailbox here.';
		if (fields['callsign']) return 'That is not a callsign.';
		if (fields['name'] === 'duplicate') return 'That administrator name is already taken.';
		if (fields['password'] === 'short') return 'The password needs at least eight characters.';
		if (fields['enabled'] === 'self') return 'You cannot disable the administrator you are signed in as.';
		if (fields['id'] === 'self') return 'You cannot delete the administrator you are signed in as.';
		if (fields['enabled'] === 'last' || fields['id'] === 'last')
			return 'That is the last enabled administrator; the station would have no operator.';
		if (fields['id'] === 'station') return 'The station cannot delete the mailbox it answers as.';
		if (fields['enabled'] === 'station') return 'The station cannot stop answering as itself.';
		if (fields['modemId'] === 'unreachable') return err.message;
		if (fields['id'] === 'armed') return 'That modem is answering calls; disarm it first.';
		return err.message;
	}

	async function run(action: () => Promise<void>): Promise<void> {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await action();
		} catch (err) {
			error = explain(err);
		} finally {
			busy = false;
		}
	}

	async function loadStation(): Promise<void> {
		station = await api.station();
	}

	async function loadAll(): Promise<void> {
		const [mailboxList, adminList, callList] = await Promise.all([
			api.mailboxes(),
			api.administrators(),
			api.calls(100)
		]);
		mailboxes = mailboxList.mailboxes;
		administrators = adminList.administrators;
		calls = callList.calls;
		await loadStation();
	}

	async function boot(): Promise<void> {
		try {
			status = await api.status();
		} catch {
			phase = 'error';
			bootError = 'The post office is not reachable. Start it and reload this page.';
			return;
		}
		try {
			me = await api.me();
			phase = 'app';
			await run(loadAll);
		} catch {
			phase = status.state === 'setup' ? 'setup' : 'login';
		}
	}

	onMount(boot);

	// The live view: while the station screen is open, ask again every few seconds, so a
	// call that comes in appears without a reload.
	$effect(() => {
		if (phase !== 'app' || section !== 'station') return;
		const timer = setInterval(() => {
			void api
				.station()
				.then((next) => (station = next))
				.catch(() => undefined);
		}, 5000);
		return () => clearInterval(timer);
	});

	async function authenticated(next: PoMe): Promise<void> {
		me = next;
		phase = 'app';
		section = 'station';
		await run(loadAll);
	}

	async function signOut(): Promise<void> {
		await api.logout().catch(() => undefined);
		me = null;
		station = null;
		phase = 'login';
		error = '';
	}

	function onArm(modemId: number): void {
		void run(async () => {
			station = await api.arm(modemId);
		});
	}

	function onDisarm(): void {
		void run(async () => {
			station = await api.disarm();
		});
	}

	function onAddModem(input: { kind: string; host: string; commandPort?: number; dataPort?: number }): void {
		void run(async () => {
			await api.createModem(input);
			await loadStation();
		});
	}

	function onDeleteModem(id: number): void {
		if (!confirm('Remove this modem from the station?')) return;
		void run(async () => {
			await api.deleteModem(id);
			await loadStation();
		});
	}

	function onCreateMailbox(input: { callsign: string; password?: string }): void {
		void run(async () => {
			await api.createMailbox(input);
			mailboxes = (await api.mailboxes()).mailboxes;
		});
	}

	function onUpdateMailbox(id: number, patch: { enabled?: boolean; password?: string }): void {
		void run(async () => {
			await api.updateMailbox(id, patch);
			mailboxes = (await api.mailboxes()).mailboxes;
		});
	}

	function onDeleteMailbox(id: number): void {
		if (!confirm('Delete this mailbox and all the mail it holds?')) return;
		void run(async () => {
			await api.deleteMailbox(id);
			mailboxes = (await api.mailboxes()).mailboxes;
		});
	}

	function onCreateAdmin(input: { name: string; password: string; canInspect: boolean }): void {
		void run(async () => {
			await api.createAdministrator(input);
			administrators = (await api.administrators()).administrators;
		});
	}

	function onUpdateAdmin(
		id: number,
		patch: { enabled?: boolean; canInspect?: boolean; password?: string }
	): void {
		void run(async () => {
			await api.updateAdministrator(id, patch);
			administrators = (await api.administrators()).administrators;
			me = await api.me();
		});
	}

	function onDeleteAdmin(id: number): void {
		if (!confirm('Remove this administrator?')) return;
		void run(async () => {
			await api.deleteAdministrator(id);
			administrators = (await api.administrators()).administrators;
		});
	}
</script>

<svelte:head>
	<title>{phase === 'app' ? `${me?.callsign ?? 'post office'} — rfmail` : 'rfmail post office'}</title>
</svelte:head>

{#if phase === 'loading'}
	<div class="boot">Loading…</div>
{:else if phase === 'error'}
	<div class="boot">{bootError}</div>
{:else if phase === 'setup' || phase === 'login'}
	<SignIn mode={phase} {statusLine} onauthenticated={authenticated} />
{:else if me}
	<div class="shell">
		<header>
			<div class="identity">
				<span class="mark">rfmail post office</span>
				<h1>{me.callsign ?? 'no callsign'}</h1>
			</div>

			<nav>
				<button class="tab" class:on={section === 'station'} onclick={() => (section = 'station')}>
					Station
				</button>
				<button class="tab" class:on={section === 'mailboxes'} onclick={() => (section = 'mailboxes')}>
					Mailboxes
				</button>
				<button class="tab" class:on={section === 'calls'} onclick={() => (section = 'calls')}>
					Calls
				</button>
				<button class="tab" class:on={section === 'admins'} onclick={() => (section = 'admins')}>
					Administrators
				</button>
			</nav>

			<div class="who">
				<span class="muted">{me.administrator.name}</span>
				<button class="link" onclick={() => void signOut()}>Sign out</button>
			</div>
		</header>

		<main>
			{#if error}<p class="banner error" role="alert">{error}</p>{/if}

			{#if section === 'station'}
				<StationView
					{station}
					{busy}
					{error}
					onarm={onArm}
					ondisarm={onDisarm}
					onaddmodem={onAddModem}
					ondeletemodem={onDeleteModem}
				/>
			{:else if section === 'mailboxes'}
				<MailboxesView
					{mailboxes}
					{busy}
					{error}
					oncreate={onCreateMailbox}
					onupdate={onUpdateMailbox}
					ondelete={onDeleteMailbox}
				/>
			{:else if section === 'calls'}
				<CallsView {calls} />
			{:else}
				<AdminsView
					{administrators}
					{busy}
					{error}
					oncreate={onCreateAdmin}
					onupdate={onUpdateAdmin}
					ondelete={onDeleteAdmin}
				/>
			{/if}
		</main>
	</div>
{/if}

<style>
	.boot {
		min-height: 100vh;
		display: grid;
		place-items: center;
		color: var(--muted);
	}
	.shell {
		max-width: 78rem;
		margin: 0 auto;
		padding: 1.2rem 1.4rem 2.4rem;
	}
	header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1.5rem;
		flex-wrap: wrap;
		border-bottom: 1px solid var(--line);
		padding-bottom: 0.7rem;
		margin-bottom: 1.1rem;
	}
	.mark {
		font-size: 0.72rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent);
		font-weight: 700;
	}
	h1 {
		margin: 0.1rem 0 0;
		font-size: 1.3rem;
		letter-spacing: 0.02em;
	}
	nav {
		display: flex;
		gap: 0.2rem;
	}
	.tab {
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--muted);
		padding: 0.45rem 0.7rem;
		font-size: 0.92rem;
	}
	.tab:hover { color: var(--text); }
	.tab.on {
		color: var(--text);
		border-bottom-color: var(--accent);
		font-weight: 600;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		font-size: 0.88rem;
	}
	.link {
		background: none;
		border: none;
		color: var(--accent);
		padding: 0;
		font-size: 0.88rem;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	main { display: flex; flex-direction: column; gap: 0.8rem; }
	.banner {
		margin: 0;
		padding: 0.6rem 0.9rem;
		border: 1px solid var(--danger);
		border-radius: 8px;
		background: rgb(239 122 114 / 0.08);
	}
</style>
