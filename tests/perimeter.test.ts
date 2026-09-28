import { describe, expect, it } from 'vitest';

import { bearingDegrees, distanceToBoundaryMetres, nearestBoundaryPoint } from '@q4413/core';
import {
  nextPerimeterState,
  PERIMETER_UNKNOWN,
  PERIMETER_WARNING_METRES,
  type PerimeterState,
} from '../apps/web/src/perimeter.ts';
import type { Polygon } from '@q4413/shared';

/**
 * R-43. The interesting half is not the threshold — it is "approaching", which
 * a single fix cannot answer and GPS noise answers wrongly about half the time
 * if asked naively.
 */

/** Metres per degree at the venue's latitude, matching geometry.ts's plane. */
const LAT = 36.65;
const METRES_PER_DEG_LAT = 111_132;
const METRES_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);

/** A square roughly 1 km on a side, centred on the venue's latitude. */
const half = 500;
const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-half / METRES_PER_DEG_LON, LAT - half / METRES_PER_DEG_LAT],
      [half / METRES_PER_DEG_LON, LAT - half / METRES_PER_DEG_LAT],
      [half / METRES_PER_DEG_LON, LAT + half / METRES_PER_DEG_LAT],
      [-half / METRES_PER_DEG_LON, LAT + half / METRES_PER_DEG_LAT],
      [-half / METRES_PER_DEG_LON, LAT - half / METRES_PER_DEG_LAT],
    ],
  ],
};

/** A fix `metresFromEast` inside the eastern edge, on the centre line. */
const insideBy = (metres: number, accuracy = 0) => ({
  lat: LAT,
  lon: (half - metres) / METRES_PER_DEG_LON,
  accuracy,
});

const outsideBy = (metres: number, accuracy = 0) => ({
  lat: LAT,
  lon: (half + metres) / METRES_PER_DEG_LON,
  accuracy,
});

const step = (previous: PerimeterState, position: ReturnType<typeof insideBy>): PerimeterState =>
  nextPerimeterState(previous, position, square);

describe('nearestBoundaryPoint', () => {
  it('lands on the nearest edge and agrees with the distance', () => {
    const nearest = nearestBoundaryPoint(insideBy(40).lon, LAT, square);
    expect(nearest).toBeDefined();
    expect(nearest!.metres).toBeCloseTo(40, 0);
    expect(nearest!.lat).toBeCloseTo(LAT, 6);
    expect(distanceToBoundaryMetres(insideBy(40).lon, LAT, square)).toBeCloseTo(40, 0);
  });

  it('measures to a corner rather than to the infinite line beyond it', () => {
    // North-east of the corner: both edges run away from it, so the answer is
    // the corner itself and not the projection onto either edge.
    const lon = (half + 30) / METRES_PER_DEG_LON;
    const lat = LAT + (half + 40) / METRES_PER_DEG_LAT;
    expect(distanceToBoundaryMetres(lon, lat, square)).toBeCloseTo(50, 0);
  });

  it('is undefined for a polygon with no segments, and Infinity in metres', () => {
    const empty: Polygon = { type: 'Polygon', coordinates: [] };
    expect(nearestBoundaryPoint(0, LAT, empty)).toBeUndefined();
    expect(distanceToBoundaryMetres(0, LAT, empty)).toBe(Infinity);
  });
});

describe('bearingDegrees', () => {
  it('reads clockwise from north', () => {
    const from = { lat: LAT, lon: 0 };
    expect(bearingDegrees(from, { lat: LAT + 0.01, lon: 0 })).toBeCloseTo(0, 3);
    expect(bearingDegrees(from, { lat: LAT, lon: 0.01 })).toBeCloseTo(90, 3);
    expect(bearingDegrees(from, { lat: LAT - 0.01, lon: 0 })).toBeCloseTo(180, 3);
    expect(bearingDegrees(from, { lat: LAT, lon: -0.01 })).toBeCloseTo(270, 3);
  });

  it('answers 0 rather than NaN for a point on top of itself', () => {
    expect(bearingDegrees({ lat: LAT, lon: 0 }, { lat: LAT, lon: 0 })).toBe(0);
  });
});

describe('nextPerimeterState — R-43', () => {
  it('says nothing well inside the perimeter', () => {
    const state = step(PERIMETER_UNKNOWN, insideBy(400));
    expect(state.warning).toBe('NONE');
    expect(state.metres).toBeCloseTo(400, 0);
  });

  it('warns nothing about a player it has no position for', () => {
    expect(nextPerimeterState(PERIMETER_UNKNOWN, undefined, square)).toEqual(PERIMETER_UNKNOWN);
  });

  it('does not warn on the first fix inside the band, having seen no movement', () => {
    // One fix cannot say which way anybody is walking, and R-43 asks for
    // "approaching" rather than "near".
    expect(step(PERIMETER_UNKNOWN, insideBy(30)).warning).toBe('NONE');
  });

  it('goes amber once the player has closed on the boundary inside the band', () => {
    let state = step(PERIMETER_UNKNOWN, insideBy(45));
    expect(state.warning).toBe('NONE');
    state = step(state, insideBy(20));
    expect(state.warning).toBe('APPROACHING');
  });

  it('holds amber while they stay in the band, rather than flickering', () => {
    let state = step(PERIMETER_UNKNOWN, insideBy(45));
    state = step(state, insideBy(20));
    expect(state.warning).toBe('APPROACHING');
    // Walking back out a little is still inside the band, and R-43's warning is
    // about where they are, not about the last five seconds.
    state = step(state, insideBy(35));
    expect(state.warning).toBe('APPROACHING');
  });

  it('clears once they leave the band', () => {
    let state = step(PERIMETER_UNKNOWN, insideBy(45));
    state = step(state, insideBy(20));
    state = step(state, insideBy(PERIMETER_WARNING_METRES + 5));
    expect(state.warning).toBe('NONE');
  });

  /**
   * The measured case: a phone still on a table walks 183 m of phantom path in
   * six minutes at 8,4 m median accuracy. Every one of these fixes is "closer
   * than the last one" half the time.
   */
  it('does not warn a player standing still on noise the size of their own accuracy', () => {
    let state = step(PERIMETER_UNKNOWN, insideBy(30, 8.4));
    for (const jitter of [-6, 4, -7, 5, -3, 6, -8, 2]) {
      state = step(state, insideBy(30 + jitter, 8.4));
      expect(state.warning).toBe('NONE');
    }
  });

  /** 1,4 m/s over 5 s pings: three of them, ~15 s, against 8,4 m of noise. */
  it('still warns a walker whose steps beat twice their own accuracy', () => {
    let state = step(PERIMETER_UNKNOWN, insideBy(45, 8.4));
    state = step(state, insideBy(38, 8.4)); // 7 m, inside the noise
    expect(state.warning).toBe('NONE');
    state = step(state, insideBy(31, 8.4)); // 14 m closed, still under 16,8
    expect(state.warning).toBe('NONE');
    state = step(state, insideBy(24, 8.4)); // 21 m from the anchor, beyond it
    expect(state.warning).toBe('APPROACHING');
  });

  /**
   * Walking into the band is itself an approach — the closure happened outside
   * it — so the warning arrives on the fix that enters rather than one ping
   * later. Only a player with no history behind them gets the benefit of the
   * doubt.
   */
  it('warns on entering the band from a fix that was further out', () => {
    let state = step(PERIMETER_UNKNOWN, insideBy(80, 5));
    expect(state.warning).toBe('NONE');
    state = step(state, insideBy(45, 5));
    expect(state.warning).toBe('APPROACHING');
  });

  it('re-arms after the player leaves the band and closes on it again', () => {
    let state = step(PERIMETER_UNKNOWN, insideBy(45, 5));
    state = step(state, insideBy(20, 5));
    expect(state.warning).toBe('APPROACHING');
    state = step(state, insideBy(80, 5)); // out of the band, cleared
    expect(state.warning).toBe('NONE');
    state = step(state, insideBy(70, 5)); // still out of it
    expect(state.warning).toBe('NONE');
    state = step(state, insideBy(25, 5));
    expect(state.warning).toBe('APPROACHING');
  });

  /**
   * Not tested here but decided with it: the player view only asks this
   * question while the game is IN_PROGRESS or PAUSED. Setup happens at home and
   * in the car, which are outside the perimeter, and a red edge through the
   * whole of preparation teaches the player to ignore it — the same reasoning
   * R-04 gives for not applying the geofence then.
   */
  it('goes red outside the perimeter, with an arrow back in', () => {
    const state = step(PERIMETER_UNKNOWN, outsideBy(40));
    expect(state.warning).toBe('OUTSIDE');
    expect(state.metres).toBeCloseTo(40, 0);
    // Due east of the eastern edge, so the way back is due west.
    expect(state.returnBearing).toBeCloseTo(270, 0);
  });

  it('carries no return arrow while inside, which would read as an instruction to leave', () => {
    expect(step(PERIMETER_UNKNOWN, insideBy(10)).returnBearing).toBeUndefined();
  });

  /**
   * The case the test geometry produced: `La Trampa Studio` sits 3 m inside the
   * perimeter, and the measured accuracy at rest is 8,4 m. Without a band that
   * is a red edge and a 600 ms vibration every other ping, for as long as a
   * player stands at their own base.
   */
  it('does not flicker for a player standing on the line', () => {
    let state = step(PERIMETER_UNKNOWN, insideBy(3, 8.4));
    expect(state.warning).toBe('NONE');
    for (const metres of [-4, 2, -6, 1, -5, 4]) {
      // Negative is outside, and every one of these is inside the fix's own error.
      const position = metres < 0 ? outsideBy(-metres, 8.4) : insideBy(metres, 8.4);
      state = step(state, position);
      expect(state.warning).toBe('NONE');
    }
  });

  it('still declares a breach once they are outside by more than their error', () => {
    let state = step(PERIMETER_UNKNOWN, insideBy(3, 8.4));
    state = step(state, outsideBy(6, 8.4));
    expect(state.warning).toBe('NONE');
    state = step(state, outsideBy(30, 8.4));
    expect(state.warning).toBe('OUTSIDE');
  });

  it('holds the breach until they are back inside by more than their error', () => {
    let state = step(PERIMETER_UNKNOWN, outsideBy(40, 8.4));
    expect(state.warning).toBe('OUTSIDE');
    state = step(state, insideBy(4, 8.4)); // inside, but inside the noise
    expect(state.warning).toBe('OUTSIDE');
    state = step(state, insideBy(20, 8.4));
    expect(state.warning).not.toBe('OUTSIDE');
  });

  it('has no band at all for a fix that reports no accuracy', () => {
    const state = step(PERIMETER_UNKNOWN, outsideBy(1));
    expect(state.warning).toBe('OUTSIDE');
  });

  it('starts the approach question over on coming back in', () => {
    let state = step(PERIMETER_UNKNOWN, outsideBy(20));
    expect(state.warning).toBe('OUTSIDE');
    state = step(state, insideBy(30));
    expect(state.warning).toBe('NONE');
  });
});
