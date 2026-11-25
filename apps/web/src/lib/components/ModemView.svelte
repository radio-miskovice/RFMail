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
	let radios = $state<Transceiver[]>([]);
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);

	let editingId = $state<number | null>(null);
	let name = $state('');
	let kind = $state<ModemKind>('ardop');
	let host = $state('127.0.0.1');
	let commandPort = $state('');
	let dataPort = $state('');
	let kissPort = $state('');
	let rigMode = $state('PKTUSB');
	let transceiverId = $state<string>('');
	let fields = $state<Record<string, string>>({});

	onMount(() => {
		void load();
		void checkRunning();
		// A modem can be started or stopped while this page is open; a plain TCP probe
		// costs nothing and keeps the state honest.
		const timer = setInterval(() => void checkRunning(), 10_000);
		return () => clearInterval(timer);
	});

	async function checkRunning(): Promise<void> {
		try {
			const answer = await api.modemStatus();
			statuses = Object.fromEntries(answer.statuses.map((entry) => [entry.id, entry]));
		} catch {
			statuses = {};
		}
	}

	/** `running`, `not running`, or `?` while the answer is unknown. */
	function stateWord(id: number): string {
		const state = statuses[id];
		if (!state) return '?';
		return state.running ? 'running' : 'not running';
	}

	/** What the port named itself, in the operator's words. */
	function answerLine(id: number): string {
		const state = statuses[id];
		if (!state || !state.reportedKind) return '';
		return `answers as ${modemKindInfo(state.reportedKind).label}${state.reportedVersion ? ` · ${state.reportedVersion}` : ''}`;
	}

	const kindInfo = $derived(modemKindInfo(kind));

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
		commandPort = info.commandPort === null ? '' : String(info.commandPort);
		dataPort = info.dataPort === null ? '' : String(info.dataPort);
		kissPort = info.kissPort === null ? '' : String(info.kissPort);
		rigMode = info.rigMode;
	}

	function reset(): void {
		editingId = null;
		name = '';
		kind = 'ardop';
		host = '127.0.0.1';
		applyKindDefaults('ardop');
		transceiverId = '';
		fields = {};
	}

	function edit(modem: Modem): void {
		editingId = modem.id;
		name = modem.name;
		kind = modem.kind;
		host = modem.host;
		commandPort = modem.commandPort === null ? '' : String(modem.commandPort);
		dataPort = modem.dataPort === null ? '' : String(modem.dataPort);
		kissPort = modem.kissPort === null ? '' : String(modem.kissPort);
		rigMode = modem.rigMode;
		transceiverId = modem.transceiverId === null ? '' : String(modem.transceiverId);
		fields = {};
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
			name: name.trim(),
			kind,
			host: host.trim(),
			commandPort: portValue(commandPort),
			dataPort: portValue(dataPort),
			kissPort: portValue(kissPort),
			rigMode,
			transceiverId: transceiverId ? Number(transceiverId) : null
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

	function radioName(id: number | null): string {
		if (id === null) return '—';
		return radios.find((radio) => radio.id === id)?.name ?? `#${id}`;
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

	<table class="table">
		<thead>
			<tr>
				<th>State</th>
				<th>Name</th>
				<th>Type</th>
				<th>Address</th>
				<th>Ports</th>
				<th>Transceiver</th>
				<th>Rig mode</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each modems as modem (modem.id)}
				<tr>
					<td>
						<span
							class="led"
							class:on={statuses[modem.id]?.running === true}
							class:off={statuses[modem.id]?.running === false}
							title={statuses[modem.id]?.running
								? 'the command port answers'
								: 'nothing is listening on the command port'}
						></span>
						<span class="state-word">{stateWord(modem.id)}</span>
						{#if answerLine(modem.id)}
							<span class="answers" class:mismatch={statuses[modem.id]?.mismatch}>{answerLine(modem.id)}</span>
						{/if}
					</td>
					<td>{modem.name}</td>
					<td>{modemKindInfo(modem.kind).label}</td>
					<td class="mono">{modem.host}</td>
					<td class="mono ports">
						{#if modem.commandPort !== null}<span>cmd {modem.commandPort}</span>{/if}
						{#if modem.dataPort !== null}<span>data {modem.dataPort}</span>{/if}
						{#if modem.kissPort !== null}<span>kiss {modem.kissPort}</span>{/if}
					</td>
					<td>{radioName(modem.transceiverId)}</td>
					<td class="mono">{modem.rigMode}</td>
					<td class="actions">
						<button class="btn ghost small-btn" type="button" onclick={() => edit(modem)}>Edit</button>
						<button class="btn ghost small-btn" type="button" disabled={busy} onclick={() => void remove(modem)}>
							Delete
						</button>
					</td>
				</tr>
			{:else}
				<tr><td colspan="8" class="empty">{loading ? 'Loading…' : 'No modem configured yet.'}</td></tr>
			{/each}
		</tbody>
	</table>

	<section class="form-section">
		<h3>{editingId === null ? 'Add a modem' : `Edit ${name || 'modem'}`}</h3>
		<form onsubmit={save}>
			<div class="fields">
				<label class="field">
					<span>Name</span>
					<input type="text" name="name" bind:value={name} placeholder="VARA 40 m" required />
					{#if fields['name']}<em class="error">{fields['name']}</em>{/if}
				</label>

				<label class="field">
					<span>Type</span>
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

				<label class="field narrow">
					<span>Command port</span>
					<input type="text" name="commandPort" bind:value={commandPort} placeholder="8515" inputmode="numeric" />
					{#if fields['commandPort']}<em class="error">{fields['commandPort']}</em>{/if}
				</label>

				<label class="field narrow">
					<span>Data port</span>
					<input type="text" name="dataPort" bind:value={dataPort} placeholder="—" inputmode="numeric" />
					{#if fields['dataPort']}<em class="error">{fields['dataPort']}</em>{/if}
				</label>

				<label class="field narrow">
					<span>KISS port</span>
					<input type="text" name="kissPort" bind:value={kissPort} placeholder="—" inputmode="numeric" />
					{#if fields['kissPort']}<em class="error">{fields['kissPort']}</em>{/if}
				</label>

				<label class="field">
					<span>Transceiver</span>
					<select name="transceiverId" bind:value={transceiverId}>
						<option value="">— none —</option>
						{#each radios as radio (radio.id)}
							<option value={String(radio.id)}>{radio.name}</option>
						{/each}
					</select>
					{#if fields['transceiverId']}<em class="error">{fields['transceiverId']}</em>{/if}
				</label>

				<label class="field narrow">
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

	.table {
		margin-top: 1rem;
		border-collapse: collapse;
		font-size: 0.9rem;
	}

	.table th {
		text-align: left;
		font-weight: 500;
		color: var(--muted);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.3rem 0.6rem;
		border-bottom: 1px solid var(--line);
		white-space: nowrap;
	}

	.table td {
		padding: 0.35rem 0.6rem;
		border-bottom: 1px solid color-mix(in oklab, var(--line) 45%, transparent);
		white-space: nowrap;
	}

	.table th:first-child,
	.table td:first-child {
		padding-left: 0;
	}

	.ports span + span::before {
		content: '· ';
		color: var(--muted);
	}

	.led {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-right: 0.35rem;
		background: var(--muted);
	}

	.led.on {
		background: var(--ok, #2e7d32);
	}

	.led.off {
		background: var(--danger);
	}

	.state-word {
		font-size: 0.78rem;
		color: var(--muted);
	}

	/* What the port said it is; red when it is not what this record claims. */
	.answers {
		display: block;
		font-size: 0.72rem;
		color: var(--faint);
	}

	.answers.mismatch {
		color: var(--danger);
	}

	.actions {
		display: flex;
		gap: 0.3rem;
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
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.75rem;
	}

	.field {
		display: grid;
		gap: 0.25rem;
		font-size: 0.78rem;
		color: var(--muted);
	}

	.field.narrow {
		max-width: 9rem;
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
