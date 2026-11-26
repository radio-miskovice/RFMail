<script lang="ts">
	// The header's read-out of the station's radio.
	//
	// The station dials rigctld by itself and keeps it dialled, so this chip has nothing to
	// press except itself: it shows the rig's name, the LED of the radio-to-rigctld link and
	// the current readout, and a click goes to the Radio screen.
	import { onMount } from 'svelte';
	import type { RadioStatus } from '@rfmail/shared';
	import { api } from '../api/client';

	let { onopenconfig }: { onopenconfig?: () => void } = $props();

	let status = $state<RadioStatus | null>(null);

	/** Green: the rig answers. Amber: dialling. Red: something failed. Grey: nothing configured. */
	const colour = $derived(
		!status
			? 'grey'
			: status.connected && status.rig?.active
				? 'green'
				: status.connected
					? 'amber'
					: status.interface && status.error
						? 'red'
						: status.interface
							? 'amber'
							: 'grey',
	);

	const label = $derived(status?.rig?.model ?? (status?.interface ? 'rigctld' : 'no radio'));

	const summary = $derived.by(() => {
		if (!status?.interface) return '';
		if (!status.connected) return status.error ? 'no answer' : 'not connected';
		if (status.rig?.frequencyHz !== null && status.rig?.frequencyHz !== undefined) {
			const mhz = (status.rig.frequencyHz / 1_000_000).toFixed(4);
			return `${mhz} MHz ${status.rig.mode ?? ''}`.trim();
		}
		return 'rig online';
	});

	/** The chip has room for a word, not for why: the reason lives in its tooltip. */
	const detail = $derived(
		status?.error ??
			(status?.interface ? `${status.interface.host}:${status.interface.port}` : 'no radio interface configured'),
	);

	onMount(() => {
		const load = async (): Promise<void> => {
			try {
				status = await api.radio();
			} catch {
				/* the header stays quiet; the Radio page reports problems */
			}
		};
		void load();
		const timer = setInterval(() => void load(), 5000);
		return () => clearInterval(timer);
	});
</script>

<button
	class="rig"
	class:error={colour === 'red'}
	type="button"
	title={detail}
	onclick={() => onopenconfig?.()}
>
	<span
		class="led {colour}"
		class:pulse={colour === 'amber'}
		role="img"
		aria-label={colour === 'green' ? 'the radio answers' : colour === 'red' ? 'the radio link failed' : colour === 'amber' ? 'dialling rigctld' : 'no radio configured'}></span>
	<span class="label">{label}</span>
	{#if summary}<span class="readout">{summary}</span>{/if}
</button>

<style>
	.rig {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.15rem 0.55rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--bg-raised);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}

	.rig:hover {
		border-color: color-mix(in oklab, var(--accent) 40%, var(--line));
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

	.label {
		font-size: 0.8rem;
		white-space: nowrap;
	}

	.readout {
		font-size: 0.76rem;
		color: var(--muted);
		max-width: 12rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 1100px) {
		.readout {
			display: none;
		}
	}
</style>
