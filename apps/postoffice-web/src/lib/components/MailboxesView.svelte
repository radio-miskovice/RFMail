<script lang="ts">
	import type { PoMailbox } from '@rfmail/shared';
	import { bytes, utcTime } from '../format';

	let {
		mailboxes,
		busy,
		error,
		oncreate,
		onupdate,
		ondelete
	}: {
		mailboxes: PoMailbox[];
		busy: boolean;
		error: string;
		oncreate: (input: { callsign: string; password?: string }) => void;
		onupdate: (id: number, patch: { enabled?: boolean; password?: string }) => void;
		ondelete: (id: number) => void;
	} = $props();

	let callsign = $state('');
	let password = $state('');
	let editing = $state<number | null>(null);
	let editedPassword = $state('');

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		oncreate({
			callsign: callsign.trim(),
			...(password ? { password } : {})
		});
		callsign = '';
		password = '';
	}

	function savePassword(id: number): void {
		onupdate(id, { password: editedPassword });
		editing = null;
		editedPassword = '';
	}
</script>

<section class="mailboxes">
	<div class="panel">
		<div class="panel-head"><h2>Mailboxes</h2></div>
		<p class="hint">One row per callsign the station holds mail for; its password answers a caller's challenge.</p>

		{#if mailboxes.length > 0}
			<table>
				<thead>
					<tr>
						<th>Callsign</th><th class="num">Messages</th><th class="num">Size</th>
						<th>Password</th><th>State</th><th></th>
					</tr>
				</thead>
				<tbody>
					{#each mailboxes as mailbox (mailbox.id)}
						<tr class:off={!mailbox.enabled}>
							<td>
								<strong>{mailbox.callsign}</strong>
								{#if mailbox.isStation}<span class="tag">this station</span>{/if}
							</td>
							<td class="num">{mailbox.messages}</td>
							<td class="num">{bytes(mailbox.bytes)}</td>
							<td>
								{#if editing === mailbox.id}
									<div class="inline">
										<input
											type="password"
											bind:value={editedPassword}
											placeholder="new password"
											autocomplete="new-password"
										/>
										<button class="btn" onclick={() => savePassword(mailbox.id)} disabled={busy}>
											Save
										</button>
										<button class="btn ghost" onclick={() => (editing = null)}>Cancel</button>
									</div>
								{:else}
									<button
										class="btn ghost"
										onclick={() => {
											editing = mailbox.id;
											editedPassword = '';
										}}
									>
										{mailbox.hasPassword ? 'change' : 'set'}
									</button>
								{/if}
							</td>
							<td class="muted">{mailbox.enabled ? 'enabled' : 'disabled'}</td>
							<td class="end">
								{#if !mailbox.isStation}
									<button
										class="btn ghost"
										onclick={() => onupdate(mailbox.id, { enabled: !mailbox.enabled })}
										disabled={busy}
									>
										{mailbox.enabled ? 'Disable' : 'Enable'}
									</button>
									<button class="btn ghost" onclick={() => ondelete(mailbox.id)} disabled={busy}>
										Delete
									</button>
								{/if}
							</td>
						</tr>
						<tr class="sub">
							<td colspan="6">created {utcTime(mailbox.createdAt)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="empty">No mailboxes yet.</p>
		{/if}

		{#if error}<p class="error" role="alert">{error}</p>{/if}

		<form class="add" onsubmit={submit}>
			<label class="field">
				<span>Callsign</span>
				<input type="text" bind:value={callsign} spellcheck="false" autocomplete="off" required />
			</label>
			<label class="field">
				<span>Post-office password <em>optional</em></span>
				<input type="password" bind:value={password} autocomplete="new-password" />
			</label>
			<div class="actions">
				<button class="btn primary" type="submit" disabled={busy}>Add mailbox</button>
			</div>
		</form>
	</div>
</section>

<style>
	.panel {
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.9rem 1.1rem 1.1rem;
	}
	.panel-head { margin-bottom: 0.3rem; }
	h2 {
		margin: 0;
		font-size: 0.85rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.hint {
		margin: 0 0 0.7rem;
		color: var(--faint);
		font-size: 0.84rem;
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
	td { padding: 0.45rem 0.5rem; vertical-align: middle; }
	tbody tr:not(.sub) td { border-top: 1px solid var(--line); }
	tr.off td { opacity: 0.62; }
	tr.sub td {
		border: none;
		padding: 0 0.5rem 0.45rem;
		font-size: 0.75rem;
		color: var(--faint);
	}
	.num { text-align: right; }
	.end { text-align: right; white-space: nowrap; }
	.tag {
		margin-left: 0.45rem;
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent);
		border: 1px solid var(--accent-soft);
		background: var(--accent-soft);
		border-radius: 999px;
		padding: 0.05rem 0.45rem;
	}
	.inline { display: flex; gap: 0.35rem; align-items: center; }
	.inline input { max-width: 12rem; }
	.empty { color: var(--muted); font-size: 0.9rem; }
	.add {
		display: grid;
		grid-template-columns: 12rem 18rem auto;
		gap: 0.7rem;
		align-items: end;
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--line);
	}
	@media (max-width: 760px) {
		.add { grid-template-columns: 1fr; }
	}
	.field em {
		font-style: normal;
		text-transform: none;
		letter-spacing: 0;
		color: var(--faint);
	}
	.actions { display: flex; justify-content: flex-end; }
</style>
