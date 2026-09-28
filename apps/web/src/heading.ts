import type { Game, ProjectedPosition } from '@q4413/shared';

/**
 * R-50: where the camera points in navigation mode, and how fast it gets there.
 *
 * The heading is the `bearing` field of the incoming ping and nothing else — no
 * device sensors, no browser geolocation, which is a decision about permission
 * prompts rather than about accuracy. One ping interval of latency (~5 s) is
 * accepted.
 *
 * Both handling rules below are **mandatory**, not polish. They are separate
 * problems with separate fixes, and each is useless without the other: the
 * freeze answers "should the camera turn at all", the low-pass answers "how
 * fast". A frozen bearing that snaps still snaps; a smoothed bearing fed noise
 * still wanders, just gracefully.
 */

const TURN = 360;

/** Any angle into `[0, 360)`, including a negative one. */
export function normaliseBearing(bearing: number): number {
  const wrapped = bearing % TURN;
  return wrapped < 0 ? wrapped + TURN : wrapped;
}

/**
 * The signed shortest way round from one bearing to another, in `(-180, 180]`.
 *
 * This is the whole of why the smoothing cannot be a plain lerp on the numbers:
 * 350° to 10° is 20° clockwise, and averaging the two gives 180°, which points
 * the camera backwards for the length of the transition.
 */
export function bearingDelta(from: number, to: number): number {
  const delta = ((normaliseBearing(to) - normaliseBearing(from) + 540) % TURN) - 180;
  // The one asymmetry worth spelling out: exactly opposite turns clockwise
  // rather than through -180, so the direction of a half-turn is at least
  // decided rather than dependent on floating-point noise.
  return delta === -180 ? 180 : delta;
}

/**
 * R-50.1 — the bearing the camera is *aiming* at, which is the last one taken
 * from a fix that was moving fast enough to mean anything.
 *
 * A GPS bearing at walking pace is derived from displacement between fixes, and
 * a phone on a table still reports displacement — 183 m of phantom walking over
 * six minutes of sitting still, measured. Feeding that to a
 * camera spins the map while the player stands there reading it, which is both
 * useless and unpleasant to hold.
 *
 * Three ways to have no answer, all of which hold the previous one:
 *
 * - **no position at all** — nothing has arrived, or §4 withheld it;
 * - **no `bearing`** — the phone build does not send one. This is the common
 *   case today: the measured Traccar Client sends neither `bearing` nor
 *   `speed`, so navigation mode holds whatever it started at;
 * - **below `bearingFreezeSpeed`, or no `speed` to check.** Absent speed
 *   freezes rather than trusts, because the gate exists precisely for the
 *   readings that look like movement and are not.
 */
export function headingTarget(
  frozen: number,
  position: Pick<ProjectedPosition, 'bearing' | 'speed'> | undefined,
  config: Pick<Game['config'], 'bearingFreezeSpeed'>,
): number {
  if (!position || position.bearing === undefined) return frozen;
  if (position.speed === undefined || position.speed < config.bearingFreezeSpeed) return frozen;
  return normaliseBearing(position.bearing);
}

/**
 * R-50.2 — one frame of the low-pass filter. **Never snap.**
 *
 * `bearingSmoothing` (0,12) is the fraction of the remaining turn taken per
 * frame, so the camera covers ~90% of a turn in about 18 frames — a third of a
 * second at 60 fps, fast enough to feel attached to the player and slow enough
 * that a single bad fix is a wobble rather than a lurch.
 *
 * Call it per animation frame, not per ping. Pings arrive every 5 s and the
 * whole point is that the turn happens over frames in between.
 */
export function smoothBearing(current: number, target: number, smoothing: number): number {
  const alpha = Math.min(1, Math.max(0, smoothing));
  return normaliseBearing(current + bearingDelta(current, target) * alpha);
}

/**
 * The bearing from one point to another, in degrees from north.
 *
 * Rhumb-line arithmetic on a venue-sized box, which is the same simplification
 * `distanceMetres()` already makes and for the same reason: over a kilometre of
 * shopping centre the difference between this and a great circle is smaller
 * than the fix's own error, and a player is being pointed in a direction rather
 * than navigated along a line.
 *
 * The latitude scaling on the longitude term is not optional. Without it the
 * bearing is wrong by the cosine of the latitude — tens of degrees at the
 * latitudes this has run at, which is a different building.
 */
export function bearingTo(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const radians = Math.PI / 180;
  const dLon = (to.lon - from.lon) * Math.cos(((from.lat + to.lat) / 2) * radians);
  const dLat = to.lat - from.lat;
  if (dLon === 0 && dLat === 0) return 0;
  return normaliseBearing(Math.atan2(dLon, dLat) / radians);
}

/**
 * The two rules as one object to hold between frames, because the freeze is
 * stateful — "the last bearing" only exists if something remembers it.
 *
 * Deliberately not a Svelte rune: this is read and written inside a
 * `requestAnimationFrame` loop driving an imperative MapLibre camera (§15.4),
 * and routing 60 writes a second through reactivity to be read back by the same
 * loop buys nothing and costs a re-render per frame.
 */
export class Heading {
  #target: number;
  #current: number;

  constructor(initial = 0) {
    this.#target = normaliseBearing(initial);
    this.#current = this.#target;
  }

  /** What the camera should be set to this frame. */
  get bearing(): number {
    return this.#current;
  }

  /**
   * A course to steer, which outranks the heading while it is set.
   *
   * **R-48 says the bearing follows the heading, and there is no heading.** The
   * measured Traccar Client sends no `bearing` at all, so R-50's filter is fed
   * nothing and navigation mode holds north — a map that never turns. A player
   * who has said where they are going has handed over the one direction that is
   * both known and wanted, so the map turns to put it at the top.
   *
   * It cannot be confused with a heading claim, which is what makes it safe:
   * the player chose the destination, and the line on the map is drawn to the
   * same point the camera is pointing at. When the course is cleared the target
   * falls back to R-50's frozen value with no jump, because both go through the
   * same low-pass.
   */
  #course: number | undefined;

  set course(bearing: number | undefined) {
    this.#course = bearing === undefined ? undefined : normaliseBearing(bearing);
  }

  /** Where it is heading: the course if there is one, else the frozen heading. */
  get target(): number {
    return this.#course ?? this.#target;
  }

  /** Call on every snapshot: a new fix moves the target, or fails to. */
  update(
    position: Pick<ProjectedPosition, 'bearing' | 'speed'> | undefined,
    config: Pick<Game['config'], 'bearingFreezeSpeed'>,
  ): void {
    this.#target = headingTarget(this.#target, position, config);
  }

  /**
   * Call on every frame: one step of the low-pass towards the target.
   *
   * `this.target`, not `this.#target` — the getter is where the course
   * overrides the heading, and reading the field directly is how a course gets
   * set, drawn on the map as a line, and then quietly never steered to.
   */
  step(smoothing: number): number {
    this.#current = smoothBearing(this.#current, this.target, smoothing);
    return this.#current;
  }

  /**
   * Take the filter back from wherever the camera actually is.
   *
   * The other half of letting a player rotate the map by hand. While they own
   * the bearing the loop stops calling `step()`, so `#current` is left at
   * whatever it was before they touched it — and the frame it is handed back,
   * the camera is written with that stale value and **snaps**, which is the one
   * thing R-50.2 says never to do.
   *
   * Only `#current` moves. The target is still the course or the frozen
   * heading, so what happens next is a turn from where the map is to where it
   * should be, at the same rate as every other turn.
   */
  resume(bearing: number): void {
    this.#current = normaliseBearing(bearing);
  }

  /**
   * Overview mode is north up (R-48), and coming back from it should not
   * unwind the whole turn the player never saw. Both values move together, so
   * the next frame has nothing to catch up on.
   */
  reset(bearing: number): void {
    this.#target = normaliseBearing(bearing);
    this.#current = this.#target;
    this.#course = undefined;
  }
}
