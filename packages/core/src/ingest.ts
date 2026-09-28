import type { OsmAndPing, OsmAndStatus, PingRejection } from '@q4413/shared';

/**
 * Traccar OsmAnd protocol decoding (R-01, R-03).
 *
 * Pure and runtime-agnostic (§6.5): it takes name/value pairs, whatever their
 * source. The Worker feeds it the query string and the POST body merged,
 * because Traccar Client sends either depending on platform and version, and
 * R-01 requires both to work.
 */

/** Parameters R-03 consumes. Everything else is kept in `attributes`. */
const CONSUMED = new Set([
  'id',
  'lat',
  'lon',
  'timestamp',
  'accuracy',
  'bearing',
  'speed',
  'batt',
  'is_moving',
  'activity',
  'event',
]);

/**
 * Three outcomes, not two.
 *
 * `STATUS` exists because Traccar Client posts a body with no coordinates every
 * time its location service starts, and calling that malformed wrote an
 * `INGEST_REJECTED` event that reads as a malfunction for what is routine — with
 * `MAX_EVENTS` at 500, enough of them evict the game's own history.
 *
 * The captured shape carries a push-token registration rather than the battery
 * this was first assumed to be salvaging (see OsmAndStatus). The battery is kept
 * when present because other builds send a shorter body that should carry one,
 * and dropping it would be the same mistake in the other direction.
 */
export type ParseResult =
  | { ok: true; kind: 'POSITION'; ping: OsmAndPing }
  | { ok: true; kind: 'STATUS'; status: OsmAndStatus }
  | { ok: false; rejection: PingRejection };

/**
 * Fix times arrive as Unix seconds per R-03, but Traccar Client builds have
 * also sent milliseconds and ISO 8601. Seconds are the documented case; the
 * others are recognised rather than silently turned into 1970 or a year 55000.
 */
function parseTimestamp(raw: string): number | null {
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    // Anything past ~2001 in ms is beyond any plausible seconds value.
    return numeric > 1e11 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseBool(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  return undefined;
}

/**
 * @param pairs   name/value pairs from the query string and the POST body
 * @param receivedAt server receive time in UTC ms — the only clock trusted (R-36)
 */
export function parseOsmAndPing(
  pairs: Iterable<readonly [string, string]>,
  receivedAt: number,
): ParseResult {
  const raw = new Map<string, string>();
  const attributes: Record<string, string> = {};

  for (const [key, value] of pairs) {
    const name = key.trim();
    if (CONSUMED.has(name)) {
      // Later pairs win: the body is merged after the query string, so a device
      // that sends both does not get the query's stale copy.
      raw.set(name, value);
    } else if (name.length > 0) {
      attributes[name] = value;
    }
  }

  const id = raw.get('id');
  if (id === undefined || id.trim() === '') {
    return { ok: false, rejection: { reason: 'MISSING_FIELD', field: 'id' } };
  }

  const numbers: Partial<Record<'lat' | 'lon' | 'accuracy' | 'bearing' | 'speed' | 'batt', number>> =
    {};
  for (const field of ['lat', 'lon', 'accuracy', 'bearing', 'speed', 'batt'] as const) {
    const value = raw.get(field);
    if (value === undefined || value.trim() === '') continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return { ok: false, rejection: { reason: 'BAD_NUMBER', field, value } };
    }
    numbers[field] = parsed;
  }

  // Numbers are parsed before this branch so a status report's `batt` is
  // validated exactly as a position's would be, rather than by a second path.
  const rawTimestamp = raw.get('timestamp');
  const ts = rawTimestamp ? parseTimestamp(rawTimestamp) : null;

  /**
   * Neither coordinate present is a **status report** (see OsmAndStatus): the
   * phone is announcing itself before it has a fix. An empty value counts as
   * absent, because `lat=&lon=` means the same thing as sending neither.
   *
   * The narrowness is deliberate. Exactly *one* of the pair missing is still
   * malformed and falls through to MISSING_FIELD below — a device that knows its
   * latitude and not its longitude is broken, not starting up, and treating that
   * as a status report would swallow a real protocol error.
   *
   * The fix time is read and dropped here for the same reason it is dropped for a
   * position: R-36 trusts no clock but the server's. It is parsed at all only
   * because R-03 requires recognising the three encodings.
   */
  if (numbers.lat === undefined && numbers.lon === undefined) {
    return {
      ok: true,
      kind: 'STATUS',
      status: {
        deviceId: id.trim(),
        receivedAt,
        ...(numbers.batt === undefined ? {} : { battery: numbers.batt }),
        attributes,
      },
    };
  }

  for (const field of ['lat', 'lon'] as const) {
    if (numbers[field] === undefined) {
      return { ok: false, rejection: { reason: 'MISSING_FIELD', field } };
    }
  }

  const lat = numbers.lat!;
  const lon = numbers.lon!;
  if (lat < -90 || lat > 90) {
    return { ok: false, rejection: { reason: 'BAD_NUMBER', field: 'lat', value: String(lat) } };
  }
  if (lon < -180 || lon > 180) {
    return { ok: false, rejection: { reason: 'BAD_NUMBER', field: 'lon', value: String(lon) } };
  }

  const rawMoving = raw.get('is_moving');
  const isMoving = rawMoving === undefined ? undefined : parseBool(rawMoving);
  const activity = raw.get('activity');
  const event = raw.get('event');

  return {
    ok: true,
    kind: 'POSITION',
    ping: {
      deviceId: id.trim(),
      lat,
      lon,
      receivedAt,
      ts: ts ?? receivedAt,
      ...(numbers.accuracy === undefined ? {} : { accuracy: numbers.accuracy }),
      ...(numbers.bearing === undefined ? {} : { bearing: numbers.bearing }),
      ...(numbers.speed === undefined ? {} : { speed: numbers.speed }),
      ...(numbers.batt === undefined ? {} : { battery: numbers.batt }),
      ...(isMoving === undefined ? {} : { isMoving }),
      ...(activity === undefined ? {} : { activity }),
      ...(event === undefined ? {} : { event }),
      attributes,
    },
  };
}
