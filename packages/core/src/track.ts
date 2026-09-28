import type {
  GameEvent,
  GameState,
  MasterMarker,
  Payload,
  Player,
  Polygon,
  TrackSample,
  Zone,
} from '@q4413/shared';

import { activeMarkers } from './marker.ts';
import { playAreaOf } from './play-area.ts';

/**
 * The track, and replay over it (R-53..R-57).
 *
 * Two halves that never meet on the wire. The **writer** turns an accepted ping
 * into a `TrackSample`; the **reader** turns a window of samples and events back
 * into a `Payload` at a chosen instant. Everything here is pure — the SQLite
 * table, the range query and the HTTP window live in `workers/src` (§6.5).
 *
 * ## Why the reader returns a `Payload`
 *
 * R-53 is the whole design: **replay is not a separate mode, it is a clock.**
 * The one thing that makes that true in code is that `replayAt()` hands back the
 * same shape a live socket message carries, with `serverNow` set to the cursor
 * instead of to now. Every derivation downstream is already written against that
 * field — `derivePositionState()` (R-11), `uncertaintyRadiusMetres()` (R-12),
 * `activeMarkers()` (R-21c), every age the panel prints — so they all replay for
 * free and there is no second renderer to keep in step. The risk M8 was given in
 * ROADMAP is exactly that fork; this is how it is avoided rather than watched
 * for.
 */

/* ------------------------------------------------------------------ */
/* The writer                                                          */
/* ------------------------------------------------------------------ */

/**
 * The R-03 attribute map, reduced to what a track may keep.
 *
 * **An allowlist, and it has to be one.** R-03 parks every parameter it does not
 * recognise in `attributes`, kept whole and on purpose — and Traccar Client's
 * status body is `id=<device>&notificationToken=<FCM registration token>`, so
 * that map can hold a live push credential (see `OsmAndStatus`). M8 was planned
 * as `TrackSample` gaining "the R-03 attribute map"; taken literally that writes
 * push tokens into game history that outlives the game. It gains these three
 * instead.
 *
 * They are here because something asked for them, not because they were
 * available: `charge` is how M1's "why did one phone last four hours and another
 * not" gets answered after the fact, and `altitude` and `hdop` are the two
 * fields that qualify a fix the accuracy figure alone does not. A fourth needs a
 * reason, and adding one is a deliberate act rather than a default.
 */
export const TRACK_ATTRIBUTES: readonly string[] = ['altitude', 'hdop', 'charge'];

/**
 * A kept value is truncated rather than refused. The allowlist already decides
 * what is written; this is about a build that sends something unexpectedly long
 * under a name we do want, and it bounds a row rather than losing one.
 */
export const TRACK_ATTRIBUTE_VALUE_MAX = 32;

/**
 * The allowlist applied. Returns `undefined` rather than an empty object so the
 * common case — a ping with nothing on the list — costs no field on the sample
 * and no bytes in the row.
 */
export function trackAttributes(
  attributes: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!attributes) return undefined;
  const kept: Record<string, string> = {};
  for (const name of TRACK_ATTRIBUTES) {
    const value = attributes[name];
    if (value === undefined) continue;
    kept[name] = value.slice(0, TRACK_ATTRIBUTE_VALUE_MAX);
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * One sample from a player whose position has just been updated.
 *
 * Read off the player rather than off the ping, and that is the point: by the
 * time this is called `applyPing()` has decided the position state (R-11) and
 * the zone (R-39), and a sample that re-derived either from the raw ping would
 * be a second implementation of both. What is stored is what the game believed.
 *
 * `ts` is `position.ts`, which is the server's receive time (R-36). A device's
 * own fix time was parsed and discarded upstream, and whether the track wants it
 * back was left open — it does not: two clocks in one table is an ordering bug
 * waiting for the first phone whose clock is wrong.
 *
 * Returns `undefined` for a player with no position, which is the status-report
 * case: nothing to place, nothing to record.
 */
export function sampleOf(
  player: Player,
  attributes?: Record<string, string>,
): TrackSample | undefined {
  const position = player.position;
  if (!position) return undefined;
  const kept = trackAttributes(attributes);
  return {
    ts: position.ts,
    playerId: player.id,
    lat: position.lat,
    lon: position.lon,
    accuracy: position.accuracy,
    state: position.state,
    ...(position.bearing === undefined ? {} : { bearing: position.bearing }),
    ...(player.battery === undefined ? {} : { battery: player.battery }),
    ...(position.zoneId === undefined ? {} : { zoneId: position.zoneId }),
    ...(kept === undefined ? {} : { attributes: kept }),
  };
}

/* ------------------------------------------------------------------ */
/* The clock (R-54)                                                    */
/* ------------------------------------------------------------------ */

/**
 * R-54b and R-54c, in the order a control cycles them.
 *
 * Speed is not an appetite here: R-62 made the window the whole game, and the
 * list is read off how long that takes to sit through. Six hours is ninety
 * minutes at 4x, forty-five at 8x and **twenty-two at 16x**, which is the first
 * number that is a sitting rather than an afternoon. They are one button rather
 * than five for the same reason they always were — a replay has one axis, and it
 * is time.
 *
 * 16x is the end of the list and not a step on the way to 32x. The tick is 100
 * ms, so one tick is 1,6 s of game time against samples that arrive every 5 s
 * (R-55): still more often than the data underneath, which is the property that
 * makes the interpolation worth running. At 32x a tick would be 3,2 s and the
 * cursor would start stepping over most of a sample interval at a time, so the
 * dot would move in the jumps R-55 exists to smooth.
 */
export const REPLAY_SPEEDS: readonly number[] = [1, 2, 4, 8, 16];

/**
 * How far back `GET /api/track` reaches when the caller names no window. Twenty
 * minutes is M8's exit criterion, and an hour is the longest scrub anybody has
 * asked for; the whole game is available by asking for it explicitly.
 */
export const REPLAY_DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long a sample is kept. The game is four hours and R-26 calls the feature
 * *post-game* replay, so the track has to survive the end of the session — which
 * it does: `FINISHED` revokes bindings and clears the tray, and deliberately
 * does not touch this. Two days is "the debrief happens tomorrow" with room to
 * spare, and `POST /api/master/game/reset` is what actually throws a game away.
 */
export const TRACK_RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * Whether the recorded game may be cut back to `from`, and why not (R-73).
 *
 * **A game accumulates a past it was never played in.** `startedAt` is written
 * once and never again — `#setState()` guards on `=== undefined`, because when a
 * game started is a fact and not a field to keep current — so the first time
 * anybody put the object into `IN_PROGRESS`, for a pairing test days earlier,
 * is what `replayWindowFor()` opens the scrub bar at for ever. The debrief then
 * spans from an afternoon of six people walking around a car park to five in the
 * morning, and the night it was kept for is a fifth of the bar.
 *
 * Retention does not solve it: 48 hours from *now* takes the game with it, not
 * the rehearsal before it. R-26 keeps the track past `FINISHED` on purpose, so
 * the only thing that can cut the front off is somebody saying where the game
 * began.
 *
 * Two refusals, and neither is a safety rail on the other:
 *
 * - **`IN_PROGRESS`** — the same condition the geometry controls carry, for a
 *   milder reason: nothing here reaches §4, but a window whose start moves under
 *   a master mid-game is R-25's replay reading one thing and the panel another.
 *   It costs nothing to wait; the game ends in four hours.
 * - **`NOT_IN_RANGE`** — a cut at or after the end leaves a window with no
 *   inside. `from` is the new beginning, not a length, and the error is easy to
 *   make with a timestamp typed by hand.
 *
 * `undefined` means it is allowed. The caller does the deleting: what rows
 * exist is SQLite's business and this file is pure (§6.5).
 */
export type TrackTrimRefusal = 'IN_PROGRESS' | 'NOT_IN_RANGE';

export function trackTrimRefusal(
  game: { state?: GameState; finishedAt?: number },
  from: number,
  now: number,
): TrackTrimRefusal | undefined {
  if (game.state === 'IN_PROGRESS') return 'IN_PROGRESS';
  // The same reading `replayWindowFor()` makes, and for the same reason: a
  // `finishedAt` left behind by a game that was opened again has already passed.
  const end = game.state === 'FINISHED' ? (game.finishedAt ?? now) : now;
  if (!Number.isFinite(from) || !(from < end)) return 'NOT_IN_RANGE';
  return undefined;
}

/**
 * The window a replay opens on, and where its cursor starts (R-62).
 *
 * **The whole game, not a fixed hour.** M8 fetched the last hour because a
 * replay was something watched during a game; a debrief is the game read end to
 * end, and an hour's window means a second request the moment the master scrubs
 * past it. Six players over six hours is about 26.000 samples — bigger than M8's
 * hour, still one request, indexed once.
 *
 * Both ends fall back rather than fail. A game that never started has no
 * `startedAt`, and one still running has no `finishedAt`; neither is a reason to
 * refuse a replay, so the missing end becomes the hour before now and now
 * itself, which is exactly M8's window and a sensible floor.
 *
 * **`finishedAt` is read only while the game is `FINISHED`, and that is not
 * belt and braces.** Nothing clears the field when a game is opened again —
 * `#setState()` sets it on the way into `FINISHED` and leaves it, which is
 * right, because when a game finished is worth keeping. But a game that
 * finished once and was set back to `PREPARATION` for the next session then
 * carries an end that has already passed, and a window ending there holds
 * nothing at all: every sample since is after it. Found on a local Worker whose
 * game had done exactly that — 37.923 samples in the table and zero in the
 * window the panel would have asked for.
 */
export function replayWindowFor(
  game: { state?: GameState; startedAt?: number; finishedAt?: number },
  liveNow: number,
): { from: number; to: number } {
  const ended = game.state === 'FINISHED' ? game.finishedAt : undefined;
  const to = ended ?? liveNow;
  const from = game.startedAt ?? to - REPLAY_DEFAULT_WINDOW_MS;
  // A game whose recorded start is after its recorded end is not a window. It
  // takes the fallback rather than an empty scrub bar the master cannot move.
  if (!(from < to)) return { from: to - REPLAY_DEFAULT_WINDOW_MS, to };
  return { from, to };
}

/** The earliest sample actually in a window, or `undefined` for an empty one. */
export function earliestSampleTs(samples: readonly TrackSample[]): number | undefined {
  let earliest: number | undefined;
  for (const sample of samples) {
    if (earliest === undefined || sample.ts < earliest) earliest = sample.ts;
  }
  return earliest;
}

/**
 * Where the cursor opens, which differs by state rather than by taste (R-62).
 *
 * A **finished** game opens at its beginning: the debrief is the whole thing,
 * and starting twenty minutes before the end would mean scrubbing backwards
 * through five and a half hours to reach the start. A game still **running**
 * opens twenty minutes back, which is M8's criterion and what a master mid-game
 * is asking about.
 *
 * **Never before the first sample there is**, which is the other half and is
 * not the same as clamping to `window.from`. The window is the game's span and
 * the track is kept for 48 hours, so a debrief the day after a long game asks
 * for an hour that has already been swept — and `from` is the *asked* bound,
 * which the server echoes back whether or not anything was found in it. Opening
 * there is an empty map for however long the gap is, which reads as everybody
 * having vanished rather than as a replay that has not started yet.
 */
export function replayStartCursor(
  window: { from: number; to: number },
  game: { state?: GameState; finishedAt?: number },
  startOffsetMs: number,
  firstSampleTs?: number,
): number {
  const earliest = Math.max(window.from, firstSampleTs ?? window.from);
  if (game.state === 'FINISHED') return Math.min(earliest, window.to);
  return Math.min(Math.max(window.to - startOffsetMs, earliest), window.to);
}

/**
 * The cursor, advanced by one tick of real time (R-54).
 *
 * **Reaching live is a snap, not a clamp**, and the difference is the whole of
 * R-54's second sentence: the cursor lands exactly on `liveNow` and the caller
 * can see that it did, which is what turns replay off and hands the panel back
 * to the socket. A clamp would leave it a few milliseconds short for ever and
 * the panel would never quite be live.
 *
 * @param elapsedMs real milliseconds since the last tick
 * @param speed     1, 2 or 4 (R-54)
 * @param liveNow   the server's clock, never the device's (R-36)
 */
export function advanceCursor(
  cursor: number,
  elapsedMs: number,
  speed: number,
  liveNow: number,
): number {
  const next = cursor + elapsedMs * speed;
  return next >= liveNow ? liveNow : next;
}

/* ------------------------------------------------------------------ */
/* The reader                                                          */
/* ------------------------------------------------------------------ */

/** What `GET /api/track` answers with: a window of history, whole. */
export interface TrackWindow {
  from: number;
  to: number;
  samples: TrackSample[];
  /** The window's events, already filtered by `visibility` in project()'s image. */
  events: GameEvent[];
}

/**
 * A window, arranged for scrubbing.
 *
 * Built once per fetch rather than per frame. A cursor dragged across a
 * 4-hour window redraws at 60 Hz over ~17.000 samples, and grouping them by
 * player on every frame is the one way to make a pure reconstruction expensive.
 */
export interface ReplayIndex {
  from: number;
  to: number;
  byPlayer: Map<string, TrackSample[]>;
  events: GameEvent[];
}

export function indexTrack(window: TrackWindow): ReplayIndex {
  const byPlayer = new Map<string, TrackSample[]>();
  for (const sample of window.samples) {
    const list = byPlayer.get(sample.playerId);
    if (list) list.push(sample);
    else byPlayer.set(sample.playerId, [sample]);
  }
  // Sorted here rather than trusted from the wire: the reader's binary search is
  // the only thing standing between a mis-ordered row and a player teleporting.
  for (const list of byPlayer.values()) list.sort((a, b) => a.ts - b.ts);
  return {
    from: window.from,
    to: window.to,
    byPlayer,
    events: [...window.events].sort((a, b) => a.ts - b.ts),
  };
}

/** Index of the last sample at or before `cursor`, or -1. */
function lastAtOrBefore(samples: TrackSample[], cursor: number): number {
  let low = 0;
  let high = samples.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (samples[mid]!.ts <= cursor) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Where one player was at `cursor` (R-55).
 *
 * Linear between two samples — and **only across a gap the feed could have
 * covered.** R-55 says interpolate; it does not say invent. Past
 * `linkThresholdMs` the two fixes are not two points on a walk, they are the
 * last fix before a blackout and the first one after it, and drawing a smooth
 * line between them replaces the thing the master actually saw (a dot going
 * `NO_LINK` under a growing circle, R-12) with a player strolling through a dead
 * zone. So a long gap **holds the earlier sample, timestamp and all**, and every
 * age downstream then reproduces the blackout exactly because it is measured
 * against a `ts` that has stopped moving.
 *
 * M1 measured the other reason not to be clever here: a phone sitting still on a
 * table summed 183 m of path over six minutes, at an implied 3 m/s. Between
 * consecutive fixes that noise is already in the samples; across a gap it would
 * be multiplied by the length of the gap.
 *
 * `bearing` and `battery` are carried from the earlier sample rather than
 * interpolated — a compass heading needs shortest-arc and nothing in the replay
 * reads one, and a battery percentage is a step, not a ramp.
 */
export function positionAt(
  samples: TrackSample[],
  cursor: number,
  linkThresholdMs: number,
): TrackSample | undefined {
  const at = lastAtOrBefore(samples, cursor);
  // Before the player's first sample: they had not reported yet, and the master
  // saw nothing. An empty screen is the honest reconstruction.
  if (at === -1) return undefined;

  const before = samples[at]!;
  const after = samples[at + 1];
  if (!after) return before;

  const span = after.ts - before.ts;
  if (span <= 0 || span > linkThresholdMs) return before;

  const t = (cursor - before.ts) / span;
  if (t <= 0) return before;

  return {
    ...before,
    ts: cursor,
    lat: before.lat + (after.lat - before.lat) * t,
    lon: before.lon + (after.lon - before.lon) * t,
    accuracy: before.accuracy + (after.accuracy - before.accuracy) * t,
  };
}

/**
 * Per-player state as of `cursor`, rebuilt from the log (R-56).
 *
 * Not copied from the live player, and that is the point of doing it at all: the
 * live record would put every elimination on screen from the replay's first
 * frame and give away the rest of it, and it would show a radio check that has
 * not happened yet as fresh — R-29's liveness is derived against `serverNow`,
 * which replay has moved.
 *
 * Both halves of R-32 are here: `ELIMINATION` carries the drop point,
 * `ELIMINATION_REVERSED` undoes it, and the last one before the cursor wins.
 *
 * One pass over the log for both, because it is the same walk and the log is the
 * longest thing a scrub touches.
 */
interface StateAtCursor {
  eliminated: Map<string, Player['eliminated']>;
  radioContact: Map<string, Player['radioContact']>;
  /**
   * The zones that were open at the cursor (R-71), or `undefined` when the
   * window holds no `GEOMETRY_TOGGLED` at or before it.
   *
   * Undefined is not "everything was open" — it is "nothing in this window says
   * otherwise", and the honest answer then is the live set, which is what the
   * caller falls back to. `GET /api/track` prepends the last toggle before the
   * window for exactly this reason, so the only case that reaches the fallback
   * is a game where nothing was ever toggled.
   */
  activeZones?: string[];
}

function stateAt(events: GameEvent[], cursor: number): StateAtCursor {
  const eliminated = new Map<string, Player['eliminated']>();
  const radioContact = new Map<string, Player['radioContact']>();
  let activeZones: string[] | undefined;
  for (const event of events) {
    if (event.ts > cursor) break;
    /**
     * R-71, and the one event here that is not about a player — so it is read
     * before the `target` guard below, which would skip it: a toggle that moved
     * several zones deliberately names none of them.
     *
     * **The whole open set, not a delta.** Folding deltas would need the window
     * to reach the start of the game, and it does not have to; the last event
     * at or before the cursor is the complete answer on its own.
     */
    if (event.kind === 'GEOMETRY_TOGGLED') {
      const active = event.data?.['active'];
      if (Array.isArray(active)) activeZones = active.filter((id) => typeof id === 'string');
      continue;
    }
    const playerId = event.target;
    if (!playerId) continue;
    switch (event.kind) {
      case 'ELIMINATION': {
        const dropPoint = event.data?.['dropPoint'] as
          | { lat: number; lon: number }
          | null
          | undefined;
        eliminated.set(playerId, {
          ts: event.ts,
          selfDeclared: event.data?.['selfDeclared'] === true,
          ...(dropPoint == null ? {} : { dropPoint }),
        });
        break;
      }
      case 'ELIMINATION_REVERSED':
        eliminated.delete(playerId);
        break;
      case 'RADIO_CONTACT':
        radioContact.set(playerId, { ts: event.ts, reportedBy: event.actor ?? 'MASTER' });
        break;
      default:
        break;
    }
  }
  return { eliminated, radioContact, ...(activeZones === undefined ? {} : { activeZones }) };
}

/**
 * The geometry as it stood at the cursor (R-71, R-56).
 *
 * **This is what stopped `replayAt()` being allowed to use the live geometry.**
 * Its own docblock used to argue that the live rings were safe because
 * `POST /api/master/game/geo` is refused while the game is `IN_PROGRESS`, and
 * named `GEO_PROFILE` as the hook to hang a geometry history on if that ever
 * stopped being true. R-71 stopped it: closing ground mid-game is the mechanic.
 * So the hook was built into the event instead — `GEOMETRY_TOGGLED` carries the
 * whole open set — and this is the thing that reads it.
 *
 * Everything is derived from the payload the master already holds, which is why
 * `project()` hands them **every** zone and **every** point rather than the ones
 * in play. A point closed now has to be recoverable, or a debrief could not show
 * ground that was open twenty minutes ago.
 */
function geometryAt(live: Payload, activeZones: string[] | undefined): Partial<Payload> {
  if (activeZones === undefined) return {};
  const open = new Set(activeZones);
  const zones = live.zones.filter((zone) => open.has(zone.id));
  return {
    zones,
    sectors: live.sectors
      .map((sector) => ({ ...sector, zoneIds: sector.zoneIds.filter((id) => open.has(id)) }))
      .filter((sector) => sector.zoneIds.length > 0),
    pois: live.pois.filter((poi) => poi.zone === undefined || open.has(poi.zone)),
    playArea: playAreaAt(live.zones, open),
  };
}

/**
 * The play boundary at the cursor, memoised on the set that produced it.
 *
 * A union over twenty-three rings is 0,76 ms, which is nothing once and real
 * money at the rate a scrub moves a cursor — and the set it depends on changes a
 * handful of times in a game while the cursor changes continuously. One entry is
 * enough: a scrub walks forward through the same geometry for long stretches,
 * and the only thing that evicts it is crossing a toggle.
 */
let lastPlayArea: { zones: readonly Zone[]; key: string; area: Polygon[] } | undefined;

function playAreaAt(zones: readonly Zone[], open: ReadonlySet<string>): Polygon[] {
  const closed = zones.map((zone) => zone.id).filter((id) => !open.has(id));
  const key = closed.join(',');
  if (lastPlayArea && lastPlayArea.zones === zones && lastPlayArea.key === key) {
    return lastPlayArea.area;
  }
  const area = playAreaOf(zones, closed);
  lastPlayArea = { zones, key, area };
  return area;
}

/**
 * The markers standing at `cursor`, rebuilt from the log (R-56).
 *
 * `MARKER_PLACED` carries the coordinates so that this is possible at all; it
 * did not before M8, so a game whose markers were placed by an older build
 * replays without them rather than in the wrong place. The TTL is **not**
 * applied here — `replayAt()` sets `serverNow` to the cursor and `activeMarkers()`
 * does it downstream, in the one place that knows R-21c.
 */
function markersAt(events: GameEvent[], cursor: number): MasterMarker[] {
  const live = new Map<string, MasterMarker>();
  for (const event of events) {
    if (event.ts > cursor) break;
    const id = event.target;
    if (!id) continue;
    if (event.kind === 'MARKER_PLACED') {
      const lat = event.data?.['lat'];
      const lon = event.data?.['lon'];
      if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      const expiresAt = event.data?.['expiresAt'];
      live.set(id, {
        id,
        label: String(event.data?.['label'] ?? ''),
        lat,
        lon,
        placedAt: event.ts,
        audience: (event.data?.['audience'] as MasterMarker['audience']) ?? { kind: 'all' },
        ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
      });
    } else if (event.kind === 'MARKER_EXPIRED') {
      live.delete(id);
    }
  }
  return [...live.values()];
}

/**
 * The points the master had hidden at `cursor` (R-63).
 *
 * R-56 says events replay too, and this was the one part of the world a replay
 * still read from the present: `hiddenPois` came off the live game, so a point
 * hidden at 21:14 was hidden from the replay's first frame — which is the same
 * mistake as copying eliminations off the live roster, arriving through a
 * different field.
 *
 * Walked forward from nothing rather than backwards from the live list, and that
 * is only correct because the list is **session-shaped**: `#endSession()` clears
 * it and so does a geo profile change, so every toggle a game contains is inside
 * the window a whole-game replay covers (R-62). A window that started mid-game
 * would need the live list as its opening state; there is no such window.
 */
function hiddenPoisAt(events: GameEvent[], cursor: number): string[] {
  const hidden = new Set<string>();
  for (const event of events) {
    if (event.ts > cursor) break;
    if (event.kind !== 'POI_VISIBILITY') continue;
    const id = event.target;
    if (!id) continue;
    if (event.data?.['hidden'] === true) hidden.add(id);
    else hidden.delete(id);
  }
  return [...hidden];
}

/**
 * Where one player has been, up to `cursor` (R-64).
 *
 * **Split wherever the feed was not there to draw**, which is R-55's rule
 * applied to a line that stays on screen instead of to a dot that moves. Past
 * `linkThresholdMs` two samples are the last fix before a blackout and the first
 * one after it, and a stroke joining them is the same invention the interpolation
 * refuses — worse here, because the dot's growing circle says *unknown* for a
 * moment while a line says *walked this way* for as long as the route is up.
 *
 * The head of the route is the interpolated position at the cursor when there is
 * one, so the line ends at the dot rather than at the last whole sample behind
 * it. When the cursor sits in a gap too long to interpolate, `positionAt()`
 * holds the earlier sample and the route ends there — which is the blackout,
 * drawn as the line stopping.
 *
 * Segments of fewer than two points are dropped: one point is not a line, and
 * the dot is already drawn at it.
 */
export function routeAt(
  samples: TrackSample[],
  cursor: number,
  linkThresholdMs: number,
): Array<Array<[number, number]>> {
  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let previous: TrackSample | undefined;

  for (const sample of samples) {
    if (sample.ts > cursor) break;
    if (previous && sample.ts - previous.ts > linkThresholdMs) {
      segments.push(current);
      current = [];
    }
    current.push([sample.lon, sample.lat]);
    previous = sample;
  }

  // The head, so the line ends where the dot is rather than at the last whole
  // sample behind it.
  //
  // The test is `ts > previous.ts`, not `ts === cursor`: `positionAt()` stamps
  // the cursor on a held sample too — a cursor landing exactly on a sample, or
  // sitting in a gap too long to cross — and both of those are already the last
  // point in `current`, so the looser test appends it twice. Past a blackout
  // there is deliberately no head at all, and the line stops where the feed did.
  const head = positionAt(samples, cursor, linkThresholdMs);
  if (head && previous && head.ts > previous.ts && current.length > 0) {
    current.push([head.lon, head.lat]);
  }

  segments.push(current);
  return segments.filter((segment) => segment.length > 1);
}

/**
 * The payload as it stood at `cursor`.
 *
 * `live` supplies everything that is not time-varying — the roster's callsigns
 * and teams, the tuning config, and the basemap. **The geometry is no longer in
 * that list.**
 *
 * It used to be, on an argument that has since expired: `POST
 * /api/master/game/geo` is refused with a 409 while the game is `IN_PROGRESS`,
 * so zone *rings* cannot move inside a replay's window, and the note here named
 * `GEO_PROFILE` as the hook to hang a geometry history on if that ever stopped
 * being true. R-71 stopped it — closing ground mid-game is the mechanic, not a
 * configuration change — and the hook went into `GEOMETRY_TOGGLED` instead,
 * which carries the **whole open set** so a cursor can read the last one before
 * it rather than folding deltas from a start the window may not reach.
 * `geometryAt()` is what reads it, and the zones, sectors, points and play
 * boundary here are the ones that were on the map at the cursor.
 *
 * The rings themselves still come from `live`, and that part of the old
 * argument is untouched: a profile change is still refused mid-game, so the
 * shapes cannot have moved — only which of them were in play.
 *
 * What is deliberately dropped: the **tray**. An unpaired device has no history
 * — only a current position — so carrying the live tray into a replay would draw
 * a stray phone where it is now on a map of twenty minutes ago. Better absent
 * than wrong.
 */
export function replayAt(live: Payload, index: ReplayIndex, cursor: number): Payload {
  const linkThresholdMs = live.config.linkThresholdMs;
  const { eliminated, radioContact, activeZones } = stateAt(index.events, cursor);

  const players = live.players.map((player) => {
    const samples = index.byPlayer.get(player.id);
    const sample = samples ? positionAt(samples, cursor, linkThresholdMs) : undefined;
    const out = { ...player };
    delete out.position;
    delete out.battery;
    delete out.eliminated;
    delete out.radioContact;
    // R-22's freeze has nothing to say here: the track records what the game
    // believed at the time, so a player who was frozen then is frozen now by the
    // samples having stopped, not by a rule applied twice.
    if (sample) {
      out.position = {
        lat: sample.lat,
        lon: sample.lon,
        accuracy: sample.accuracy,
        ts: sample.ts,
        state: sample.state,
        source: 'LIVE',
        ...(sample.bearing === undefined ? {} : { bearing: sample.bearing }),
        ...(sample.zoneId === undefined ? {} : { zoneId: sample.zoneId }),
      };
      if (sample.battery !== undefined) out.battery = sample.battery;
    }
    const wasEliminated = eliminated.get(player.id);
    if (wasEliminated) out.eliminated = wasEliminated;
    const contact = radioContact.get(player.id);
    if (contact) out.radioContact = contact;
    return out;
  });

  return {
    ...live,
    // R-71's geometry as it stood, and nothing at all when the window holds no
    // toggle — in which case the live geometry is the honest answer, because
    // nothing in this window says otherwise.
    ...geometryAt(live, activeZones),
    // The clock, and the only line that makes replay a clock rather than a mode.
    serverNow: cursor,
    players,
    markers: activeMarkers(markersAt(index.events, cursor), cursor),
    // R-63, and it is the second of two filters over the same list now: this is
    // which points the master had taken off every map, and `geometryAt()` above
    // has already dropped the ones whose ground was closed. Two decisions, taken
    // separately at the time, replayed separately here.
    hiddenPois: hiddenPoisAt(index.events, cursor),
    events: index.events.filter((event) => event.ts <= cursor),
    tray: [],
  };
}
