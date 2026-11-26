<script lang="ts">
	// Modems (R3): the programs that speak to the radio on this station's behalf.
	//
	// What a modem needs stored is how to reach it and what the radio must do: the
	// type decides which ports exist and which gateways it can work, the address and
	// ports say where it listens, the transceiver and its mode say which radio it is
	// wired to and what that radio must be set to while the modem runs.
	import { onMount } from 'svelte';
	import {
		MODEM_KINDS,
		RIG_MODES,
		modemKindInfo,
		modemPortsOf,
		type Modem,
		type ModemKind,
		type Transceiver
	} from '@rfmail/shared';
	import type { ModemStatus } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';

	let modems = $state<Modem[]>([]);
	/**
	 * What each command port says: whether it answers, and — since VARA, XARA, Data2G and
	 * Mercury share the same ports — which program answered.
	 */
	let statuses = $state<Record<number, ModemStatus>>({});
	/** LAN names of the modem hosts, when a name service answers (decision 42). */
	let names = $state<Record<string, string | null>>({});
	let radios = $state<Transceiver[]>([]);
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);

	let editingId = $state<number | null>(null);
	/** Which tile is open; one at a time, because the details are read, not compared. */
	let openId = $state<number | null>(null);
	let name = $state('');
	let kind = $state<ModemKind>('ardop');
	let host = $state('127.0.0.1');
	/** The port fields as typed; which of them exist is the kind's business. */
	let ports = $state<Record<'commandPort' | 'dataPort' | 'kissPort', string>>({
		commandPort: String(modemKindInfo('ardop').commandPort ?? ''),
		dataPort: String(modemKindInfo('ardop').dataPort ?? ''),
		kissPort: String(modemKindInfo('ardop').kissPort ?? '')
	});
	let rigMode = $state('PKTUSB');
	let fields = $state<Record<string, string>>({});

	onMount(() => {
		void load();
		void checkRunning();
		void loadNames();
		// A modem can be started or stopped while this page is open; a plain TCP probe
		// costs nothing and keeps the state honest.
		const timer = setInterval(() => void checkRunning(), 10_000);
		return () => clearInterval(timer);
	});

	/** Names arrive on their own: the tile draws the address first and fills the name in. */
	async function loadNames(): Promise<void> {
		try {
			const answer = await api.hostNames();
			names = answer.names;
		} catch {
			/* a name is decoration; the address is the truth */
		}
	}

	async function checkRunning(): Promise<void> {
		try {
			const answer = await api.modemStatus();
			statuses = Object.fromEntries(answer.statuses.map((entry) => [entry.id, entry]));
		} catch {
			statuses = {};
		}
	}

	/** `active`, `unavailable`, or `?` while the answer is unknown. */
	function stateWord(id: number): string {
		const state = statuses[id];
		if (!state) return '?';
		return state.running ? 'active' : 'unavailable';
	}

	/** What the port named itself, in the operator's words. */

	const kindInfo = $derived(modemKindInfo(kind));

	/** The ports this kind has, in the order the form shows them. */
	const kindPorts = $derived(modemPortsOf(kind));

	async function load(): Promise<void> {
		loading = true;
		try {
			const [modemList, radioList] = await Promise.all([api.modems(), api.transceivers()]);
			modems = modemList;
			radios = radioList;
			error = '';
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not load the modems.';
		} finally {
			loading = false;
		}
	}

	/** A new modem arrives with the vendor's own port numbers filled in. */
	function applyKindDefaults(next: ModemKind): void {
		const info = modemKindInfo(next);
		ports = {
			commandPort: info.commandPort === null ? '' : String(info.commandPort),
			dataPort: info.dataPort === null ? '' : String(info.dataPort),
			kissPort: info.kissPort === null ? '' : String(info.kissPort)
		};
		rigMode = info.rigMode;
	}

	function reset(): void {
		editingId = null;
		name = '';
		kind = 'ardop';
		host = '127.0.0.1';
		applyKindDefaults('ardop');
		fields = {};
	}

	function edit(modem: Modem): void {
		editingId = modem.id;
		name = modem.name;
		kind = modem.kind;
		host = modem.host;
		ports = {
			commandPort: modem.commandPort === null ? '' : String(modem.commandPort),
			dataPort: modem.dataPort === null ? '' : String(modem.dataPort),
			kissPort: modem.kissPort === null ? '' : String(modem.kissPort)
		};
		rigMode = modem.rigMode;
		fields = {};
	}

	/**
	 * What a modem is called when the form does not ask: the protocol, then where it listens.
	 * The name is still what sessions and the record list use, so it is built from the facts
	 * the form does collect — protocol, host, first port — and cannot silently repeat.
	 */
	function composedName(): string {
		const first = ports.commandPort.trim() || ports.dataPort.trim() || ports.kissPort.trim();
		const where = host.trim();
		return first ? `${kindInfo.label} ${where}:${first}` : `${kindInfo.label} ${where}`;
	}

	function portValue(text: string): number | null {
		const trimmed = text.trim();
		if (!trimmed) return null;
		const value = Number(trimmed);
		return Number.isInteger(value) ? value : Number.NaN;
	}

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		busy = true;
		notice = '';
		fields = {};
		const body = {
			name: editingId === null ? composedName() : name.trim(),
			kind,
			host: host.trim(),
			commandPort: portValue(ports.commandPort),
			dataPort: portValue(ports.dataPort),
			kissPort: portValue(ports.kissPort),
			rigMode
		};
		// A port that is neither a number nor empty is caught here, before the server
		// has to explain it.
		for (const [key, value] of Object.entries(body)) {
			if (typeof value === 'number' && Number.isNaN(value)) {
				fields = { [key]: 'not a number' };
				busy = false;
				return;
			}
		}
		try {
			if (editingId === null) await api.createModem(body);
			else await api.updateModem(editingId, body);
			notice = editingId === null ? 'Modem added.' : 'Modem saved.';
			reset();
			await load();
		} catch (err) {
			fields = err instanceof ApiRequestError ? (err.fields ?? { name: err.message }) : { name: 'Could not save.' };
		} finally {
			busy = false;
		}
	}

	async function remove(modem: Modem): Promise<void> {
		busy = true;
		notice = '';
		try {
			await api.deleteModem(modem.id);
			if (editingId === modem.id) reset();
			notice = 'Modem removed.';
			await load();
		} catch (err) {
			fields = { name: err instanceof ApiRequestError ? err.message : 'Could not remove.' };
		} finally {
			busy = false;
		}
	}

	/** The interface the station currently uses: the one the header shows (decision 40). */
	function currentRadio(): Transceiver | null {
		return radios.reduce<Transceiver | null>(
			(best, row) =>
				best === null || row.lastUsedAt > best.lastUsedAt || (row.lastUsedAt === best.lastUsedAt && row.id > best.id)
					? row
					: best,
			null
		);
	}

	/**
	 * The radio as the modem sees it: the model rigctld named, or the address it answers at.
	 * A modem that names none takes the current interface, so the tile shows the radio that
	 * will actually be tuned (decision 43).
	 */
	function radioName(id: number | null): string {
		const radio = id === null ? currentRadio() : (radios.find((entry) => entry.id === id) ?? null);
		if (!radio) return id === null ? 'current interface' : `#${id}`;
		return radio.link.rig?.model ?? `${radio.host}:${radio.port}`;
	}
</script>

<section class="modems">
	<header class="head">
		<div>
			<h2>Modems</h2>
			<p class="lede">
				A modem is a program on a TCP port — VARA, ARDOP, XARA and the rest. The station needs its address and
				ports, the transceiver it is wired to, and the mode that transceiver must be in while it runs.
			</p>
		</div>
	</header>

	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
	{#if error}<p class="alert" role="alert">{error}</p>{/if}

	<!-- One tile per modem: what it is, where it runs, whether it is there. The rest of the
	     record — the other ports, the radio, the mode — is in the detail below the tile. -->
	<div class="tiles">
		{#each modems as modem (modem.id)}
			{@const state = statuses[modem.id]}
			<button
				class="tile"
				class:down={state?.running === false}
				type="button"
				aria-label={modem.name}
				aria-expanded={openId === modem.id}
				onclick={() => (openId = openId === modem.id ? null : modem.id)}
			>
				<span class="line">
					<span
						class="led"
						class:on={state?.running === true}
						class:off={state?.running === false}
						title={state?.running ? 'the modem answers as its kind' : (state?.error ?? 'nothing is listening on the command port')}
					></span>
					<span class="proto">{modemKindInfo(modem.kind).label}</span>
					<span class="state">{stateWord(modem.id)}</span>
				</span>
				<span class="line2 mono">
					{#if names[modem.host]}<strong class="lan">{names[modem.host]}</strong> · {/if}{modem.host}
				</span>
				<span class="line3">
					{#each modemPortsOf(modem.kind).filter((port) => modem[port.field] !== null) as port (port.field)}
						<span class="port">
							<span class="pname">{port.label}</span>
							{modem[port.field]}
							<span class="wire" title={port.transport === 'TCP' ? 'TCP' : 'UDP'}>
								{port.transport === 'TCP' ? 't' : 'u'}
							</span>
						</span>
					{/each}
				</span>
			</button>

			{#if openId === modem.id}
				<div class="details">
					<dl>
						{#each modemPortsOf(modem.kind) as port (port.field)}
							{#if modem[port.field] !== null}
								<dt>{port.label} port ({port.transport})</dt>
								<dd class="mono">{modem[port.field]}</dd>
							{/if}
						{/each}
						<dt>Radio</dt>
						<dd>{radioName(modem.transceiverId)}</dd>
						<dt>Rig mode</dt>
						<dd class="mono">{modem.rigMode}</dd>
						{#if state?.error}
							<dt>Last answer</dt>
							<dd class="failure">{state.error}</dd>
						{/if}
					</dl>
					<div class="actions">
						<button class="btn ghost small-btn" type="button" onclick={() => edit(modem)}>Edit</button>
						<button class="btn ghost small-btn danger" type="button" disabled={busy} onclick={() => void remove(modem)}>
							Delete
						</button>
					</div>
				</div>
			{/if}
		{:else}
			<p class="empty">{loading ? 'Loading…' : 'No modem configured yet.'}</p>
		{/each}
	</div>

	<section class="form-section">
		<h3>{editingId === null ? 'Add a modem' : `Edit ${name || 'modem'}`}</h3>
		<form onsubmit={save}>
			<div class="fields">
				<label class="field">
					<span>Protocol</span>
					<select
						name="kind"
						bind:value={kind}
						onchange={(event) => {
							const next = (event.currentTarget as HTMLSelectElement).value as ModemKind;
							if (editingId === null) applyKindDefaults(next);
						}}
					>
						{#each MODEM_KINDS as entry (entry.kind)}
							<option value={entry.kind}>{entry.label}</option>
						{/each}
					</select>
				</label>

				<label class="field">
					<span>IP address or host</span>
					<input type="text" name="host" bind:value={host} placeholder="127.0.0.1" required />
					{#if fields['host']}<em class="error">{fields['host']}</em>{/if}
				</label>

				<fieldset class="ports">
					<legend>Ports</legend>
					{#each kindPorts as port (port.field)}
						<label class="port-row">
							<span>{port.title}{port.transport === 'UDP' ? ' (UDP)' : ''}</span>
							<input
								type="text"
								name={port.field}
								bind:value={ports[port.field]}
								placeholder="—"
								inputmode="numeric"
							/>
						</label>
						{#if fields[port.field]}<em class="error port-error">{fields[port.field]}</em>{/if}
					{/each}
				</fieldset>

				<label class="field">
					<span>Transceiver mode</span>
					<select name="rigMode" bind:value={rigMode}>
						{#each RIG_MODES as mode (mode)}
							<option value={mode}>{mode}</option>
						{/each}
					</select>
					{#if fields['rigMode']}<em class="error">{fields['rigMode']}</em>{/if}
				</label>
			</div>

			<p class="hint">{kindInfo.note}</p>
			<p class="hint">
				Works with:
				{#each kindInfo.families as family (family)}<span class="tag">{family}</span>{/each}
				{#each kindInfo.serviceCodes as code (code)}<span class="tag code">{code}</span>{/each}
				{#if kindInfo.families.length === 0 && kindInfo.serviceCodes.length === 0}
					<span class="tag">nothing recorded</span>
				{/if}
			</p>

			<div class="buttons">
				<button class="btn primary" type="submit" disabled={busy}>
					{editingId === null ? 'Add modem' : 'Save modem'}
				</button>
				{#if editingId !== null}
					<button class="btn" type="button" onclick={reset}>Cancel</button>
				{/if}
			</div>
		</form>
	</section>
</section>

<style>
	.modems {
		padding: 1rem 1.1rem 2rem;
		overflow: auto;
	}

	.head h2 {
		margin: 0 0 0.3rem;
		font-size: 1.05rem;
	}

	.lede {
		margin: 0;
		color: var(--muted);
		font-size: 0.84rem;
		max-width: 68ch;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.5rem;
		margin-top: 1rem;
		max-width: 62rem;
	}

	/* Three lines: protocol and LED, the address, then the three ports in their own columns. */
	.tile {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.45rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--bg-panel);
		color: var(--fg);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.tile:hover {
		border-color: color-mix(in oklab, var(--accent) 40%, var(--line));
	}

	.tile.down {
		border-color: color-mix(in oklab, var(--danger) 35%, var(--line));
	}

	.line {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.proto {
		font-weight: 600;
		font-size: 0.88rem;
	}

	.line2 {
		font-size: 0.78rem;
		color: var(--muted);
	}

	/* The machine's name, when a name service answered; the address stays beside it. */
	.lan {
		font-weight: 600;
		color: var(--text);
	}

	.line3 {
		display: flex;
		justify-content: space-between;
		gap: 0.6rem;
		font-size: 0.74rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.port {
		display: flex;
		align-items: baseline;
		gap: 0.22rem;
		white-space: nowrap;
	}

	.pname {
		font-size: 0.64rem;
		letter-spacing: 0.04em;
		color: var(--faint);
	}

	.wire {
		font-size: 0.62rem;
		letter-spacing: 0.02em;
		color: var(--faint);
	}

	.state {
		margin-left: auto;
		font-size: 0.7rem;
		color: var(--muted);
	}

	.led {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: 0 0 auto;
		background: var(--muted);
	}

	.led.on {
		background: var(--ok, #2e7d32);
	}

	.led.off {
		background: var(--danger);
	}

	.details {
		margin: -0.2rem 0 0.3rem 1.4rem;
		padding: 0.6rem 0.9rem;
		border-left: 2px solid var(--line);
	}

	.details dl {
		display: grid;
		grid-template-columns: 8rem 1fr;
		row-gap: 0.25rem;
		margin: 0;
		font-size: 0.84rem;
	}

	.details dt {
		color: var(--muted);
	}

	.details dd {
		margin: 0;
	}

	.failure {
		color: var(--danger);
	}

	.actions {
		display: flex;
		gap: 0.35rem;
		margin-top: 0.6rem;
	}

	.form-section {
		margin-top: 1.6rem;
		max-width: 62rem;
	}

	.form-section h3 {
		margin: 0 0 0.6rem;
		font-size: 0.95rem;
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		max-width: 24rem;
	}

	.field {
		display: grid;
		gap: 0.25rem;
		font-size: 0.78rem;
		color: var(--muted);
	}

	/* The port table: the function on the left, the value on the right, one row per port. */
	.ports {
		display: grid;
		gap: 0.4rem;
		margin: 0;
		padding: 0.5rem 0.7rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: 8px;
	}

	.ports legend {
		padding: 0 0.3rem;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--faint);
	}

	.port-row {
		display: grid;
		grid-template-columns: 1fr 7rem;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.port-row input {
		font: inherit;
		font-size: 0.9rem;
		color: var(--fg);
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 7px;
		padding: 0.35rem 0.5rem;
		font-variant-numeric: tabular-nums;
	}

	.field input,
	.field select {
		font: inherit;
		font-size: 0.9rem;
		color: var(--fg);
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 7px;
		padding: 0.4rem 0.5rem;
	}

	.hint {
		margin: 0.5rem 0 0;
		color: var(--muted);
		font-size: 0.78rem;
		max-width: 72ch;
	}

	.tag.code {
		border-color: var(--accent);
		color: var(--accent);
	}

	.tag {
		display: inline-block;
		margin-right: 0.3rem;
		padding: 0 0.35rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		font-size: 0.7rem;
	}

	.buttons {
		margin-top: 0.8rem;
		display: flex;
		gap: 0.5rem;
	}

	.error {
		color: var(--danger);
		font-style: normal;
		font-size: 0.74rem;
	}

	.notice {
		color: var(--ok, #2e7d32);
		font-size: 0.82rem;
		margin: 0.5rem 0 0;
	}

	.alert {
		color: var(--danger);
		font-size: 0.82rem;
		margin: 0.5rem 0 0;
	}

	.empty {
		color: var(--muted);
	}

	.mono {
		font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
		font-variant-numeric: tabular-nums;
	}
</style>
