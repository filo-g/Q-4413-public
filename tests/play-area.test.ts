import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { gameGeoFromGeoJson, playAreaOf } from '@q4413/core';
import type { GameGeoJson, Zone } from '@q4413/shared';

/**
 * R-71's boundary: where play stops, as against where the map does.
 *
 * `Game.geo.perimeter` is the whole recinto and **does not move** — it is what
 * `pmtiles extract` was given (§14.2), and an archive that shrank with a
 * master's decision would be a download the phones cannot redo at the venue.
 * This is the other one, and it is derived from the open zones rather than
 * drawn, which is what makes ground inside the boundary and inside no zone
 * impossible: under §4 that is a player nobody can see who can see nobody.
 */
const load = (profile: string) =>
  gameGeoFromGeoJson(
    JSON.parse(
      readFileSync(new URL(`../packages/shared/geo/${profile}.geojson`, import.meta.url), 'utf8'),
    ) as GameGeoJson,
  );

const square = (west: number, south: number, side: number): Zone['geometry'] => ({
  type: 'Polygon',
  coordinates: [
    [
      [west, south],
      [west + side, south],
      [west + side, south + side],
      [west, south + side],
      [west, south],
    ],
  ],
});

const zone = (id: string, west: number, south: number, side = 0.01): Zone => ({
  id,
  name: id,
  geometry: square(west, south, side),
  sector: id,
});

describe('playAreaOf — R-71', () => {
  it('is one piece when the open zones touch', () => {
    const zones = [zone('a', 0, 0), zone('b', 0.01, 0)];
    const area = playAreaOf(zones, []);
    expect(area).toHaveLength(1);
    expect(area[0]?.coordinates).toHaveLength(1);
  });

  /**
   * Two islands, and the case that decided the return type. A geometry whose two
   * halves are joined by a single zone — a road between two towns, drawn as a
   * sector of its own precisely so a master may shut it — comes apart the moment
   * that zone closes. A single `Polygon` could not describe the result, and a
   * `MultiPolygon` would make every consumer special-case a second shape.
   */
  it('is two pieces when what joined them is closed', () => {
    const zones = [zone('west', 0, 0), zone('road', 0.01, 0), zone('east', 0.02, 0)];
    expect(playAreaOf(zones, [])).toHaveLength(1);
    expect(playAreaOf(zones, ['road'])).toHaveLength(2);
  });

  /** A closed zone in the middle is a hole, not a smaller boundary. */
  it('leaves a hole where an interior zone closes', () => {
    const ring = [zone('mid', 0.01, 0.01)];
    for (let x = 0; x <= 2; x += 1) {
      for (let y = 0; y <= 2; y += 1) {
        if (x === 1 && y === 1) continue;
        ring.push(zone(`r${x}${y}`, x * 0.01, y * 0.01));
      }
    }
    const holed = playAreaOf(ring, ['mid']);
    expect(holed).toHaveLength(1);
    expect(holed[0]?.coordinates.length).toBeGreaterThan(1);
  });

  /**
   * Every zone closed is a state a master can reach by pressing both district
   * buttons, and it means what it says: nothing is in play, so there is no
   * boundary. `nextPerimeterState()` reads an empty list as UNKNOWN rather than
   * as a breach — there is a difference between "you are outside" and "there is
   * no inside".
   */
  it('is empty when everything is closed', () => {
    const zones = [zone('a', 0, 0), zone('b', 0.01, 0)];
    expect(playAreaOf(zones, ['a', 'b'])).toEqual([]);
  });

  /**
   * The bundled geometry, and the invariant the whole derivation rests on: the
   * zones tile the perimeter, so with nothing closed the union **is** the
   * perimeter. `tests/geo.test.ts` samples every profile on a 10 m grid and
   * refuses a gap or an overlap, which is what makes this true rather than
   * approximately true.
   */
  it('reproduces the drawn perimeter when nothing is closed', () => {
    for (const profile of ['madrid', 'barcelona', 'sevilla']) {
      const geo = load(profile);
      const area = playAreaOf(geo.zones, []);
      expect(area, profile).toHaveLength(1);

      const box = (ring: number[][]) => [
        Math.min(...ring.map((p) => p[0]!)),
        Math.min(...ring.map((p) => p[1]!)),
        Math.max(...ring.map((p) => p[0]!)),
        Math.max(...ring.map((p) => p[1]!)),
      ];
      const drawn = box(geo.perimeter.coordinates[0]!);
      const derived = box(area[0]!.coordinates[0]!);
      // Within a centimetre in degrees, which is far below the noding tolerance
      // the outlines were snapped with.
      for (const [index, value] of derived.entries()) {
        expect(Math.abs(value - drawn[index]!), `${profile} bound ${index}`).toBeLessThan(1e-7);
      }
    }
  });

  /**
   * A sector, closed. This is the shape a master actually produces, and the
   * numbers are what say the boundary followed: the 1 km square of a whole
   * profile becomes the 1.000 x 500 m of the half still in play.
   */
  it('closes around the sector that is left', () => {
    const geo = load('madrid');
    const south = geo.sectors
      .filter((sector) => sector.id === 's-sur')
      .flatMap((sector) => sector.zoneIds);
    expect(south).toHaveLength(2);
    const area = playAreaOf(geo.zones, south);
    expect(area).toHaveLength(1);

    const ring = area[0]!.coordinates[0]!;
    const lons = ring.map((p) => p[0]!);
    const lats = ring.map((p) => p[1]!);
    const mid = (Math.min(...lats) + Math.max(...lats)) / 2;
    const width = (Math.max(...lons) - Math.min(...lons)) * 111_320 * Math.cos((mid * Math.PI) / 180);
    const height = (Math.max(...lats) - Math.min(...lats)) * 111_132;
    expect(width).toBeGreaterThan(950);
    expect(width).toBeLessThan(1050);
    expect(height).toBeGreaterThan(450);
    expect(height).toBeLessThan(550);
  });
});
