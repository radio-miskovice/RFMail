<script lang="ts">
	import { onMount } from 'svelte';
	import type { Transceiver } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';

	let { onopenconfig }: { onopenconfig?: () => void } = $props();

	let radios = $state<Transceiver[]>([]);
	let selectedId = $state<number | null>(null);
	let busy = $state(false);
	let failure = $state('');

	const selected = $derived(radios.find((radio) => radio.id === selectedId) ?? null);
	const linkState = $derived(selected?.link.state ?? 'disconnected');

	/** LED: grey never opened, amber dialling, green up, red last exchange failed. */
	const colour = $derived(
		linkState === 'connected'
			? 'green'
			: linkState === 'error'
				? 'red'
				: linkState === 'connecting'
					? 'amber'
					: 'grey',
	);

	const summary = $derived.by(() => {
		if (!selected) return 'no transceiver';
		const link = selected.link;
		if (link.state === 'connected' && link.frequencyHz !== null) {
			const mhz = (link.frequencyHz / 1_000_000).toFixed(4);
			return `${mhz} MHz ${link.mode ?? ''}`.trim();
		}
		if (link.state === 'error') return link.error ?? 'error';
		if (link.state === 'connecting') return 'connecting…';
		return 'not connected';
	});

	async function load(): Promise<void> {
		try {
			radios = await api.transceivers();
			const remembered = Number(localStorage.getItem('rfmail.transceiver') ?? '');
			if (radios.some((radio) => radio.id === remembered)) selectedId = remembered;
			else if (radios.length > 0 && !radios.some((radio) => radio.id === selectedId)) {
				selectedId = radios[0]?.id ?? null;
			}
		} catch {
			/* the header stays quiet; the Radio page reports problems */
		}
	}

	/** Clears a red LED without retrying: the link simply goes back to grey. */
	async function clearError(): Promise<void> {
		const radio = selected;
		if (!radio) return;
		busy = true;
		try {
			const result = await api.disconnectTransceiver(radio.id);
			radios = radios.map((entry) => (entry.id === radio.id ? result.transceiver : entry));
			failure = '';
		} catch {
			/* the poll will show the state as it is */
		} finally {
			busy = false;
		}
	}

	async function toggle(): Promise<void> {
		const radio = selected;
		if (!radio || busy) return;
		busy = true;
		failure = '';
		try {
			if (radio.link.state === 'connected' || radio.link.state === 'error') {
				if (radio.link.state === 'error') {
					// Reconnect: a red LED is cleared by a successful connect or by disconnecting.
					const result = await api.connectTransceiver(radio.id);
					radios = radios.map((entry) => (entry.id === radio.id ? result.transceiver : entry));
					if (result.error) failure = result.error;
				} else {
					const result = await api.disconnectTransceiver(radio.id);
					radios = radios.map((entry) => (entry.id === radio.id ? result.transceiver : entry));
				}
			} else {
				const result = await api.connectTransceiver(radio.id);
				radios = radios.map((entry) => (entry.id === radio.id ? result.transceiver : entry));
				if (result.error) failure = result.error;
			}
		} catch (error) {
			failure = error instanceof ApiRequestError ? (error.fields?.['host'] ?? error.message) : 'the backend did not answer';
			await load();
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		void load();
		const timer = setInterval(() => void load(), 5000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (selectedId !== null) localStorage.setItem('rfmail.transceiver', String(selectedId));
	});
</script>

<div class="rig" class:error={linkState === 'error'}>
	<span
		class="led {colour}"
		class:pulse={linkState === 'connecting' || busy}
		role="img"
		aria-label={linkState}
		title={linkState === 'error' ? (selected?.link.error ?? 'error') : summary}></span>

	{#if radios.length === 0}
		<span class="muted small">no transceiver</span>
		{#if onopenconfig}
			<button class="btn ghost small" type="button" onclick={onopenconfig}>Configure</button>
		{/if}
	{:else}
		<select
			class="picker"
			aria-label="Transceiver"
			value={selectedId ?? ''}
			onchange={(event) => (selectedId = Number(event.currentTarget.value) || null)}
		>
			{#each radios as radio (radio.id)}
				<option value={radio.id}>{radio.name}</option>
			{/each}
		</select>
		<span class="readout" title={failure || summary}>{summary}</span>
		<button
			class="btn ghost small"
			type="button"
			disabled={busy || !selected}
			title={linkState === 'connected' ? 'Close the rig link' : linkState === 'error' ? 'Try again' : 'Open the rig link'}
			onclick={toggle}
		>
			{linkState === 'connected' ? 'Disconnect' : linkState === 'error' ? 'Reconnect' : 'Connect'}
		</button>
		{#if linkState === 'error'}
			<button
				class="btn ghost small"
				type="button"
				disabled={busy}
				title="Clear the error and go back to not connected"
				aria-label="Clear the error"
				onclick={clearError}
			>
				✕
			</button>
		{/if}
	{/if}
</div>

<style>
	.rig {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.15rem 0.5rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--bg-raised);
	}

	.rig.error {
		border-color: color-mix(in oklab, var(--danger) 45%, var(--line));
	}

	.led {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		flex: 0 0 auto;
		background: var(--faint);
		box-shadow: 0 0 0 1px color-mix(in oklab, var(--line) 70%, transparent);
	}

	.led.green {
		background: var(--ok);
		box-shadow: 0 0 6px color-mix(in oklab, var(--ok) 70%, transparent);
	}

	.led.red {
		background: var(--danger);
		box-shadow: 0 0 6px color-mix(in oklab, var(--danger) 70%, transparent);
	}

	.led.amber {
		background: #d9a441;
	}

	.led.pulse {
		animation: blink 900ms ease-in-out infinite;
	}

	@keyframes blink {
		50% {
			opacity: 0.35;
		}
	}

	.picker {
		background: transparent;
		border: none;
		color: var(--text);
		font: inherit;
		font-size: 0.82rem;
		max-width: 9rem;
	}

	.readout {
		font-size: 0.76rem;
		color: var(--muted);
		max-width: 12rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.small {
		font-size: 0.76rem;
	}

	.btn.small {
		padding: 0.15rem 0.5rem;
		font-size: 0.76rem;
	}

	@media (max-width: 1100px) {
		.readout {
			display: none;
		}
	}
</style>
