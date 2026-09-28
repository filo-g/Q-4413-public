import type { Audience, Game, MasterMarker, Player, Polygon, Team } from '@q4413/shared';

import { insideIngestArea } from './gating.ts';

/**
 * The master markers (R-19, R-20b, R-21c).
 *
 * **Up to five exist at a time, globally**, and a sixth is refused. R-20 used to
 * allow exactly one, replacing whatever was there; five with a refusal is the
 * amendment of 2026-09-03, and the refusal is what keeps the set from becoming
 * the queue R-20 was written to prevent — a marker never leaves somebody's phone
 * because the master placed another one. Still no per-audience slot: the five are
 * one global set whatever each is addressed to.
 *
 * A marker carries **a TTL or none** (R-21c). Without one it stays until the
 * master clears it or the session ends (R-08).
 *
 * Pure and separate from the Durable Object for the usual reason (§6.5): what is
 * left for the Worker is writing the result down, scheduling the one alarm, and
 * broadcasting. Everything that can be got wrong about a marker — an audience
 * nobody is in, a TTL that outlives the game, a coordinate pair typed the wrong
 * way round — is decided here, where a test can reach it.
 */

export type MarkerError =
  | { reason: 'LABEL_REQUIRED' }
  | { reason: 'LABEL_TOO_LONG'; max: number }
  | { reason: 'BAD_POSITION' }
  | { reason: 'OUTSIDE_INGEST_AREA'; lat: number; lon: number }
  | { reason: 'BAD_AUDIENCE' }
  | { reason: 'UNKNOWN_TEAM'; teamId: string }
  | { reason: 'UNKNOWN_PLAYER'; playerId: string }
  | { reason: 'BAD_TTL'; minMs: number; maxMs: number }
  | { reason: 'MARKER_LIMIT'; max: number };

export type MarkerResult<T> = { ok: true; value: T } | { ok: false; error: MarkerError };

/** Spoken aloud on a walkie before it is read off a screen. Room for a phrase, not a paragraph. */
export const MARKER_LABEL_MAX = 48;

/**
 * TTL bounds, and both ends are a judgement rather than a spec.
 *
 * Under 30 s a marker is gone before anyone looks up from the radio conversation
 * that produced it. Over two hours it is not a temporary direction any more, and
 * the honest home for a point that lasts is a POI — static configuration with an
 * audience of its own (R-16, R-17), which is exactly the same shape and does not
 * silently vanish mid-game.
 */
export const MARKER_TTL_MIN_MS = 30_000;
export const MARKER_TTL_MAX_MS = 7_200_000;

/**
 * How many may exist at once (R-20b).
 *
 * Five, and the number is doing work: it is few enough for a master to hold in
 * their head while talking on a radio, and few enough that the map does not stop
 * carrying information — the same worry as M7's growing circles, where a handful
 * of overlapping shapes leaves nothing to look at.
 */
export const MARKER_MAX = 5;

/** What a master submits. Everything unvalidated, because it arrives from a form. */
export interface MarkerInput {
  label?: string | undefined;
  lat?: number | undefined;
  lon?: number | undefined;
  audience?: Audience | undefined;
  /**
   * Three cases, and the distinction between two of them is the point (R-21c):
   *
   * - **absent** — `config.markerDefaultTtlMs`, which is what a form that never
   *   touched the field means
   * - **`null`** — no expiry at all, which is a deliberate choice
   * - a number — that TTL, inside the bounds above
   *
   * A missing field and an explicit "never" must not collapse into each other, or
   * forgetting to send a TTL would quietly place a permanent marker.
   */
  ttlMs?: number | null | undefined;
}

function audienceOf(
  audience: Audience | undefined,
  roster: { players: readonly Player[]; teams: readonly Team[] },
): MarkerResult<Audience> {
  // Unlike a POI, a marker's audience is never defaulted by absence: R-19 lists
  // it as one of the three things a master supplies, and "everyone" is a choice
  // worth making on purpose rather than by leaving a select alone.
  if (audience === undefined) return { ok: false, error: { reason: 'BAD_AUDIENCE' } };
  switch (audience.kind) {
    case 'all':
      return { ok: true, value: { kind: 'all' } };
    case 'team': {
      const team = roster.teams.find((candidate) => candidate.id === audience.teamId);
      // A marker nobody can see is a marker that quietly never expires from any
      // screen, because it was never on one — and the master has no way to tell
      // it apart from one that worked. #removePlayer clears the marker for the
      // same reason from the other direction.
      if (!team) {
        return { ok: false, error: { reason: 'UNKNOWN_TEAM', teamId: audience.teamId } };
      }
      return { ok: true, value: { kind: 'team', teamId: team.id } };
    }
    case 'player': {
      const player = roster.players.find((candidate) => candidate.id === audience.playerId);
      if (!player) {
        return { ok: false, error: { reason: 'UNKNOWN_PLAYER', playerId: audience.playerId } };
      }
      return { ok: true, value: { kind: 'player', playerId: player.id } };
    }
    default:
      return { ok: false, error: { reason: 'BAD_AUDIENCE' } };
  }
}

/**
 * R-19, R-20. Builds the marker that replaces whatever was there.
 *
 * The id comes from the caller because randomness is the runtime's to provide and
 * this package stays portable (§6.5) — the same arrangement as a player's session
 * token. It matters even with one slot: a client that sees the same id twice has
 * no way to tell a replacement from a redraw of the marker it already had.
 *
 * The position is checked against the **ingest area**, not the perimeter. A
 * marker just outside the playable area is a legitimate instruction — the car
 * park entrance, a meeting point at the gate — while a coordinate pair typed the
 * wrong way round lands in the sea off Somalia, and that is the mistake worth
 * catching. The ingest area is the box the game already treats as "plausibly
 * here" (R-04, §14.2).
 */
export function placeMarker(
  input: MarkerInput,
  context: {
    players: readonly Player[];
    teams: readonly Team[];
    ingestArea: Polygon;
    config: Pick<Game['config'], 'markerDefaultTtlMs'>;
    /**
     * The markers that already exist. Only their count is read, and the caller is
     * expected to have dropped the expired ones first — `activeMarkers()` does
     * that — so a slot held by a marker whose TTL has passed does not refuse a
     * new one.
     */
    existing: readonly MasterMarker[];
  },
  id: string,
  now: number,
): MarkerResult<MasterMarker> {
  // Before anything else: the cap is about the set, not about this marker, and
  // reporting a bad label on a request that was going to be refused anyway would
  // send the master to fix the wrong thing.
  if (activeMarkers(context.existing, now).length >= MARKER_MAX) {
    return { ok: false, error: { reason: 'MARKER_LIMIT', max: MARKER_MAX } };
  }

  const label = input.label?.trim() ?? '';
  if (!label) return { ok: false, error: { reason: 'LABEL_REQUIRED' } };
  if (label.length > MARKER_LABEL_MAX) {
    return { ok: false, error: { reason: 'LABEL_TOO_LONG', max: MARKER_LABEL_MAX } };
  }

  const { lat, lon } = input;
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return { ok: false, error: { reason: 'BAD_POSITION' } };
  }
  if (!insideIngestArea(lon, lat, context.ingestArea)) {
    return { ok: false, error: { reason: 'OUTSIDE_INGEST_AREA', lat, lon } };
  }

  const audience = audienceOf(input.audience, context);
  if (!audience.ok) return audience;

  // `null` is "no expiry" and `undefined` is "you did not say", so the default
  // only applies to the second (R-21c).
  const indefinite = input.ttlMs === null;
  const ttlMs = indefinite ? 0 : input.ttlMs ?? context.config.markerDefaultTtlMs;
  if (!indefinite && (!Number.isFinite(ttlMs) || ttlMs < MARKER_TTL_MIN_MS || ttlMs > MARKER_TTL_MAX_MS)) {
    return {
      ok: false,
      error: { reason: 'BAD_TTL', minMs: MARKER_TTL_MIN_MS, maxMs: MARKER_TTL_MAX_MS },
    };
  }

  return {
    ok: true,
    value: {
      id,
      label,
      lat,
      lon,
      audience: audience.value,
      placedAt: now,
      // Left off entirely rather than set to a sentinel, so nothing downstream can
      // compare an indefinite marker's expiry against a clock by accident.
      ...(indefinite ? {} : { expiresAt: now + ttlMs }),
    },
  };
}

/**
 * R-21c. Expiry is a comparison, not a state: the alarm writes it down, it does
 * not decide it. A marker with no `expiresAt` is never expired — that is the
 * whole of "indefinite", and it lives here so no caller has to remember it.
 */
export function markerExpired(marker: MasterMarker | null | undefined, now: number): boolean {
  if (!marker || marker.expiresAt === undefined) return false;
  return now >= marker.expiresAt;
}

/**
 * The markers still live as of `now`, soonest expiry first and the indefinite
 * ones last.
 *
 * Read by `project()`, by the client and by the Worker, and that duplication is
 * the point. R-21c makes an alarm the thing that clears an expired marker, and an
 * alarm is a scheduled request: it can be late, it can be lost to a deploy that
 * replaces the object mid-flight, and — measured on a local Worker with no
 * traffic — it may not run at all while the object is idle. A marker whose TTL
 * has passed must not still be on a map because the platform was busy. Expiry is
 * derived at read time for the same reason `NO_LINK` is (R-15, §6.3): the absence
 * of a message is not something to wait for.
 *
 * The ordering is deliberate. What is about to disappear is what a master needs
 * to see first, and an indefinite marker has no place in a queue sorted by
 * urgency.
 */
export function activeMarkers(
  markers: readonly MasterMarker[],
  now: number,
): MasterMarker[] {
  return markers
    .filter((marker) => !markerExpired(marker, now))
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
}

/**
 * When the next alarm is due, or `undefined` if nothing expires.
 *
 * One alarm for the whole set (R-21c, §6.3): a Durable Object has exactly one to
 * give, so it is scheduled for the earliest expiry and re-armed after each firing
 * from whatever is left. Markers with no TTL contribute nothing, so five
 * indefinite markers schedule no alarm at all.
 */
export function nextMarkerExpiry(markers: readonly MasterMarker[]): number | undefined {
  const times = markers
    .map((marker) => marker.expiresAt)
    .filter((expiresAt): expiresAt is number => expiresAt !== undefined);
  return times.length === 0 ? undefined : Math.min(...times);
}
