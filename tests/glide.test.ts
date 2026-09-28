import { describe, expect, it } from 'vitest';

import { distanceMetres } from '@q4413/core';

import type { Dot } from '../apps/web/src/map/frame.ts';
import { Glide, glideAlpha, GLIDE_SNAP_METRES, GLIDE_TAU_MS } from '../apps/web/src/map/glide.ts';

/**
 * The dot smoother (M9). It exists so a walking player reads as walking rather
 * than as a stutter — a phone reports every five to ten seconds and the dot
 * jumps seven metres at a time.
 *
 * What is tested here is the part that would be wrong quietly: a filter that
 * runs at a different speed on a different screen, and one that slides a dot
 * across a relocation it should have jumped.
 */

const METRES_PER_DEGREE_LAT = 111_132;

function dot(over: Partial<Dot> = {}): Dot {
  return {
    key: 'p1',
    label: 'ALFA',
    lat: 36.6,
    lon: -4.48,
    kind: 'PLAYER',
    state: 'MOVING',
    uncertaintyMetres: 10,
    unlocatable: false,
    eliminated: false,
    ...over,
  };
}

/** North by `metres`, which is the one axis whose degrees do not depend on where you are. */
function north(from: Dot, metres: number): Dot {
  return { ...from, lat: from.lat + metres / METRES_PER_DEGREE_LAT };
}

describe('glideAlpha', () => {
  it('covers 63% of the distance in one time constant', () => {
    expect(glideAlpha(GLIDE_TAU_MS)).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  /**
   * The bug this rules out: a per-frame constant makes the dot arrive twice as
   * fast on a 120 Hz phone as on a 60 Hz one, so the smoothing everybody agreed
   * on is a different smoothing per device. Exponentials compose, so two short
   * frames have to land exactly where one long one does.
   */
  it('is frame-rate independent — two 8 ms frames equal one 16 ms frame', () => {
    const once = glideAlpha(16);
    const twice = 1 - (1 - glideAlpha(8)) * (1 - glideAlpha(8));
    expect(twice).toBeCloseTo(once, 12);
  });

  it('does not move on a zero or backwards frame', () => {
    expect(glideAlpha(0)).toBe(0);
    expect(glideAlpha(-16)).toBe(0);
  });
});

describe('Glide', () => {
  it('adopts a dot it has never seen, rather than sliding it in from nowhere', () => {
    const glide = new Glide();
    const [drawn] = glide.step([dot()], 16);
    expect(drawn?.lat).toBe(36.6);
    expect(glide.settled).toBe(true);
  });

  it('lags behind a step and then arrives', () => {
    const glide = new Glide();
    const start = dot();
    glide.step([start], 0);

    const target = north(start, 10);
    const [first] = glide.step([target], 16);
    expect(first!.lat).toBeGreaterThan(start.lat);
    expect(first!.lat).toBeLessThan(target.lat);
    expect(glide.settled).toBe(false);

    // Three time constants is 95%; a couple of seconds of frames is arrival.
    for (let elapsed = 0; elapsed < 2_000; elapsed += 16) glide.step([target], 16);
    const [last] = glide.step([target], 16);
    expect(last!.lat).toBeCloseTo(target.lat, 9);
    expect(glide.settled).toBe(true);
  });

  /**
   * A step is only worth smoothing if a person could have taken it. Past the
   * threshold the dot is somewhere else — re-paired, a profile changed under it,
   * a replay cursor seeking across minutes — and sliding through that would draw
   * a walk that never happened. R-55 refuses the same thing across a blackout.
   */
  it('jumps rather than slides when the step is longer than anybody walked', () => {
    const glide = new Glide();
    const start = dot();
    glide.step([start], 0);

    const far = north(start, GLIDE_SNAP_METRES + 25);
    const [drawn] = glide.step([far], 16);
    expect(drawn!.lat).toBe(far.lat);
    expect(glide.settled).toBe(true);
  });

  it('slides a step just inside the threshold', () => {
    const glide = new Glide();
    const start = dot();
    glide.step([start], 0);

    const near = north(start, GLIDE_SNAP_METRES - 25);
    const [drawn] = glide.step([near], 16);
    expect(drawn!.lat).toBeLessThan(near.lat);
    expect(glide.settled).toBe(false);
  });

  /**
   * A key that leaves has to be forgotten, or a player removed from the roster
   * and added back resumes from wherever they were — which is a dot sliding
   * across the venue for no reason anybody can see.
   */
  it('forgets a dot that has gone', () => {
    const glide = new Glide();
    const start = dot();
    glide.step([start], 0);
    glide.step([], 16);

    const elsewhere = north(start, 30);
    const [drawn] = glide.step([elsewhere], 16);
    expect(drawn!.lat).toBe(elsewhere.lat);
  });

  it('smooths each dot on its own key', () => {
    const glide = new Glide();
    const a = dot({ key: 'a' });
    const b = dot({ key: 'b', lon: -4.47 });
    glide.step([a, b], 0);

    const moved = north(a, 10);
    const [drawnA, drawnB] = glide.step([moved, b], 16);
    expect(drawnA!.lat).toBeLessThan(moved.lat);
    expect(drawnB!.lat).toBe(b.lat);
    expect(drawnB!.lon).toBe(b.lon);
  });

  /**
   * The smoother may move a dot and nothing else. Everything on the record that
   * is a *claim* — R-12's radius, the link state, R-22's elimination — has to
   * come out of it untouched, because the same object is what the circle and
   * the glyphs are drawn from.
   */
  it('changes the position and no other field', () => {
    const glide = new Glide();
    const start = dot({ uncertaintyMetres: 42, state: 'NO_LINK', eliminated: true });
    glide.step([start], 0);

    const target = north(start, 10);
    const [drawn] = glide.step([target], 16);
    expect(drawn!.uncertaintyMetres).toBe(42);
    expect(drawn!.state).toBe('NO_LINK');
    expect(drawn!.eliminated).toBe(true);
    expect(drawn!.label).toBe('ALFA');
    expect(drawn!.key).toBe('p1');
  });

  /** The tail has to be short enough to finish before the next fix lands. */
  it('is within a metre of the fix well inside a five-second reporting gap', () => {
    const glide = new Glide();
    const start = dot();
    glide.step([start], 0);

    const target = north(start, 14);
    for (let elapsed = 0; elapsed < 1_000; elapsed += 16) glide.step([target], 16);
    const [drawn] = glide.step([target], 16);
    expect(
      distanceMetres({ lat: drawn!.lat, lon: drawn!.lon }, { lat: target.lat, lon: target.lon }),
    ).toBeLessThan(1);
  });
});
