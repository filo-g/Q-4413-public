import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

import { bearingDegrees, nearestBoundaryPoint } from '@q4413/core';
import type { Polygon, ProjectedPosition } from '@q4413/shared';

/**
 * R-43 — boundary warnings, computed **client-side against the perimeter**, so
 * they work with no network.
 *
 * | Condition | Warning |
 * |---|---|
 * | < 50 m from the boundary, approaching | amber screen edge, short vibration |
 * | outside the perimeter | persistent red edge, long vibration, return arrow |
 *
 * Client-side is the requirement, not an optimisation. A player walking out of
 * the venue is the case where the phone has the least signal and the server has
 * the least chance of telling them — and the server would be telling them about
 * a fix that is already 5 s old by the time it round-trips. Everything here runs
 * off the perimeter polygon the payload already carries and the position the
 * phone already has.
 *
 * §9 puts these **outside the game aesthetic**: this is the one thing on screen
 * that is not part of the fiction, and it must not be mistakable for game
 * content. The values below are what the warning *is*; where it is drawn is the
 * component's business.
 */

/** R-43's band. Inside it and closing, the edge goes amber. */
export const PERIMETER_WARNING_METRES = 50;

/**
 * How much of the fix's own accuracy a closing move has to beat before it
 * counts, and the one number here that is not in R-43.
 *
 * Two, because the comparison is between **two** noisy distances rather than
 * one: the difference of two fixes each carrying error σ carries about 1,4 σ,
 * so a one-σ margin declares an approach on noise roughly a third of the time.
 * Twice the reported accuracy is the smallest claim that survives the measured
 * jitter — 8,4 m median at rest — and it costs about 15 s of walking to
 * establish an approach at 1,4 m/s, which still leaves half the band.
 */
export const APPROACH_NOISE_FACTOR = 2;

export type PerimeterWarning = 'NONE' | 'APPROACHING' | 'OUTSIDE';

/**
 * Vibration patterns, in the shape `navigator.vibrate()` takes. Short for the
 * warning, long for the breach — R-43 distinguishes them, and a player who is
 * running will feel the difference before they can read anything.
 *
 * Fired on entering a state, never repeated per frame or per ping: a buzz every
 * five seconds for as long as somebody stands outside is noise they will learn
 * to ignore, which is the opposite of what the long one is for.
 */
export const PERIMETER_VIBRATION: Record<Exclude<PerimeterWarning, 'NONE'>, number[]> = {
  APPROACHING: [120],
  OUTSIDE: [600],
};

export interface PerimeterState {
  warning: PerimeterWarning;
  /** Metres to the nearest point of the perimeter, in or out. `Infinity` when unknown. */
  metres: number;
  /**
   * Degrees clockwise from north, towards the nearest way back in. Present only
   * when `OUTSIDE` — R-43 asks for the arrow there and nowhere else, and an
   * arrow pointing at the fence from inside would read as an instruction to
   * leave.
   */
  returnBearing?: number;
  /**
   * The furthest the player has been from the boundary since the last time they
   * were moving away from it, and the distance "approaching" is measured
   * against. Carried in the state because a single fix cannot say which way
   * anybody is walking.
   */
  anchorMetres: number;
}

export const PERIMETER_UNKNOWN: PerimeterState = {
  warning: 'NONE',
  metres: Infinity,
  anchorMetres: Infinity,
};

/**
 * The next warning state, from the previous one and a new fix.
 *
 * **"Approaching" is the part that needs the noise handling**, and one
 * measurement is why: a phone sitting still on a table produced 183 m of phantom
 * walking in six minutes, at a median accuracy of 8,4 m. Comparing this fix's distance with the last one's would therefore
 * report a player standing at a fence as approaching it about half the time,
 * and each report is a vibration in their pocket.
 *
 * So the comparison is against an **anchor** — the furthest from the boundary
 * they have been since they were last moving away — and it has to be beaten by
 * more than `APPROACH_NOISE_FACTOR` times the fix's own reported accuracy
 * before it counts as closing. Same reasoning as the zone hold in `zoneAt()`:
 * the fix's own error is the only honest estimate of the noise available, and a
 * claim smaller than it is not a claim.
 *
 * Once amber, the warning **holds until the player leaves the band** rather than
 * re-deciding every ping. A warning that flickers off while somebody is still
 * 20 m from the fence is worse than one that stays on a little too long, and the
 * 50 m band is its own hysteresis — leaving it is unambiguous in a way that a
 * per-ping direction never is.
 *
 * @param position the recipient's own fix, from the payload. `undefined` — no
 *                 position yet, or the feed is dark — warns about nothing:
 *                 there is a difference between "you are inside" and "nobody
 *                 knows", and only the first is safe to draw as calm.
 */
export function nextPerimeterState(
  previous: PerimeterState,
  position: Pick<ProjectedPosition, 'lat' | 'lon' | 'accuracy'> | undefined,
  perimeter: Polygon | readonly Polygon[],
): PerimeterState {
  if (!position) return PERIMETER_UNKNOWN;

  /**
   * A list since R-71: the play area is the union of the open zones, and
   * closing the road between the two towns leaves two islands. **Inside means
   * inside any piece, and the boundary is the nearest edge of any piece** —
   * which is the same arithmetic as the holes this already handled, one level
   * out. One polygon still works, because one is a list of one.
   */
  const pieces: readonly Polygon[] = Array.isArray(perimeter)
    ? perimeter
    : [perimeter as Polygon];

  let nearest: ReturnType<typeof nearestBoundaryPoint> | undefined;
  let inside = false;
  for (const piece of pieces) {
    const candidate = nearestBoundaryPoint(position.lon, position.lat, piece);
    if (candidate && (!nearest || candidate.metres < nearest.metres)) nearest = candidate;
    if (booleanPointInPolygon([position.lon, position.lat], piece)) inside = true;
  }
  // No segments at all is a configuration that has not arrived yet, or every
  // zone closed (R-71) — not a player in danger. Both say the same thing: there
  // is no boundary to be on the wrong side of.
  if (!nearest) return PERIMETER_UNKNOWN;

  /**
   * The breach gets the same hysteresis the approach does, and for a sharper
   * reason: **the boundary is a line, and a fix has an error.**
   *
   * A player standing on it — or 3 m inside it, which is where one of the test
   * profile's POIs sits — lands on either side about half the time at the
   * measured 8,4 m accuracy. Without a band that is a red screen edge and a
   * 600 ms vibration every other ping, for as long as they stand there. The
   * warning that means "you have left the play area" cannot be the warning a
   * player gets for standing at the edge of it.
   *
   * So the line has a width, and the width is the fix's own reported accuracy:
   * crossing it needs the point to be outside by more than its error, and
   * clearing it needs the point to be inside by more than its error. Between
   * the two, whatever was showing stays. A fix that reports no accuracy gets no
   * band, which is the same "no accuracy, no claim" that `zoneAt()` makes.
   */
  const band = position.accuracy || 0;
  const wasOutside = previous.warning === 'OUTSIDE';
  const outside = wasOutside
    ? !(inside && nearest.metres > band)
    : !inside && nearest.metres > band;

  if (outside) {
    return {
      warning: 'OUTSIDE',
      metres: nearest.metres,
      // The arrow points at the nearest way back in even while the fix is
      // technically inside the band — it is the same direction either way, and
      // an arrow that blinks out is worse than one that is briefly redundant.
      returnBearing: bearingDegrees(position, nearest),
      // Outside, the anchor means nothing to measure from: coming back in
      // starts the approach question over rather than resuming it.
      anchorMetres: Infinity,
    };
  }

  const beyondBand = nearest.metres >= PERIMETER_WARNING_METRES;
  if (beyondBand) {
    return { warning: 'NONE', metres: nearest.metres, anchorMetres: nearest.metres };
  }

  // Moving away resets what "closing" is measured from, so a player who
  // approaches, retreats and approaches again is warned both times.
  const anchor = Math.max(
    nearest.metres,
    Number.isFinite(previous.anchorMetres) ? previous.anchorMetres : nearest.metres,
  );
  const closing = anchor - nearest.metres > (position.accuracy || 0) * APPROACH_NOISE_FACTOR;
  const held = previous.warning === 'APPROACHING';

  return {
    warning: closing || held ? 'APPROACHING' : 'NONE',
    metres: nearest.metres,
    anchorMetres: anchor,
  };
}
