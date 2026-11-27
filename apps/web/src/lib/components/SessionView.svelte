<script lang="ts">
	// The session screen: what an operator chooses before a radio session is
	// started, and the gateway list that fills those choices in.
	//
	// Two controls at the top decide what the list can even contain — the modem
	// (the digital mode) and the band — and the mode control is the same one the
	// session itself uses, so there is no second dropdown to keep in step. The
	// three things a session actually needs are then the gateway callsign, the
	// dial frequency in hertz, and that mode.
	import { onMount, tick, untrack } from 'svelte';
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
		type SessionEvent,
		type SessionMode,
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
	/** How a remembered entry names the kind of session it ran (decision 50). */
	const SESSION_KIND_LABEL: Record<SessionMode, string> = { cms: 'GW', p2p: 'P2P', postoffice: 'PO' };
	/** The catalogue is a modal: it is a place to choose from and leave, not a second page. */
	let listDialog = $state<HTMLDialogElement | null>(null);
	let listOpen = $state(false);
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

	// The live view of a running session (decision 51): the modem's own words and the exchange's
	// lines, arriving over a WebSocket, in a modal that also carries the stop control.
	let sessionDialog = $state<HTMLDialogElement | null>(null);
	let liveBox = $state<HTMLOListElement | null>(null);
	/** One line of the feed. `·` is not a direction: it marks a line about the air itself. */
	type LiveLine = {
		kind: 'modem' | 'line';
		dir: '>' | '<' | '·';
		text: string;
		atMs: number;
		note?: boolean;
	};
	let live = $state<LiveLine[]>([]);
	/** Who the data lines are with: the station this session called, or plain PEER. */
	let livePeer = $state('PEER');
	let liveState = $state<{ state: string; detail: string | null } | null>(null);
	/** What the single control has done so far: nothing, a disconnect asked, or an abort. */
	let stopPhase = $state<'idle' | 'disconnecting' | 'aborted'>('idle');
	/** The transmitter: the modem says `PTT ON` when it keys and `PTT OFF` when it stops. */
	let onAir = $state(false);
	/** When the current transmission began, in the session's own milliseconds. */
	let transmitFrom = $state<number | null>(null);
	/** When the key last dropped: the start of a silence, if nothing breaks it (decision 54). */
	let idleFrom = $state<number | null>(null);
	let streamId = $state<string | null>(null);
	let socket: WebSocket | null = null;

	/** Opens the session's own modal. Called when a session starts, not by an effect: the
	 *  dialog is bound by then, and a screen that is not there to open is a bug worth seeing. */
	async function openSessionSheet(): Promise<void> {
		await tick();
		const dialog = sessionDialog;
		if (dialog && !dialog.open) dialog.showModal();
	}

	/** Adds a line where its own timestamp belongs, and keeps the tail short. */
	function insertLive(entry: LiveLine): void {
		const at = live.findIndex((other) => other.atMs > entry.atMs);
		const next = at < 0 ? [...live, entry] : [...live.slice(0, at), entry, ...live.slice(at)];
		live = next.slice(-400);
		void tick().then(() => {
			if (liveBox) liveBox.scrollTop = liveBox.scrollHeight;
		});
	}

	/** Opens the live view before the session starts, so nothing said is missed. */
	function openStream(id: string): void {
		socket?.close();
		try {
			const ws = new WebSocket(api.sessionStreamUrl(id));
			socket = ws;
			ws.onmessage = (message) => {
				let event: SessionEvent;
				try {
					event = JSON.parse(String(message.data)) as SessionEvent;
				} catch {
					return;
				}
				if (event.t === 'state') {
					liveState = { state: event.state, detail: event.detail };
					return;
				}
				if (event.t === 'end') return;

				// PTT is not something to read in a log: it is a lamp in the header, and one line
				// when the transmission ends saying how long it held the channel (decision 53).
				if (event.t === 'modem') {
					const ptt = /^PTT\s+(ON|OFF)\b/i.exec(event.text.trim());
					if (ptt) {
						if (ptt[1]!.toUpperCase() === 'ON') {
							// Nothing was said or sent while the key was down, but the silence after it
							// may be worth a line: a call that is listening, not talking.
							if (idleFrom !== null) {
								const waited = (event.atMs - idleFrom) / 1000;
								if (waited >= 0.1) {
									insertLive({
										kind: 'modem',
										dir: '·',
										text: `waiting ${waited.toFixed(1)} s`,
										atMs: idleFrom,
										note: true
									});
								}
								idleFrom = null;
							}
							onAir = true;
							transmitFrom = event.atMs;
						} else {
							onAir = false;
							if (transmitFrom !== null) {
								const held = Math.max(0, (event.atMs - transmitFrom) / 1000);
								insertLive({
									kind: 'modem',
									dir: '>',
									text: `TRANSMIT ${held.toFixed(1)} s`,
									atMs: transmitFrom,
									note: true
								});
								transmitFrom = null;
							}
							// The key is down and the air is the station's to listen to.
							idleFrom = event.atMs;
						}
						return;
					}
				}
				// Only traffic breaks the silence: data arriving from the peer, or a command sent
				// to the modem. The modem's own chatter — `MODE …`, `IAMALIVE` — is not a sign that
				// anything passed between the stations, and Data2G prints a `MODE` line after most
				// transmissions; counting those would hide the waits this line exists to show.
				if (event.t === 'hex' || event.t === 'line' || event.dir === '>') idleFrom = null;
				if (event.t === 'hex') {
					live = [
						...live.slice(-399),
						{
							kind: 'line',
							dir: event.dir,
							text: `${event.hex} … ${event.count} bytes`,
							atMs: event.atMs
						}
					];
					void tick().then(() => {
						if (liveBox) liveBox.scrollTop = liveBox.scrollHeight;
					});
					return;
				}
				// A long session says a great deal; the screen keeps the recent tail, and the
				// whole of it is still in the report that follows.
				live = [...live.slice(-399), { kind: event.t, dir: event.dir, text: event.text, atMs: event.atMs }];
				void tick().then(() => {
					if (liveBox) liveBox.scrollTop = liveBox.scrollHeight;
				});
			};
			ws.onclose = () => {
				if (socket === ws) socket = null;
			};
		} catch {
			/* no live view: the session runs all the same, only without a running commentary */
		}
	}

	/**
	 * The one control. The first press asks the modem to disconnect, which the far end sees as a
	 * normal end of link; a second press, while that is happening, cuts the link with no closing
	 * sequence — what an operator needs when the signal has gone and the repeats would take
	 * minutes to give up (decision 51).
	 */
	async function stopSession(): Promise<void> {
		const id = streamId;
		if (!id || session?.state !== 'running') return;
		try {
			stopPhase = (await api.stopSession(id)).phase;
		} catch (err) {
			error = err instanceof ApiRequestError ? err.message : 'the session did not take the request';
		}
	}

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

	/** Opens the catalogue over the screen, fetching it only when there is nothing to show. */
	async function openGateways(): Promise<void> {
		if (!canWinlink) return;
		listOpen = true;
		if (!list) await loadGateways();
	}

	/** Closing leaves whatever was chosen alone: the form behind is the truth. */
	function closeGateways(): void {
		listOpen = false;
	}

	// The dialog is opened and closed from state, so the button that opens it, the row that
	// picks, the close icon, Cancel and Escape all end in the same place.
	$effect(() => {
		const dialog = listDialog;
		if (!dialog) return;
		if (listOpen && !dialog.open) dialog.showModal();
		else if (!listOpen && dialog.open) dialog.close();
	});

	/** The gateways called before, as the server ranks them: most used first. */
	async function loadTargets(): Promise<void> {
		try {
			targets = (await api.sessionTargets()).targets;
		} catch {
			// A list of favourites is a convenience; a failed read costs nothing else.
		}
	}

	/**
	 * Fills the three choices from a gateway called before: the callsign, the dial, and the
	 * digital mode it answered on (decision 49). The band and the unit follow the dial the same
	 * way the catalogue's pick() sets them.
	 */
	function useTarget(target: SessionTarget): void {
		callsign = target.callsign;
		frequencyHz = target.frequencyHz;
		frequencyText = dialNumber(target.frequencyHz);
		typedUnit = dialUnitFor(target.frequencyHz);
		band = bandOf(target.frequencyHz);
		// Only a mode this station has a modem for can be put back in the form; an entry from
		// before modes were kept leaves the choice as it is.
		if (target.kind && options?.modems.some((entry) => entry.kind === target.kind)) {
			modem = target.kind;
		}
		// The kind of session is half of the choice too: a gateway is not a peer (decision 50).
		// A gateway or post-office session needs the Winlink password, so an account without
		// one keeps the peer-to-peer choice it is allowed to make.
		if (target.sessionMode && (target.sessionMode === 'p2p' || canWinlink)) {
			sessionMode = target.sessionMode;
		}
		pickedMode = null;
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
		// Choosing a channel is the reason the modal was opened; it closes behind the choice.
		closeGateways();
	}

	/** Waiting for the typing to settle before the catalogue is read again. */
	let gatewayTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleGateways(): void {
		if (gatewayTimer) clearTimeout(gatewayTimer);
		gatewayTimer = setTimeout(() => {
			gatewayTimer = null;
			void loadGateways();
		}, 350);
	}

	/**
	 * Typing sets the hertz value, and the band follows it: a 3597 kHz dial is an 80 m dial
	 * whatever the list was showing before, so the band field can no longer sit on 40 m while
	 * the form talks about 80 m. The text is left alone so the caret stays put.
	 *
	 * A number that lands in no band in the unit the field shows is read in the other one:
	 * `3597` in a megahertz field is 3597 MHz by the letter, and 3.597 MHz by the intent.
	 */
	function onFrequencyInput(): void {
		const typed = parseDial(frequencyText, unit);
		if (!typed) {
			frequencyHz = null;
			return;
		}
		let parsed = typed;
		if (bandOf(typed.hz) === 'unknown') {
			const other = parseDial(frequencyText, typed.unit === 'kHz' ? 'MHz' : 'kHz');
			if (other && bandOf(other.hz) !== 'unknown') parsed = other;
		}
		frequencyHz = parsed.hz;
		typedUnit = parsed.unit;

		const typedBand = bandOf(parsed.hz);
		if (typedBand !== 'unknown' && typedBand !== band) {
			band = typedBand;
			// Above 144 MHz there is no estimate to order by, so the order falls back to
			// distance instead of sorting by a column that is not shown.
			if ((band === '2m' || band === '70cm') && sort === 'quality') sort = 'distance';
			scheduleGateways();
		}
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

	// With one compatible modem the field shows one line, and that line is the choice: an
	// unpicked select whose only option is shown must not read as "no modem".
	const chosenModem = $derived(
		compatibleModems.find((entry) => entry.id === modemId) ?? compatibleModems[0] ?? null
	);

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
		// An id for this run's live view. Not `crypto.randomUUID`, which a page served over
		// plain HTTP to a LAN address does not get: the station is often opened that way.
		const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		livePeer = callsign.trim().toUpperCase() || 'PEER';
		streamId = id;
		live = [];
		liveState = null;
		stopPhase = 'idle';
		openStream(id);
		session = { state: 'running', response: null, error: '' };
		await openSessionSheet();
		try {
			const response = await api.runSession({
				modemId: chosenModem.id,
				mode: sessionMode,
				target: callsign.trim().toUpperCase(),
				frequencyHz: frequencyHz!,
				bandwidthHz: pickedMode ? bandwidthOfMode(pickedMode) : undefined,
				streamId: id
			});
			session = { state: 'done', response, error: '' };
			// The mailbox changed under the screen: let the folder list catch up.
			onSent?.();
		} catch (err) {
			session = {
				state: 'done',
				response: null,
				error: err instanceof ApiRequestError ? err.message : 'The session failed.'
			};
		} finally {
			// The sheet is a verdict now, not a running commentary: the stage starts over, and
			// nothing is on the air any more.
			onAir = false;
			transmitFrom = null;
			idleFrom = null;
			liveState = { state: 'done', detail: 'the session has ended' };
			stopPhase = 'idle';
			// A call that answered has just been counted; the ranking may have moved, and the
			// list of what this station calls is read from the store rather than remembered.
			void loadTargets();
			// The report is in hand; the socket has said what it had to say.
			const closing = socket;
			socket = null;
			setTimeout(() => closing?.close(), 500);
			streamId = null;
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
				{#each targets as target (target.callsign + target.frequencyHz + (target.kind ?? '') + (target.sessionMode ?? ''))}
					<button
						class="target"
						type="button"
						title={`${target.callsign} on ${formatDial(target.frequencyHz)}${target.kind ? `, ${modemKindInfo(target.kind).label}` : ''}${target.sessionMode ? `, ${SESSION_KIND_LABEL[target.sessionMode]}` : ''} — used ${target.uses}×`}
						onclick={() => useTarget(target)}
					>
						<strong>{target.callsign}</strong>
						<span class="target-freq">{formatDial(target.frequencyHz)}</span>
						{#if target.kind}<span class="target-mode">{modemKindInfo(target.kind).label}</span>{/if}
						{#if target.sessionMode}<span class="target-type">{SESSION_KIND_LABEL[target.sessionMode]}</span>{/if}
						{#if target.uses > 1}<span class="target-uses">{target.uses}×</span>{/if}
					</button>
				{/each}
			</div>
		{/if}

		<p class="sid">
			SID:
			<span class="mono">[{sessionMode === 'cms' ? WINLINK_CLIENT_IDENTITY : ownSid}-B2FHM$]</span>
		</p>

		<p class="hint">
			{#if isDial(frequencyHz)}
				{formatDial(frequencyHz!)} — the dial {band === 'any' ? '' : `on ${band}`}, 1.5 kHz below
				the AF carrier the gateway lists.
			{:else}
				Below 10 MHz the dial is written in kilohertz (3595.5), from 10 MHz upwards in megahertz (14.1096).
			{/if}
		</p>

		<div class="actions">
			{#if canWinlink}
				<button class="btn" type="button" onclick={() => void openGateways()}>
					{list ? 'Choose from the list' : 'Find gateways'}
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

	<dialog
		class="sheet running"
		bind:this={sessionDialog}
		oncancel={(event) => {
			// While the transmitter is up, the sheet is not a thing to dismiss by accident.
			if (session?.state === 'running') event.preventDefault();
		}}
		onclose={() => (session = null)}
		onclick={(event) => {
			// The sheet is dismissed by the backdrop, its close control, Escape or Close — but
			// not while the transmitter is up.
			if (event.target === sessionDialog && session?.state !== 'running') sessionDialog?.close();
		}}
	>
		<div class="sheet-head">
			<h3>
				{#if session?.state === 'running'}
					In session with {callsign.trim().toUpperCase()}
				{:else if session?.response?.result === 'complete'}
					Session complete
				{:else if session?.response?.result === 'aborted'}
					Session cancelled
				{:else if session?.response?.result === 'failed'}
					The session failed
				{:else}
					The session could not run
				{/if}
			</h3>
			<span class="onair" class:lit={onAir} title={onAir ? 'The transmitter is on the air' : 'The transmitter is idle'}>
				<span class="led" aria-hidden="true"></span>
				ON AIR
			</span>
			<span class="stage">
				{liveState?.detail ??
					(stopPhase === 'disconnecting'
						? 'disconnecting the link'
						: stopPhase === 'aborted'
							? 'aborting'
							: (liveState?.state ?? ''))}
			</span>
			{#if session?.state !== 'running'}
				<button class="sheet-close" type="button" aria-label="Close" title="Close" onclick={() => sessionDialog?.close()}>
					×
				</button>
			{/if}
		</div>

		<div class="sheet-body">
			{#if session?.state === 'running'}
				<p class="detail">
					{formatDial(frequencyHz!)} through {chosenModem?.name}. The modem is transmitting; the link is
					dropped at the end either way.
				</p>
			{:else if session?.response}
				<p class="detail">
					{session.response.message} · {Math.round(session.response.elapsedMs / 100) / 10} s ·
					{session.response.modemName}{session.response.transceiverName
						? ` via ${session.response.transceiverName}`
						: ''}
				</p>
				{#if session.response.dialResult !== 'connected'}
					<p class="detail">
						Not counted in Called before: the far end never answered, so this call says nothing
						about that station.
					</p>
				{/if}
				{#if session.response.remoteSid}
					<p class="detail">The far end identified itself as {session.response.remoteSid}.</p>
				{/if}
				{#if session.response.sent.length > 0}
					<p class="detail">
						Sent {session.response.sent.join(', ')} — {session.response.sent.length === 1 ? 'moved' : 'each moved'} to SENT.
					</p>
				{/if}
				{#if session.response.received.length > 0}
					<p class="detail">Received {session.response.received.join(', ')} — waiting in INBOX.</p>
				{/if}
				{#if session.response.deferred.length > 0}
					<p class="detail">Asked for again later, still in OUTBOX: {session.response.deferred.join(', ')}.</p>
				{/if}
				{#if session.response.failed.length > 0}
					<p class="detail">
						Arrived damaged: {session.response.failed.map((entry) => `${entry.mid} (${entry.reason})`).join('; ')}.
					</p>
				{/if}
			{:else if session?.error}
				<p class="detail">{session.error}</p>
			{/if}

			{#if live.length > 0}
				<ol class="live" bind:this={liveBox}>
					{#each live as event, index (index)}
						<li
							class:modem={event.kind === 'modem'}
							class:peer={event.kind !== 'modem'}
							class:recv={event.dir === '<'}
							class:out={event.dir === '>'}
							class:note={event.note === true}
						>
							<span class="at">{(event.atMs / 1000).toFixed(1)}</span>
							<span class="who">{event.kind === 'modem' ? 'MODEM' : livePeer}</span>
							<span class="dir">{event.dir}</span>
							<span class="text">{event.text}</span>
						</li>
					{/each}
				</ol>
			{:else if session?.state === 'running'}
				<p class="hint">Waiting for the modem to answer…</p>
			{/if}
		</div>

		<div class="sheet-foot">
			{#if session?.state === 'running'}
				<button
					class="btn"
					class:primary={stopPhase === 'idle'}
					class:danger={stopPhase !== 'idle'}
					type="button"
					title={stopPhase === 'idle'
						? 'Ask the modem to disconnect: the far end sees an end of link instead of a dead carrier'
						: 'Cut the link now: no closing sequence, no waiting for repeats'}
					onclick={() => void stopSession()}
				>
					{stopPhase === 'idle' ? 'Disconnect' : stopPhase === 'disconnecting' ? 'Abort' : 'Aborting…'}
				</button>
			{:else}
				<button class="btn primary" type="button" onclick={() => sessionDialog?.close()}>Close</button>
			{/if}
		</div>
	</dialog>

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

	{#if canWinlink}
		<dialog
			class="sheet gateways"
			bind:this={listDialog}
			onclose={() => (listOpen = false)}
			onclick={(event) => {
				// A click that lands on the backdrop, not on the sheet, means "leave".
				if (event.target === event.currentTarget) closeGateways();
			}}
		>
			<div class="sheet-head">
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
				<button class="sheet-close" type="button" aria-label="Close the gateway list" title="Close" onclick={closeGateways}>
					×
				</button>
			</div>

			<div class="sheet-body">
				{#if loading && !list}
					<p class="hint">Fetching the catalogue…</p>
				{:else if !list}
					<p class="hint">
						The catalogue could not be read{error ? `: ${error}` : ''}. Close this and name the gateway by hand.
					</p>
				{:else}
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
			</div>

			<div class="sheet-foot">
				<button class="btn" type="button" onclick={closeGateways}>Cancel</button>
			</div>
		</dialog>
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
		background: var(--bg-panel);
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

	/* The digital mode the entry was reached with, said quietly beside the dial. */
	.target-mode {
		color: var(--faint);
		font-size: 0.72rem;
	}

	/* …and the kind of session: a gateway, a peer, or the post office. */
	.target-type {
		color: var(--faint);
		font-size: 0.66rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
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

	/* What the station will call itself on the air: one line, no explanation. */
	.sid {
		margin: 0.6rem 0 0;
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

	/* ON AIR: the modem's PTT, shown instead of its two lines. */
	.onair {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		margin-left: auto;
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		color: var(--faint);
	}

	.onair .led {
		width: 0.65rem;
		height: 0.65rem;
		border-radius: 50%;
		border: 1px solid var(--line);
		background: var(--bg);
	}

	.onair.lit {
		color: #ff4444;
		font-weight: 700;
	}

	/* A lamp that is on is red, not "the theme's danger colour": red is what a keyed
	   transmitter looks like on a panel, and nothing else in the sheet is that colour. */
	.onair.lit .led {
		border-color: #ff0000;
		background: #ff0000;
		box-shadow: 0 0 6px #ff0000, 0 0 14px rgb(255 68 68 / 80%);
	}

	/* The running session says where it is, beside its title. */
	.stage {
		margin-left: auto;
		font-size: 0.74rem;
		color: var(--muted);
	}

	/* The live view: one line per thing said, the modem's words and the protocol's, in order. */
	.live {
		/* The data channel's two colours, distinct from the modem's grey. */
		--peer: #123c8c;
		--data-out: #1f7a3d;
		margin: 0.5rem 0 0;
		padding: 0.4rem 0.5rem;
		list-style: none;
		max-height: 45vh;
		overflow: auto;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg);
		font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
		font-size: 0.72rem;
		line-height: 1.45;
		/* The feed takes the height the sheet has; past that it scrolls. */
		flex: 1;
		min-height: 0;
		max-height: none;
	}

	.live li {
		display: grid;
		grid-template-columns: 3.2rem 6rem 1rem 1fr;
		gap: 0.5rem;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.live .at {
		color: var(--faint);
		text-align: right;
	}

	.live .who {
		color: var(--faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.live .dir {
		color: var(--accent);
	}

	.live li.modem .who {
		color: var(--muted);
	}

	/* The data channel is the traffic the operator came for: bold, blue when it arrives and
	   green when it goes. The command channel is machinery — its replies plain, its commands
	   in italic, and neither of them bold. */
	.live li.peer .who {
		font-weight: 700;
	}

	.live li.peer.recv .who,
	.live li.peer.recv .text,
	.live li.peer.recv .dir {
		color: var(--peer);
	}

	.live li.peer.out .who,
	.live li.peer.out .text,
	.live li.peer.out .dir {
		color: var(--data-out);
	}

	.live li.peer .text {
		font-weight: 700;
	}

	.live li.modem.out:not(.note) .text {
		font-style: italic;
	}

	.detail {
		margin: 0.3rem 0 0;
		color: var(--muted);
		font-size: 0.8rem;
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

	/* The catalogue comes up over the screen: choosing is the point, and leaving is one click. */
	.sheet {
		width: min(78rem, calc(100vw - 2rem));
		max-height: calc(100vh - 3rem);
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--bg-panel);
		color: var(--fg);
		overflow: auto;
	}

	/* The session's sheet is a frame, not a box that grows: it spans the session screen — from
	   under the app's 56px header to just above the bottom of the window — and hands the space
	   to the feed, which scrolls when it is full (decision 53). */
	/* `[open]` matters: a dialog that is not open is hidden by `display: none`, and a plain
	   class rule that sets `display: flex` would put the closed sheet on the page, over the
	   fields it belongs to. */
	.sheet.running[open] {
		inset: calc(56px + 1rem) 0 1rem 0;
		height: auto;
		max-height: none;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.sheet.running .sheet-head,
	.sheet.running .sheet-foot {
		position: static;
		flex: none;
	}

	.sheet.running .sheet-body {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.sheet::backdrop {
		background: rgb(0 0 0 / 45%);
	}

	.sheet-head {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.8rem;
		padding: 0.7rem 0.9rem;
		background: var(--bg-panel);
		border-bottom: 1px solid var(--line);
	}

	.sheet-head h3 {
		margin: 0;
		font-size: 0.95rem;
	}

	.sheet-head .order {
		margin-left: auto;
	}

	.sheet-close {
		font: inherit;
		font-size: 1.15rem;
		line-height: 1;
		width: 1.9rem;
		height: 1.9rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg);
		color: var(--muted);
		cursor: pointer;
	}

	.sheet-close:hover {
		color: var(--fg);
		border-color: var(--accent);
	}

	.sheet-body {
		padding: 0.2rem 0.9rem 0.6rem;
	}

	.sheet-foot .btn.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	.sheet-foot .btn.danger:hover {
		background: var(--bg-hover);
	}

	.sheet-foot {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0.6rem 0.9rem;
		background: var(--bg-panel);
		border-top: 1px solid var(--line);
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
