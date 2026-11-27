<script lang="ts">
	import type { PoAdministrator } from '@rfmail/shared';
	import { utcTime } from '../format';

	let {
		administrators,
		busy,
		oncreate,
		onupdate,
		ondelete
	}: {
		administrators: Array<PoAdministrator & { self: boolean }>;
		busy: boolean;
		oncreate: (input: { name: string; password: string; canInspect: boolean }) => void;
		onupdate: (id: number, patch: { enabled?: boolean; canInspect?: boolean; password?: string }) => void;
		ondelete: (id: number) => void;
	} = $props();

	let name = $state('');
	let password = $state('');
	let inspect = $state(false);
	let editing = $state<number | null>(null);
	let editedPassword = $state('');

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		oncreate({ name: name.trim(), password, canInspect: inspect });
		name = '';
		password = '';
		inspect = false;
	}
</script>

<section class="admins">
	<div class="panel">
		<div class="panel-head"><h2>Administrators</h2></div>
		<p class="hint">People who run the station: no mailbox, no callsign. Inspect is envelope metadata only, never message bodies.</p>

		<table>
			<thead>
				<tr><th>Name</th><th>Inspect</th><th>State</th><th class="num">Since</th><th></th></tr>
			</thead>
			<tbody>
				{#each administrators as admin (admin.id)}
					<tr class:off={!admin.enabled}>
						<td>
							<strong>{admin.name}</strong>
							{#if admin.self}<span class="tag">you</span>{/if}
						</td>
						<td>
							<button
								class="btn ghost"
								onclick={() => onupdate(admin.id, { canInspect: !admin.canInspect })}
								disabled={busy}
								title="read other mailboxes' envelope metadata"
							>
								{admin.canInspect ? 'allowed' : 'not allowed'}
							</button>
						</td>
						<td class="muted">{admin.enabled ? 'enabled' : 'disabled'}</td>
						<td class="num mono">{utcTime(admin.createdAt)}</td>
						<td class="end">
							{#if editing === admin.id}
								<div class="inline">
									<input
										type="password"
										bind:value={editedPassword}
										placeholder="new password"
										autocomplete="new-password"
									/>
									<button
										class="btn"
										onclick={() => {
											onupdate(admin.id, { password: editedPassword });
											editing = null;
											editedPassword = '';
										}}
										disabled={busy}
									>
										Save
									</button>
									<button class="btn ghost" onclick={() => (editing = null)}>Cancel</button>
								</div>
							{:else}
								<button
									class="btn ghost"
									onclick={() => {
										editing = admin.id;
										editedPassword = '';
									}}
								>
									Password
								</button>
								{#if !admin.self}
									<button
										class="btn ghost"
										onclick={() => onupdate(admin.id, { enabled: !admin.enabled })}
										disabled={busy}
									>
										{admin.enabled ? 'Disable' : 'Enable'}
									</button>
									<button class="btn ghost" onclick={() => ondelete(admin.id)} disabled={busy}>
										Delete
									</button>
								{/if}
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>


		<form class="add" onsubmit={submit}>
			<label class="field">
				<span>Name</span>
				<input type="text" bind:value={name} autocomplete="off" spellcheck="false" required />
			</label>
			<label class="field">
				<span>Password</span>
				<input type="password" bind:value={password} autocomplete="new-password" required />
			</label>
			<label class="check">
				<input type="checkbox" bind:checked={inspect} />
				<span>may inspect envelopes</span>
			</label>
			<div class="actions">
				<button class="btn primary" type="submit" disabled={busy}>Add administrator</button>
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
	h2 {
		margin: 0 0 0.3rem;
		font-size: 0.85rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.hint {
		margin: 0 0 0.8rem;
		max-width: 62rem;
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
	td { padding: 0.45rem 0.5rem; border-top: 1px solid var(--line); }
	tr.off td { opacity: 0.62; }
	.num { text-align: right; }
	.end { text-align: right; white-space: nowrap; }
	.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.84rem; }
	.tag {
		margin-left: 0.45rem;
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent);
		background: var(--accent-soft);
		border-radius: 999px;
		padding: 0.05rem 0.45rem;
	}
	.inline { display: flex; gap: 0.35rem; align-items: center; justify-content: flex-end; }
	.inline input { max-width: 11rem; }
	.add {
		display: grid;
		grid-template-columns: 12rem 16rem auto auto;
		gap: 0.7rem;
		align-items: end;
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--line);
	}
	@media (max-width: 860px) {
		.add { grid-template-columns: 1fr; }
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.88rem;
		color: var(--muted);
		padding-bottom: 0.55rem;
	}
	.actions { display: flex; justify-content: flex-end; }
</style>
