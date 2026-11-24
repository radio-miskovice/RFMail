<script lang="ts">
	import type { MessageSummary } from '@rfmail/shared';
	import { formatBytes, formatDate, senderName } from '../format';

	let {
		messages,
		selectedId,
		loading,
		onselect
	}: {
		messages: MessageSummary[];
		selectedId: number | null;
		loading: boolean;
		onselect: (id: number) => void;
	} = $props();
</script>

<div class="list" aria-busy={loading}>
	{#each messages as message (message.id)}
		<button
			type="button"
			class="row"
			class:unread={message.unread}
			class:selected={message.id === selectedId}
			onclick={() => onselect(message.id)}
		>
			<span class="line1">
				<span class="dot" aria-hidden="true"></span>
				<span class="from">{senderName(message.from)}</span>
				<span class="date">{formatDate(message.date)}</span>
			</span>
			<span class="subject">{message.subject || '(no subject)'}</span>
			<span class="line3">
				{#if message.flagged}<span class="flag" aria-label="flagged">★</span>{/if}
				{#if message.attachmentCount > 0}
					<span class="clip" aria-label="{message.attachmentCount} attachments">⌘</span>
				{/if}
				<span class="size">{formatBytes(message.size)}</span>
				{#if message.attachmentCount > 0}
					<span class="size">· {message.attachmentCount} file{message.attachmentCount === 1 ? '' : 's'}</span>
				{/if}
			</span>
		</button>
	{/each}

	{#if messages.length === 0}
		<p class="empty">{loading ? 'Loading…' : 'Nothing here.'}</p>
	{/if}
</div>

<style>
	.list {
		overflow-y: auto;
		min-height: 0;
		height: 100%;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.row {
		display: grid;
		gap: 0.15rem;
		width: 100%;
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 0.55rem 0.65rem;
		color: var(--text);
	}

	.row:hover {
		background: var(--bg-hover);
	}

	.row.selected {
		background: var(--bg-raised);
		border-color: var(--line);
	}

	.line1 {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: transparent;
		flex: none;
	}

	.row.unread .dot {
		background: var(--accent);
	}

	.from {
		font-size: 0.9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row.unread .from {
		font-weight: 650;
	}

	.date {
		margin-left: auto;
		font-size: 0.75rem;
		color: var(--faint);
		white-space: nowrap;
	}

	.subject {
		font-size: 0.86rem;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding-left: calc(7px + 0.45rem);
	}

	.row.unread .subject {
		color: var(--text);
	}

	.line3 {
		display: flex;
		gap: 0.35rem;
		align-items: center;
		font-size: 0.72rem;
		color: var(--faint);
		padding-left: calc(7px + 0.45rem);
	}

	.flag {
		color: var(--accent);
	}

	.empty {
		margin: 2rem 1rem;
		color: var(--faint);
		font-size: 0.9rem;
		text-align: center;
	}
</style>
