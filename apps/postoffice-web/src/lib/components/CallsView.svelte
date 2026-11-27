<script lang="ts">
	import type { PoCall } from '@rfmail/shared';
	import { duration, utcTime } from '../format';

	let { calls }: { calls: PoCall[] } = $props();
</script>

<section class="calls">
	<div class="panel">
		<div class="panel-head"><h2>Call log</h2></div>
		<p class="hint">Every call the station answered, newest first: who called and what the exchange did, no message content.</p>

		{#if calls.length > 0}
			<table>
				<thead>
					<tr>
						<th>Time</th><th>Caller</th><th>Result</th>
						<th class="num">Received</th><th class="num">Sent</th>
						<th class="num">Duration</th><th>Reason</th>
					</tr>
				</thead>
				<tbody>
					{#each calls as call (call.id)}
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
			<p class="empty">No calls recorded yet.</p>
		{/if}
	</div>
</section>

<style>
	.panel {
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.9rem 1.1rem 1.1rem;
	}
	h2 {
		margin: 0 0 0.3rem;
		font-size: 0.85rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.hint {
		margin: 0 0 0.9rem;
		max-width: 66rem;
		color: var(--faint);
		font-size: 0.84rem;
	}
	table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
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
	td { padding: 0.42rem 0.5rem; border-top: 1px solid var(--line); }
	.num { text-align: right; }
	.ok { color: var(--ok); }
	.bad { color: var(--danger); }
	.reason { color: var(--muted); font-size: 0.84rem; }
	.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.84rem; }
	.empty { color: var(--muted); font-size: 0.9rem; }
</style>
