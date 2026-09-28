import type { Game, OsmAndPing, Player, PositionState } from '@q4413/shared';

/**
 * Link derivation (R-10..R-15).
 *
 * No server tick (§6.3, R-15): everything here is a function of a timestamp and
 * the moment you ask. Each Durable Object alarm bills as a full request, so a
 * clock that ticks to age six dots is the one implementation this milestone may
 * not have — and does not need, because age is arithmetic.
 *
 * ## Only two of the three states are ever stored
 *
 * `MOVING` and `STATIONARY` are claims a device makes, so they are written when a
 * ping arrives and stay put. `NO_LINK` is not a claim, it is the **absence** of
 * one, and nothing arrives to write it. It is derived from how long ago the last
 * ping landed, by whoever is asking, at the moment they ask.
 *
 * That asymmetry is the whole reason no tick is needed, and it is why
 * `stateFromPing()` returns a two-member union rather than `PositionState`: a
 * function handed a ping that just arrived cannot honestly return `NO_LINK`.
 */

/** What a device can claim about itself. `NO_LINK` is never claimed, only derived. */
type ClaimedState = Extract<PositionState, 'MOVING' | 'STATIONARY'>;

/** The fields of a ping R-10 reads. Narrow, so a test can pass a literal. */
type MotionEvidence = Pick<OsmAndPing, 'isMoving' | 'activity' | 'event'>;

/**
 * R-10's stationary evidence: **exactly** the three sources it lists — a
 * `motionchange` carrying `is_moving: false`, a `heartbeat`, or `activity: still`.
 *
 * `is_moving: true` vetoes all three. A device that says it is moving is moving,
 * whatever event carried the message.
 *
 * ## Two deliberate narrownesses
 *
 * **`activity` is one source of three, never a requirement.** One player's phone
 * runs GrapheneOS with no Play services and reports
 * `ActivityRecognition.API is not available on this device`, so it supplies the
 * first two sources and never the third. Every rule here has to hold with
 * `activity` absent; `tools/fake-phones.mjs --no-activity` reproduces the device.
 *
 * **A bare `is_moving: false` with no event is not evidence.** R-10 puts
 * `motionchange` in front of it and this follows that literally, which leaves a
 * gap the requirement does not resolve: `MOVING` is specified as
 * "`is_moving: true` **or absent**", so a plain location update carrying
 * `is_moving: false` matches neither state's description. It falls through to
 * `MOVING` here, and the asymmetry of being wrong is what decides it. Reading a
 * bare `false` as stationary would render a walking player as parked on any build
 * that sends `is_moving: false` by default — the mistake shows on the map and
 * misleads a master. Falling through to `MOVING` costs almost nothing: R-12 gives
 * `MOVING` and `STATIONARY` the same valid, non-growing circle, so the difference
 * between them is a label and `stationarySince`, not a position anyone acts on.
 */
export function stationaryEvidence(ping: MotionEvidence): boolean {
  if (ping.isMoving === true) return false;
  if (ping.event === 'motionchange' && ping.isMoving === false) return true;
  if (ping.event === 'heartbeat') return true;
  if (ping.activity === 'still') return true;
  return false;
}

/** The state a ping that just landed puts a device in. Never `NO_LINK` — see above. */
export function stateFromPing(ping: MotionEvidence): ClaimedState {
  return stationaryEvidence(ping) ? 'STATIONARY' : 'MOVING';
}

/**
 * When the current stationary run began, or `undefined` if the device is moving.
 *
 * A run continues across consecutive stationary pings and restarts otherwise. The
 * one case worth spelling out is the third condition: **a run does not survive a
 * gap longer than the link threshold.** A phone that goes quiet in a pocket for
 * two hours and comes back with a heartbeat has not been demonstrably still for
 * two hours — it was dark, and R-10 calls a `NO_LINK` position unreliable for
 * exactly that reason. Carrying the old `stationarySince` across the gap would
 * turn that absence of evidence into a confident "still here since 19:40", which
 * is the kind of invented certainty this milestone is trying to keep off the map.
 */
export function stationarySinceFor(
  previous: Player['position'],
  ping: MotionEvidence & Pick<OsmAndPing, 'receivedAt'>,
  linkThresholdMs: number,
): number | undefined {
  if (stateFromPing(ping) !== 'STATIONARY') return undefined;
  if (
    previous?.state === 'STATIONARY' &&
    previous.stationarySince !== undefined &&
    ping.receivedAt - previous.ts <= linkThresholdMs
  ) {
    return previous.stationarySince;
  }
  return ping.receivedAt;
}

/**
 * How long ago the last ping landed, in ms. `Infinity` for a player who has never
 * reported one, which is the honest answer and makes every threshold comparison
 * below fall the right way without a special case.
 */
export function positionAgeMs(position: { ts: number } | undefined, now: number): number {
  return position === undefined ? Infinity : now - position.ts;
}

/**
 * R-11. The state as of `now`, which is the only form of the question worth
 * asking: a stored `MOVING` is a claim from a specific moment, not a standing
 * fact, and it expires.
 *
 * Threshold **90 s**, one value for everyone (R-09, R-11). Silence past it is
 * `NO_LINK` whatever the device last claimed — and that "whatever" is load
 * bearing. It would be tempting to let a device that declared itself stationary
 * keep the state through the silence, on the grounds that it told us it was
 * parked and parked things stay put. That reading makes a flat battery in a
 * pocket render `STATIONARY` forever, with the confident non-growing circle R-12
 * gives a valid position, which is precisely the failure R-12 exists to prevent.
 * It also breaks R-22: `OPERATIONAL` depends on a flat battery and an eliminated
 * player taking the same branch, and an exemption would give the battery its own.
 *
 * So stationary evidence distinguishes `STATIONARY` from `MOVING` *within* the
 * threshold, and buys no time past it. A genuinely stationary phone stays out of
 * `NO_LINK` by continuing to send — which is what Traccar's heartbeat is for, and
 * why its interval has to be shorter than this threshold to be worth anything.
 */
export function derivePositionState(
  position: { ts: number; state: PositionState } | undefined,
  linkThresholdMs: number,
  now: number,
): PositionState {
  if (position === undefined) return 'NO_LINK';
  if (positionAgeMs(position, now) > linkThresholdMs) return 'NO_LINK';
  return position.state;
}

/**
 * R-12. The radius to draw around a position, in metres. It grows **only** in
 * `NO_LINK`: a device that declared itself stationary is telling the truth about
 * where it is, so its circle stays at the fix's own accuracy.
 *
 * ## Two choices R-12 leaves open
 *
 * **It grows from the last ping, not from the moment the threshold was crossed.**
 * So the circle does not fade in from nothing — it appears at roughly 126 m the
 * instant a 90 s silence becomes `NO_LINK`, and grows from there. That step is
 * not an artefact to smooth away, it is the truth arriving late: the player could
 * have been walking since the last fix, and a circle starting at `accuracy` at
 * second 91 would assert they are within a few metres of a point they may already
 * be a hundred metres from. R-12's own word for what the circle does is "appears".
 *
 * **`walkingSpeed`, with no `detourFactor`.** R-45 inflates a *route* by 1.35 to
 * account for streets rather than straight lines, which is right for an ETA and
 * wrong here: this is a bound on how far someone could have got, and the furthest
 * they could have got is a straight line. Multiplying it would draw a circle
 * larger than anywhere they could physically be.
 *
 * Deliberately uncapped. Four hours of silence gives a radius wider than the play
 * area, and that is the correct answer to "where might they be" — the circle
 * ceasing to be useful *is* the information. Clamping for rendering is the map's
 * business, not this function's.
 */
export function uncertaintyRadiusMetres(
  position: { accuracy: number; ts: number; state: PositionState } | undefined,
  config: Pick<Game['config'], 'linkThresholdMs' | 'walkingSpeed'>,
  now: number,
): number {
  if (position === undefined) return 0;
  if (derivePositionState(position, config.linkThresholdMs, now) !== 'NO_LINK') {
    return position.accuracy;
  }
  // The age is necessarily positive here: NO_LINK means it exceeded the threshold.
  return position.accuracy + (config.walkingSpeed * positionAgeMs(position, now)) / 1000;
}

/**
 * R-13's two words for a `NO_LINK` player: someone has spoken to them by walkie
 * recently, or nobody has.
 *
 * **Neither is an alarm.** R-13 says so twice over, and it is the requirement most
 * likely to be quietly broken later, because "unaccounted" reads like something
 * that ought to flash. It is a label on a roster row. Six people in a field with
 * walkies do not need the interface to panic on their behalf, and a state that
 * every player enters routinely — a pocket, a tunnel, a dead spot — cannot be one
 * that raises anything.
 */
export type Accountability = 'ACCOUNTED' | 'UNACCOUNTED';

/** R-13: contact is worth something for five minutes (`radioContactValidityMs`). */
export function radioContactFresh(
  contact: { ts: number } | undefined,
  config: Pick<Game['config'], 'radioContactValidityMs'>,
  now: number,
): boolean {
  if (contact === undefined) return false;
  return now - contact.ts <= config.radioContactValidityMs;
}

/**
 * R-13, whole: `undefined` while the feed is alive, because radio contact "only
 * starts mattering once the player is in `NO_LINK`" and is "neither displayed nor
 * tracked" before that.
 *
 * The asymmetry is deliberate and it is not the same as ignoring the record.
 * Contact recorded while a player is live is still stored and still counts if they
 * go dark within the validity window — which is the common case, since you notice
 * you have not heard from someone shortly *after* speaking to them. What R-13
 * suppresses is the display, not the memory.
 */
export function accountabilityOf(
  position: { ts: number; state: PositionState } | undefined,
  radioContact: { ts: number } | undefined,
  config: Pick<Game['config'], 'linkThresholdMs' | 'radioContactValidityMs'>,
  now: number,
): Accountability | undefined {
  if (derivePositionState(position, config.linkThresholdMs, now) !== 'NO_LINK') return undefined;
  return radioContactFresh(radioContact, config, now) ? 'ACCOUNTED' : 'UNACCOUNTED';
}

/**
 * R-22's single predicate. **A flat battery and an eliminated player take the
 * same branch by design** — that is the whole mechanism of `OPERATIONAL`, and it
 * must not be special-cased.
 *
 * Expressed through derivePositionState() so the threshold comparison lives in
 * one place: what R-22 calls a stopped feed and what R-10 calls `NO_LINK` are the
 * same condition seen from two requirements, and they must not be able to drift.
 */
export function feedStopped(player: Player, config: Game['config'], now: number): boolean {
  if (player.eliminated) return true;
  return derivePositionState(player.position, config.linkThresholdMs, now) === 'NO_LINK';
}

/** Metres between two coordinates. Haversine; the play area is small but the maths is cheap. */
export function distanceMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
