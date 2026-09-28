import { describe, expect, it } from 'vitest';

import {
  bearingDelta,
  bearingTo,
  Heading,
  headingTarget,
  normaliseBearing,
  smoothBearing,
} from '../apps/web/src/heading.ts';
import type { Game } from '@q4413/shared';

/**
 * R-50, which is two mandatory rules and one wrap-around that breaks them both
 * if it is got wrong. Tested here rather than through the map for the same
 * reason as frame.ts: what can go wrong is the arithmetic, not the camera.
 */
const CONFIG: Pick<Game['config'], 'bearingFreezeSpeed'> = { bearingFreezeSpeed: 0.5 };

describe('normaliseBearing', () => {
  it('wraps into [0, 360)', () => {
    expect(normaliseBearing(0)).toBe(0);
    expect(normaliseBearing(360)).toBe(0);
    expect(normaliseBearing(370)).toBe(10);
    expect(normaliseBearing(-10)).toBe(350);
    expect(normaliseBearing(-370)).toBe(350);
  });
});

describe('bearingDelta', () => {
  it('takes the short way round the wrap', () => {
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(10, 350)).toBe(-20);
  });

  it('is zero for the same bearing however it is written', () => {
    expect(bearingDelta(90, 90)).toBe(0);
    expect(bearingDelta(90, 450)).toBe(0);
  });

  it('turns clockwise for exactly opposite, rather than either way', () => {
    expect(bearingDelta(0, 180)).toBe(180);
    expect(bearingDelta(180, 0)).toBe(180);
  });
});

describe('headingTarget — R-50.1, the freeze', () => {
  it('takes the bearing of a fix moving above the threshold', () => {
    expect(headingTarget(0, { bearing: 270, speed: 1.4 }, CONFIG)).toBe(270);
  });

  it('holds the last bearing below the threshold', () => {
    expect(headingTarget(270, { bearing: 33, speed: 0.4 }, CONFIG)).toBe(270);
  });

  it('holds it at the threshold itself, which is a floor and not a ceiling', () => {
    expect(headingTarget(270, { bearing: 33, speed: 0.5 }, CONFIG)).toBe(33);
  });

  /**
   * The case that is not hypothetical. The measured Traccar Client sends
   * neither field, so this is what navigation mode actually does today: it
   * points wherever it was pointing and never turns.
   */
  it('holds when the phone sends no speed to check', () => {
    expect(headingTarget(270, { bearing: 33 }, CONFIG)).toBe(270);
  });

  it('holds when the phone sends no bearing', () => {
    expect(headingTarget(270, { speed: 3 }, CONFIG)).toBe(270);
  });

  it('holds when there is no position at all', () => {
    expect(headingTarget(270, undefined, CONFIG)).toBe(270);
  });

  it('normalises a bearing the device wrote past a full turn', () => {
    expect(headingTarget(0, { bearing: 361, speed: 2 }, CONFIG)).toBe(1);
  });
});

describe('smoothBearing — R-50.2, the low-pass', () => {
  it('takes a fraction of the turn, never the whole of it', () => {
    expect(smoothBearing(0, 100, 0.12)).toBeCloseTo(12, 6);
  });

  it('crosses the wrap without going the long way round', () => {
    // The bug this exists to catch: a plain lerp gives 302, pointing south.
    expect(smoothBearing(350, 10, 0.12)).toBeCloseTo(352.4, 6);
  });

  it('converges without overshooting', () => {
    let bearing = 0;
    for (let frame = 0; frame < 60; frame += 1) bearing = smoothBearing(bearing, 90, 0.12);
    expect(bearing).toBeGreaterThan(89.9);
    expect(bearing).toBeLessThanOrEqual(90);
  });

  it('is ~90% of the way there in 18 frames, which is the number in the docblock', () => {
    let bearing = 0;
    for (let frame = 0; frame < 18; frame += 1) bearing = smoothBearing(bearing, 100, 0.12);
    expect(bearing).toBeGreaterThan(89);
    expect(bearing).toBeLessThan(91);
  });

  it('clamps a smoothing outside [0, 1] rather than oscillating', () => {
    expect(smoothBearing(0, 90, 2)).toBe(90);
    expect(smoothBearing(0, 90, -1)).toBe(0);
  });
});

describe('Heading', () => {
  it('holds the target across frames and walks the camera to it', () => {
    const heading = new Heading(0);
    heading.update({ bearing: 90, speed: 2 }, CONFIG);
    expect(heading.target).toBe(90);
    expect(heading.bearing).toBe(0);

    const first = heading.step(0.12);
    expect(first).toBeCloseTo(10.8, 6);
    expect(heading.step(0.12)).toBeGreaterThan(first);
  });

  /** A player stopping mid-turn finishes the turn; it does not stop where it is. */
  it('keeps stepping towards a frozen target after the player stops', () => {
    const heading = new Heading(0);
    heading.update({ bearing: 90, speed: 2 }, CONFIG);
    heading.step(0.12);
    heading.update({ bearing: 300, speed: 0.1 }, CONFIG);
    expect(heading.target).toBe(90);
    for (let frame = 0; frame < 60; frame += 1) heading.step(0.12);
    expect(heading.bearing).toBeCloseTo(90, 1);
  });

  it('reset moves both, so overview → navigation does not unwind a turn', () => {
    const heading = new Heading(0);
    heading.update({ bearing: 200, speed: 2 }, CONFIG);
    heading.reset(0);
    expect(heading.bearing).toBe(0);
    expect(heading.target).toBe(0);
    expect(heading.step(0.12)).toBe(0);
  });
});

describe('bearingTo', () => {
  const at = { lat: 36.6584, lon: -4.4762 };

  it('answers the four cardinals from a venue-sized step', () => {
    expect(bearingTo(at, { lat: at.lat + 0.001, lon: at.lon })).toBeCloseTo(0, 1);
    expect(bearingTo(at, { lat: at.lat, lon: at.lon + 0.001 })).toBeCloseTo(90, 1);
    expect(bearingTo(at, { lat: at.lat - 0.001, lon: at.lon })).toBeCloseTo(180, 1);
    expect(bearingTo(at, { lat: at.lat, lon: at.lon - 0.001 })).toBeCloseTo(270, 1);
  });

  /**
   * The latitude scaling on the longitude term is the whole of this test. A
   * degree of longitude is `cos(lat)` of a degree of latitude, and at Plaza
   * Mayor that is 0,8 — so an unscaled diagonal comes out 37° off, which is a
   * different building.
   */
  it('scales longitude by the latitude, or it points at the wrong building', () => {
    const north = 0.001;
    // The east step that *is* the same distance as the north one at this
    // latitude: a true north-east is 45°.
    const east = north / Math.cos((at.lat * Math.PI) / 180);
    expect(bearingTo(at, { lat: at.lat + north, lon: at.lon + east })).toBeCloseTo(45, 0);
  });

  it('has no opinion about standing on the destination', () => {
    expect(bearingTo(at, at)).toBe(0);
  });
});

describe('Heading — a course outranks the heading', () => {
  /**
   * R-48 says the bearing follows the heading and there is no heading: the
   * measured Traccar Client sends no `bearing`, so R-50's filter is fed nothing
   * and the map holds north. A destination is a direction that is both known
   * and wanted.
   */
  it('steers to the course while one is set, and back after', () => {
    const heading = new Heading(0);
    heading.course = 90;
    expect(heading.target).toBe(90);
    for (let i = 0; i < 80; i += 1) heading.step(0.12);
    expect(heading.bearing).toBeCloseTo(90, 0);

    heading.course = undefined;
    expect(heading.target).toBe(0);
  });

  /**
   * The filter has to be the thing that reads the override, or a course is set,
   * drawn on the map as a line, and quietly never steered to.
   */
  it('puts the course through the low-pass rather than snapping to it', () => {
    const heading = new Heading(0);
    heading.course = 90;
    const first = heading.step(0.12);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(90);
  });

  /** Overview is north up, and coming back from it must not resume a course. */
  it('forgets the course on a reset', () => {
    const heading = new Heading(0);
    heading.course = 200;
    heading.reset(0);
    expect(heading.target).toBe(0);
  });
});

describe('Heading.resume', () => {
  /**
   * The other half of letting a player rotate the map by hand. While they own
   * the bearing the camera loop stops calling `step()`, so `#current` is left
   * where it was before they touched it — and the frame it is handed back, the
   * camera is written with that stale value and snaps, which is the one thing
   * R-50.2 forbids.
   */
  it('takes the filter back from where the camera is, and turns from there', () => {
    const heading = new Heading(0);
    // The camera loop ran for a while, then the player turned the map to 200.
    heading.resume(200);
    expect(heading.bearing).toBe(200);
    // The target is untouched, so what happens next is a turn rather than a jump.
    expect(heading.target).toBe(0);
    const next = heading.step(0.12);
    // Closer to the target than it was, **the short way round** — which from
    // 200° to 0° is clockwise through 280, so the number goes up. Asserting
    // `next < 200` would be asserting the long way and is the same mistake
    // `bearingDelta` exists to stop anybody making.
    expect(Math.abs(bearingDelta(next, 0))).toBeLessThan(Math.abs(bearingDelta(200, 0)));
    expect(next).not.toBe(200);
  });

  it('does not invent a target of its own', () => {
    const heading = new Heading(0);
    heading.course = 90;
    heading.resume(270);
    expect(heading.target).toBe(90);
  });
});
