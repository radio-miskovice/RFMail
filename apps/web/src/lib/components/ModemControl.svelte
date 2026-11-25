<script lang="ts">
	// The modem this station is working with, and whether it accepts inbound calls.
	//
	// It sits in the header because both facts are station-wide, not screen-wide: a session
	// needs to know which modem to dial, and a P2P peer can only reach us while the modem
	// is listening. The choice is remembered in the browser; the listening flag is the last
	// value we sent to the modem, since the host protocol has no command that reads it.
	import { onMount } from 'svelte';
	import { modemKindInfo, type Modem, type ModemStatus } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';

	let modems = $state<Modem[]>([]);
	let statuses = $state<Record<number, ModemStatus>>({});
	let selectedId = $state<number | null>(null);
	let busy = $state(false);
	let answer = $state('');
	let error = $state('');

	onMount(async () => {
		try {
			const [configured, status] = await Promise.all([api.modems(), api.modemStatus()]);
			modems = configured.filter((entry) => entry.enabled);
			statuses = Object.fromEntries(status.statuses.map((entry) => [entry.id, entry]));
			const saved = Number(localStorage.getItem('rfmail.headerModem'));
			selectedId = modems.some((entry) => entry.id === saved)
				? saved
				: (modems.find((entry) => statuses[entry.id]?.running)?.id ?? modems[0]?.id ?? null);
		} catch {
			// A header control that cannot load costs convenience, not the session screen.
		}
	});

	const selected = $derived(modems.find((entry) => entry.id === selectedId) ?? null);
	const listening = $derived(selectedId === null ? false : statuses[selectedId]?.listening === true);
	const running = $derived(selectedId === null ? null : (statuses[selectedId]?.running ?? null));

	function choose(id: number): void {
		selectedId = id;
		answer = '';
		error = '';
		try {
			localStorage.setItem('rfmail.headerModem', String(id));
		} catch {
			// No storage, no memory of the choice.
		}
	}

	async function setListening(on: boolean): Promise<void> {
		if (selectedId === null || busy) return;
		busy = true;
		error = '';
		try {
			const result = await api.setModemListening(selectedId, on);
			statuses = {
				...statuses,
				[selectedId]: { ...(statuses[selectedId] ?? { id: selectedId, running: true, error: null }), listening: result.listening }
			};
			answer = result.answer;
			if (!/^OK\b/i.test(result.answer)) error = `${selected?.name ?? 'The modem'} answered "${result.answer}"`;
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'The modem did not answer.';
			// The checkbox follows the modem, not the click: put it back.
			statuses = { ...statuses, [selectedId]: { ...(statuses[selectedId] ?? { id: selectedId, running: false, error: null }), listening: !on } };
		} finally {
			busy = false;
		}
	}
</script>

<div class="modem-head">
	<label class="pick">
		<span class="cap">Modem</span>
		<select
			bind:value={selectedId}
			disabled={modems.length === 0}
			onchange={(event) => choose(Number((event.currentTarget as HTMLSelectElement).value))}
		>
			{#each modems as entry (entry.id)}
				<option value={entry.id}>
					{entry.name} · {modemKindInfo(entry.kind).label}{statuses[entry.id]?.running === false ? ' — not running' : ''}
				</option>
			{/each}
			{#if modems.length === 0}
				<option value={null}>no modem configured</option>
			{/if}
		</select>
	</label>

	<label
		class="listen"
		title={error || (running === false ? 'nothing is listening on this modem’s command port' : answer || 'accept inbound P2P calls (LISTEN ON)')}
	>
		<input
			type="checkbox"
			checked={listening}
			disabled={selectedId === null || busy || running === false}
			onchange={(event) => void setListening((event.currentTarget as HTMLInputElement).checked)}
		/>
		<span class="word">Listen</span>
	</label>

	{#if error}
		<span class="problem" role="alert">{error}</span>
	{/if}
</div>

<style>
	.modem-head {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
	}

	.pick {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}

	.cap {
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--faint);
	}

	select {
		max-width: 14rem;
		min-width: 6rem;
		background: var(--bg-raised);
		color: var(--text);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 0.2rem 0.4rem;
		font-size: 0.78rem;
	}

	.listen {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.78rem;
		color: var(--muted);
		white-space: nowrap;
	}

	.listen input {
		margin: 0;
	}

	@media (max-width: 1000px) {
		.cap,
		.word {
			display: none;
		}
		select {
			max-width: 10rem;
		}
	}

	.problem {
		font-size: 0.72rem;
		color: var(--danger);
		max-width: 18rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

</style>
