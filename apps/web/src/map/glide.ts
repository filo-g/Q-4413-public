import { distanceMetres } from '@q4413/core';

import type { Dot } from './frame.ts';

/**
 * Dots that slide between fixes instead of jumping.
 *
 * A phone reports every five to ten seconds, so a walking player's dot moves in
 * seven-metre steps and reads as a stutter rather than as walking. This is the
 * only thing that changes: **where the dot is drawn**, for under a second after
 * each fix.
 *
 * ## What it must not touch, and does not
 *
 * Everything that is a *claim* keeps the fix's own coordinates. The roster's
 * position, the point card's distance and walk time (R-18, R-44, R-45), R-43's
 * boundary warning, the HUD's QTH, R-12's radius and the zone a player is in
 * all read the payload, not this — and the payload is untouched. A smoothed
 * position that reached any of them would be a number the server never said,
 * arriving where somebody is about to act on it.
 *
 * The uncertainty circle does move with its dot, because it is drawn *around*
 * it: a circle that stayed put while the dot slid out of it would be two claims
 * about one player. Its radius — the part that is a claim — is untouched.
 *
 * ## Why an exponential filter and not a tween
 *
 * Fixes do not arrive on a schedule. A tween needs a duration and an end, and
 * the next fix lands in the middle of it; an exponential approach has no end to
 * interrupt, so a fix arriving early, late or twice in a row is just a new
 * target. It is the same reason R-50's bearing filter is one, and the same
 * reason the camera loop low-passes rather than eases.
 *
 * `alpha` is derived from elapsed time rather than fixed per frame, so the
 * result is the same on a 60 Hz screen and a 120 Hz one — a per-frame constant
 * makes the dot twice as fast on a better phone.
 */

/**
 * The time constant. One `tau` covers 63% of the distance, three covers 95% —
 * so a step finishes in about two thirds of a second.
 *
 * Tuned against the gap it hides rather than by eye. Traccar Client's shortest
 * sane interval is five seconds; a smoothing tail longer than a fraction of
 * that would still be moving when the next fix lands, which is a dot
 * permanently behind its player rather than a dot that stopped jumping.
 */
export const GLIDE_TAU_MS = 220;

/**
 * Past this, the dot is moved rather than slid.
 *
 * A step is only worth smoothing if a person could have taken it. Walking at
 * `walkingSpeed` for a ten-second gap is about fourteen metres, and outdoor GPS
 * jitter adds tens more — so seventy-five metres is comfortably above anything
 * that is still a step, and comfortably below a relocation: a device re-paired
 * to another player, a geo profile changed underneath, a replay cursor seeking
 * across minutes. Sliding a dot through those would draw a walk that never
 * happened, which is the same lie R-55 refuses when it declines to interpolate
 * across a blackout.
 */
export const GLIDE_SNAP_METRES = 75;

/** About a centimetre, well under any fix's own error. */
const SETTLED_DEGREES = 1e-7;

/**
 * The fraction of the remaining distance to cover in `elapsedMs`.
 *
 * Frame-rate independent by construction: two 8 ms frames compose to the same
 * position as one 16 ms frame, because the exponentials multiply.
 */
export function glideAlpha(elapsedMs: number, tauMs: number = GLIDE_TAU_MS): number {
  if (!(elapsedMs > 0) || !(tauMs > 0)) return 0;
  return 1 - Math.exp(-elapsedMs / tauMs);
}

interface Point {
  lon: number;
  lat: number;
}

/**
 * Holds where each dot is currently drawn, keyed the way `Dot` is.
 *
 * Stateful on purpose and deliberately **not** a rune: this is read and written
 * inside a `requestAnimationFrame` loop, and routing sixty writes a second
 * through reactivity would cost a re-render per frame to be read back by the
 * same loop. Same reasoning as `Heading` for R-50.
 */
export class Glide {
  readonly #shown = new Map<string, Point>();

  /** False while any dot is still short of its target. */
  #settled = true;

  get settled(): boolean {
    return this.#settled;
  }

  /**
   * Advance every dot toward its fix and return the dots as they should be
   * drawn now.
   *
   * A key that was not being shown is adopted exactly — a dot has to appear
   * where it is, not slide in from wherever the last one with that key was.
   * Keys that have gone are dropped, or a player who leaves the roster and
   * returns would resume from a stale position.
   */
  step(dots: readonly Dot[], elapsedMs: number): Dot[] {
    const alpha = glideAlpha(elapsedMs);
    const live = new Set<string>();
    let settled = true;

    const out = dots.map((dot) => {
      live.add(dot.key);
      const shown = this.#shown.get(dot.key);
      if (
        !shown ||
        distanceMetres({ lat: shown.lat, lon: shown.lon }, { lat: dot.lat, lon: dot.lon }) >
          GLIDE_SNAP_METRES
      ) {
        this.#shown.set(dot.key, { lon: dot.lon, lat: dot.lat });
        return dot;
      }

      const lon = shown.lon + (dot.lon - shown.lon) * alpha;
      const lat = shown.lat + (dot.lat - shown.lat) * alpha;
      if (
        Math.abs(dot.lon - lon) < SETTLED_DEGREES &&
        Math.abs(dot.lat - lat) < SETTLED_DEGREES
      ) {
        this.#shown.set(dot.key, { lon: dot.lon, lat: dot.lat });
        return dot;
      }

      settled = false;
      this.#shown.set(dot.key, { lon, lat });
      return { ...dot, lon, lat };
    });

    for (const key of this.#shown.keys()) {
      if (!live.has(key)) this.#shown.delete(key);
    }
    this.#settled = settled;
    return out;
  }
}
