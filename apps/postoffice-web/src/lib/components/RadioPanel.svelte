<script lang="ts">
	import { dialText, type PoRadio } from '@rfmail/shared';

	let {
		radio,
		busy,
		onsave,
		ondelete,
		onconnect,
		ondisconnect
	}: {
		radio: PoRadio | null;
		busy: boolean;
		onsave: (input: { host: string; port?: number; pttInput: 'rear' | 'front' | 'auto' }) => void;
		ondelete: () => void;
		onconnect: () => void;
		ondisconnect: () => void;
	} = $props();

	let editing = $state(false);
	let host = $state('');
	let port = $state('4532');
	let pttInput = $state<'rear' | 'front' | 'auto'>('rear');
	let formError = $state('');

	const link = $derived(radio?.link ?? null);
	const connected = $derived(link?.state === 'connected');

	/** Its own model once rigctld has answered, the address until then. */
	const title = $derived(
		radio?.transceiver
			? (link?.model ?? `${radio.transceiver.host}:${radio.transceiver.port}`)
			: ''
	);

	const word = $derived.by(() => {
		if (!link) return 'not configured';
		switch (link.state) {
			case 'connected':
				return 'connected';
			case 'connecting':
				return 'dialling';
			case 'error':
				return 'unavailable';
			default:
				return 'disconnected';
		}
	});

	function begin(): void {
		if (radio?.transceiver) {
			host = radio.transceiver.host;
			port = String(radio.transceiver.port);
			pttInput = radio.transceiver.pttInput;
		}
		formError = '';
		editing = true;
	}

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		formError = '';
		if (!host.trim()) {
			formError = 'The interface needs an address.';
			return;
		}
		const parsed = Number(port);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
			formError = 'The port must be between 1 and 65535.';
			return;
		}
		onsave({ host: host.trim(), port: parsed, pttInput });
		editing = false;
	}
</script>

<section class="panel">
	<div class="panel-head">
		<h2>Radio</h2>
		{#if radio?.transceiver && !editing}
			<div class="acts">
				{#if connected}
					<button class="btn ghost" onclick={ondisconnect} disabled={busy}>Disconnect</button>
				{:else}
					<button class="btn ghost" onclick={onconnect} disabled={busy}>Connect</button>
				{/if}
				<button class="btn ghost" onclick={begin}>Change</button>
				<button class="btn ghost" onclick={ondelete} disabled={busy}>Remove</button>
			</div>
		{/if}
	</div>

	{#if radio?.transceiver && !editing}
		<div class="headline">
			<div class="state {link?.state ?? 'disconnected'}">
				<span class="dot" aria-hidden="true"></span>
				<strong>{title}</strong>
				<span class="word">{word}</span>
			</div>
			<div class="readout">
				{#if link?.state === 'connected'}
					<span class="mono">{dialText(link.frequencyHz)}</span>
					<span class="muted">{link.mode ?? '—'}{link.passbandHz ? ` · ${link.passbandHz} Hz` : ''}</span>
				{:else}
					<span class="mono">{radio.transceiver.host}:{radio.transceiver.port}</span>
					<span class="muted">{radio.transceiver.pttInput === 'rear' ? 'rear input' : radio.transceiver.pttInput === 'front' ? 'front microphone' : 'auto PTT'}</span>
				{/if}
			</div>
		</div>
		{#if link?.error}
			<p class="error" role="alert">{link.error}</p>
		{/if}
	{:else}
		<p class="hint">
			The rigctld the station tunes and keys through. It is dialled at start-up and kept open; nothing about the
			connection is stored.
		</p>
		<form class="form" onsubmit={submit}>
			<label class="field">
				<span>Address</span>
				<input type="text" bind:value={host} spellcheck="false" placeholder="192.168.133.222" />
			</label>
			<label class="field">
				<span>Port</span>
				<input type="text" inputmode="numeric" bind:value={port} />
			</label>
			<label class="field">
				<span>Transmit audio</span>
				<select bind:value={pttInput}>
					<option value="rear">Rear input</option>
					<option value="front">Front microphone</option>
					<option value="auto">Rear, falling back</option>
				</select>
			</label>
			<div class="submit">
				{#if radio?.transceiver}
					<button class="btn ghost" type="button" onclick={() => (editing = false)}>Cancel</button>
				{/if}
				<button class="btn primary" type="submit" disabled={busy}>Save</button>
			</div>
			{#if formError}<p class="error">{formError}</p>{/if}
		</form>
	{/if}
</section>

<style>
	.panel {
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.85rem 1.1rem 1rem;
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.45rem;
	}
	h2 {
		margin: 0;
		font-size: 0.85rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.acts { display: flex; gap: 0.15rem; }
	.headline {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.state {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.dot {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 999px;
		background: var(--faint);
		align-self: center;
	}
	.state.connected .dot { background: var(--ok); box-shadow: 0 0 0 3px rgb(95 206 155 / 0.18); }
	.state.connecting .dot { background: var(--accent); box-shadow: 0 0 0 3px rgb(242 166 64 / 0.2); }
	.state.error .dot { background: var(--danger); box-shadow: 0 0 0 3px rgb(239 122 114 / 0.18); }
	.state strong { font-size: 0.98rem; }
	.word { color: var(--muted); font-size: 0.86rem; }
	.readout {
		display: flex;
		align-items: baseline;
		gap: 0.7rem;
		font-size: 0.9rem;
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.86rem;
	}
	.hint {
		margin: 0 0 0.7rem;
		color: var(--faint);
		font-size: 0.84rem;
	}
	.form {
		display: grid;
		grid-template-columns: minmax(10rem, 16rem) 6rem minmax(9rem, 12rem) auto;
		gap: 0.7rem;
		align-items: end;
	}
	@media (max-width: 900px) {
		.form { grid-template-columns: 1fr; }
	}
	.submit {
		display: flex;
		gap: 0.4rem;
		justify-content: flex-end;
	}
	select {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.55rem 0.7rem;
		color: var(--text);
	}
	.error {
		margin: 0.45rem 0 0;
		font-size: 0.88rem;
	}
	form .error { grid-column: 1 / -1; }
</style>
