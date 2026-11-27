<script lang="ts">
	import { MODEM_KINDS, dialHz, dialText, type PoRadio, type PoStation } from '@rfmail/shared';
	import { duration, utcTime } from '../format';
	import RadioPanel from './RadioPanel.svelte';

	let {
		station,
		radio,
		busy,
		onarm,
		ondisarm,
		onaddmodem,
		ondeletemodem,
		onsaveradio,
		ondelradio,
		onconnectradio,
		ondisconnectradio
	}: {
		station: PoStation | null;
		radio: PoRadio | null;
		busy: boolean;
		onarm: (modemId: number, frequencyHz: number) => void;
		ondisarm: () => void;
		onaddmodem: (input: { kind: string; host: string; commandPort?: number; dataPort?: number }) => void;
		ondeletemodem: (id: number) => void;
		onsaveradio: (input: { host: string; port?: number; pttInput: 'rear' | 'front' | 'auto' }) => void;
		ondelradio: () => void;
		onconnectradio: () => void;
		ondisconnectradio: () => void;
	} = $props();

	/** The dial as the operator reads it: kilohertz below 10 MHz, megahertz above. */
	let dial = $state('');
	let unit = $state<'khz' | 'mhz'>('khz');
	let dialError = $state('');

	const linkUp = $derived(radio?.link?.state === 'connected');

	function arm(): void {
		dialError = '';
		const value = Number(dial.replace(',', '.').trim());
		if (!Number.isFinite(value) || value <= 0) {
			dialError = 'Type the dial to arm on.';
			return;
		}
		if (selected === null) return;
		onarm(selected, dialHz(value, unit));
	}

	let selected = $state<number | null>(null);
	let adding = $state(false);
	let kind = $state<string>('vara');
	let host = $state('');
	let commandPort = $state('');
	let dataPort = $state('');
	let formError = $state('');

	const kindInfo = $derived(MODEM_KINDS.find((entry) => entry.kind === kind) ?? MODEM_KINDS[0]!);

	// The station remembers one modem choice while the screen is open; the first is a
	// reasonable default and there is usually only one. A selection that vanished with
	// a deletion falls back rather than leaving the Arm button pointing at nothing.
	$effect(() => {
		const modems = station?.modems ?? [];
		if (selected === null || !modems.some((modem) => modem.id === selected)) {
			selected = modems[0]?.id ?? null;
		}
	});

	const signal = $derived.by(() => {
		if (!station) return { tone: 'idle', word: 'NOT CONNECTED', detail: '' };
		if (station.error) return { tone: 'bad', word: 'FAULT', detail: station.error };
		if (station.current)
			return {
				tone: 'busy',
				word: 'CALL',
				detail: `${station.current.peer} · ${duration(station.current.elapsedMs)}`
			};
		if (station.armed)
			return {
				tone: 'ok',
				word: 'ARMED',
				detail: `${station.modemName ?? ''} listening${station.callsign ? ` as ${station.callsign}` : ''}${
					station.frequencyHz ? ` · ${dialText(station.frequencyHz)}` : ''
				}`
			};
		return { tone: 'idle', word: 'DISARMED', detail: 'not listening' };
	});

	function pickKind(): void {
		commandPort = kindInfo.commandPort === null ? '' : String(kindInfo.commandPort);
		dataPort = kindInfo.dataPort === null ? '' : String(kindInfo.dataPort);
	}

	function submitModem(event: SubmitEvent): void {
		event.preventDefault();
		formError = '';
		if (!host.trim()) {
			formError = 'The modem needs an address.';
			return;
		}
		onaddmodem({
			kind,
			host: host.trim(),
			...(commandPort ? { commandPort: Number(commandPort) } : {}),
			...(dataPort ? { dataPort: Number(dataPort) } : {})
		});
		host = '';
		commandPort = '';
		dataPort = '';
		adding = false;
	}

	pickKind();
</script>

<section class="station">
	<div class="headline">
		<div class="state {signal.tone}">
			<span class="dot" aria-hidden="true"></span>
			<strong>{signal.word}</strong>
			<span class="detail">{signal.detail}</span>
		</div>

		<div class="controls">
			<label class="sr-only" for="modem">Modem</label>
			<select id="modem" bind:value={selected} disabled={busy || station?.armed === true}>
				{#each station?.modems ?? [] as modem (modem.id)}
					<option value={modem.id}>{modem.name}</option>
				{/each}
			</select>
			{#if station?.armed}
				<button class="btn" onclick={ondisarm} disabled={busy}>Disarm</button>
			{:else}
				<label class="sr-only" for="dial">Dial</label>
				<input
					id="dial"
					class="dial"
					type="text"
					inputmode="decimal"
					bind:value={dial}
					spellcheck="false"
					autocomplete="off"
					title="The dial to answer on"
				/>
				<label class="sr-only" for="unit">Unit</label>
				<select id="unit" class="unit" bind:value={unit}>
					<option value="khz">kHz</option>
					<option value="mhz">MHz</option>
				</select>
				<button
					class="btn primary"
					onclick={arm}
					disabled={busy || selected === null || (station?.modems ?? []).length === 0 || !linkUp}
					title={linkUp ? 'Arm the modem on this dial' : 'the radio link is down'}
				>
					Arm
				</button>
			{/if}
		</div>
	</div>

	{#if dialError}<p class="error" role="alert">{dialError}</p>{/if}

	<RadioPanel
		{radio}
		{busy}
		onsave={onsaveradio}
		ondelete={ondelradio}
		onconnect={onconnectradio}
		ondisconnect={ondisconnectradio}
	/>

	<div class="panels">
		<div class="panel">
			<div class="panel-head">
				<h2>Modems</h2>
				<button class="btn ghost" onclick={() => (adding = !adding)}>
					{adding ? 'Cancel' : 'Add'}
				</button>
			</div>

			{#if station && station.modems.length > 0}
				<table>
					<thead>
						<tr><th>Protocol</th><th>Address</th><th></th></tr>
					</thead>
					<tbody>
						{#each station.modems as modem (modem.id)}
							<tr>
								<td>{MODEM_KINDS.find((entry) => entry.kind === modem.kind)?.label ?? modem.kind}</td>
								<td class="mono">{modem.host}:{modem.commandPort ?? '—'}</td>
								<td class="end">
									<button
										class="btn ghost"
										onclick={() => ondeletemodem(modem.id)}
										disabled={busy || station?.modemId === modem.id}
										title={station?.modemId === modem.id ? 'answering calls' : 'remove'}
									>
										Remove
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="empty">No modem yet. A post office with no modem listens on nothing.</p>
			{/if}

			{#if adding}
				<form class="modem-form" onsubmit={submitModem}>
					<label class="field">
						<span>Protocol</span>
						<select bind:value={kind} onchange={pickKind}>
							{#each MODEM_KINDS as entry (entry.kind)}
								<option value={entry.kind}>{entry.label}</option>
							{/each}
						</select>
					</label>
					<label class="field">
						<span>Address</span>
						<input type="text" bind:value={host} spellcheck="false" placeholder="192.168.1.20" />
					</label>
					<div class="ports">
						<label class="field">
							<span>Command</span>
							<input type="text" inputmode="numeric" bind:value={commandPort} />
						</label>
						<label class="field">
							<span>Data</span>
							<input type="text" inputmode="numeric" bind:value={dataPort} />
						</label>
					</div>
					{#if formError}<p class="error">{formError}</p>{/if}
					<div class="actions">
						<button class="btn primary" type="submit" disabled={busy}>Add modem</button>
					</div>
				</form>
			{/if}
		</div>

		<div class="panel">
			<div class="panel-head"><h2>Recent calls</h2></div>
			{#if station && station.recent.length > 0}
				<table class="calls">
					<thead>
						<tr>
							<th>Time</th><th>Caller</th><th>Result</th>
							<th class="num">In</th><th class="num">Out</th><th class="num">Duration</th><th>Reason</th>
						</tr>
					</thead>
					<tbody>
						{#each station.recent as call (call.id)}
							<tr>
								<td class="mono">{utcTime(call.startedAt)}</td>
								<td>{call.peer}</td>
								<td class={call.result === 'complete' ? 'ok' : 'bad'}>{call.result}</td>
								<td class="num">{call.received}</td>
								<td class="num">{call.sent}</td>
								<td class="num">{duration(call.elapsedMs)}</td>
								<td class="reason">{call.reason ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="empty">No calls yet.</p>
			{/if}
		</div>
	</div>
</section>

<style>
	.station {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.headline {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.9rem 1.1rem;
	}
	.state {
		display: flex;
		align-items: baseline;
		gap: 0.55rem;
	}
	.dot {
		width: 0.65rem;
		height: 0.65rem;
		border-radius: 999px;
		background: var(--faint);
		align-self: center;
	}
	.state strong {
		letter-spacing: 0.06em;
		font-size: 0.95rem;
	}
	.state.ok .dot { background: var(--ok); box-shadow: 0 0 0 3px rgb(95 206 155 / 0.18); }
	.state.busy .dot { background: var(--accent); box-shadow: 0 0 0 3px rgb(242 166 64 / 0.2); }
	.state.bad .dot { background: var(--danger); box-shadow: 0 0 0 3px rgb(239 122 114 / 0.18); }
	.detail { color: var(--muted); font-size: 0.9rem; }
	.controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	select {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.45rem 0.6rem;
		color: var(--text);
		max-width: 18rem;
	}
	.dial {
		width: 7.5rem;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.45rem 0.6rem;
		color: var(--text);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.9rem;
		text-align: right;
	}
	.unit { max-width: 5rem; }
	.panels {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
		gap: 1rem;
	}
	@media (max-width: 900px) {
		.panels { grid-template-columns: minmax(0, 1fr); }
	}
	.panel {
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.9rem 1.1rem 1.1rem;
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.5rem;
	}
	h2 {
		margin: 0;
		font-size: 0.85rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	th {
		text-align: left;
		font-weight: 500;
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--faint);
		padding: 0.3rem 0.5rem 0.35rem;
		border-bottom: 1px solid var(--line);
	}
	td {
		padding: 0.42rem 0.5rem;
		border-bottom: 1px solid var(--line);
	}
	tbody tr:last-child td { border-bottom: none; }
	.num { text-align: right; }
	.end { text-align: right; }
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.84rem;
	}
	.reason { color: var(--muted); font-size: 0.84rem; }
	.ok { color: var(--ok); }
	.bad { color: var(--danger); }
	.empty { color: var(--muted); font-size: 0.9rem; margin: 0.3rem 0.2rem; }
	.modem-form {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		margin-top: 0.9rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--line);
	}
	.ports {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.7rem;
	}
	.actions { display: flex; justify-content: flex-end; }
</style>
