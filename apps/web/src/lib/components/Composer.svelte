<script lang="ts">
	import { onMount } from 'svelte';
	import type { MessageDetail } from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';
	import { addressOnly, formatBytes, quoteForReply } from '../format';

	let {
		replyTo,
		onclose,
		onsent
	}: {
		replyTo: MessageDetail | null;
		onclose: () => void;
		onsent: (message: MessageDetail) => void;
	} = $props();

	interface DraftAttachment {
		name: string;
		contentType: string;
		dataBase64: string;
		size: number;
	}

	let to = $state('');
	let cc = $state('');
	let subject = $state('');
	let body = $state('');

	onMount(() => {
		if (!replyTo) return;
		to = addressOnly(replyTo.from);
		subject = replyTo.subject.toLowerCase().startsWith('re:') ? replyTo.subject : `Re: ${replyTo.subject}`;
		body = quoteForReply(replyTo);
	});
	let attachments = $state<DraftAttachment[]>([]);
	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});

	const totalBytes = $derived(attachments.reduce((sum, item) => sum + item.size, 0));

	async function addFiles(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const files = input.files ? Array.from(input.files) : [];
		for (const file of files) {
			if (file.size > 8 * 1024 * 1024) {
				error = `${file.name} is larger than 8 MB`;
				continue;
			}
			const buffer = new Uint8Array(await file.arrayBuffer());
			let binary = '';
			for (const byte of buffer) binary += String.fromCharCode(byte);
			attachments = [
				...attachments,
				{
					name: file.name,
					contentType: file.type || 'application/octet-stream',
					dataBase64: btoa(binary),
					size: file.size
				}
			];
		}
		input.value = '';
	}

	function removeAttachment(index: number): void {
		attachments = attachments.filter((_, i) => i !== index);
	}

	async function send(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy) return;
		busy = true;
		error = '';
		fieldErrors = {};
		try {
			const created = await api.compose({
				to: to.trim(),
				cc: cc.trim(),
				subject: subject.trim(),
				body,
				attachments: attachments.map(({ name, contentType, dataBase64 }) => ({
					name,
					contentType,
					dataBase64
				}))
			});
			onsent(created);
		} catch (err) {
			if (err instanceof ApiRequestError) {
				fieldErrors = err.fields ?? {};
				error = Object.values(fieldErrors)[0] ?? err.message;
			} else {
				error = 'Could not send: the backend did not answer.';
			}
		} finally {
			busy = false;
		}
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') onclose();
	}}
/>

<div class="overlay" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
	<div class="panel" role="dialog" aria-modal="true" aria-labelledby="composer-title">
		<header>
			<h2 id="composer-title">{replyTo ? 'Reply' : 'New message'}</h2>
			<button class="btn ghost" type="button" onclick={onclose} aria-label="Close composer">✕</button>
		</header>

		<form onsubmit={send}>
			<label class="field">
				<span>To</span>
				<input type="text" name="to" bind:value={to} placeholder="CALLSIGN or name@example.org" />
			</label>
			{#if fieldErrors['to']}<p class="error">{fieldErrors['to']}</p>{/if}

			<label class="field">
				<span>Cc</span>
				<input type="text" name="cc" bind:value={cc} placeholder="optional" />
			</label>

			<label class="field">
				<span>Subject</span>
				<input type="text" name="subject" bind:value={subject} />
			</label>
			{#if fieldErrors['subject']}<p class="error">{fieldErrors['subject']}</p>{/if}

			<label class="field grow">
				<span>Message</span>
				<textarea name="body" bind:value={body} rows="12"></textarea>
			</label>

			<div class="attach-row">
				<label class="btn">
					Add attachment
					<input class="sr-only" type="file" multiple onchange={addFiles} />
				</label>
				<span class="muted small">{formatBytes(totalBytes)} attached</span>
			</div>

			{#if attachments.length > 0}
				<ul class="attachments">
					{#each attachments as attachment, index (attachment.name + index)}
						<li>
							<span>{attachment.name}</span>
							<span class="muted small">{formatBytes(attachment.size)}</span>
							<button class="btn ghost" type="button" onclick={() => removeAttachment(index)} aria-label="Remove {attachment.name}">✕</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if error}
				<p class="error" role="alert">{error}</p>
			{/if}

			<footer>
				<p class="hint muted small">
					Queued in OUTBOX. Radio delivery arrives in a later milestone; the message is stored now.
				</p>
				<button class="btn primary" type="submit" disabled={busy || !to.trim() || !subject.trim()}>
					{busy ? 'Saving…' : 'Queue for sending'}
				</button>
			</footer>
		</form>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgb(5 8 12 / 0.6);
		backdrop-filter: blur(3px);
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding: 4vh 1rem;
		z-index: 40;
		overflow-y: auto;
	}

	.panel {
		width: min(48rem, 100%);
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: 14px;
		box-shadow: var(--shadow);
		display: flex;
		flex-direction: column;
		max-height: 92vh;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.9rem 1.1rem;
		border-bottom: 1px solid var(--line);
	}

	h2 {
		margin: 0;
		font-size: 1rem;
		letter-spacing: 0.01em;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 1rem 1.1rem 1.1rem;
		overflow-y: auto;
	}

	.grow textarea {
		min-height: 12rem;
		font-family: ui-monospace, "SFMono-Regular", "Consolas", monospace;
		font-size: 0.9rem;
	}

	.attach-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.small {
		font-size: 0.78rem;
	}

	.attachments {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.attachments li {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.35rem 0.6rem;
		font-size: 0.85rem;
	}

	.attachments li .btn {
		margin-left: auto;
	}

	footer {
		position: sticky;
		bottom: -1.1rem;
		display: flex;
		align-items: center;
		gap: 1rem;
		border-top: 1px solid var(--line);
		padding: 0.9rem 0 0.2rem;
		margin-top: 0.2rem;
		background: var(--bg-panel);
	}

	.hint {
		margin: 0;
		flex: 1 1 auto;
	}
</style>
