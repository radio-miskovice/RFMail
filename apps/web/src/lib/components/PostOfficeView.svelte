<script lang="ts">
	import { onMount } from 'svelte';
	import type { Modem, PostOfficeStatus } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';
	import { formatDateTime } from '../format';
	import { isDial } from '../dial';

	/**
	 * The station answering calls. One modem is armed at a time, on one dial
	 * frequency, under the callsign of the account marked as the post office owner.
	 */

	let status = $state<PostOfficeStatus | null>(null);
	let modems = $state<Modem[]>([]);
	let modemId = $state<number | null>(null);
	let dial = $state('');
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let timer: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		void load();
		// Inbound sessions happen while the operator is doing something else, so the
		// panel asks rather than waiting to be told.
		timer = setInterval(() => void refresh(), 4000);
		return () => {
			if (timer) clearInterval(timer);
		};
	});

	async function load(): Promise<void> {
		try {
			modems = await api.modems();
			await refresh();
			if (modemId === null) {
				const usable = modems.find((modem) => modem.commandPort !== null && modem.dataPort !== null);
				modemId = usable?.id ?? modems[0]?.id ?? null;
			}
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not load the post office.';
		}
	}

	async function refresh(): Promise<void> {
		try {
			status = await api.postOfficeStatus();
		} catch {
			// A failing poll is not worth a red banner over the last good state.
		}
	}

	/** Below 10 MHz the operator types kilohertz (3595.5); above it, megahertz. */
	function dialUnitOf(text: string): 'kHz' | 'MHz' {
		const value = Number(text.replace(',', '.').trim());
		return Number.isFinite(value) && value >= 1000 ? 'kHz' : 'MHz';
	}

	function hertzOf(text: string): number | null {
		const value = Number(text.replace(',', '.').trim());
		if (!Number.isFinite(value) || value <= 0) return null;
		const hz = Math.round(value * (dialUnitOf(text) === 'kHz' ? 1000 : 1_000_000));
		return isDial(hz) ? hz : null;
	}

	async function arm(): Promise<void> {
		if (busy || modemId === null) return;
		const hz = hertzOf(dial);
		if (hz === null) {
			error = 'Type a dial frequency inside the amateur bands: kHz below 10 MHz, MHz above it.';
			return;
		}
		busy = true;
		error = '';
		notice = '';
		try {
			const next = await api.postOfficeArm({ modemId, frequencyHz: hz });
			status = next;
			notice = `Listening as ${next.owner ?? 'the owner'}.`;
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not arm the post office.';
		} finally {
			busy = false;
		}
	}

	async function disarm(): Promise<void> {
		if (busy) return;
		busy = true;
		error = '';
		notice = '';
		try {
			status = await api.postOfficeDisarm();
			notice = 'No longer answering calls.';
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not disarm the post office.';
		} finally {
			busy = false;
		}
	}

	function frequencyText(hz: number): string {
		return hz < 10_000_000 ? `${(hz / 1000).toFixed(1)} kHz` : `${(hz / 1_000_000).toFixed(4)} MHz`;
	}
</script>

<div class="panel">
	<header>
		<h1>Post office</h1>
		<p class="muted">
			This station answers radio calls and holds mail for its own accounts, without a Winlink gateway
			registration. A station that dials in is asked for its password before anything is offered; mail it
			leaves is filed in the mailbox of every local callsign it names, and mail waiting for it is handed over
			once.
		</p>
	</header>

	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	<section class="state">
		<div class="row">
			<span class="label">State</span>
			<span class="value">
				{#if status?.armed && status.busy}
					<span class="dot on"></span> in session as <strong>{status.owner ?? '—'}</strong> with
					<strong>{status.sessions[0]?.peer ?? 'a station'}</strong>
				{:else if status?.armed}
					<span class="dot on"></span> answering calls as <strong>{status.owner ?? '—'}</strong>
					{#if status.modemName}
						· {status.modemName}
					{/if}
					{#if status.frequencyHz}
						· {frequencyText(status.frequencyHz)}
					{/if}
				{:else}
					<span class="dot"></span> not answering
					{#if status?.error}
						· <span class="reason">{status.error}</span>
					{/if}
				{/if}
			</span>
		</div>
		{#if status && !status.owner}
			<p class="error" role="alert">
				No account owns the post office. Mark the station's own account on the Accounts page first — its
				callsign is what this station answers as.
			</p>
		{/if}
	</section>

	{#if !status?.armed}
		<section>
			<h2>Answer calls</h2>
			<form class="fields" onsubmit={(event) => { event.preventDefault(); void arm(); }}>
				<label class="field">
					<span>Modem</span>
					<select bind:value={modemId} disabled={busy}>
						{#each modems as modem (modem.id)}
							{#if modem.commandPort !== null && modem.dataPort !== null}
								<option value={modem.id}>{modem.name} · {modem.kind}</option>
							{/if}
						{/each}
					</select>
				</label>
				<label class="field">
					<span>Dial frequency ({dialUnitOf(dial)})</span>
					<input
						type="text"
						inputmode="decimal"
						bind:value={dial}
						placeholder={dialUnitOf(dial) === 'kHz' ? '3595.5' : '14.1081'}
						title="The transceiver's dial, not the AF carrier the catalogue lists"
					/>
				</label>
				<button class="btn primary" type="submit" disabled={busy || modemId === null || !status?.owner}>
					{busy ? 'Arming…' : 'Start answering'}
				</button>
			</form>
			<p class="muted small">
				The radio is tuned to that dial before the modem is told to listen, and the modem must be reachable:
				an inbound call cannot be tuned for. Below 10 MHz the dial is kilohertz, from 10 MHz up megahertz.
			</p>
		</section>
	{:else}
		<section>
			<button class="btn" type="button" onclick={() => void disarm()} disabled={busy}>
				{busy ? 'Disarming…' : 'Stop answering'}
			</button>
		</section>
	{/if}

	<section>
		<h2>Recent sessions</h2>
		{#if !status || status.sessions.length === 0}
			<p class="muted">No station has called yet.</p>
		{:else}
			<div class="table">
				<div class="head row">
					<span>Station</span>
					<span>Started</span>
					<span>Result</span>
					<span>Received</span>
					<span>Sent</span>
					<span>Reason</span>
				</div>
				{#each status.sessions as session (session.startedAt + session.peer)}
					<div class="row">
						<span class="mono">{session.peer}</span>
						<span class="muted">{formatDateTime(session.startedAt)}</span>
						<span class:bad={session.result !== 'complete'}>{session.result ?? 'in session'}</span>
						<span>{session.received}</span>
						<span>{session.sent}</span>
						<span class="muted reason">{session.reason ?? ''}</span>
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1.5rem;
		max-width: 72rem;
	}

	header h1 {
		margin: 0 0 0.25rem;
		font-size: 1.35rem;
	}

	section h2 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}

	.state .row {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
	}

	.state .label {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}

	.dot {
		display: inline-block;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--muted);
		margin-right: 0.35rem;
	}

	.dot.on {
		background: var(--ok, #2f9e44);
	}

	.fields {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 0.75rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
	}

	.field span {
		color: var(--muted);
	}

	input,
	select {
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: 0.35rem;
		background: var(--bg-panel);
		color: inherit;
		font: inherit;
	}

	.table {
		width: auto;
		border-collapse: collapse;
		font-size: 0.85rem;
	}

	.table .row {
		display: grid;
		grid-template-columns: 8rem 11rem 6rem 5rem 4rem 20rem;
		gap: 0.75rem;
		padding: 0.35rem 0.25rem;
		border-bottom: 1px solid var(--border);
		align-items: baseline;
	}

	.table .head span {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}

	.bad {
		color: var(--danger, #c92a2a);
	}

	.mono {
		font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
		font-weight: 600;
	}

	.reason {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.small {
		font-size: 0.78rem;
	}
</style>
