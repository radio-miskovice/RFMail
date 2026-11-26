<script lang="ts">
	// The session screen: what an operator chooses before a radio session is
	// started, and the gateway list that fills those choices in.
	//
	// Two controls at the top decide what the list can even contain — the modem
	// (the digital mode) and the band — and the mode control is the same one the
	// session itself uses, so there is no second dropdown to keep in step. The
	// three things a session actually needs are then the gateway callsign, the
	// dial frequency in hertz, and that mode.
	import { onMount, untrack } from 'svelte';
	import {
		dialFromCarrier,
		modemDrivesMode,
		modemForChannel,
		modemKindInfo,
		type GatewayChannelView,
		type GatewayList,
		type Me,
		type Modem,
		type ModemKind,
		type ModemStatus,
		type SessionOptions,
		type SessionRunResponse,
		type SessionTarget,
		type SessionTestResponse,
		type Transceiver
	} from '@rfmail/shared';
	import { api, ApiRequestError } from '../api/client';
	import { WINLINK_CLIENT_IDENTITY, bandContains, bandOf } from '@rfmail/shared';
	import { chooseSessionMode } from '../session-default';
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
	/** What each command port says it is, when it names itself. */
	let reportedModems = $state<Record<number, ModemStatus>>({});
	let modemId = $state<number | null>(null);
	let modem = $state<ModemKind>('ardop');
	let band = $state<string>('40m');
	let sort = $state<'quality' | 'distance' | 'callsign'>('quality');
	/** Emergency-only stations are never listed by accident: the box starts unticked. */
	let emcomm = $state(false);

	let callsign = $state('');
	/**
	 * What is on the far end. It changes what the session asks the peer for and which
	 * messages it may offer: a CMS routes for all of Winlink, a peer for itself alone,
	 * a post office for its own users.
	 */
	let sessionMode = $state<'cms' | 'p2p' | 'postoffice'>(
		untrack(() => (me.user.hasWinlinkPassword ? 'cms' : 'p2p')),
	);

	/**
	 * The client identity is the mode's, not the operator's: `cms` presents the type a CMS
	 * accepts, everything else this station's own name (decision 36).
	 */
	/** This station's own SID identity, shown with the mode's choice. */
	const ownSid = 'RF Mail-0.1';
	/** The dial is held in hertz; the input shows it in kHz or MHz (dial.ts). */
	let frequencyHz = $state<number | null>(null);
	let frequencyText = $state('');
	let typedUnit = $state<DialUnit>('kHz');

	let list = $state<GatewayList | null>(null);
	/** Gateways this station has called before, most used first (decision 44). */
	let targets = $state<SessionTarget[]>([]);
	/** The connect test's state: null before the first run. */
	let test = $state<{ state: 'calling' | 'done'; response: SessionTestResponse | null; error: string } | null>(
		null
	);
	/** The exchange's state: null before the first run. */
	let session = $state<{ state: 'running' | 'done'; response: SessionRunResponse | null; error: string } | null>(
		null
	);

	/** Told after an exchange, so the folder list behind the screen catches up. */
	let { onSent, me }: { onSent?: () => void; me: Me } = $props();

	/**
	 * A station with no Winlink password is non-WL: an RMS gateway challenges the caller,
	 * so a CMS would refuse the session (decision 21) and offering its channel list would
	 * only lead the operator into that refusal. Such an account gets no gateway list and no
	 * CMS session type; a peer-to-peer call to a station it names still works.
	 */
	const canWinlink = $derived(me.user.hasWinlinkPassword);
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

	/** The mode this browser chose last, or null when it has never chosen one. */
	function readLastMode(): ModemKind | null {
		try {
			const stored = localStorage.getItem('rfmail.sessionMode');
			return stored ? (stored as ModemKind) : null;
		} catch {
			return null;
		}
	}

	/** Remembered on every change, so a reopened browser starts where it left off. */
	function rememberMode(mode: ModemKind): void {
		try {
			localStorage.setItem('rfmail.sessionMode', mode);
		} catch {
			// As above: losing storage loses a convenience, not a session.
		}
	}

	/** The opening mode is decided once, after the modems and their ports are known. */
	let modeChosen = false;

	function chooseOpeningMode(): void {
		if (modeChosen) return;
		modeChosen = true;
		modem = chooseSessionMode({
			kinds: (options?.modems ?? []).map((entry) => entry.kind),
			modems,
			running: runningModems,
			saved: readLastMode()
		});
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
			void loadTargets();
			const status = await api.modemStatus().catch(() => null);
			runningModems = status
				? Object.fromEntries(status.statuses.map((entry) => [entry.id, entry.running]))
				: {};
			reportedModems = status
				? Object.fromEntries(status.statuses.map((entry) => [entry.id, entry]))
				: {};
			// A mode whose modem is listening beats a remembered one that is not; only when
			// nothing is listening does the browser's last choice decide.
			chooseOpeningMode();
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'Could not load the session options.';
		}
	}

	async function loadGateways(refresh = false): Promise<void> {
		if (!canWinlink) {
			// No password, no collection: nothing to ask Winlink for.
			list = null;
			return;
		}
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

	/** The gateways called before, as the server ranks them: most used first. */
	async function loadTargets(): Promise<void> {
		try {
			targets = (await api.sessionTargets()).targets;
		} catch {
			// A list of favourites is a convenience; a failed read costs nothing else.
		}
	}

	/**
	 * Fills the two fields from a gateway called before. The band, the unit and the dial are
	 * set the same way the catalogue's pick() sets them, so a favourite behaves like a channel
	 * that was chosen from the list rather than typed.
	 */
	function useTarget(target: SessionTarget): void {
		callsign = target.callsign;
		frequencyHz = target.frequencyHz;
		frequencyText = dialNumber(target.frequencyHz);
		typedUnit = dialUnitFor(target.frequencyHz);
		band = bandOf(target.frequencyHz);
		test = null;
	}

	function pick(channel: GatewayChannelView): void {
		callsign = channel.callsign;
		pickedMode = channel.mode;
		test = null;
		// The catalogue lists the AF carrier, 1500 Hz above the dial: a session tunes the
		// transceiver 1.5 kHz lower so the signal lands centred in the modem's passband.
		const dial = dialFromCarrier(channel.frequencyHz);
		frequencyHz = dial;
		frequencyText = dialNumber(dial);
		typedUnit = dialUnitFor(dial);
		band = channel.band;
		// The service code decides: `VARA (DATA2G)` is a Data2G channel, whatever the mode
		// string says, and picking it has to set Data2G or the session dials the wrong modem.
		modem = modemForChannel(channel.family, channel.serviceCode);
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

	/**
	 * What the modem's port reports. VARA, XARA, Data2G and Mercury share ports, so the
	 * status also says whether the program there is the kind this record claims — a mismatch
	 * makes the modem unavailable and the reason carries the rest.
	 */
	const chosenReport = $derived(chosenModem === null ? null : (reportedModems[chosenModem.id] ?? null));

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
		// The pair that is now in effect is the pair to open on next time, whether the
		// operator picked the modem or the mode change picked it for them.
		rememberModem(modem, candidate.id);
	});

	const ready = $derived({ ...readouts(), modem: chosenModem !== null });

	/** The catalogue mode string of the picked row, for the dial's bandwidth. */
	let pickedMode = $state<string | null>(null);

	/**
	 * The connect test: tune the radio, dial the gateway through the modem, report what
	 * the modem said and hang up. It proves the chain answers, nothing more.
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

	/**
	 * The session itself: the radio is tuned, the modem dials, the mail moves both ways
	 * and the link is dropped again. This is the one that keys the transmitter, so it
	 * carries what the exchange did, not just whether it dialled.
	 */
	async function runExchange(): Promise<void> {
		if (!chosenModem || !isDial(frequencyHz)) return;
		session = { state: 'running', response: null, error: '' };
		try {
			const response = await api.runSession({
				modemId: chosenModem.id,
				mode: sessionMode,
				target: callsign.trim().toUpperCase(),
				frequencyHz: frequencyHz!,
				bandwidthHz: pickedMode ? bandwidthOfMode(pickedMode) : undefined
			});
			session = { state: 'done', response, error: '' };
			// The mailbox changed under the screen: let the folder list catch up.
			onSent?.();
			// A gateway that answered has just been counted; the ranking may have moved.
			void loadTargets();
		} catch (err) {
			session = {
				state: 'done',
				response: null,
				error: err instanceof ApiRequestError ? err.message : 'The session failed.'
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
				{#if canWinlink}
					A session moves queued mail between this station and one RMS gateway. Choose the modem and the
					band, then name the gateway — or take one from the list.
				{:else}
					A session calls one station over the air. This account is non-WL, so it collects nothing from an
					RMS gateway: name the station you are calling and the session runs peer to peer.
				{/if}
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
				<select
					bind:value={modem}
					onchange={() => {
						rememberMode(modem);
						void loadGateways();
					}}
				>
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
						if (modemId !== null) {
							rememberModem(modem, modemId);
							rememberMode(modem);
						}
					}}
				>
					{#each compatibleModems as entry (entry.id)}
						<option value={entry.id}>
							{modemLabel(entry)}{runningModems[entry.id] === false ? ' — unavailable' : ''}
						</option>
					{/each}
					{#if compatibleModems.length === 0}
						<option value={null}>— none configured —</option>
					{/if}
				</select>
			</label>
		</div>

		{#if chosenModem && chosenRunning === false}
			<p class="warn">
				{chosenModem.name} is unavailable at {chosenModem.host}:{chosenModem.commandPort ?? '?'}
				{chosenReport?.error ? ` — ${chosenReport.error}.` : ' — start it before a session.'}
			</p>
		{:else if compatibleModems.length === 0}
			<p class="warn">
				No {modemKindInfo(modem).label} modem is configured — add one on the Modems page.
			</p>
		{/if}

		<div class="row">
			<label class="field narrow">
				<span>Target</span>
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

			<label class="field narrow">
				<span>Session type</span>
				<select bind:value={sessionMode}>
					{#if canWinlink}
						<option value="cms">Winlink RMS gateway</option>
					{/if}
					<option value="p2p">Peer to peer</option>
					{#if canWinlink}
						<option value="postoffice">Post office</option>
					{/if}
				</select>
			</label>
		</div>

		{#if targets.length > 0}
			<div class="targets" aria-label="Gateways called before">
				<span class="targets-label">Called before</span>
				{#each targets as target (target.callsign + target.frequencyHz)}
					<button
						class="target"
						type="button"
						title={`${target.callsign} on ${formatDial(target.frequencyHz)}, ${target.uses}×`}
						onclick={() => useTarget(target)}
					>
						<strong>{target.callsign}</strong>
						<span class="target-freq">{formatDial(target.frequencyHz)}</span>
						{#if target.uses > 1}<span class="target-uses">{target.uses}×</span>{/if}
					</button>
				{/each}
			</div>
		{/if}

		<div class="row">
			<p class="forced">
				Client identity:
				{#if sessionMode === 'cms'}
					<span class="mono">[{WINLINK_CLIENT_IDENTITY}-B2FHM$]</span> — the client type a Winlink CMS
					accepts; it refuses any other, so this one is fixed for gateway sessions. This station's own
					name, [{ownSid}-B2FHM$], is what it sends to a peer.
				{:else}
					<span class="mono">[{ownSid}-B2FHM$]</span> — this station's own name, which is what a peer
					reads. A Winlink gateway session would present the client type the CMS accepts instead.
				{/if}
			</p>
		</div>

		<p class="hint">
			{#if isDial(frequencyHz)}
				{formatDial(frequencyHz!)} — the dial {band === 'any' ? '' : `on ${band}`}, 1.5 kHz below
				the AF carrier the gateway lists.
			{:else}
				Below 10 MHz the dial is written in kilohertz (7053.5), from 10 MHz upwards in megahertz (14.1096).
			{/if}
		</p>

		<div class="actions">
			{#if canWinlink}
				<button class="btn" type="button" onclick={() => void loadGateways()}>
					{list ? 'Refresh list' : 'Find gateways'}
				</button>
			{/if}
			<button
				class="btn"
				type="button"
				disabled={!ready.callsign || !ready.frequency || !ready.modem || test?.state === 'calling' || session?.state === 'running'}
				onclick={() => void runTest()}
			>
				{test?.state === 'calling' ? 'Calling…' : 'Test the link'}
			</button>
			<button
				class="btn primary"
				type="submit"
				disabled={!ready.callsign || !ready.frequency || !ready.modem || session?.state === 'running' || test?.state === 'calling'}
				onclick={() => void runExchange()}
			>
				{session?.state === 'running' ? 'In session…' : 'Start session'}
			</button>
			<span class="blocked">
				Start session tunes the radio, dials, exchanges mail in both directions and hangs up. Test the link
				stops once the call comes up, for when the question is only whether the gateway answers.
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

	{#if session}
		<section
			class="report"
			class:calling={session.state === 'running'}
			class:ok={session.response?.result === 'complete'}
			class:bad={session.state === 'done' &&
				(session.error !== '' || (session.response !== null && session.response.result !== 'complete'))}
		>
			{#if session.state === 'running'}
				<p class="verdict">
					In session with {callsign.trim().toUpperCase()} on {formatDial(frequencyHz!)} through
					{chosenModem?.name}…
				</p>
				<p class="detail">
					The modem is transmitting. A session can take several minutes; the link is dropped at the end
					either way.
				</p>
			{:else if session.response}
				<p class="verdict">
					{#if session.response.result === 'complete'}
						Session complete
					{:else if session.response.result === 'failed'}
						The session failed
					{:else if session.response.result === 'aborted'}
						Session cancelled
					{:else}
						The session could not run
					{/if}
				</p>
				<p class="detail">
					{session.response.message} · {Math.round(session.response.elapsedMs / 100) / 10} s ·
					{session.response.modemName}{session.response.transceiverName
						? ` via ${session.response.transceiverName}`
						: ''}
				</p>
				{#if session.response.remoteSid}
					<p class="detail">The far end identified itself as {session.response.remoteSid}.</p>
				{/if}
				{#if session.response.sent.length > 0}
					<p class="detail">
						Sent {session.response.sent.join(', ')} — {session.response.sent.length === 1
							? 'moved'
							: 'each moved'} to SENT.
					</p>
				{/if}
				{#if session.response.received.length > 0}
					<p class="detail">
						Received {session.response.received.join(', ')} — waiting in INBOX.
					</p>
				{/if}
				{#if session.response.deferred.length > 0}
					<p class="detail">
						Asked for again later, still in OUTBOX: {session.response.deferred.join(', ')}.
					</p>
				{/if}
				{#if session.response.failed.length > 0}
					<p class="detail">
						Arrived damaged: {session.response.failed
							.map((entry) => `${entry.mid} (${entry.reason})`)
							.join('; ')}.
					</p>
				{/if}
				<details class="log">
					<summary>The exchange ({session.response.log.length} lines)</summary>
					<pre>{session.response.log.map((entry) => `${entry.direction} ${entry.text}`).join('\n')}</pre>
				</details>
				<details class="log">
					<summary>What the modem said while dialling ({session.response.dialLog.length} lines)</summary>
					<pre>{session.response.dialLog.join('\n')}</pre>
				</details>
			{:else}
				<p class="verdict">The session did not run</p>
				<p class="detail">{session.error}</p>
			{/if}
		</section>
	{/if}

	{#if !canWinlink}
		<div class="nonwl">
			<h3>No Winlink collection</h3>
			<p>
				This account is <strong>non-WL</strong>: no Winlink password is stored, so an RMS gateway
				would challenge the station and refuse the session. No gateway list is offered here. Add the
				Winlink password on the Account page to collect mail; a peer-to-peer call to a station whose
				callsign you name still works.
			</p>
		</div>
	{/if}

	{#if list && canWinlink}
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
					<th class="num" title="AF carrier frequency as the gateway publishes it; the dial is 1.5 kHz lower">AF carrier</th>
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

	/* The gateways called before: one compact button each, ranked by use. */
	.targets {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.35rem;
		margin: 0.55rem 0 0;
	}

	.targets-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--faint);
		margin-right: 0.15rem;
	}

	.target {
		display: inline-flex;
		align-items: baseline;
		gap: 0.35rem;
		font: inherit;
		font-size: 0.78rem;
		color: var(--fg);
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0.12rem 0.55rem;
		cursor: pointer;
	}

	.target:hover {
		border-color: var(--accent);
	}

	.target strong {
		font-weight: 600;
	}

	.target-freq {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.target-uses {
		font-size: 0.68rem;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
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

	/* The client identity a Winlink session will present, stated rather than chosen. */
	.forced {
		grid-column: 1 / -1;
		margin: 0;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg-raised);
		color: var(--muted);
		font-size: 0.78rem;
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

	/* The non-WL notice stands where the gateway list would be. */
	.nonwl {
		border: 1px solid var(--line);
		border-left: 3px solid var(--accent);
		border-radius: 8px;
		background: var(--bg-raised);
		padding: 0.7rem 0.85rem;
		margin: 0.8rem 0;
	}

	.nonwl h3 {
		margin: 0 0 0.35rem;
		font-size: 0.9rem;
	}

	.nonwl p {
		margin: 0;
		font-size: 0.82rem;
		color: var(--muted);
	}

	@media (max-width: 760px) {
		.row {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
