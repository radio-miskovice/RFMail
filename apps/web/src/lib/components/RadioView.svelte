<script lang="ts">
	import { onMount } from 'svelte';
	import type { PttInput, Transceiver } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';
	import { PTT_INPUT_LABELS } from '../labels';

	let radios = $state<Transceiver[]>([]);
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);

	let name = $state('');
	let host = $state('');
	let port = $state('4532');
	let pttInput = $state<PttInput>('rear');
	let editingId = $state<number | null>(null);

	onMount(() => void load());

	async function load(): Promise<void> {
		loading = true;
		try {
			radios = await api.transceivers();
			error = '';
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not load the transceivers.';
		} finally {
			loading = false;
		}
	}

	function reset(): void {
		editingId = null;
		name = '';
		host = '';
		port = '4532';
		pttInput = 'rear';
	}

	function edit(radio: Transceiver): void {
		editingId = radio.id;
		name = radio.name;
		host = radio.host;
		port = String(radio.port);
		pttInput = radio.pttInput;
		error = '';
		notice = '';
	}

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		busy = true;
		error = '';
		notice = '';
		try {
			const body = {
				name: name.trim(),
				host: host.trim(),
				port: Number(port),
				pttInput
			};
			if (editingId === null) {
				await api.createTransceiver(body);
				notice = `${body.name} added.`;
			} else {
				await api.updateTransceiver(editingId, body);
				notice = `${body.name} saved.`;
			}
			reset();
			await load();
		} catch (err) {
			error =
				err instanceof ApiRequestError
					? (Object.values(err.fields ?? {})[0] ?? err.message)
					: 'Could not save the transceiver.';
		} finally {
			busy = false;
		}
	}

	async function toggle(radio: Transceiver): Promise<void> {
		busy = true;
		error = '';
		notice = '';
		try {
			if (radio.link.state === 'connected') {
				const result = await api.disconnectTransceiver(radio.id);
				radios = radios.map((entry) => (entry.id === radio.id ? result.transceiver : entry));
				notice = `${radio.name} disconnected.`;
			} else {
				const result = await api.connectTransceiver(radio.id);
				radios = radios.map((entry) => (entry.id === radio.id ? result.transceiver : entry));
				if (result.error) error = `${radio.name}: ${result.error}`;
				else notice = `${radio.name} connected.`;
			}
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'The backend did not answer.';
			await load();
		} finally {
			busy = false;
		}
	}

	/** A red state is cleared by a successful connect or by dropping back to grey. */
	async function clearError(radio: Transceiver): Promise<void> {
		busy = true;
		try {
			const result = await api.disconnectTransceiver(radio.id);
			radios = radios.map((entry) => (entry.id === radio.id ? result.transceiver : entry));
			error = '';
			notice = `${radio.name}: error cleared.`;
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not clear it.';
		} finally {
			busy = false;
		}
	}

	async function remove(radio: Transceiver): Promise<void> {
		if (!window.confirm(`Remove ${radio.name}? The rig itself is untouched.`)) return;
		busy = true;
		try {
			await api.deleteTransceiver(radio.id);
			notice = `${radio.name} removed.`;
			if (editingId === radio.id) reset();
			await load();
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not remove it.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="panel">
	<header>
		<h1>Transceivers</h1>
		<p class="muted small">
			Each entry is one rigctld the station can talk to. The station never opens a serial port itself; it
			connects to the daemon you run (or that it launches), reads the frequency and mode, and keys the
			transmitter through it.
		</p>
	</header>

	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	<div class="table" aria-busy={loading}>
		<div class="head row">
			<span>Name</span>
			<span>rigctld</span>
			<span>Transmit audio</span>
			<span>State</span>
			<span></span>
		</div>
		{#each radios as radio (radio.id)}
			<div class="row">
				<span class="name">{radio.name}</span>
				<span class="mono">{radio.host}:{radio.port}</span>
				<span class="small">{PTT_INPUT_LABELS[radio.pttInput]}</span>
				<span class="state">
					<span
						class="led {radio.link.state === 'connected'
							? 'green'
							: radio.link.state === 'error'
								? 'red'
								: radio.link.state === 'connecting'
									? 'amber'
									: 'grey'}"></span>
					{#if radio.link.state === 'connected' && radio.link.frequencyHz !== null}
						{(radio.link.frequencyHz / 1_000_000).toFixed(4)} MHz {radio.link.mode ?? ''}
					{:else if radio.link.state === 'error'}
						<span class="red-text" title={radio.link.error ?? ''}>{radio.link.error ?? 'error'}</span>
					{:else}
						{radio.link.state}
					{/if}
				</span>
				<span class="actions">
					<button class="btn ghost small-btn" type="button" disabled={busy} onclick={() => toggle(radio)}>
						{radio.link.state === 'connected' ? 'Disconnect' : radio.link.state === 'error' ? 'Reconnect' : 'Connect'}
					</button>
					{#if radio.link.state === 'error'}
						<button class="btn ghost small-btn" type="button" disabled={busy} onclick={() => clearError(radio)}>
							Clear
						</button>
					{/if}
					<button class="btn ghost small-btn" type="button" onclick={() => edit(radio)}>Edit</button>
					<button class="btn ghost small-btn danger" type="button" disabled={busy} onclick={() => remove(radio)}>
						Delete
					</button>
				</span>
			</div>
		{/each}
		{#if radios.length === 0 && !loading}
			<p class="muted">No transceiver configured yet.</p>
		{/if}
	</div>

	<section>
		<h2>{editingId === null ? 'Add a transceiver' : 'Edit the transceiver'}</h2>
		<form onsubmit={save}>
			<div class="fields">
				<label class="field">
					<span>Name</span>
					<input type="text" name="name" bind:value={name} placeholder="TS-590SG" required />
				</label>
				<label class="field">
					<span>rigctld address</span>
					<input type="text" name="host" bind:value={host} placeholder="192.168.133.222" required />
				</label>
				<label class="field">
					<span>Port</span>
					<input type="number" name="port" bind:value={port} min="1" max="65535" />
				</label>
				<label class="field">
					<span>Transmit audio input</span>
					<select name="pttInput" bind:value={pttInput}>
						<option value="rear">{PTT_INPUT_LABELS.rear}</option>
						<option value="front">{PTT_INPUT_LABELS.front}</option>
						<option value="auto">{PTT_INPUT_LABELS.auto}</option>
					</select>
				</label>
			</div>
			<p class="hint muted small">
				The rear input is the connector a modem feeds; the front microphone connector transmits the room
				instead, and the far end hears nothing usable.
			</p>
			<div class="row-buttons">
				<button class="btn primary" type="submit" disabled={busy || !name.trim() || !host.trim()}>
					{busy ? 'Saving…' : editingId === null ? 'Add transceiver' : 'Save changes'}
				</button>
				{#if editingId !== null}
					<button class="btn" type="button" onclick={reset}>Cancel</button>
				{/if}
			</div>
		</form>
	</section>
</div>

<style>
	.panel {
		padding: 1.5rem;
		overflow-y: auto;
		min-height: 0;
	}

	h1 {
		font-size: 1.2rem;
		margin: 0 0 0.3rem;
	}

	header {
		margin-bottom: 1rem;
	}

	.small {
		font-size: 0.82rem;
	}

	.table {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--line);
		border-radius: 10px;
		overflow: hidden;
	}

	.row {
		display: grid;
		grid-template-columns: minmax(7rem, 1fr) minmax(9rem, 1.1fr) minmax(10rem, 1.4fr) minmax(11rem, 1.4fr) auto;
		gap: 0.6rem;
		align-items: center;
		padding: 0.55rem 0.8rem;
		border-top: 1px solid var(--line);
		font-size: 0.88rem;
	}

	.row:first-child {
		border-top: none;
	}

	.head {
		background: var(--bg-raised);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.name {
		font-weight: 600;
	}

	.mono {
		font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
		font-size: 0.82rem;
	}

	.state {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.82rem;
		color: var(--muted);
		overflow: hidden;
	}

	.led {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--faint);
		flex: 0 0 auto;
	}

	.led.green {
		background: var(--ok);
		box-shadow: 0 0 6px color-mix(in oklab, var(--ok) 70%, transparent);
	}

	.led.red {
		background: var(--danger);
	}

	.led.amber {
		background: #d9a441;
	}

	.red-text {
		color: var(--danger);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		gap: 0.25rem;
		justify-content: flex-end;
		flex-wrap: wrap;
	}

	.small-btn {
		font-size: 0.78rem;
		padding: 0.2rem 0.5rem;
	}

	.danger {
		color: var(--danger);
	}

	section {
		border-top: 1px solid var(--line);
		margin-top: 1.25rem;
		padding-top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	h2 {
		font-size: 0.95rem;
		margin: 0;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.75rem;
		max-width: 48rem;
	}

	select {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.55rem 0.7rem;
		color: var(--text);
		font: inherit;
	}

	.hint {
		margin: 0;
		max-width: 44rem;
	}

	.row-buttons {
		display: flex;
		gap: 0.5rem;
	}

	.notice {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
		background: color-mix(in oklab, var(--ok) 12%, transparent);
		border-radius: 8px;
		font-size: 0.88rem;
	}

	@media (max-width: 1100px) {
		.row {
			grid-template-columns: 1fr;
			gap: 0.25rem;
		}

		.head {
			display: none;
		}

		.actions {
			justify-content: flex-start;
		}
	}
</style>
