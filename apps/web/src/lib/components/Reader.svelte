<script lang="ts">
	import type { MessageDetail } from '@rfmail/shared';
	import { api } from '../api/client';
	import { addressOnly, formatBytes, formatDateTime, senderName } from '../format';

	let {
		message,
		onreply,
		ondelete,
		onflag,
		onunread,
		onclose
	}: {
		message: MessageDetail | null;
		onreply: (message: MessageDetail) => void;
		ondelete: (message: MessageDetail) => void;
		onflag: (message: MessageDetail) => void;
		onunread: (message: MessageDetail) => void;
		onclose: () => void;
	} = $props();

	let showImages = $state(false);
	let showSource = $state(false);
	let currentId = $state<number | null>(null);

	// Reset the view switches when another message is opened. The effect reads
	// the message id and writes the two switches, never the id itself.
	$effect(() => {
		const id = message?.id ?? null;
		if (id !== currentId) {
			currentId = id;
			showImages = false;
			showSource = false;
		}
	});

	const recipients = $derived(
		message ? [...message.to, ...message.cc.map((cc) => `${cc} (cc)`)].map(addressOnly).join(', ') : ''
	);
	/**
	 * Which end of the message is the interesting one. An arriving message is from
	 * somebody; a message this station sent is to somebody, and its sender is always us —
	 * so the heading line is swapped rather than repeating this station's own address.
	 */
	const outgoing = $derived(message?.direction === 'out');

	const renderedHtml = $derived(
		message?.bodyHtml
			? showImages
				? message.bodyHtml.replaceAll('data-src="', 'src="')
				: message.bodyHtml
			: null
	);
</script>

<div class="reader-pane">
	{#if !message}
		<div class="placeholder">
			<p>Select a message.</p>
		</div>
	{:else}
		<header class="head">
			<button class="btn ghost back" type="button" onclick={onclose} aria-label="Back to the list">←</button>
			<div class="subject-block">
				<h2>{message.subject || '(no subject)'}</h2>
				<p class="meta">
					{#if outgoing}
						<strong>to {recipients || '—'}</strong>
					{:else}
						<strong>{senderName(message.from)}</strong>
						<span class="addr">&lt;{addressOnly(message.from)}&gt;</span>
					{/if}
					<span class="when">{formatDateTime(message.date)}</span>
				</p>
				<p class="meta small">
					{#if outgoing}
						from <span class="addr">{addressOnly(message.from)}</span>
					{:else}
						to {recipients || '—'}
					{/if}
					<span class="when">· {formatBytes(message.size)} · MID {message.mid}</span>
				</p>
			</div>
		</header>

		<div class="actions">
			<button class="btn" type="button" onclick={() => onreply(message)}>Reply</button>
			<button class="btn" type="button" onclick={() => onflag(message)}>
				{message.flagged ? 'Unflag' : 'Flag'}
			</button>
			<button class="btn" type="button" onclick={() => onunread(message)}>Mark unread</button>
			<a class="btn" href={api.rawUrl(message.id)} download>Download .eml</a>
			{#if message.bodyHtml}
				<button class="btn" type="button" onclick={() => (showImages = !showImages)}>
					{showImages ? 'Block images' : 'Show images'}
				</button>
				<button class="btn" type="button" onclick={() => (showSource = !showSource)}>
					{showSource ? 'Show formatted' : 'Plain text'}
				</button>
			{/if}
			<button class="btn danger" type="button" onclick={() => ondelete(message)}>Delete</button>
		</div>

		{#if message.attachments.length > 0}
			<ul class="attachments">
				{#each message.attachments as attachment (attachment.id)}
					<li>
						<a class="chip" href={api.attachmentUrl(message.id, attachment.id)} download={attachment.name}>
							<span class="name">{attachment.name}</span>
							<span class="size">{formatBytes(attachment.size)}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}

		{#if renderedHtml && !showSource}
			<!-- Sanitised on the server (sanitize-html whitelist): no scripts, no
			     event handlers, no javascript: URLs; images load only on request. -->
			<div class="html">{@html renderedHtml}</div>
		{:else}
			<pre class="body">{message.body}</pre>
		{/if}
	{/if}
</div>

<style>
	.reader-pane {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		overflow: hidden;
		background: var(--bg-panel);
		border-left: 1px solid var(--line);
	}

	.placeholder {
		display: grid;
		place-items: center;
		height: 100%;
		color: var(--faint);
		font-size: 0.9rem;
	}

	.head {
		display: flex;
		gap: 0.5rem;
		padding: 1rem 1.25rem 0.75rem;
		border-bottom: 1px solid var(--line);
	}

	.back {
		display: none;
		align-self: flex-start;
	}

	h2 {
		margin: 0 0 0.35rem;
		font-size: 1.15rem;
		line-height: 1.35;
	}

	.meta {
		margin: 0;
		font-size: 0.85rem;
		color: var(--muted);
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: baseline;
	}

	.meta.small {
		font-size: 0.78rem;
		color: var(--faint);
		margin-top: 0.2rem;
	}

	.addr,
	.when {
		color: var(--faint);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		padding: 0.6rem 1.25rem;
		border-bottom: 1px solid var(--line);
	}

	.btn.danger {
		color: var(--danger);
		margin-left: auto;
	}

	.attachments {
		list-style: none;
		margin: 0;
		padding: 0.7rem 1.25rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		border-bottom: 1px solid var(--line);
	}

	.chip {
		display: inline-flex;
		gap: 0.5rem;
		align-items: center;
		border: 1px solid var(--line);
		background: var(--bg-raised);
		border-radius: 999px;
		padding: 0.3rem 0.75rem;
		text-decoration: none;
		color: var(--text);
		font-size: 0.82rem;
	}

	.chip:hover {
		border-color: var(--accent);
	}

	.chip .size {
		color: var(--faint);
		font-size: 0.75rem;
	}

	.body {
		margin: 0;
		padding: 1.1rem 1.25rem 2rem;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		font: inherit;
		line-height: 1.6;
		min-height: 0;
	}

	.html {
		padding: 1.1rem 1.25rem 2rem;
		overflow: auto;
		min-height: 0;
		line-height: 1.6;
		font-size: 0.95rem;
		overflow-wrap: anywhere;
	}

	.html :global(img) {
		max-width: 100%;
		height: auto;
	}

	.html :global(a) {
		color: var(--accent);
	}

	.html :global(blockquote) {
		margin: 0.5rem 0;
		padding-left: 0.9rem;
		border-left: 3px solid var(--line);
		color: var(--muted);
	}

	.html :global(table) {
		border-collapse: collapse;
		max-width: 100%;
	}

	.html :global(td),
	.html :global(th) {
		border: 1px solid var(--line);
		padding: 0.25rem 0.5rem;
	}

	.html :global(pre),
	.html :global(code) {
		font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
		background: var(--bg);
		border-radius: 6px;
		padding: 0.1rem 0.3rem;
	}

	@media (max-width: 1000px) {
		.reader-pane {
			border-left: none;
		}

		.back {
			display: inline-flex;
		}
	}
</style>
