<script lang="ts">
	// The session screen: what an operator chooses before a radio session is
	// started, and the gateway list that fills those choices in.
	//
	// Two controls at the top decide what the list can even contain — the modem
	// (the digital mode) and the band — and the mode control is the same one the
	// session itself uses, so there is no second dropdown to keep in step. The
	// three things a session actually needs are then the gateway callsign, the
	// dial frequency in hertz, and that mode.
	import { onMount } from 'svelte';
	import {
		modemDrivesMode,
		modemKindInfo,
		type GatewayChannelView,
		type GatewayList,
		type Modem,
		type ModemKind,
		type SessionOptions,
		type SessionTestResponse,
		type Transceiver
	} from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';
	import { bandContains } from '@rfmail/shared';
	import {
		dialNumber,
		dialUnitFor,
		dialUnitForBand,
		formatDial,
		isDial,
		parseDial,
		type DialUnit
	} from '../dial';

	let options = $state<SessionOptions | null>(null);
	let modems = $state<Modem[]>([]);
	/**
	 * The modem last used for each digital mode, so a station that runs VARA through
	 * XARA keeps choosing XARA rather than falling back to VARA every time.
	 */
	let modemMemory = $state<Record<string, number>>(readModemMemory());
	let radios = $state<Transceiver[]>([]);
	/** Which modems answer on their command port right now. */
	let runningModems = $state<Record<number, boolean>>({});
	let modemId = $state<number | null>(null);
	let modem = $state<ModemKind>('ardop');
	let band = $state<string>('40m');
	let sort = $state<'quality' | 'distance' | 'callsign'>('quality');
	/** Emergency-only stations are never listed by accident: the box starts unticked. */
	let emcomm = $state(false);

	let callsign = $state('');
	/** The dial is held in hertz; the input shows it in kHz or MHz (dial.ts). */
	let frequencyHz = $state<number | null>(null);
	let frequencyText = $state('');
	let typedUnit = $state<DialUnit>('kHz');

	let list = $state<GatewayList | null>(null);
	/** The connect test's state: null before the first run. */
	let test = $state<{ state: 'calling' | 'done'; response: SessionTestResponse | null; error: string } | null>(
		null
	);
	let loading = $state(false);
	let error = $state('');

	onMount(() => void loadOptions());

	function readModemMemory(): Record<string, number> {
		try {
			const stored = localStorage.getItem('rfmail.modemForMode');
			const parsed: unknown = stored ? JSON.parse(stored) : {};
			return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
		} catch {
			return {};
		}
	}

	function rememberModem(mode: ModemKind, id: number): void {
		modemMemory = { ...modemMemory, [mode]: id };
		try {
			localStorage.setItem('rfmail.modemForMode', JSON.stringify(modemMemory));
		} catch {
			// A browser that refuses storage costs the convenience, not the session.
		}
	}

	async function loadOptions(): Promise<void> {
		try {
			const [session, configured, rigs] = await Promise.all([
				api.sessionOptions(),
				api.modems(),
				api.transceivers()
			]);
			options = session;
			modems = configured;
			radios = rigs;
			const status = await api.modemStatus().catch(() => null);
			runningModems = status
				? Object.fromEntries(status.statuses.map((entry) => [entry.id, entry.running]))
				: {};
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not load the session options.';
		}
	}

	async function loadGateways(refresh = false): Promise<void> {
		loading = true;
		error = '';
		try {
			list = await api.gateways({ modem, band, sort, limit: 60, refresh, emcomm });
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not read the gateway list.';
			list = null;
		} finally {
			loading = false;
		}
	}

	/** The unit shown is the one being typed in; it follows the band and the pick. */
	const unit = $derived<DialUnit>(typedUnit);

	function pick(channel: GatewayChannelView): void {
		callsign = channel.callsign;
		pickedMode = channel.mode;
		test = null;
		frequencyHz = channel.frequencyHz;
		frequencyText = dialNumber(channel.frequencyHz);
		typedUnit = dialUnitFor(channel.frequencyHz);
		band = channel.band;
		if (channel.family === 'vara-fm') modem = 'vara-fm';
		else if (channel.family === 'ardop') modem = 'ardop';
		else if (channel.family === 'vara') modem = modem === 'xara' ? 'xara' : 'vara';
	}

	/** Typing sets the hertz value; the text is left alone so the caret stays put. */
	function onFrequencyInput(): void {
		const parsed = parseDial(frequencyText, unit);
		frequencyHz = parsed ? parsed.hz : null;
		if (parsed) typedUnit = parsed.unit;
	}

	/**
	 * A band change switches the unit, and drops a frequency that belonged to the
	 * band we left — 7053.5 kHz is not a 20 m dial, so keeping it would be a lie.
	 */
	function onBandChange(): void {
		typedUnit = dialUnitForBand(band);
		// Above 144 MHz there is no estimate to order by, so the order falls back to
		// distance instead of sorting by a column that is not shown.
		if ((band === '2m' || band === '70cm') && sort === 'quality') sort = 'distance';
		if (frequencyHz !== null && !bandContains(band, frequencyHz)) {
			frequencyHz = null;
			frequencyText = '';
		} else if (frequencyHz !== null) {
			frequencyText = dialNumber(frequencyHz, typedUnit);
		}
		void loadGateways();
	}

	function readouts(): { callsign: boolean; frequency: boolean } {
		return {
			callsign: /^[A-Za-z0-9]{3,10}([-/][A-Za-z0-9]{1,3})?$/.test(callsign.trim()),
			frequency: isDial(frequencyHz)
		};
	}

	/**
	 * The configured modems that can run this digital mode. VARA and XARA speak the
	 * same interface, so either runs a VARA session; nothing else is interchangeable.
	 */
	const compatibleModems = $derived(
		modems.filter((entry) => entry.enabled && modemDrivesMode(entry.kind, modem))
	);

	const chosenModem = $derived(compatibleModems.find((entry) => entry.id === modemId) ?? null);

	/** Whether the chosen modem is listening; null while the answer is unknown. */
	const chosenRunning = $derived(
		chosenModem === null ? null : (runningModems[chosenModem.id] ?? null)
	);

	/** `VARA 40m, @TS-590SG : PKTUSB` — what the modem is, on which radio, in which mode. */
	function modemLabel(entry: Modem): string {
		const radio = radios.find((candidate) => candidate.id === entry.transceiverId);
		const where = radio ? `, @${radio.name}` : '';
		return `${entry.name}${where} : ${entry.rigMode}`;
	}

	// A mode change can leave the chosen modem unable to work it. Then the modem last
	// used for this mode wins, and only if that one is gone does the first compatible
	// one take over — so the field is never quietly wrong and never forgets the habit.
	$effect(() => {
		if (compatibleModems.length === 0) {
			if (modemId !== null) modemId = null;
			return;
		}
		if (compatibleModems.some((entry) => entry.id === modemId)) return;
		const remembered = modemMemory[modem];
		const candidate =
			compatibleModems.find((entry) => entry.id === remembered) ?? compatibleModems[0]!;
		modemId = candidate.id;
	});

	const ready = $derived({ ...readouts(), modem: chosenModem !== null });

	/** The catalogue mode string of the picked row, for the dial's bandwidth. */
	let pickedMode = $state<string | null>(null);

	/**
	 * The connect test. It tunes the radio, dials the gateway, reports what the modem
	 * said, and hangs up — there is no FBB exchange behind this yet.
	 */
	async function runTest(): Promise<void> {
		if (!chosenModem || !isDial(frequencyHz)) return;
		test = { state: 'calling', response: null, error: '' };
		try {
			const response = await api.testSession({
				modemId: chosenModem.id,
				target: callsign.trim().toUpperCase(),
				frequencyHz: frequencyHz!,
				bandwidthHz: pickedMode ? bandwidthOfMode(pickedMode) : undefined
			});
			test = { state: 'done', response, error: '' };
		} catch (err) {
			test = {
				state: 'done',
				response: null,
				error: err instanceof ApiRequestError ? err.message : 'The connect test failed.'
			};
		}
	}

	function bandwidthOfMode(mode: string): number {
		const number = /(\d{3,4})/.exec(mode);
		if (number) return Number(number[1]);
		const lower = mode.toLowerCase();
		if (lower.startsWith('vara fm')) return 1200;
		if (lower.startsWith('ardop')) return 2000;
		return 2300;
	}

	/**
	 * At 144 MHz and above the path is line of sight: band-against-distance and
	 * "will the gateway answer" say nothing about whether a signal gets through, so
	 * the two estimates are hidden rather than shown at a meaningless value.
	 */
	const showEstimates = $derived(
		band !== '2m' &&
			band !== '70cm' &&
			(list === null || list.channels.length === 0 || list.channels.some((channel) => channel.frequencyHz < 144_000_000))
	);
	const placeholder = $derived(
		unit === 'kHz' ? '7053.5' : band === '2m' || band === '70cm' || band === '6m' ? '144.8750' : '14.1096'
	);

	function sourceLine(): string {
		if (!list) return '';
		if (list.error) return `The catalogue could not be reached (${list.error}); showing ${list.stale ? 'what was cached earlier' : 'nothing'}.`;
		const when = list.fetchedAt ? new Date(list.fetchedAt).toLocaleString() : 'unknown';
		const how = list.source === 'network' ? 'downloaded' : list.source === 'cache' ? 'from cache' : 'unavailable';
		return `${list.total} channels match · ${how} ${when}`;
	}
</script>

<section class="session">
	<header class="head">
		<div>
			<h2>Session</h2>
			<p class="lede">
				A session moves queued mail between this station and one RMS gateway. Choose the modem and the band,
				then name the gateway — or take one from the list.
			</p>
		</div>
	</header>

	{#if error}
		<p class="alert" role="alert">{error}</p>
	{/if}

	<form class="panel" onsubmit={(event) => event.preventDefault()}>
		<div class="row">
			<label class="field">
				<span>Digital mode</span>
				<select bind:value={modem} onchange={() => void loadGateways()}>
					{#each options?.modems ?? [] as entry (entry.kind)}
						<option value={entry.kind}>{entry.label}</option>
					{/each}
				</select>
			</label>

			<label class="field short">
				<span>Band</span>
				<select bind:value={band} onchange={onBandChange}>
					<option value="any">any</option>
					{#each options?.bands ?? [] as name (name)}
						<option value={name}>{name}</option>
					{/each}
				</select>
			</label>

			<label class="field modem">
				<span>Modem</span>
				<select
					bind:value={modemId}
					onchange={() => {
						if (modemId !== null) rememberModem(modem, modemId);
					}}
				>
					{#each compatibleModems as entry (entry.id)}
						<option value={entry.id}>
							{modemLabel(entry)}{runningModems[entry.id] === false ? ' — not running' : ''}
						</option>
					{/each}
					{#if chosenModem && chosenRunning === false}
			<p class="warn">
				{chosenModem.name} is configured but nothing is listening on
				{chosenModem.host}:{chosenModem.commandPort ?? '?'} — start it before a session.
			</p>
		{:else if compatibleModems.length === 0}
						<option value={null}>— none configured —</option>
					{/if}
				</select>
			</label>
		</div>

		{#if chosenModem && chosenRunning === false}
			<p class="warn">
				{chosenModem.name} is configured but nothing is listening on
				{chosenModem.host}:{chosenModem.commandPort ?? '?'} — start it before a session.
			</p>
		{:else if compatibleModems.length === 0}
			<p class="warn">
				No {modemKindInfo(modem).label} modem is configured — add one on the Modems page.
			</p>
		{/if}

		<div class="row">
			<label class="field narrow">
				<span>Target RMS gateway</span>
				<input
					class="call"
					bind:value={callsign}
					placeholder="OK0N"
					maxlength="10"
					autocomplete="off"
					spellcheck="false"
					title="Callsign of the gateway, up to six characters plus an SSID"
				/>
			</label>

			<label class="field narrow">
				<span>Dial frequency ({unit})</span>
				<input
					class="dial"
					bind:value={frequencyText}
					oninput={onFrequencyInput}
					placeholder={placeholder}
					inputmode="decimal"
					autocomplete="off"
				/>
			</label>
		</div>

		<p class="hint">
			{#if isDial(frequencyHz)}
				{formatDial(frequencyHz!)} — the carrier the receiver is tuned to
				{band === 'any' ? '' : `on ${band}`}.
			{:else}
				Below 10 MHz the dial is written in kilohertz (7053.5), from 10 MHz upwards in megahertz (14.1096).
			{/if}
		</p>

		<div class="actions">
			<button class="btn" type="button" onclick={() => void loadGateways()}>
				{list ? 'Refresh list' : 'Find gateways'}
			</button>
			<button
				class="btn primary"
				type="submit"
				disabled={!ready.callsign || !ready.frequency || !ready.modem || test?.state === 'calling'}
				onclick={() => void runTest()}
			>
				{test?.state === 'calling' ? 'Calling…' : 'Start session'}
			</button>
			<span class="blocked">
				This is a connect test: the radio is tuned, the modem dials, the answer is reported and the link is
				dropped again. The mail exchange over that link comes later.
			</span>
		</div>
	</form>

	{#if test}
		<section class="report" class:calling={test.state === 'calling'} class:ok={test.response?.result === 'connected'} class:bad={test.state === 'done' && (test.error !== '' || (test.response && test.response.result !== 'connected'))}>
			{#if test.state === 'calling'}
				<p class="verdict">
					Calling {callsign.trim().toUpperCase()} on {formatDial(frequencyHz!)} through {chosenModem?.name}…
				</p>
				<p class="detail">The modem is transmitting. This can take up to a minute; then the link is dropped again.</p>
			{:else if test.response}
				<p class="verdict">
					{#if test.response.result === 'connected'}
						Connected to {callsign.trim().toUpperCase()}
					{:else if test.response.result === 'failed'}
						No connection
					{:else if test.response.result === 'cancelled'}
						Cancelled
					{:else}
						The connect test failed
					{/if}
				</p>
				<p class="detail">
					{test.response.message} · {Math.round(test.response.elapsedMs / 100) / 10} s ·
					{test.response.modemName}{test.response.transceiverName ? ` via ${test.response.transceiverName}` : ''}
					{test.response.rig ? ` · radio on ${formatDial(test.response.rig.frequencyHz)} ${test.response.rig.mode}` : ''}
				</p>
				{#if test.response.result === 'connected'}
					<p class="detail">
						The link was dropped again, as intended: nothing was exchanged. Bandwidth reported:
						{test.response.bandwidthHz} Hz.
					</p>
				{/if}
				<details class="log">
					<summary>What the modem said ({test.response.log.length} lines)</summary>
					<pre>{test.response.log.join('\n')}</pre>
				</details>
			{:else}
				<p class="verdict">The connect test did not run</p>
				<p class="detail">{test.error}</p>
			{/if}
		</section>
	{/if}

	{#if list}
		<div class="list-head">
			<h3>RMS gateways</h3>
			<div class="order">
				<label class="inline check" title="Stations open for emergency traffic only, in addition to the ordinary ones">
					<input type="checkbox" bind:checked={emcomm} onchange={() => void loadGateways()} />
					<span>EMCOMM stations</span>
				</label>
				<label class="inline">
					<span>Order</span>
					<select bind:value={sort} onchange={() => void loadGateways()}>
						{#if showEstimates}
							<option value="quality">estimate (Rel × Qual)</option>
						{/if}
						<option value="distance">distance</option>
						<option value="callsign">callsign</option>
					</select>
				</label>
				<button class="btn ghost small" type="button" onclick={() => void loadGateways(true)} disabled={loading}>
					{loading ? 'Fetching…' : 'Ask Winlink again'}
				</button>
			</div>
		</div>

		<p class="hint">
			{sourceLine()}
			{#if !list.origin}
				· No grid square on this account, so distances are unknown — set it on the Account page.
			{/if}
		</p>

		<table class="grid">
			<thead>
				<tr>
					<th>Gateway</th>
					<th class="num">Frequency</th>
					<th>Locator</th>
					<th>Mode</th>
					<th>Hours</th>
					<th class="num" title="Distance in kilometres from your WW-Locator">km</th>
					<th class="num">Bearing</th>
					{#if showEstimates}
						<th class="num" title="Link Reliability">Rel</th>
						<th class="num" title="Link Quality">Qual</th>
					{/if}
				</tr>
			</thead>
			<tbody>
				{#each list.channels as channel (channel.callsign + channel.frequencyHz + channel.mode)}
					<tr class:closed={!channel.openNow} onclick={() => pick(channel)} title="Use this channel">
						<td class="mono strong">{channel.callsign}</td>
						<td class="num mono">{formatDial(channel.frequencyHz)}</td>
						<td class="mono dim">{channel.gridsquare || '—'}</td>
						<td>
							{channel.mode}
							{#if channel.serviceCode !== 'PUBLIC'}
								<span
									class="svc"
									class:emcomm={channel.serviceCode === 'EMCOMM'}
									title={channel.serviceCode === 'EMCOMM'
										? 'Open for emergency traffic only'
										: `The gateway lists this channel under service code ${channel.serviceCode}`}
								>
									({channel.serviceCode})
								</span>
							{/if}
						</td>
						<td class="mono dim">{channel.hours}</td>
						<td class="num">{channel.distanceKm === null ? '—' : channel.distanceKm}</td>
						<td class="num dim">{channel.bearingDeg === null ? '—' : `${channel.bearingDeg}°`}</td>
						{#if showEstimates}
							<td class="num" class:low={channel.reliability < 0.35}>{channel.reliability.toFixed(2)}</td>
							<td class="num" class:low={channel.quality < 0.45}>{channel.quality.toFixed(2)}</td>
						{/if}
					</tr>
				{:else}
					<tr>
						<td colspan={showEstimates ? 9 : 7} class="empty">
							{#if (band === '2m' || band === '70cm' || band === '6m') && modem !== 'vara-fm'}
								No {options?.modems.find((entry) => entry.kind === modem)?.label ?? modem} channel on {band}:
								the FM gateways there take VARA FM.
							{:else if modem === 'vara-fm'}
								No VARA FM channel on {band}: FM gateways sit on 6 m, 2 m and 70 cm.
							{:else}
								No channel matches this modem and band.
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		{#if list.channels.length > 0}
			<p class="hint footnote">
			{#if showEstimates}
				Winlink publishes no reliability or quality figure: its catalogue carries the callsign, frequency, grid
				square, modes, hours and claimed range, and nothing about propagation. Both columns are therefore our own
				estimates, each from one set of facts — <strong>Rel</strong> (link reliability) from when the gateway last
				reported and whether it is open now, <strong>Qual</strong> (link quality) from the band against the
				distance. Neither knows the hour of day or the solar flux; a VOACAP prediction replaces both. Rows in
				grey are outside their operating hours.
			{:else}
				At 144 MHz and above the path is line of sight, so no propagation estimate is offered — only distance and
					bearing, which are facts. Rows in grey are outside their operating hours.
				{/if}
			</p>
		{/if}
	{/if}
</section>

<style>
	.session {
		padding: 1rem 1.1rem 2rem;
		overflow: auto;
	}

	.head h2 {
		margin: 0 0 0.3rem;
		font-size: 1.05rem;
	}

	.lede {
		margin: 0;
		color: var(--muted);
		font-size: 0.84rem;
		max-width: 62ch;
	}

	.panel {
		margin: 1rem 0 1.4rem;
		padding: 0.9rem 1rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel);
		display: grid;
		gap: 0.7rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.8rem;
	}

	.field {
		display: grid;
		gap: 0.25rem;
		font-size: 0.78rem;
		color: var(--muted);
	}

	.field.short {
		max-width: 8em;
	}

	/* A mode name is short: `ARDOP`, `VARA HF`, `Mercury`. */
	.field:not(.short):not(.modem):has(select) {
		max-width: 11em;
	}

	/* `VARA 40m, @TS-590SG : PKTUSB` needs room. */
	.field.modem {
		min-width: 17em;
	}

	.field.narrow {
		max-width: none;
	}

	/* A callsign is six characters plus an SSID: nine em is room to spare. */
	.field input.call {
		max-width: 9em;
	}

	.field input.dial {
		max-width: 10em;
	}

	.field input,
	.field select {
		font: inherit;
		font-size: 0.9rem;
		color: var(--fg);
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 7px;
		padding: 0.4rem 0.5rem;
	}

	.hint {
		margin: 0;
		color: var(--muted);
		font-size: 0.76rem;
	}

	.footnote {
		margin-top: 0.5rem;
		max-width: 76ch;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.report {
		margin: 1rem 0 1.4rem;
		padding: 0.8rem 1rem;
		border: 1px solid var(--line);
		border-left-width: 4px;
		border-radius: 8px;
		background: var(--panel);
		max-width: 62ch;
	}

	.report.calling {
		border-left-color: var(--accent);
	}

	.report.ok {
		border-left-color: var(--ok, #2e7d32);
	}

	.report.bad {
		border-left-color: var(--danger);
	}

	.verdict {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
	}

	.detail {
		margin: 0.3rem 0 0;
		color: var(--muted);
		font-size: 0.8rem;
	}

	.log {
		margin-top: 0.5rem;
		font-size: 0.78rem;
		color: var(--muted);
	}

	.log pre {
		margin: 0.3rem 0 0;
		max-height: 12rem;
		overflow: auto;
		white-space: pre-wrap;
		font-size: 0.74rem;
	}

	.warn {
		color: var(--danger);
		font-style: normal;
		font-size: 0.74rem;
		max-width: 34ch;
	}

	.blocked {
		color: var(--muted);
		font-size: 0.74rem;
		max-width: 44ch;
	}

	.list-head {
		display: flex;
		align-items: baseline;
		justify-content: flex-start;
		gap: 1.3rem;
		margin-bottom: 0.4rem;
	}

	.list-head h3 {
		margin: 0;
		font-size: 0.9rem;
	}

	.order {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.inline {
		display: flex;
		align-items: baseline;
		gap: 0.35rem;
		font-size: 0.76rem;
		color: var(--muted);
	}

	.inline select {
		font: inherit;
		font-size: 0.8rem;
		color: var(--fg);
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 0.15rem 0.3rem;
	}

	/* Columns size to what they hold: a callsign is ten characters, a locator six,
	   a dial twelve. Stretching them across the window puts the numbers far from
	   their headings and reads worse, not better. */
	.grid {
		width: auto;
		border-collapse: collapse;
		font-size: 0.95rem;
		font-variant-numeric: tabular-nums;
	}

	.grid th {
		text-align: left;
		font-weight: 500;
		color: var(--muted);
		font-size: 0.74rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.32rem 0.5rem;
		border-bottom: 1px solid var(--line);
		white-space: nowrap;
	}

	.grid th:first-child,
	.grid td:first-child {
		padding-left: 0;
	}

	.grid td {
		padding: 0.28rem 0.5rem;
		border-bottom: 1px solid color-mix(in oklab, var(--line) 40%, transparent);
		white-space: nowrap;
	}

	.grid tbody tr {
		cursor: pointer;
	}

	.grid tbody tr:hover {
		background: var(--accent-soft);
	}

	.grid tr.closed {
		opacity: 0.4;
	}

	.num {
		text-align: right;
	}

	.mono {
		font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
	}

	.strong {
		font-weight: 600;
	}

	.dim {
		color: var(--muted);
	}

	.svc {
		color: var(--accent);
		font-size: 0.82em;
	}

	.svc.emcomm {
		color: var(--danger);
	}

	.inline.check {
		gap: 0.3rem;
	}

	.inline.check input {
		margin: 0;
	}

	.low {
		color: var(--danger);
	}

	.empty,
	.alert {
		color: var(--muted);
	}

	.alert {
		color: var(--danger);
		margin: 0 0 0.6rem;
		font-size: 0.82rem;
	}

	@media (max-width: 760px) {
		.row {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
