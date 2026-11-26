<script lang="ts">
	// Radio interfaces.
	//
	// Each tile is one rigctld: the host it answers on, whether the rig behind it is talking,
	// and the transceiver's own name — host, LED, state, and that is all. Everything about it
	// (port, serial line, dial, filter, transmit connector, power, on/off) opens under the
	// click. A station may run several: one per rig, or one per serial line.
	//
	// The interface the operator used last is remembered in the database (`last_used_at`), so
	// the header chip keeps pointing at the one that matters after a restart.
	import { onDestroy, onMount } from 'svelte';
	import type { PttInput, Transceiver } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';
	import { PTT_INPUT_LABELS } from '../labels';

	let radios = $state<Transceiver[]>([]);
	/** LAN names of the configured addresses, when a name service answers (decision 42). */
	let names = $state<Record<string, string | null>>({});
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);

	let openId = $state<number | null>(null);
	let powerPct = $state<number | null>(null);

	let formOpen = $state(false);
	let editingId = $state<number | null>(null);
	let host = $state('');
	let port = $state('');
	let serialPort = $state('');
	let serialSpeed = $state('');
	let enabled = $state(true);

	let timer: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		void load();
		// The names arrive on their own: the tile draws the address first, never waiting for
		// a name service that may not answer at all.
		void loadNames();
		timer = setInterval(() => void poll(), 3000);
	});

	async function loadNames(): Promise<void> {
		try {
			const answer = await api.hostNames();
			names = answer.names;
		} catch {
			/* a name is decoration; the address is the truth */
		}
	}

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

	async function load(): Promise<void> {
		try {
			radios = await api.transceivers();
			error = '';
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not read the radio interfaces.';
		} finally {
			loading = false;
		}
	}

	async function poll(): Promise<void> {
		if (busy || formOpen) return;
		try {
			radios = await api.transceivers();
		} catch {
			// The next tick tries again.
		}
	}

	/** The LED of one interface: grey off, amber dialling, green the rig answers, red failed. */
	function ledOf(radio: Transceiver): string {
		if (!radio.enabled) return 'grey';
		return radio.link.state === 'connected'
			? radio.link.rig?.active
				? 'green'
				: 'amber'
			: radio.link.state === 'error'
				? 'red'
				: radio.link.state === 'connecting'
					? 'amber'
					: 'grey';
	}

	/** `active`, `dialling`, `unavailable`, `off` — the state in one word. */
	function stateWord(radio: Transceiver): string {
		if (!radio.enabled) return 'off';
		if (radio.link.state === 'connected') return radio.link.rig?.active ? 'active' : 'dialling';
		return radio.link.state === 'connecting' ? 'dialling' : 'unavailable';
	}

	function beginCreate(): void {
		editingId = null;
		host = '';
		port = '';
		serialPort = '';
		serialSpeed = '';
		enabled = true;
		error = '';
		notice = '';
		formOpen = true;
	}

	function beginEdit(radio: Transceiver): void {
		editingId = radio.id;
		host = radio.host;
		port = String(radio.port);
		serialPort = radio.serialPort ?? '';
		serialSpeed = radio.serialSpeed === null ? '' : String(radio.serialSpeed);
		enabled = radio.enabled;
		error = '';
		notice = '';
		formOpen = true;
	}

	function closeForm(): void {
		formOpen = false;
		editingId = null;
	}

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		busy = true;
		error = '';
		notice = '';
		const body = {
			host: host.trim() || 'localhost',
			port: port.trim() ? Number(port) : 4532,
			serialPort: serialPort.trim() || null,
			serialSpeed: serialSpeed.trim() ? Number(serialSpeed) : null,
			enabled,
		};
		try {
			if (editingId === null) {
				// An interface is named for where it answers; there is no name field to fill.
				await api.createTransceiver({ name: `${body.host}:${body.port}`, ...body });
				notice = 'Interface added.';
			} else {
				await api.updateTransceiver(editingId, body);
				notice = 'Interface saved.';
			}
			closeForm();
			await load();
			void loadNames();
		} catch (err) {
			error =
				err instanceof ApiRequestError
					? (Object.values(err.fields ?? {})[0] ?? err.message)
					: 'Could not save the interface.';
		} finally {
			busy = false;
		}
	}

	async function open(radio: Transceiver): Promise<void> {
		if (openId === radio.id) {
			openId = null;
			return;
		}
		openId = radio.id;
		powerPct =
			radio.link.rig?.rfPower === null || radio.link.rig?.rfPower === undefined
				? null
				: Math.round(radio.link.rig.rfPower * 100);
		// Opening an interface is using it: it becomes the current one.
		try {
			await api.selectTransceiver(radio.id);
		} catch {
			/* a failed select is not worth an alert; the next poll shows the truth */
		}
	}

	async function applyPower(radio: Transceiver, percent: number): Promise<void> {
		busy = true;
		error = '';
		notice = '';
		try {
			const updated = await api.setTransceiverPower(radio.id, percent / 100);
			radios = radios.map((entry) => (entry.id === updated.id ? updated : entry));
			powerPct =
				updated.link.rig?.rfPower === null || updated.link.rig?.rfPower === undefined
					? null
					: Math.round(updated.link.rig.rfPower * 100);
			notice = `Power set to ${powerPct ?? 0} %.`;
		} catch (err) {
			error =
				err instanceof ApiRequestError
					? (Object.values(err.fields ?? {})[0] ?? err.message)
					: 'The radio did not take the power setting.';
		} finally {
			busy = false;
		}
	}

	async function applyPttInput(radio: Transceiver, value: PttInput): Promise<void> {
		busy = true;
		error = '';
		notice = '';
		try {
			const updated = await api.updateTransceiver(radio.id, { pttInput: value });
			radios = radios.map((entry) => (entry.id === updated.id ? updated : entry));
			notice = `Transmitting through ${PTT_INPUT_LABELS[value].toLowerCase()}.`;
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not save that choice.';
		} finally {
			busy = false;
		}
	}

	async function setEnabled(radio: Transceiver, on: boolean): Promise<void> {
		busy = true;
		error = '';
		notice = '';
		try {
			const updated = await api.updateTransceiver(radio.id, { enabled: on });
			radios = radios.map((entry) => (entry.id === updated.id ? updated : entry));
			notice = on ? `${radio.host} switched on.` : `${radio.host} switched off.`;
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not switch it.';
		} finally {
			busy = false;
		}
	}

	async function remove(radio: Transceiver): Promise<void> {
		if (!window.confirm(`Remove the interface at ${radio.host}? The daemon is untouched.`)) return;
		busy = true;
		try {
			await api.deleteTransceiver(radio.id);
			if (openId === radio.id) openId = null;
			notice = 'Interface removed.';
			await load();
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not remove it.';
		} finally {
			busy = false;
		}
	}

	function mhz(hz: number | null): string {
		return hz === null ? '—' : (hz / 1_000_000).toFixed(4);
	}
</script>

<div class="panel">
	<header>
		<h1>Radio</h1>
		<p class="muted small">
			Each interface is one rigctld. The station dials every enabled one by itself and stays dialled; the
			one you open last is the one the rest of the station follows.
		</p>
	</header>

	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	<section class="card">
		<header class="card-head">
			<h2>Interfaces</h2>
			<button class="btn ghost small" type="button" onclick={beginCreate}>+ Add</button>
		</header>

		{#if formOpen}
			<form onsubmit={save}>
				<div class="fields">
					<label class="field">
						<span>Address or host name</span>
						<input type="text" name="host" bind:value={host} placeholder="localhost" autocomplete="off" />
					</label>
					<label class="field">
						<span>Port</span>
						<input
							type="text"
							name="port"
							bind:value={port}
							placeholder="4532"
							inputmode="numeric"
							autocomplete="off"
						/>
					</label>
					<label class="field">
						<span>Serial port</span>
						<input
							type="text"
							name="serialPort"
							bind:value={serialPort}
							placeholder="as rigctld runs it"
							autocomplete="off"
						/>
					</label>
					<label class="field">
						<span>Speed</span>
						<input
							type="text"
							name="serialSpeed"
							bind:value={serialSpeed}
							placeholder="baud"
							inputmode="numeric"
							autocomplete="off"
						/>
					</label>
					<label class="field check">
						<input type="checkbox" bind:checked={enabled} />
						<span>Switched on</span>
					</label>
				</div>
				<div class="row-buttons">
					<button class="btn primary" type="submit" disabled={busy}>
						{busy ? 'Saving…' : editingId === null ? 'Add interface' : 'Save'}
					</button>
					<button class="btn" type="button" onclick={closeForm}>Cancel</button>
					<span class="muted small">
						Empty address means localhost, empty port means 4532. Serial port and speed are noted for
						the tile: rigctld never reports the ones it was started with.
					</span>
				</div>
			</form>
		{/if}

		{#if loading}
			<p class="muted small">Reading…</p>
		{:else if radios.length === 0 && !formOpen}
			<p class="muted small">No interface yet: “+ Add” sets where rigctld answers.</p>
		{/if}

		<div class="tiles">
			{#each radios as radio (radio.id)}
				<button
					class="tile"
					class:bad={ledOf(radio) === 'red'}
					type="button"
					aria-expanded={openId === radio.id}
					onclick={() => void open(radio)}
				>
					<span class="line">
						<span
							class="led {ledOf(radio)}"
							role="img"
							aria-label={stateWord(radio)}
							title={stateWord(radio)}
						></span>
						<span class="label">
							<strong>{names[radio.host] ?? radio.host}</strong><span class="port">:{radio.port}</span>
						</span>
					</span>
					{#if names[radio.host]}
						<span class="line2 addr mono">{radio.host}</span>
					{/if}
					<span class="line2">
						{radio.link.rig?.model ?? '—'}
						{#if radio.serialPort}
							<span class="muted">
								· {radio.serialPort}{radio.serialSpeed ? ` @ ${radio.serialSpeed}` : ''}
							</span>
						{/if}
					</span>
				</button>

				{#if openId === radio.id}
					<div class="details">
						{#if radio.link.state !== 'connected'}
							<p class="muted small">
								{radio.link.error ?? (radio.enabled ? 'the link is closed' : 'this interface is switched off')}
							</p>
						{:else if !radio.link.rig}
							<p class="muted small">rigctld is up; it has not described the radio yet.</p>
						{:else}
							<div class="readout">
								<div class="value">
									<span class="big">{mhz(radio.link.rig.frequencyHz)}</span>
									<span class="unit">MHz</span>
									{#if radio.link.rig.mode}<span class="mode">{radio.link.rig.mode}</span>{/if}
								</div>
								<div class="value">
									<span class="label">Filter</span>
									<span class="value-text">
										{radio.link.rig.filterHz === null ? 'not reported' : `${radio.link.rig.filterHz} Hz`}
									</span>
									{#if radio.link.rig.shiftHz !== null}
										<span
											class="shift"
											class:off={radio.link.rig.shiftHz !== 1500}
											title="The rig's IF shift in the data mode; 1500 Hz is centred"
										>
											{#if radio.link.rig.shiftHz === 1500}
												· centred
											{:else}
												· shift {radio.link.rig.shiftHz} Hz —
												{radio.link.rig.usableHz ?? 0} Hz usable
											{/if}
										</span>
									{/if}
								</div>
							</div>

							<div class="controls">
								<label class="control">
									<span class="label">Transmit audio</span>
									<select
										value={radio.pttInput}
										disabled={busy}
										onchange={(event) =>
											void applyPttInput(radio, event.currentTarget.value as PttInput)}
									>
										<option value="rear">{PTT_INPUT_LABELS.rear}</option>
										<option value="front">{PTT_INPUT_LABELS.front}</option>
										<option value="auto">{PTT_INPUT_LABELS.auto}</option>
									</select>
								</label>

								<label class="control power">
									<span class="label">RF power</span>
									<input
										type="range"
										min="5"
										max="100"
										step="5"
										value={powerPct ?? 100}
										disabled={busy || powerPct === null}
										onchange={(event) => void applyPower(radio, Number(event.currentTarget.value))}
									/>
									<span class="value-text">{powerPct === null ? 'not reported' : `${powerPct} %`}</span>
								</label>
							</div>
						{/if}

						<div class="controls foot">
							<label class="control check">
								<input
									type="checkbox"
									checked={radio.enabled}
									disabled={busy}
									onchange={(event) => void setEnabled(radio, event.currentTarget.checked)}
								/>
								<span>Switched on</span>
							</label>
							<span class="muted small mono">{radio.host}:{radio.port}</span>
							<button class="btn ghost small" type="button" onclick={() => beginEdit(radio)}>
								Edit
							</button>
							<button
								class="btn ghost small danger"
								type="button"
								disabled={busy}
								onclick={() => void remove(radio)}
							>
								Delete
							</button>
						</div>
					</div>
				{/if}
			{/each}
		</div>
	</section>
</div>

<style>
	.panel {
		padding: 1.5rem;
		overflow-y: auto;
		min-height: 0;
		max-width: 56rem;
	}

	h1 {
		font-size: 1.2rem;
		margin: 0 0 0.3rem;
	}

	h2 {
		font-size: 0.95rem;
		margin: 0;
	}

	.small {
		font-size: 0.82rem;
	}

	.card {
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--bg-panel);
		padding: 0.9rem 1rem;
		margin-top: 1rem;
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.7rem;
	}

	.card-head .btn {
		margin-left: auto;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
		gap: 0.5rem;
	}

	/* Two lines: host and LED, then the transceiver it serves. Nothing else. */
	.tile {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.45rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--bg);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.tile:hover {
		border-color: color-mix(in oklab, var(--accent) 40%, var(--line));
	}

	.tile.bad {
		border-color: color-mix(in oklab, var(--danger) 40%, var(--line));
	}

	.line {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.line2 {
		font-size: 0.8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.led {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		background: var(--faint);
		flex: 0 0 auto;
		/* The LED is the state; the word lives in its accessibility label and tooltip. */
		cursor: help;
	}

	.led.green {
		background: var(--ok);
		box-shadow: 0 0 6px color-mix(in oklab, var(--ok) 70%, transparent);
	}

	.led.amber {
		background: #d9a441;
	}

	.led.red {
		background: var(--danger);
	}

	/* `Quantum-Q1:4532` — the machine's name in bold, the port in the same line, lighter. */
	.label {
		font-size: 0.88rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.label strong {
		font-weight: 600;
	}

	.label .port {
		color: var(--muted);
		font-weight: 400;
		font-variant-numeric: tabular-nums;
	}

	.addr {
		font-size: 0.76rem;
		color: var(--muted);
	}

	/* The LED is the state; the word lives in its accessibility label and tooltip. */
	.led {
		cursor: help;
	}

	.details {
		grid-column: 1 / -1;
		padding: 0.5rem 0.2rem 0.2rem 1.1rem;
		border-left: 2px solid var(--line);
	}

	.readout {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 1.6rem;
	}

	.value {
		display: flex;
		align-items: baseline;
		gap: 0.35rem;
	}

	.value .label {
		color: var(--faint);
		font-size: 0.76rem;
	}

	.big {
		font-size: 1.35rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.unit {
		font-size: 0.78rem;
		color: var(--muted);
	}

	.mode {
		font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
		font-size: 0.82rem;
		margin-left: 0.2rem;
	}

	.value-text {
		font-size: 0.86rem;
	}

	/* The IF shift, said beside the filter: centred, or how much the filter has lost. */
	.shift {
		font-size: 0.72rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.shift.off {
		color: var(--danger);
	}

	.mono {
		font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1.2rem;
		margin-top: 0.7rem;
	}

	.controls.foot {
		border-top: 1px solid var(--line);
		padding-top: 0.6rem;
	}

	.control {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.84rem;
	}

	.control.check {
		gap: 0.4rem;
	}

	.control.power input[type='range'] {
		width: 10rem;
		accent-color: var(--accent);
	}

	select {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.25rem 0.45rem;
		color: var(--text);
		font: inherit;
		font-size: 0.84rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		border-bottom: 1px solid var(--line);
		padding-bottom: 0.9rem;
		margin-bottom: 0.9rem;
	}

	.fields {
		display: grid;
		grid-template-columns: minmax(10rem, 1fr) 5rem minmax(8rem, 1fr) 5rem auto;
		gap: 0.6rem;
		align-items: end;
	}

	.field {
		display: grid;
		gap: 0.2rem;
		font-size: 0.76rem;
		color: var(--muted);
	}

	.field.check {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.84rem;
		color: var(--text);
	}

	.row-buttons {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.row-buttons .small {
		max-width: 40rem;
	}

	.danger {
		color: var(--danger);
	}

	.notice {
		margin: 0.4rem 0 0;
		padding: 0.45rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
		background: color-mix(in oklab, var(--ok) 12%, transparent);
		border-radius: 8px;
		font-size: 0.86rem;
	}

	.error {
		margin: 0.4rem 0 0;
		font-size: 0.86rem;
		color: var(--danger);
	}
</style>
