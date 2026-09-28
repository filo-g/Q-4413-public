import { readFileSync } from 'node:fs';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { describe, expect, it } from 'vitest';

import {
  bboxOf,
  metresPerDegree,
  mulberry32,
  parseArgs,
  pointInRing,
  pointOutsideRing,
  randomPointInRing,
  ringOf,
  rolesFor,
  walkStep,
  zoneRing,
} from '../tools/fake-phones.mjs';

/**
 * The emitter carries its own point-in-polygon so it can run against a deployed
 * environment with nothing but `node`. This suite is the price of that
 * duplication: the copy is checked against turf, which is what the server uses.
 */
const geojson = JSON.parse(
  readFileSync(new URL('../packages/shared/geo/madrid.geojson', import.meta.url), 'utf8'),
);
const perimeter = ringOf(geojson, 'PERIMETER') as Array<[number, number]>;
const ingestArea = ringOf(geojson, 'INGEST_AREA') as Array<[number, number]>;

/** The tool is plain JS, so its return types come back loose. */
const somewhereInside = (random: () => number): [number, number] =>
  randomPointInRing(perimeter, random) as [number, number];
const perimeterPolygon = { type: 'Polygon' as const, coordinates: [perimeter] };

describe('pointInRing agrees with turf', () => {
  it('over a 40x40 grid across the perimeter bbox', () => {
    const [minLon, minLat, maxLon, maxLat] = bboxOf(perimeter) as [number, number, number, number];
    let checked = 0;
    let inside = 0;

    /**
     * Padded past the bbox and sampled at cell centres, which is two decisions
     * and both are load-bearing. A ring that *is* its own bbox — the bundled
     * profiles are rectangles — would otherwise put every edge sample exactly on
     * the boundary, where a ray cast and turf are each entitled to answer either
     * way; and a grid confined to the bbox of such a ring is all-inside, which a
     * constant-true implementation passes. The padding is what puts points on
     * the far side of the ring into the grid at all.
     */
    const padding = 0.1;
    const width = maxLon - minLon;
    const height = maxLat - minLat;

    for (let i = 0; i <= 40; i += 1) {
      for (let j = 0; j <= 40; j += 1) {
        const point: [number, number] = [
          minLon - padding * width + width * (1 + 2 * padding) * ((i + 0.5) / 41),
          minLat - padding * height + height * (1 + 2 * padding) * ((j + 0.5) / 41),
        ];
        const mine = pointInRing(point, perimeter);
        const turf = booleanPointInPolygon(point, perimeterPolygon);
        expect(mine, `disagreement at ${point.join(',')}`).toBe(turf);
        checked += 1;
        if (mine) inside += 1;
      }
    }

    expect(checked).toBe(41 * 41);
    // And the padding did its job: the grid holds points on both sides of the ring.
    expect(inside).toBeLessThan(checked);
    // Sanity: the shape covers a meaningful part of its bbox, so a
    // constant-false implementation cannot pass this suite.
    expect(inside).toBeGreaterThan(100);
  });
});

describe('mulberry32', () => {
  it('is deterministic for a seed', () => {
    const a = mulberry32(4413);
    const b = mulberry32(4413);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('differs between seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('stays in [0, 1)', () => {
    const random = mulberry32(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('randomPointInRing', () => {
  it('only returns points inside', () => {
    const random = mulberry32(99);
    for (let i = 0; i < 200; i += 1) {
      expect(booleanPointInPolygon(somewhereInside(random), perimeterPolygon)).toBe(true);
    }
  });
});

describe('walkStep', () => {
  it('never leaves the perimeter over a long walk', () => {
    const random = mulberry32(4413);
    const [startLon, startLat] = somewhereInside(random);
    let state = { lon: startLon, lat: startLat, heading: 0 };

    for (let i = 0; i < 1000; i += 1) {
      state = walkStep(state, { ring: perimeter, metres: 14, random });
      expect(
        booleanPointInPolygon([state.lon, state.lat], perimeterPolygon),
        `left the perimeter at step ${i}`,
      ).toBe(true);
    }
  });

  it('actually moves, roughly by the requested distance', () => {
    const random = mulberry32(5);
    const [lon, lat] = somewhereInside(random);
    const start = { lon, lat, heading: 90 };
    const next = walkStep(start, { ring: perimeter, metres: 14, random });

    const scale = metresPerDegree(lat);
    const moved = Math.hypot(
      (next.lon - start.lon) * scale.lon,
      (next.lat - start.lat) * scale.lat,
    );
    expect(moved).toBeGreaterThan(13);
    expect(moved).toBeLessThan(15);
  });
});

describe('pointOutsideRing', () => {
  it('is outside the ingest area, so R-04 has something to reject', () => {
    const point = pointOutsideRing(ingestArea) as [number, number];
    expect(pointInRing(point, ingestArea)).toBe(false);
    expect(
      booleanPointInPolygon(point, { type: 'Polygon', coordinates: [ingestArea] }),
    ).toBe(false);
  });
});

describe('zoneRing', () => {
  /**
   * The point of placing a device in a zone is that it stays in it: §4 decides
   * who sees whom by zone, so a device that wandered out would answer a
   * visibility question with wherever it happened to be by the time somebody
   * looked. A zone ring inside the perimeter is what makes that hold — the walk
   * turns around at the ring it was given.
   */
  it('returns a ring that lies inside the perimeter', () => {
    const ring = zoneRing(geojson, 'zone-norte-este') as Array<[number, number]>;
    expect(ring.length).toBeGreaterThan(3);
    for (const point of ring) {
      expect(booleanPointInPolygon(point, perimeterPolygon)).toBe(true);
    }
  });

  it('puts a random point for that zone inside that zone', () => {
    const ring = zoneRing(geojson, 'zone-norte-este') as Array<[number, number]>;
    const point = randomPointInRing(ring, mulberry32(7)) as [number, number];
    expect(booleanPointInPolygon(point, { type: 'Polygon', coordinates: [ring] })).toBe(true);
  });

  /**
   * Loudly, and with the list. A typo falling back to the perimeter would put
   * the device anywhere at all, and the run would read as the zone rules
   * failing rather than as the tool being told the wrong thing.
   */
  it('refuses a zone that is not there, and says which are', () => {
    expect(() => zoneRing(geojson, 'zone-nowhere')).toThrow(/no zone zone-nowhere/);
    expect(() => zoneRing(geojson, 'zone-nowhere')).toThrow(/zone-norte-este/);
  });
});

describe('rolesFor', () => {
  it('spreads the interesting states across six devices in mixed', () => {
    const roles = rolesFor('mixed', ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(roles).toEqual(['walk', 'walk', 'walk', 'stationary', 'nolink', 'outside']);
  });

  it('gives every device the same role for a single scenario', () => {
    expect(rolesFor('walk', ['a', 'b'])).toEqual(['walk', 'walk']);
  });

  it('degrades sensibly with one device', () => {
    expect(rolesFor('mixed', ['only'])).toEqual(['walk']);
  });
});

describe('parseArgs', () => {
  it('parses numbers as numbers', () => {
    const options = parseArgs(['--devices', '3', '--interval', '5']);
    expect(options.devices).toBe(3);
    expect(options.interval).toBe(5);
  });

  it('reads flags', () => {
    const options = parseArgs(['--once', '--no-activity', '--quiet']);
    expect(options.once).toBe(true);
    expect(options.activity).toBe(false);
    expect(options.quiet).toBe(true);
  });

  it('takes the zone list as a string, positional against --ids', () => {
    expect(parseArgs(['--zones', 'zone-norte-este,zone-sur-oeste']).zones).toBe(
      'zone-norte-este,zone-sur-oeste',
    );
    expect(parseArgs([]).zones).toBe('');
  });

  it('rejects an unknown option rather than ignoring it', () => {
    expect(() => parseArgs(['--nope', '1'])).toThrow(/unknown option/);
  });

  it('rejects a non-numeric value for a numeric option', () => {
    expect(() => parseArgs(['--interval', 'soon'])).toThrow(/needs a number/);
  });

  it('rejects a bare argument', () => {
    expect(() => parseArgs(['oops'])).toThrow(/unexpected argument/);
  });
});
