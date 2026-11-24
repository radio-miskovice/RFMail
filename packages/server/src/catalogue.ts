// The Winlink gateway catalogue, and what a session needs from it.
//
// Winlink publishes every RMS gateway's status over HTTPS; pat calls it the same
// way (POST form parameters, a public access key the WDT issued for clients).
// Each gateway lists its channels: a frequency in Hz, a mode string ("ARDOP
// 2000", "VARA 2750", "VARA FM WIDE", "Packet 1200"), a grid square and the hours
// it is staffed.
//
// Three things are computed here and nowhere else:
//   * the band of a frequency, so the operator can pick "40 m" instead of typing
//     megahertz;
//   * the distance from the operator's grid square, which is a fact;
//   * an *estimate* of whether a session would work — clearly an estimate, built
//     from band-versus-distance plausibility, how recently the gateway reported
//     in, and whether it is open now. VOACAP replaces this later (R5.x); until
//     then the column is labelled as an estimate in the UI rather than dressed up
//     as a prediction.
//
// A modem is chosen before the catalogue is useful: ARDOP works ARDOP channels,
// VARA and XARA work VARA channels, VARA FM the FM ones. Data2G and Mercury have
// no catalogue listing at all — they speak the VARA and ARDOP interfaces — so the
// screen says that instead of inventing entries.

const CATALOGUE_URL = 'https://api.winlink.org/gateway/status.json';
/** Public key issued by the Winlink Development Team for clients (as in pat). */
const CATALOGUE_KEY = '1880278F11684B358F36845615BD039A';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 45_000;

import {
  bandOf,
  CATALOGUE_SERVICE_CODES,
  EMCOMM_SERVICE_CODE,
  MODEM_KINDS,
  modemKindInfo,
  type ModeFamily,
  type ModemKind
} from '@rfmail/shared';

export type { ModemKind };

/** Which catalogue mode strings each modem can operate (see @rfmail/shared). */
export const MODEM_FAMILIES: Record<ModemKind, ModeFamily[]> = Object.fromEntries(
  MODEM_KINDS.map((entry) => [entry.kind, entry.families]),
) as Record<ModemKind, ModeFamily[]>;

export const MODEM_LABELS: Record<ModemKind, string> = Object.fromEntries(
  MODEM_KINDS.map((entry) => [entry.kind, entry.label]),
) as Record<ModemKind, string>;

export interface GatewayChannel {
  callsign: string;
  /** The catalogue's own string, e.g. `VARA 2750`. */
  mode: string;
  family: ModeFamily;
  frequencyHz: number;
  band: string;
  gridsquare: string;
  /**
   * The catalogue service code the channel was listed under: `PUBLIC` for the
   * ordinary class, or the modem class (`XARA`, `MERCURY`, `DATA2G`) that the
   * gateway advertises it for. `EMCOMM` never reaches here: those stations are
   * open for emergency traffic only.
   */
  serviceCode: string;
  /** Kilometres from the operator's locator, or null when either is unknown. */
  distanceKm: number | null;
  /** Initial great-circle bearing in degrees from the operator, 0…359. */
  bearingDeg: number | null;
  hours: string;
  openNow: boolean;
  baud: string;
  radioRangeKm: number | null;
  lastStatus: string;
  hoursSinceStatus: number | null;
  /**
   * 0…1: will the path carry the data? Band against distance, nothing else — see
   * pathQuality(). VOACAP's signal margin replaces this.
   */
  quality: number;
  /**
   * 0…1: is the gateway likely to answer at all? Recency of its status report and
   * its opening hours — see gatewayReliability(). VOACAP's circuit reliability
   * replaces this.
   */
  reliability: number;
}

export interface CatalogueResult {
  channels: GatewayChannel[];
  fetchedAt: string;
  /** True when the answer came from a cache older than the refresh interval. */
  stale: boolean;
  /** Where the data came from, for the screen to be honest about it. */
  source: 'network' | 'cache' | 'none';
  error: string | null;
}

// -- bands (the table itself lives in @rfmail/shared) ---------------------

export { BAND_NAMES, bandOf } from '@rfmail/shared';

export function isVhfUhf(band: string): boolean {
  return band === '6m' || band === '2m' || band === '70cm';
}

// -- modes ---------------------------------------------------------------

export function familyOf(mode: string): ModeFamily {
  const text = mode.trim().toLowerCase();
  if (text.startsWith('ardop')) return 'ardop';
  if (text.startsWith('vara fm')) return 'vara-fm';
  if (text.startsWith('vara')) return 'vara';
  if (text.startsWith('pactor')) return 'pactor';
  if (text.startsWith('robust packet')) return 'robust-packet';
  if (text.startsWith('packet')) return 'packet';
  return 'other';
}

export function modemCanOperate(modem: ModemKind, mode: string): boolean {
  return MODEM_FAMILIES[modem].includes(familyOf(mode));
}

// -- geography -----------------------------------------------------------

/** Maidenhead locator to the centre of its square. */
export function gridsquareToLatLon(square: string): { lat: number; lon: number } | null {
  const text = square.trim().toUpperCase();
  const match = /^([A-R])([A-R])(\d{2})(?:([A-X])([A-X]))?$/.exec(text);
  if (!match) return null;
  const [, fieldLon, fieldLat, digits, subsquareLon, subsquareLat] = match;
  const lon = (fieldLon!.charCodeAt(0) - 65) * 20 - 180;
  const lat = (fieldLat!.charCodeAt(0) - 65) * 10 - 90;
  // The two digits are separate axes: the first is longitude, the second latitude.
  const lonSquare = Number(digits![0]) * 2;
  const latSquare = Number(digits![1]) * 1;
  let precisionLon = 0;
  let precisionLat = 0;
  let offsetLon = 0;
  let offsetLat = 0;
  if (subsquareLon && subsquareLat) {
    precisionLon = (subsquareLon.charCodeAt(0) - 65) * (2 / 24);
    precisionLat = (subsquareLat.charCodeAt(0) - 65) * (1 / 24);
    offsetLon = 2 / 48;
    offsetLat = 1 / 48;
  } else {
    offsetLon = 1;
    offsetLat = 0.5;
  }
  return { lat: lat + latSquare + precisionLat + offsetLat, lon: lon + lonSquare + precisionLon + offsetLon };
}

export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const radius = 6371;
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * radius * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Initial great-circle bearing from a to b, in whole degrees clockwise from north. */
export function bearingDeg(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return Math.round((degrees + 360) % 360) % 360;
}

// -- mode names, shortened for a table cell ------------------------------

// -- the estimates -------------------------------------------------------

/** Hours `HH-HH` in UTC; `00-23` is always open. */
export function isOpenNow(hours: string, now: Date): boolean {
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(hours.trim());
  if (!match) return true;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from === 0 && to === 23) return true;
  const hour = now.getUTCHours();
  return from <= to ? hour >= from && hour <= to : hour >= from || hour <= to;
}

/**
 * Will the path carry data? 0…1 from the band against the distance.
 *
 * Each band gets two distances: `near`, where the band is comfortably usable, and
 * `far`, past which it is hopeless. Between them the score fades linearly. This is
 * deliberately monotonic — a longer path is never better than a shorter one within
 * the same band — because a bell curve would rank the middle of a range above a
 * gateway ten kilometres away, which is not something we can defend. It is still a
 * guess about propagation: VOACAP's signal margin replaces it.
 */
const REACH: Record<string, [number, number]> = {
  '160m': [0, 400],
  '80m': [0, 900],
  '60m': [0, 1200],
  '40m': [0, 2500],
  '30m': [200, 4000],
  '20m': [400, 7000],
  '17m': [600, 9000],
  '15m': [800, 11_000],
  '12m': [1000, 11_000],
  '10m': [1000, 11_000],
  '6m': [60, 800],
  '2m': [30, 250],
  '70cm': [15, 100]
};

export function pathQuality(input: { band: string; distanceKm: number | null }): number {
  const reach = REACH[input.band];
  if (!reach) return 0.5;
  const distance = input.distanceKm;
  if (distance === null) return 0.5;
  const [near, far] = reach;
  if (distance <= near) return 1;
  if (distance >= far) return 0;
  return Math.round((1 - (distance - near) / (far - near)) * 100) / 100;
}

/**
 * Is the gateway likely to answer? 0…1 from facts about the gateway, not the
 * path: a channel closed at this hour scores nothing, and one that reported in an
 * hour ago scores near the top. VOACAP's circuit reliability replaces this when
 * the prediction is in.
 */
export function gatewayReliability(input: {
  hoursSinceStatus: number | null;
  openNow: boolean;
}): number {
  if (!input.openNow) return 0;
  if (input.hoursSinceStatus === null) return 0.5;
  // Reported in the last hour: near full marks; a day old: half; older: little.
  return Math.round((1 / (1 + input.hoursSinceStatus / 12)) * 100) / 100;
}

// -- fetching ------------------------------------------------------------

interface RawChannel {
  SupportedModes?: string;
  Frequency?: number;
  Gridsquare?: string;
  OperatingHours?: string;
  Baud?: string;
  RadioRange?: string;
  ServiceCode?: string;
}

export interface RawGateway {
  Callsign?: string;
  LastStatus?: string;
  HoursSinceStatus?: number;
  Latitude?: number;
  Longitude?: number;
  GatewayChannels?: RawChannel[];
}

export interface FetchOptions {
  /** Directory for the on-disk cache; null keeps it in memory only. */
  cacheDir?: string | null;
  /** Ignore the cache and download. */
  force?: boolean;
  /** Injected for tests. */
  fetcher?: typeof fetch;
  now?: Date;
  /** The operator's position, so every row carries its distance. */
  origin?: { lat: number; lon: number } | null;
}

export function parseCatalogue(text: string): RawGateway[] {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('catalogue is not an object');
  const gateways = (parsed as { Gateways?: unknown }).Gateways;
  if (!Array.isArray(gateways)) throw new Error('catalogue has no Gateways array');
  return gateways as RawGateway[];
}

/** Flattens gateways × channels into rows, adding everything computed above. */
export function toChannels(
  gateways: readonly RawGateway[],
  options: { origin?: { lat: number; lon: number } | null; now?: Date } = {},
): GatewayChannel[] {
  const now = options.now ?? new Date();
  const origin = options.origin ?? null;
  const channels: GatewayChannel[] = [];

  for (const gateway of gateways) {
    const callsign = (gateway.Callsign ?? '').trim().toUpperCase();
    if (!callsign) continue;
    const hoursSinceStatus =
      typeof gateway.HoursSinceStatus === 'number' && Number.isFinite(gateway.HoursSinceStatus)
        ? gateway.HoursSinceStatus
        : null;

    for (const channel of gateway.GatewayChannels ?? []) {
      const mode = (channel.SupportedModes ?? '').trim();
      const frequencyHz = Number(channel.Frequency ?? 0);
      if (!mode || !Number.isFinite(frequencyHz) || frequencyHz <= 0) continue;
      const serviceCode = (channel.ServiceCode ?? 'PUBLIC').toUpperCase();
      // Anything we did not ask for (EMCOMM above all) is not offered for routine
      // mail, so it never becomes a row.
      if (!CATALOGUE_SERVICE_CODES.includes(serviceCode)) continue;

      const band = bandOf(frequencyHz);
      const gridsquare = (channel.Gridsquare ?? '').trim().toUpperCase();
      const position = gridsquare ? gridsquareToLatLon(gridsquare) : null;
      const distance = origin && position ? distanceKm(origin, position) : null;
      const bearing = origin && position ? bearingDeg(origin, position) : null;
      const hours = (channel.OperatingHours ?? '00-23').trim();
      const openNow = isOpenNow(hours, now);
      const radioRange = Number(channel.RadioRange ?? Number.NaN);

      channels.push({
        callsign,
        mode,
        family: familyOf(mode),
        frequencyHz,
        band,
        gridsquare,
        serviceCode,
        distanceKm: distance,
        bearingDeg: bearing,
        hours,
        openNow,
        baud: (channel.Baud ?? '0').trim(),
        radioRangeKm: Number.isFinite(radioRange) && radioRange > 0 ? radioRange : null,
        lastStatus: (gateway.LastStatus ?? '').trim(),
        hoursSinceStatus,
        quality: pathQuality({ band, distanceKm: distance }),
        reliability: gatewayReliability({ hoursSinceStatus, openNow }),
      });
    }
  }
  return channels;
}

/** Filters and orders rows for one session attempt. */
export function selectChannels(
  channels: readonly GatewayChannel[],
  options: {
    modems?: readonly ModemKind[];
    band?: string | null;
    maxDistanceKm?: number | null;
    sort?: 'distance' | 'quality' | 'callsign';
    limit?: number;
    /** Include stations open only for emergency traffic. Never the default. */
    includeEmcomm?: boolean;
  } = {},
): GatewayChannel[] {
  const kinds = options.modems ?? [];
  const families = new Set<ModeFamily>();
  const codes = new Set<string>();
  for (const modem of kinds) {
    const info = modemKindInfo(modem);
    for (const family of info.families) families.add(family);
    for (const code of info.serviceCodes) codes.add(code);
  }

  let rows = channels.filter((channel) => {
    // A station open only for emergency traffic is offered only when asked for.
    if (channel.serviceCode === EMCOMM_SERVICE_CODE) {
      if (!options.includeEmcomm) return false;
      return kinds.length === 0 || families.has(channel.family);
    }
    // A channel listed under a modem's own service code belongs to that modem and to
    // nothing else: its mode string is usually ordinary VARA, so matching on the mode
    // would hand a Data2G channel to every VARA client on the air.
    if (channel.serviceCode !== 'PUBLIC') {
      return codes.has(channel.serviceCode);
    }
    // An ordinary channel is matched by what the modem's waveform can work. A modem
    // with no families — Data2G, Mercury — works no ordinary channel at all.
    return kinds.length === 0 || families.has(channel.family);
  });

  rows = rows.filter((channel) => {
    if (options.band && channel.band !== options.band) return false;
    if (options.maxDistanceKm !== null && options.maxDistanceKm !== undefined) {
      if (channel.distanceKm === null || channel.distanceKm > options.maxDistanceKm) return false;
    }
    return true;
  });

  const sort = options.sort ?? 'quality';
  rows = [...rows].sort((a, b) => {
    if (sort === 'callsign') return a.callsign.localeCompare(b.callsign);
    if (sort === 'distance') {
      const left = a.distanceKm ?? Number.POSITIVE_INFINITY;
      const right = b.distanceKm ?? Number.POSITIVE_INFINITY;
      if (left !== right) return left - right;
      return a.callsign.localeCompare(b.callsign);
    }
    // A gateway that cannot answer at this hour is useless however good the path.
    const score = (channel: GatewayChannel): number => channel.quality * channel.reliability;
    if (score(b) !== score(a)) return score(b) - score(a);
    return (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY);
  });

  return rows.slice(0, Math.max(1, options.limit ?? 50));
}

// Keyed by cache directory: two stations, or a test after a run, must not answer
// from each other's download. `codes` records which service classes the payload was
// fetched for, so widening the set (adding the emergency class) reloads rather than
// quietly serving a list that cannot contain what was asked for.
let memoryCache: {
  key: string;
  codes: string;
  text: string;
  gateways: RawGateway[];
  fetchedAt: number;
} | null = null;

const serviceCodeKey = (): string => CATALOGUE_SERVICE_CODES.join(',');

/**
 * Downloads the catalogue, or answers from the cache while it is fresh. A failed
 * download falls back to whatever the cache holds and says so, because a stale
 * gateway list is still better than an empty screen.
 */
export async function fetchCatalogue(options: FetchOptions = {}): Promise<CatalogueResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const fetcher = options.fetcher ?? fetch;
  const cacheDir = options.cacheDir ?? null;

  const cacheKey = cacheDir ?? '(memory)';
  const codes = serviceCodeKey();
  let cachedGateways: RawGateway[] | null = null;
  let cachedAt = 0;
  let cachedCodes = '';
  let source: CatalogueResult['source'] = 'none';

  if (memoryCache && memoryCache.key === cacheKey) {
    cachedGateways = memoryCache.gateways;
    cachedAt = memoryCache.fetchedAt;
    cachedCodes = memoryCache.codes;
    source = 'cache';
  } else if (cacheDir) {
    try {
      const { readFileSync } = await import('node:fs');
      cachedGateways = parseCatalogue(readFileSync(`${cacheDir}/gateway-status.json`, 'utf8'));
      cachedAt = Number(readFileSync(`${cacheDir}/gateway-status.fetched`, 'utf8')) || 0;
      try {
        cachedCodes = readFileSync(`${cacheDir}/gateway-status.codes`, 'utf8').trim();
      } catch {
        cachedCodes = '';
      }
      source = 'cache';
    } catch {
      cachedGateways = null;
    }
  }

  // A payload fetched for a narrower set of classes cannot answer for a wider one.
  const fresh = cachedGateways !== null && nowMs - cachedAt < CACHE_TTL_MS && cachedCodes === codes;
  if (fresh && cachedGateways && !options.force) {
    return {
      channels: toChannels(cachedGateways, { origin: options.origin ?? null, now }),
      fetchedAt: new Date(cachedAt).toISOString(),
      stale: false,
      source: 'cache',
      error: null,
    };
  }

  try {
    const body = new URLSearchParams({ Mode: 'AnyAll', key: CATALOGUE_KEY, HistoryHours: '6' });
    for (const code of CATALOGUE_SERVICE_CODES) body.append('ServiceCodes', code);
    const response = await fetcher(CATALOGUE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'rfmail/0.1',
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`catalogue answered HTTP ${response.status}`);
    const text = await response.text();
    const gateways = parseCatalogue(text);
    memoryCache = { key: cacheKey, codes, text, gateways, fetchedAt: nowMs };
    if (cacheDir) {
      try {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(`${cacheDir}/gateway-status.json`, text);
        writeFileSync(`${cacheDir}/gateway-status.fetched`, String(nowMs));
        writeFileSync(`${cacheDir}/gateway-status.codes`, codes);
      } catch {
        // A cache we cannot write is a slower start, not a failure.
      }
    }
    return {
      channels: toChannels(gateways, { origin: options.origin ?? null, now }),
      fetchedAt: now.toISOString(),
      stale: false,
      source: 'network',
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cachedGateways) {
      return {
        channels: toChannels(cachedGateways, { origin: options.origin ?? null, now }),
        fetchedAt: new Date(cachedAt).toISOString(),
        stale: true,
        source,
        error: message,
      };
    }
    return { channels: [], fetchedAt: '', stale: false, source: 'none', error: message };
  }
}
