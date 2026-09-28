import { describe, expect, it } from 'vitest';

import {
  CORNER_MAX_MS,
  CORNER_MIN_MS,
  IDLE_MS,
  isCorner,
  MAX_CROSSINGS,
  MIN_CELLS,
  type Path,
  pathFor,
  positionAt,
  RATIO_TOLERANCE,
  REARM_MS,
  SPEED_PX_PER_S,
} from '../apps/web/src/chrome/screensaver.ts';

/**
 * R-67's bounce. Everything worth asserting about a screensaver is arithmetic:
 * none of it is visible in review, and the two things that went wrong here both
 * took one glance at a real screen and would have taken a very long time to
 * find any other way.
 *
 * A spread of tube sizes to run every property against — a laptop, a desktop,
 * a master's phone held the short way, the big screens where the corner's
 * deadline is the constraint that bites, and four deliberately awkward shapes.
 * The awkward ones are not padding: an extreme aspect is what exhausted the
 * fraction search at `MAX_CROSSINGS = 12` and produced the sparse figure the
 * density floor exists to prevent.
 */
const TUBES = [
  { name: 'laptop', width: 1440, height: 780 },
  { name: 'desktop', width: 2560, height: 1330 },
  { name: 'phone', width: 390, height: 780 },
  { name: 'square', width: 900, height: 900 },
  { name: 'letterbox', width: 1920, height: 420 },
  { name: '4K', width: 3840, height: 2160 },
  { name: '5K', width: 5120, height: 2880 },
  { name: 'slit', width: 2560, height: 300 },
  { name: 'column', width: 420, height: 1600 },
] as const;

/**
 * The drawing at a plausible rendered size: 29 columns by 15 rows at an aspect
 * of 1,92, which at the component's clamped font size is about this on a laptop
 * and a little more on a desktop. It is a fixture rather than a measurement —
 * nothing here can render — and the properties below hold for any of them.
 */
const MARK = { width: 135, height: 134 };

/** `a` and `b` back out of a path: the corner counted in each axis's crossings. */
function terms(path: Path): { a: number; b: number } {
  return { a: Math.round(path.cornerMs / path.yMs), b: Math.round(path.cornerMs / path.xMs) };
}

/**
 * How much of the box a whole period actually touches, as cells of an 8 x 8
 * grid. This is the behavioural version of `MIN_CELLS` — it samples the real
 * trajectory instead of trusting the fraction it was built from.
 */
function coverage(path: Path, grid = 8): number {
  const seen = new Set<string>();
  for (let ms = 0; ms < path.cornerMs * 2; ms += 20) {
    const at = positionAt(path, ms);
    const x = Math.min(grid - 1, Math.floor((at.x / path.travel.width) * grid));
    const y = Math.min(grid - 1, Math.floor((at.y / path.travel.height) * grid));
    seen.add(`${x},${y}`);
  }
  return seen.size;
}

describe('pathFor', () => {
  /**
   * **The whole reason this file exists.**
   *
   * A DVD logo in a box is folklore for one reason, and it is the corner. A
   * velocity pair chosen by eye almost never lands on one — the two axes have to
   * come back into phase, and for an arbitrary ratio of crossing times they
   * never do. `pathFor` snaps the ratio to a fraction precisely so that they
   * must, and this is the assertion that says they do.
   */
  it.each(TUBES)('reaches a corner, on $name', (tube) => {
    const path = pathFor(tube, MARK);
    expect(path).not.toBeNull();
    if (!path) return;

    for (let visit = 1; visit <= 4; visit += 1) {
      const at = positionAt(path, path.cornerMs * visit);
      expect(isCorner(path, at), `visit ${visit} landed at ${at.x},${at.y}`).toBe(true);
    }
  });

  /**
   * **The bug a screen found in four seconds, and the reason the search ranks by
   * density rather than by accuracy.**
   *
   * Snapping to the *nearest* fraction gives the smallest terms, and the
   * smallest terms are degenerate: `1/1` is the pure diagonal — corner to
   * opposite corner and back, for ever — and `2/1` is a chevron that touches a
   * corner every other crossing. Both are closed figures covering a fraction of
   * the glass, and both are what a near-square or laptop-shaped tube produced.
   *
   * The numbers below are measured rather than chosen: on an 8 x 8 grid the
   * diagonal touches 8 cells and the chevron 19, while every real path here
   * touches 44 or more. Nothing sits in the gap.
   */
  it.each(TUBES)('never collapses to a diagonal or a chevron, on $name', (tube) => {
    const path = pathFor(tube, MARK);
    expect(path).not.toBeNull();
    if (!path) return;

    const { a, b } = terms(path);
    expect(`${a}/${b}`).not.toBe('1/1');
    expect(a * b).toBeGreaterThanOrEqual(MIN_CELLS);
    expect(coverage(path), `${a}/${b} covers too little of the box`).toBeGreaterThanOrEqual(40);
  });

  /**
   * And the corner has to be **rare**, which is the other half of the same
   * mistake. A logo that lands in a corner every fifteen seconds is not
   * folklore, it is a screen test — the joke is the wait.
   *
   * The deadline is the soft one: on a screen big enough that no dense fraction
   * fits inside it, `MIN_CELLS` wins and the corner is late. That is the
   * documented trade and the 5K is the case that takes it, so this asserts the
   * floor everywhere and allows the ceiling to be overrun.
   */
  it.each(TUBES)('makes the corner rare, on $name', (tube) => {
    const path = pathFor(tube, MARK);
    expect(path).not.toBeNull();
    if (!path) return;

    // Or as rare as the tube allows: a 300 px-tall window crosses in two
    // seconds and `MAX_CROSSINGS` of those is half a minute, so on a shape like
    // that the floor is unreachable rather than missed.
    expect(path.cornerMs).toBeGreaterThanOrEqual(
      Math.min(CORNER_MIN_MS, path.yMs * MAX_CROSSINGS) - 1e-9,
    );
    expect(path.cornerMs).toBeLessThanOrEqual(CORNER_MAX_MS * 1.5);
  });

  /**
   * The corner has to be a whole number of half-crossings on **both** axes, not
   * an accident at one instant. Checking the ratio is what says the property
   * is structural: `cornerMs` is a whole multiple of each crossing time.
   */
  it.each(TUBES)('is a common multiple of both crossings, on $name', (tube) => {
    const path = pathFor(tube, MARK);
    if (!path) return;
    for (const period of [path.xMs, path.yMs]) {
      const multiple = path.cornerMs / period;
      expect(Math.abs(multiple - Math.round(multiple))).toBeLessThan(1e-9);
    }
    const { a, b } = terms(path);
    expect(a).toBeLessThanOrEqual(MAX_CROSSINGS);
    expect(b).toBeLessThanOrEqual(MAX_CROSSINGS);
  });

  /**
   * Density is bought with speed, and this is the price tag. `RATIO_TOLERANCE`
   * is what the search is allowed to spend; a change that quietly spends more
   * turns a bounce into something that visibly hurries on one axis.
   */
  it.each(TUBES)('stays within the speed tolerance it is allowed, on $name', (tube) => {
    const path = pathFor(tube, MARK);
    if (!path) return;
    const ideal = Math.max(2000, (path.travel.width / SPEED_PX_PER_S) * 1000);
    expect(Math.abs(path.xMs / ideal - 1)).toBeLessThanOrEqual(RATIO_TOLERANCE + 1e-9);
  });

  /**
   * A mark bigger than the tube is a master's phone held the wrong way, not a
   * fault. `null` is the answer the component reads as "centre it and leave it",
   * and the alternative — a travel box of zero with a crossing time derived from
   * it — is a division nobody wants to find at three in the morning.
   */
  it('has no path when there is no room to move', () => {
    expect(pathFor({ width: 120, height: 120 }, MARK)).toBeNull();
    expect(pathFor({ width: 0, height: 0 }, MARK)).toBeNull();
  });

  /** One axis with no room is still a path: it slides along the other one. */
  it('bounces on one axis when only one has room', () => {
    const path = pathFor({ width: 1440, height: 134 }, MARK);
    expect(path).not.toBeNull();
    if (!path) return;
    expect(path.travel.height).toBe(0);
    expect(path.travel.width).toBeGreaterThan(0);
    const at = positionAt(path, path.cornerMs / 2);
    expect(at.y).toBe(0);
  });
});

describe('positionAt', () => {
  const path = pathFor(TUBES[0], MARK);

  /** Never off the glass, at any instant, at any phase. */
  it('stays inside the travel box', () => {
    expect(path).not.toBeNull();
    if (!path) return;
    for (const phase of [0, 1_234, 40_000, path.cornerMs * 0.37]) {
      for (let ms = 0; ms < 20 * 60 * 1000; ms += 137) {
        const at = positionAt(path, ms, phase);
        expect(at.x).toBeGreaterThanOrEqual(-1e-9);
        expect(at.y).toBeGreaterThanOrEqual(-1e-9);
        expect(at.x).toBeLessThanOrEqual(path.travel.width + 1e-9);
        expect(at.y).toBeLessThanOrEqual(path.travel.height + 1e-9);
      }
    }
  });

  /**
   * **The phase shifts the clock, not the axes**, and that is the only reason it
   * is allowed to exist. One offset added to both waves moves where on the path
   * the mark starts without moving the path, so the corner still arrives —
   * shifted by the same offset. Two independent offsets would be a different
   * trajectory with no corners in it at all, which is the mistake this asserts
   * against.
   */
  it('keeps the corner whatever phase it is given', () => {
    expect(path).not.toBeNull();
    if (!path) return;
    for (const phase of [0, 950, 12_345, path.cornerMs * 0.61, path.cornerMs * 1.4]) {
      const at = positionAt(path, path.cornerMs - phase, phase);
      expect(isCorner(path, at), `phase ${phase} missed the corner`).toBe(true);
    }
  });

  /**
   * And it has to actually start somewhere else. Zero phase starts the mark in a
   * corner, which opens with the payoff and then makes the viewer wait for a
   * repeat of what they have already seen — so the component picks an offset,
   * and almost every offset has to put it somewhere along the path instead.
   */
  it('starts away from a corner at almost every phase', () => {
    expect(path).not.toBeNull();
    if (!path) return;
    let inCorner = 0;
    const samples = 200;
    for (let i = 0; i < samples; i += 1) {
      if (isCorner(path, positionAt(path, 0, (path.cornerMs * i) / samples))) inCorner += 1;
    }
    expect(inCorner / samples).toBeLessThan(0.05);
  });

  /**
   * It is a function of the clock, not an integration. A dropped frame, a tab
   * hidden for an hour and a scrub all have to land in the same place, which is
   * only true if asking twice gives the same answer — and if asking once at
   * `t` equals asking after any number of intervening calls.
   */
  it('is a pure function of elapsed time', () => {
    expect(path).not.toBeNull();
    if (!path) return;
    const direct = positionAt(path, 987_654);
    for (let ms = 0; ms < 987_654; ms += 16) positionAt(path, ms);
    expect(positionAt(path, 987_654)).toEqual(direct);
  });

  /** A whole period is a whole period: the path repeats rather than drifting. */
  it('repeats exactly', () => {
    expect(path).not.toBeNull();
    if (!path) return;
    const period = path.cornerMs * 2;
    for (const ms of [0, 1234, 45_678, 200_000]) {
      const here = positionAt(path, ms);
      const later = positionAt(path, ms + period);
      expect(later.x).toBeCloseTo(here.x, 6);
      expect(later.y).toBeCloseTo(here.y, 6);
    }
  });
});

describe('the timings', () => {
  /**
   * The parked note said two to five minutes; a minute is what it turned out to
   * want in front of a real panel, because being caught reading the map costs
   * one movement of the pointer and three minutes of a still bright map costs
   * exactly what the thing exists to prevent.
   *
   * The bounds are still bounds. Under half a minute it would fire while
   * somebody is reading a roster, and past five the panel has already burned
   * for most of the time it was going to.
   */
  it('waits between half a minute and five', () => {
    expect(IDLE_MS).toBeGreaterThanOrEqual(30 * 1000);
    expect(IDLE_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  /**
   * `REARM_MS` is what keeps idle detection a timestamp and a timeout rather
   * than a tick, and it buys that at the price of slack on the delay. It has to
   * stay small enough for the slack to be invisible against `IDLE_MS`.
   */
  it('re-arms rarely enough to be cheap and often enough to be invisible', () => {
    expect(REARM_MS).toBeGreaterThanOrEqual(250);
    // Under a thirtieth of the delay, so the slack it buys stays well inside
    // the rounding anybody would apply to "about a minute".
    expect(REARM_MS).toBeLessThanOrEqual(IDLE_MS / 30);
  });

  /** The corner's window has to be a window. */
  it('leaves room between the corner bounds', () => {
    expect(CORNER_MIN_MS).toBeLessThan(CORNER_MAX_MS);
  });
});
