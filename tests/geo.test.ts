import { readFileSync } from 'node:fs';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { describe, expect, it } from 'vitest';

import {
  basemapBbox,
  distanceToBoundaryMetres,
  BASEMAP_FRAME_FACTOR,
  GameGeoError,
  gameGeoFromGeoJson,
  poisOf,
  sectorsOf,
  zoneAt,
  zonesOf,
} from '@q4413/core';
import type { GameGeoJson } from '@q4413/shared';

/**
 * The geometry files feed both the renderer and server-side geometry (R-51).
 * A feature missing featureType is invisible to one of the two consumers, and
 * which one depends on the reader — so the files' invariants are tested, not
 * assumed. Everything geographic is configuration, never code (§11).
 *
 * **Every profile is held to the same invariants and none gets to be the only
 * one checked.** That is the point of this file for anybody describing their own
 * ground: drop a `.geojson` beside the bundled ones, add its name below, and
 * this suite tells you whether the file is playable — which is a different
 * question from whether it looks right on a map, and a harder one to answer by
 * eye.
 */
const PROFILES = ['madrid', 'barcelona', 'sevilla'] as const;

const load = (profile: string) =>
  JSON.parse(
    readFileSync(new URL(`../packages/shared/geo/${profile}.geojson`, import.meta.url), 'utf8'),
  ) as GameGeoJson;

describe.each(PROFILES)('%s.geojson — shared invariants', (profile) => {
  const subject = load(profile);
  const typed = (type: string) =>
    subject.features.filter((f) => f.properties.featureType === type);

  it('carries featureType on every feature (R-51)', () => {
    for (const feature of subject.features) expect(feature.properties.featureType).toBeDefined();
  });

  it('holds exactly one perimeter and one ingest area', () => {
    expect(typed('PERIMETER')).toHaveLength(1);
    expect(typed('INGEST_AREA')).toHaveLength(1);
  });

  it('gives every zone and POI a stable id and a name', () => {
    for (const feature of [...typed('ZONE'), ...typed('POI')]) {
      expect(feature.properties.id).toBeTruthy();
      expect(feature.properties.name).toBeTruthy();
    }
  });

  it('uses unique ids', () => {
    const ids = subject.features.map((f) => f.properties.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('closes every polygon ring', () => {
    for (const feature of subject.features) {
      if (feature.geometry.type !== 'Polygon') continue;
      for (const ring of feature.geometry.coordinates) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring.at(0)).toEqual(ring.at(-1));
      }
    }
  });

  it('keeps coordinates in lon, lat order and inside valid ranges', () => {
    const positions = subject.features.flatMap((f) =>
      f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates.flat(),
    );
    for (const [lon, lat] of positions) {
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
    }
  });

  it('holds at least two zones, or §4 never branches', () => {
    // With one zone every player is always in it and the visibility matrix has
    // nothing to scope, so a profile with fewer is untestable by construction.
    expect(gameGeoFromGeoJson(subject).zones.length).toBeGreaterThanOrEqual(2);
  });

  it('makes the ingest area strictly larger than the perimeter (R-04)', () => {
    const parsed = gameGeoFromGeoJson(subject);
    const perimeter = bboxOf(parsed.perimeter.coordinates[0]!);
    const ingest = bboxOf(parsed.ingestArea.coordinates[0]!);

    expect(ingest[0]).toBeLessThan(perimeter[0]);
    expect(ingest[1]).toBeLessThan(perimeter[1]);
    expect(ingest[2]).toBeGreaterThan(perimeter[2]);
    expect(ingest[3]).toBeGreaterThan(perimeter[3]);
  });

  it('puts every zone inside the ingest area, so its pings are accepted (R-04)', () => {
    const parsed = gameGeoFromGeoJson(subject);
    const [minLon, minLat, maxLon, maxLat] = bboxOf(parsed.ingestArea.coordinates[0]!);
    for (const zone of parsed.zones) {
      for (const position of zone.geometry.coordinates[0]!) {
        const lon = position[0]!;
        const lat = position[1]!;
        expect(lon).toBeGreaterThanOrEqual(minLon);
        expect(lon).toBeLessThanOrEqual(maxLon);
        expect(lat).toBeGreaterThanOrEqual(minLat);
        expect(lat).toBeLessThanOrEqual(maxLat);
      }
    }
  });

  /**
   * Every POI has to be somewhere a player can reach and a ping is accepted from.
   * A POI outside the perimeter is not automatically wrong — a car park entrance
   * is a legitimate one — but outside the ingest area it is a coordinate typed
   * wrong, and a POI on a map nobody can ping from is a meeting point nobody can
   * be tracked to.
   */
  it('keeps every POI inside the ingest area (R-04, R-16)', () => {
    const parsed = gameGeoFromGeoJson(subject);
    const [minLon, minLat, maxLon, maxLat] = bboxOf(parsed.ingestArea.coordinates[0]!);
    for (const poi of parsed.pois) {
      expect(poi.lon).toBeGreaterThanOrEqual(minLon);
      expect(poi.lon).toBeLessThanOrEqual(maxLon);
      expect(poi.lat).toBeGreaterThanOrEqual(minLat);
      expect(poi.lat).toBeLessThanOrEqual(maxLat);
    }
  });

  /**
   * R-70, checked on the artefact rather than on whatever produced it. The
   * grouping is written into every zone by hand, which makes it exactly the kind
   * of edit that rots — and the failure is silent everywhere it matters: the map
   * draws the zone, §4 scopes by it, and the only symptom is a closure that
   * leaves a piece of ground open with players standing on it.
   */
  it('puts every zone in a sector and every sector in a district (R-70)', () => {
    for (const feature of typed('ZONE')) {
      expect(feature.properties.sector).toBeTruthy();
      expect(feature.properties.sectorName).toBeTruthy();
      expect(feature.properties.district).toBeTruthy();
      expect(feature.properties.districtName).toBeTruthy();
    }
  });

  /**
   * The grouping has to survive the reader, not merely exist in the file: every
   * zone accounted for exactly once, and no empty sector. An empty sector is a
   * control that does nothing, which at the venue is a master pressing a button
   * and watching the map not change.
   */
  it('derives a grouping that accounts for every zone exactly once (R-70)', () => {
    const parsed = gameGeoFromGeoJson(subject);
    const grouped = parsed.sectors.flatMap((sector) => sector.zoneIds);
    expect(grouped.slice().sort()).toEqual(parsed.zones.map((zone) => zone.id).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const sector of parsed.sectors) expect(sector.zoneIds.length).toBeGreaterThan(0);

    const sectorIds = parsed.districts.flatMap((district) => district.sectorIds);
    expect(sectorIds.slice().sort()).toEqual(parsed.sectors.map((sector) => sector.id).sort());
    expect(new Set(sectorIds).size).toBe(sectorIds.length);
    for (const district of parsed.districts) expect(district.sectorIds.length).toBeGreaterThan(0);
  });

  /**
   * **The invariant this whole file exists for.**
   *
   * A gap between two zones is the worst defect a geometry can carry and the
   * least visible: two borders traced against the same kerb that miss each other
   * by half a metre leave a strip where `zoneAt()` returns nothing, and under §4
   * a player standing there sees nobody and is seen by nobody. An overlap is the
   * same mistake mirrored — first match wins, so who can see them depends on
   * feature order in a file.
   *
   * It is not hypothetical. The venue geometry this project ran on had exactly
   * this: a strip along one border in no zone at all, invisible on every screen,
   * found by a sampler and corrected by hand.
   *
   * 10 m rather than a finer grid: it is coarse enough to keep this in the root
   * suite instead of making the suite something people skip, and it still caught
   * the real defects it was written for. The tripwire below proves it still can.
   */
  it('leaves no point inside the perimeter in no zone, or in two (§4)', () => {
    expect(coverageOf(subject)).toEqual({ gaps: [], overlaps: [] });
  });

  /**
   * An entrance stands **on** the ring of the zone it opens into, which is what
   * makes `entranceTo` a field rather than a derivation (see Poi.entranceTo).
   * Pinned because it is invisible: an entrance a few metres off its line looks
   * exactly right on any screen, and the next redraw is what would move it.
   *
   * The tolerance is 0,05 m — coordinates are stored to seven decimal places,
   * about 1 cm, so anything tighter would be testing the rounding.
   */
  it('puts every entrance exactly on the border of the zone its note names', () => {
    expectEntrancesOnTheirBorders(subject);
  });

  /**
   * The demo shape, spelled out (R-70): one district, two sectors, two zones
   * each. One district and not two, although the point is to show all three
   * levels — with two districts of one sector each, closing a district would be
   * identical to closing a sector, and the grouping would stop being visible in
   * the one geometry that exists to show it.
   */
  it('is one district, two sectors, four zones', () => {
    const parsed = gameGeoFromGeoJson(subject);
    expect(parsed.districts).toHaveLength(1);
    expect(parsed.sectors).toHaveLength(2);
    expect(parsed.zones).toHaveLength(4);
    for (const sector of parsed.sectors) expect(sector.zoneIds).toHaveLength(2);
  });

  /**
   * Zone ids are stored on positions, so a rename is a silent data migration: a
   * player carrying `zone-norte-este` is out of zone the moment the id changes
   * under them. Pinned here so redrawing a profile cannot quietly renumber them,
   * and so the three files stay interchangeable — switching profiles is one of
   * the five things the demo is for.
   */
  it('keeps the zone ids stable, and the same across profiles', () => {
    expect(gameGeoFromGeoJson(subject).zones.map((zone) => zone.id)).toEqual([
      'zone-norte-oeste',
      'zone-norte-este',
      'zone-sur-oeste',
      'zone-sur-este',
    ]);
  });
});

/**
 * The sampler has to be able to fail, or a suite of passing coverage tests says
 * nothing. Both defects are constructed from a real profile rather than kept as
 * a stale fixture: shrink one zone and the ground it left is in no zone at all;
 * grow it and it is in two.
 */
describe('coverageOf — a real tripwire', () => {
  const nudged = (metresOfDegrees: number): GameGeoJson => {
    const subject = load('madrid');
    return {
      ...subject,
      features: subject.features.map((feature) => {
        if (feature.properties.id !== 'zone-sur-este') return feature;
        const ring = (feature.geometry as { coordinates: number[][][] }).coordinates[0]!;
        const lons = ring.map((p) => p[0]!);
        const west = Math.min(...lons);
        return {
          ...feature,
          geometry: {
            type: 'Polygon' as const,
            // Only the western edge moves, which is the edge it shares with its
            // neighbour — the one place a drawing mistake actually happens.
            coordinates: [
              ring.map(([lon, lat]) =>
                lon === west ? [lon + metresOfDegrees, lat!] : [lon!, lat!],
              ),
            ],
          },
        };
      }),
    };
  };

  it('finds the strip a shrunken zone leaves in no zone at all', () => {
    const { gaps, overlaps } = coverageOf(nudged(0.0005));
    expect(gaps.length).toBeGreaterThan(0);
    expect(overlaps).toEqual([]);
  });

  it('finds the ground a grown zone claims twice', () => {
    const { gaps, overlaps } = coverageOf(nudged(-0.0005));
    expect(overlaps.length).toBeGreaterThan(0);
    expect(gaps).toEqual([]);
  });
});

function bboxOf(ring: number[][]): [number, number, number, number] {
  const lons = ring.map((position) => position[0]!);
  const lats = ring.map((position) => position[1]!);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/**
 * Shared by every profile that carries an entrance. The `note` names the zone,
 * so the file says which border the door belongs to rather than the test
 * guessing it from geometry — which it could not do, since a point on a shared
 * ring is inside both of the zones that share it.
 */
function expectEntrancesOnTheirBorders(subject: GameGeoJson): void {
  const zones = new Map(
    gameGeoFromGeoJson(subject).zones.map((zone) => [zone.id, zone.geometry] as const),
  );
  const entrances = subject.features.filter(
    (feature) => feature.properties.category === 'ENTRANCE',
  );
  expect(entrances.length).toBeGreaterThan(0);

  for (const entrance of entrances) {
    const zoneId = /\b(zone-[a-z-]+)\b/.exec(entrance.properties.note ?? '')?.[1];
    expect(zoneId, `${entrance.properties.id} names no zone in its note`).toBeDefined();
    const geometry = zones.get(zoneId!);
    expect(geometry, `${entrance.properties.id} names ${zoneId}, which is not a zone`).toBeDefined();

    const [lon, lat] = entrance.geometry.coordinates as [number, number];
    expect(distanceToBoundaryMetres(lon, lat, geometry!)).toBeLessThan(0.05);
  }
}

/**
 * Samples a 10 m grid inside the perimeter and reports the points that are in no
 * zone or in more than one. Takes the geometry rather than reading a path, so a
 * caller can check a candidate without writing it anywhere.
 */
function coverageOf(subject: GameGeoJson): {
  gaps: Array<[number, number]>;
  overlaps: Array<[number, number, string[]]>;
} {
  const parsed = gameGeoFromGeoJson(subject);
  const [minLon, minLat, maxLon, maxLat] = bboxOf(parsed.perimeter.coordinates[0]!);
  const midLat = (minLat + maxLat) / 2;
  const step = 10;
  const dLon = step / (111_320 * Math.cos((midLat * Math.PI) / 180));
  const dLat = step / 111_132;

  const gaps: Array<[number, number]> = [];
  const overlaps: Array<[number, number, string[]]> = [];

  for (let lat = minLat; lat <= maxLat; lat += dLat) {
    for (let lon = minLon; lon <= maxLon; lon += dLon) {
      if (!booleanPointInPolygon([lon, lat], parsed.perimeter)) continue;
      const holding = parsed.zones
        .filter((zone) => booleanPointInPolygon([lon, lat], zone.geometry))
        .map((zone) => zone.id);
      if (holding.length === 0) gaps.push([lon, lat]);
      else if (holding.length > 1) overlaps.push([lon, lat, holding]);
    }
  }

  // Five is enough to see where it went wrong; a full list of a thousand
  // points in a failure message is not a better failure message.
  return { gaps: gaps.slice(0, 5), overlaps: overlaps.slice(0, 5) };
}

/**
 * The reader's own behaviour, on a fixture rather than on a profile. It used to
 * be tested against the bundled geometry, which coupled four assertions to
 * whichever POIs happened to be drawn — so redrawing a profile broke tests about
 * parsing. The files have file-shaped tests above; this has reader-shaped ones.
 */
const fixture = (): GameGeoJson => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { featureType: 'PERIMETER' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-4.48, 36.65],
            [-4.47, 36.65],
            [-4.47, 36.66],
            [-4.48, 36.66],
            [-4.48, 36.65],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { featureType: 'INGEST_AREA' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-4.49, 36.64],
            [-4.46, 36.64],
            [-4.46, 36.67],
            [-4.49, 36.67],
            [-4.49, 36.64],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {
        featureType: 'ZONE',
        id: 'zone-a',
        name: 'Zona A',
        sector: 'sector-a',
        sectorName: 'Sector A',
        district: 'distrito',
        districtName: 'Distrito',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-4.48, 36.65],
            [-4.475, 36.65],
            [-4.475, 36.66],
            [-4.48, 36.66],
            [-4.48, 36.65],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { featureType: 'POI', id: 'poi-plain', name: 'Sin categoria' },
      geometry: { type: 'Point', coordinates: [-4.4784, 36.6529] },
    },
    {
      type: 'Feature',
      properties: {
        featureType: 'POI',
        id: 'poi-team',
        name: 'Del equipo A',
        category: 'OBJECTIVE',
        audience: { kind: 'team', teamId: 'team-a' },
      },
      geometry: { type: 'Point', coordinates: [-4.477, 36.657] },
    },
  ],
});

describe('gameGeoFromGeoJson', () => {
  it('splits a file into the four shapes the game layer uses', () => {
    const parsed = gameGeoFromGeoJson(fixture());
    expect(parsed.perimeter.type).toBe('Polygon');
    expect(parsed.ingestArea.type).toBe('Polygon');
    expect(parsed.zones.map((z) => z.id)).toEqual(['zone-a']);
    expect(parsed.pois.map((p) => p.id)).toEqual(['poi-plain', 'poi-team']);
  });

  it('reads POI coordinates as lon, lat and exposes them as lat, lon', () => {
    const plain = poisOf(fixture()).find((p) => p.id === 'poi-plain')!;
    expect(plain.lon).toBe(-4.4784);
    expect(plain.lat).toBe(36.6529);
  });

  it('leaves an absent POI audience absent, so the default lives in one place', () => {
    expect(poisOf(fixture()).find((p) => p.id === 'poi-plain')!.audience).toBeUndefined();
  });

  it('carries an audience through when the file sets one', () => {
    expect(poisOf(fixture()).find((p) => p.id === 'poi-team')!.audience).toEqual({
      kind: 'team',
      teamId: 'team-a',
    });
  });

  it('defaults a POI with no category to OTHER', () => {
    expect(poisOf(fixture()).find((p) => p.id === 'poi-plain')!.category).toBe('OTHER');
  });

  it('refuses a file with two perimeters rather than picking one', () => {
    const geo = load('madrid');
    const perimeter = geo.features.find((f) => f.properties.featureType === 'PERIMETER')!;
    const doubled: GameGeoJson = { ...geo, features: [...geo.features, perimeter] };
    expect(() => gameGeoFromGeoJson(doubled)).toThrow(GameGeoError);
  });

  it('refuses a zone with no id, since projection keys off it', () => {
    const geo = load('madrid');
    const zone = geo.features.find((f) => f.properties.featureType === 'ZONE')!;
    const { id: _id, ...properties } = zone.properties;
    const broken: GameGeoJson = { ...geo, features: [{ ...zone, properties }] };
    expect(() => zonesOf(broken)).toThrow(GameGeoError);
  });
});

/**
 * R-70's grouping, and every way it can be written wrong.
 *
 * The three levels are **distrito ⊃ sector ⊃ zona**, and only the bottom one is
 * geometry. A sector's boundary is the union of its zones and is never drawn,
 * which is not economy: ground inside a drawn sector but inside none of its
 * zones is ground where §4 can see nobody and nobody can be seen, and that was
 * a real defect at a real venue. Derived, it cannot be written.
 */
describe('sectorsOf — R-70', () => {
  const zoned = (
    id: string,
    sector: string,
    district: string,
    names: { sectorName?: string; districtName?: string } = {},
  ) => ({
    type: 'Feature' as const,
    properties: {
      featureType: 'ZONE' as const,
      id,
      name: id,
      sector,
      district,
      sectorName: names.sectorName ?? sector,
      districtName: names.districtName ?? district,
    },
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
  });

  const collection = (...features: ReturnType<typeof zoned>[]): GameGeoJson => ({
    type: 'FeatureCollection',
    features,
  });

  it('groups zones into sectors and sectors into districts, in file order', () => {
    const subject = collection(
      zoned('z1', 'norte', 'pueblo', { sectorName: 'Norte', districtName: 'El Pueblo' }),
      zoned('z2', 'sur', 'pueblo', { sectorName: 'Sur' }),
      zoned('z3', 'norte', 'pueblo'),
      zoned('z4', 'afueras', 'campo', { sectorName: 'Afueras', districtName: 'El Campo' }),
    );
    const { sectors, districts } = sectorsOf(subject, zonesOf(subject));

    expect(sectors).toEqual([
      { id: 'norte', name: 'Norte', district: 'pueblo', zoneIds: ['z1', 'z3'] },
      { id: 'sur', name: 'Sur', district: 'pueblo', zoneIds: ['z2'] },
      { id: 'afueras', name: 'Afueras', district: 'campo', zoneIds: ['z4'] },
    ]);
    expect(districts).toEqual([
      { id: 'pueblo', name: 'El Pueblo', sectorIds: ['norte', 'sur'] },
      { id: 'campo', name: 'El Campo', sectorIds: ['afueras'] },
    ]);
  });

  /**
   * A zone with no sector is a zone nobody can switch off, and the failure is
   * silent everywhere it matters: the map draws it, §4 scopes by it, and the
   * only symptom is a closure that leaves a piece of ground open with players
   * standing on it. Refused at the one moment the whole file is in one hand.
   */
  it('refuses a zone that is in no sector', () => {
    const orphan = zoned('z1', '', 'pueblo');
    expect(() => zonesOf(collection(orphan))).toThrow(GameGeoError);
  });

  it('refuses a zone that is in no district', () => {
    const orphan = zoned('z1', 'norte', '');
    const subject = collection(orphan);
    expect(() => sectorsOf(subject, [{ id: 'z1', name: 'z1', geometry: square(0, 0), sector: 'norte' }])).toThrow(
      GameGeoError,
    );
  });

  /**
   * The one thing the derivation cannot catch by construction. A sector is
   * exactly the zones that name it and a district exactly the sectors whose
   * zones name it, so "a sector listing a zone that does not exist" and "a zone
   * in two sectors" are sentences that cannot be written — but two zones of one
   * sector disagreeing about the district can, and it is the shape a paste
   * takes. Left alone it puts one sector under two group controls, where closing
   * the district would half-close the sector.
   */
  it('refuses a sector whose zones disagree about their district', () => {
    const subject = collection(zoned('z1', 'norte', 'pueblo'), zoned('z2', 'norte', 'campo'));
    expect(() => sectorsOf(subject, zonesOf(subject))).toThrow(GameGeoError);
  });
});

/** A closed triangle; the reader never looks at the shape here. */
function square(lon: number, lat: number) {
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [lon, lat],
        [lon + 1, lat],
        [lon + 1, lat + 1],
        [lon, lat],
      ],
    ],
  };
}

/**
 * §14.2 and R-47. The archive's box and MapLibre's `maxBounds` are the same
 * number, and the number has to let a 16:9 laptop and a 9:16 phone both frame
 * the play area — otherwise the map crops the game at minimum zoom, which is
 * the one moment it must not.
 */
describe('basemapBbox — the box has to fit both orientations', () => {
  const METRES_PER_DEGREE_LAT = 111_132;

  const metresOf = (box: readonly [number, number, number, number]) => {
    const midLat = (box[1] + box[3]) / 2;
    return {
      width: (box[2] - box[0]) * 111_320 * Math.cos((midLat * Math.PI) / 180),
      height: (box[3] - box[1]) * METRES_PER_DEGREE_LAT,
    };
  };

  const geoOf = (profile: string) => gameGeoFromGeoJson(load(profile));

  for (const profile of PROFILES) {
    /**
     * To fit `W × H` on a viewport of aspect `a` the view must cover
     * `max(W, H·a)` across. Across 16:9 and 9:16 that is `1,778 × max(W, H)` in
     * both directions, and the box is square, so one check covers both.
     */
    it(`${profile} frames the perimeter in 16:9 and in 9:16`, () => {
      const geo = geoOf(profile);
      const box = metresOf(basemapBbox(geo));
      const perimeter = metresOf(bboxOf(geo.perimeter.coordinates[0]!));
      const needed = (16 / 9) * Math.max(perimeter.width, perimeter.height);
      expect(box.width).toBeGreaterThanOrEqual(needed);
      expect(box.height).toBeGreaterThanOrEqual(needed);
    });

    /**
     * R-04 accepts a ping from anywhere in the ingest area, so a master has to
     * be able to pan to wherever one came from — and `maxBounds` is this box.
     */
    it(`${profile} still contains the whole ingest area`, () => {
      const geo = geoOf(profile);
      const [west, south, east, north] = basemapBbox(geo);
      for (const [lon, lat] of geo.ingestArea.coordinates[0]!) {
        expect(lon!).toBeGreaterThanOrEqual(west);
        expect(lon!).toBeLessThanOrEqual(east);
        expect(lat!).toBeGreaterThanOrEqual(south);
        expect(lat!).toBeLessThanOrEqual(north);
      }
    });
  }

  it('is square in metres, which is what makes one factor serve both orientations', () => {
    for (const profile of PROFILES) {
      const box = metresOf(basemapBbox(geoOf(profile)));
      expect(box.width).toBeCloseTo(box.height, 0);
    }
  });

  it('keeps the factor above the 16:9 minimum it exists to clear', () => {
    expect(BASEMAP_FRAME_FACTOR).toBeGreaterThan(16 / 9);
  });
});

describe('entranceTo — which zone an entrance opens into', () => {
  /**
   * The reason the field exists rather than being derived. An entrance is drawn
   * **on** the ring of the zone it serves, `booleanPointInPolygon` counts a
   * boundary as inside, and `zoneAt()` answers with whichever zone the file
   * lists first — which for the bundled profiles is the zone on the *other* side
   * of the door. Reordering the features would relabel it, which is what
   * "arbitrary" means here.
   */
  it.each(PROFILES)('%s disagrees with the containing zone', (profile) => {
    const venue = gameGeoFromGeoJson(load(profile));
    const entrances = venue.pois.filter((poi) => poi.category === 'ENTRANCE');
    expect(entrances.length).toBeGreaterThan(0);
    for (const entrance of entrances) {
      expect(entrance.entranceTo).toBeDefined();
    }
    const disagreeing = entrances.filter(
      (entrance) => zoneAt(entrance.lon, entrance.lat, venue.zones) !== entrance.entranceTo,
    );
    expect(disagreeing.length).toBeGreaterThan(0);
  });

  it('refuses an entrance pointing at a zone the file does not define', () => {
    const broken = load('madrid');
    const entrance = broken.features.find((f) => f.properties.category === 'ENTRANCE');
    expect(entrance).toBeDefined();
    entrance!.properties.entranceTo = 'zone-that-was-renamed';
    expect(() => gameGeoFromGeoJson(broken)).toThrow(GameGeoError);
  });
});
