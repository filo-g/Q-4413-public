import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { applyPing, distanceToBoundaryMetres, zoneAt, ZONE_HOLD_MAX_METRES } from '@q4413/core';
import type { GameGeoJson, OsmAndPing, Player, Polygon, Zone } from '@q4413/shared';

import { zoneName } from '../apps/web/src/format.ts';

/**
 * Zone assignment, and the hold that keeps a border from flickering (M4).
 *
 * §4 scopes positions by zone, so every answer here decides who may see whom.
 * The synthetic zones below are two squares sharing an edge, which is what makes
 * the distances exact: the band is compared in metres, and a test that cannot say
 * where five metres is cannot check it.
 */

/** The bundled geometry's latitude, so the longitude scale is the one the code uses. */
const LAT = 40.4168;
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const east = (metres: number) => metres / M_PER_DEG_LON;
const north = (metres: number) => metres / M_PER_DEG_LAT;

/** A square with its west edge on `lonWest`, `sideMetres` on a side. */
function square(lonWest: number, sideMetres: number): Polygon {
  const east0 = lonWest + east(sideMetres);
  const south = LAT;
  const north0 = LAT + north(sideMetres);
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lonWest, south],
        [east0, south],
        [east0, north0],
        [lonWest, north0],
        [lonWest, south],
      ],
    ],
  };
}

/** WEST and EAST share the meridian lon = 0; both are 200 m on a side. */
const WEST: Zone = { id: 'west', name: 'Oeste', geometry: square(east(-200), 200), sector: 'oeste' };
const EAST: Zone = { id: 'east', name: 'Este', geometry: square(0, 200), sector: 'este' };
const ZONES = [WEST, EAST];

/** Inside EAST, `metres` past the shared border, halfway up it. */
const acrossInEast = (metres: number): [number, number] => [east(metres), LAT + north(100)];

describe('zoneAt() — the raw answer', () => {
  it('names the zone containing the point', () => {
    const [lon, lat] = acrossInEast(50);
    expect(zoneAt(lon, lat, ZONES)).toBe('east');
  });

  it('is undefined outside every zone', () => {
    expect(zoneAt(east(400), LAT + north(100), ZONES)).toBeUndefined();
  });

  it('holds nothing when no previous zone is offered', () => {
    const [lon, lat] = acrossInEast(5);
    expect(zoneAt(lon, lat, ZONES, { accuracy: 20 })).toBe('east');
  });
});

describe('zoneAt() — holding the previous zone through the fix error (M4)', () => {
  it('keeps the old zone while the point is inside its own accuracy of the border', () => {
    const [lon, lat] = acrossInEast(5);
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'west', accuracy: 12 })).toBe('west');
  });

  it('switches once the fix is accurate enough to prove the crossing', () => {
    const [lon, lat] = acrossInEast(5);
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'west', accuracy: 3 })).toBe('east');
  });

  /**
   * The behaviour before M4, and still the behaviour for a fix that reports
   * nothing about its own error: `applyPing()` stores 0 when the ping carries no
   * accuracy, and no accuracy is no claim.
   */
  it('holds nothing with no reported accuracy', () => {
    const [lon, lat] = acrossInEast(5);
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'west' })).toBe('east');
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'west', accuracy: 0 })).toBe('east');
  });

  it('switches as soon as the point is past the band, however accurate the fix claims to be', () => {
    const [lon, lat] = acrossInEast(60);
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'west', accuracy: 12 })).toBe('east');
  });

  /**
   * The cap. A cell-tower fix reporting 500 m of error would otherwise pin a
   * player in a zone they left a street ago, and the pin would survive every
   * subsequent good fix that landed inside the same band.
   */
  it('caps the band, so one bad fix cannot pin a player in the zone they left', () => {
    const [lon, lat] = acrossInEast(ZONE_HOLD_MAX_METRES + 5);
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'west', accuracy: 500 })).toBe('east');
    // Just inside the cap, the same fix still holds: the cap bounds the band, it
    // does not disable the hold.
    const [nearLon, nearLat] = acrossInEast(ZONE_HOLD_MAX_METRES - 5);
    expect(zoneAt(nearLon, nearLat, ZONES, { previousZoneId: 'west', accuracy: 500 })).toBe('west');
  });

  it('holds a zone for a point that has left every zone', () => {
    const outside = east(205);
    expect(zoneAt(outside, LAT + north(100), ZONES, { previousZoneId: 'east', accuracy: 12 })).toBe(
      'east',
    );
    expect(
      zoneAt(outside, LAT + north(100), ZONES, { previousZoneId: 'east', accuracy: 2 }),
    ).toBeUndefined();
  });

  /**
   * A stored zoneId was decided by the geometry that was live when the ping
   * landed. After a profile swap it names nothing, and answering with it anyway
   * would keep a player in a zone that is on nobody's map.
   */
  it('cannot hold a zone the geometry no longer has', () => {
    const [lon, lat] = acrossInEast(5);
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'zone-from-another-profile', accuracy: 20 }))
      .toBe('east');
  });
});

describe('applyPing() — when the hold is offered at all', () => {
  const LINK_THRESHOLD_MS = 90_000;
  const NOW = 1_760_000_000_000;

  const playerInWest = (ts: number): Player => ({
    id: 'romeo',
    callsign: 'ROMEO',
    fullName: 'Nombre de ROMEO',
    teamId: 'team-zulu',
    sessionToken: 'token',
    position: {
      lat: LAT + north(100),
      lon: east(-5),
      accuracy: 8,
      ts,
      state: 'MOVING',
      zoneId: 'west',
    },
  });

  const pingAcross = (accuracy: number): OsmAndPing => {
    const [lon, lat] = acrossInEast(5);
    return {
      deviceId: 'device-1',
      lat,
      lon,
      receivedAt: NOW,
      ts: NOW,
      accuracy,
      attributes: {},
    };
  };

  it('offers the hold while the feed is live', () => {
    const player = applyPing(playerInWest(NOW - 5_000), pingAcross(12), {
      zones: ZONES,
      linkThresholdMs: LINK_THRESHOLD_MS,
    });
    expect(player.position?.zoneId).toBe('west');
  });

  /**
   * A gap longer than the link threshold ends the hold: the player was
   * unobservable, and a fix on the far side of a border after ten minutes of
   * silence is evidence that they walked, not noise to absorb. Holding across it
   * would keep them visible to a zone they left while nobody could see them.
   */
  it('does not offer the hold across a gap in the feed', () => {
    const player = applyPing(playerInWest(NOW - 600_000), pingAcross(12), {
      zones: ZONES,
      linkThresholdMs: LINK_THRESHOLD_MS,
    });
    expect(player.position?.zoneId).toBe('east');
  });
});

/**
 * The same question against a geometry the game will actually run on. The two
 * northern zones share their whole eastern/western edge, so the border is a real
 * drawn line rather than a constructed one, and it is open ground with the
 * border drawn in the air — the case the M4 measurements say is worst.
 */
describe('the bundled geometry', () => {
  const geo = JSON.parse(
    readFileSync(new URL('../packages/shared/geo/madrid.geojson', import.meta.url), 'utf8'),
  ) as GameGeoJson;
  const zones: Zone[] = geo.features
    .filter((f) => f.properties.featureType === 'ZONE')
    .map((f) => ({
      id: f.properties.id!,
      name: f.properties.name ?? f.properties.id!,
      geometry: f.geometry as Polygon,
      sector: f.properties.sector!,
    }));

  const westZone = zones.find((zone) => zone.id === 'zone-norte-oeste')!;
  const eastZone = zones.find((zone) => zone.id === 'zone-norte-este')!;

  /**
   * A point a few metres inside `eastZone` of the shared border, found by walking
   * outward from the midpoint of a shared segment. Computed rather than written
   * down: a literal would go stale the next time the geometry is redrawn.
   */
  const nearBorder = (): { lon: number; lat: number; fromWest: number } => {
    const ring = (eastZone.geometry.coordinates[0] ?? []) as Array<[number, number]>;
    const shared = new Set(
      ((westZone.geometry.coordinates[0] ?? []) as Array<[number, number]>).map(
        ([lon, lat]) => `${lon},${lat}`,
      ),
    );
    for (let index = 1; index < ring.length; index += 1) {
      const a = ring[index - 1]!;
      const b = ring[index]!;
      if (!shared.has(`${a[0]},${a[1]}`) || !shared.has(`${b[0]},${b[1]}`)) continue;
      const midLon = (a[0] + b[0]) / 2;
      const midLat = (a[1] + b[1]) / 2;
      // Perpendicular to the segment, tried both ways: whichever lands inside
      // the eastern zone is the one pointing away from the western one.
      const dLon = b[0] - a[0];
      const dLat = b[1] - a[1];
      const length = Math.hypot(dLon, dLat) || 1;
      for (const sign of [1, -1]) {
        const step = 5; // metres
        const lon = midLon + (sign * (-dLat / length) * step) / M_PER_DEG_LON;
        const lat = midLat + (sign * (dLon / length) * step) / M_PER_DEG_LAT;
        if (zoneAt(lon, lat, zones) === eastZone.id) {
          return { lon, lat, fromWest: distanceToBoundaryMetres(lon, lat, westZone.geometry) };
        }
      }
    }
    throw new Error('no shared border segment found between the two northern zones');
  };

  it('holds the old zone a few metres over a real border, and gives it up further in', () => {
    const { lon, lat, fromWest } = nearBorder();
    expect(fromWest).toBeLessThan(8);
    expect(zoneAt(lon, lat, zones)).toBe('zone-norte-este');
    expect(zoneAt(lon, lat, zones, { previousZoneId: 'zone-norte-oeste', accuracy: 8 })).toBe(
      'zone-norte-oeste',
    );
    expect(zoneAt(lon, lat, zones, { previousZoneId: 'zone-norte-oeste', accuracy: 2 })).toBe(
      'zone-norte-este',
    );
  });
});

describe('distanceToBoundaryMetres()', () => {
  it('measures to the nearest edge, from either side', () => {
    // 50 m east of the shared meridian, inside EAST: 50 m from EAST's own west
    // edge, and 150 m from its east edge — the nearest wins.
    const [lon, lat] = acrossInEast(50);
    expect(distanceToBoundaryMetres(lon, lat, EAST.geometry)).toBeCloseTo(50, 0);
    expect(distanceToBoundaryMetres(lon, lat, WEST.geometry)).toBeCloseTo(50, 0);
  });

  it('measures to a corner for a point past the end of an edge', () => {
    // 3-4-5: 30 m west and 40 m south of WEST's south-west corner.
    const corner = distanceToBoundaryMetres(east(-230), LAT - north(40), WEST.geometry);
    expect(corner).toBeCloseTo(50, 0);
  });

  it('is Infinity for a polygon with no vertices', () => {
    expect(distanceToBoundaryMetres(0, LAT, { type: 'Polygon', coordinates: [] })).toBe(Infinity);
  });
});

/**
 * What a zone is called on screen, tested here rather than beside the other
 * formatters because the requirement is about zones: §4 decides visibility on
 * `zoneId`, and that value is an identifier out of the geometry file. The
 * master's card printed it raw — `zone-restaurantes` where it meant
 * "Restaurante" — and a sector is something a master says out loud on the radio.
 */
describe('zoneName — the sector as a master would say it', () => {
  const zones = [
    { id: 'zone-restaurantes', name: 'Restaurante' },
    { id: 'zone-outlet', name: 'Outlet' },
  ];

  it('renders the name the geometry gives a zone', () => {
    expect(zoneName(zones, 'zone-restaurantes')).toBe('Restaurante');
    expect(zoneName(zones, 'zone-outlet')).toBe('Outlet');
  });

  /**
   * An id nobody can read is still evidence that somebody is somewhere, and a
   * dash says the opposite. Only an absent zone gets the dash — a player outside
   * every zone there is (R-40).
   */
  it('falls back to the id, and only to a dash with no zone at all', () => {
    expect(zoneName(zones, 'zone-gone')).toBe('zone-gone');
    expect(zoneName(undefined, 'zone-outlet')).toBe('zone-outlet');
    expect(zoneName(zones, undefined)).toBe('—');
    expect(zoneName(undefined, undefined)).toBe('—');
  });
});

/**
 * The cap, after the field rehearsal moved it (R-15, §6.3).
 *
 * The complaint was that a player's QTH took too long to catch up. It was not
 * time, it was distance: the hold runs until the fix is its own accuracy past
 * the border, so a phone reporting 24 m indoors and moving had to be walked 24 m
 * into the new zone — about eighteen seconds at 1,4 m/s, plus up to one ping
 * interval.
 */
describe('ZONE_HOLD_MAX_METRES — what the rehearsal moved', () => {
  it('leaves a fix at the measured resting accuracy exactly as it was', () => {
    // The phones show 8 m at rest, which is under the cap either way, so the
    // band is the accuracy and nothing about a stationary player changed.
    const [lon, lat] = acrossInEast(4);
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'west', accuracy: 8 })).toBe('west');
    const [farLon, farLat] = acrossInEast(12);
    expect(zoneAt(farLon, farLat, ZONES, { previousZoneId: 'west', accuracy: 8 })).toBe('east');
  });

  /**
   * And the case that was slow: a fix reporting worse than the cap is held only
   * to the cap, not to its own error. This is the whole of the change, and it
   * moves in §4's fail-closed direction — the hold is an over-disclosure to the
   * zone just left, and this shortens it.
   */
  it('never holds further than the cap, however bad the fix claims to be', () => {
    const [lon, lat] = acrossInEast(ZONE_HOLD_MAX_METRES + 2);
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'west', accuracy: 24 })).toBe('east');
    expect(zoneAt(lon, lat, ZONES, { previousZoneId: 'west', accuracy: 500 })).toBe('east');

    const [nearLon, nearLat] = acrossInEast(ZONE_HOLD_MAX_METRES - 2);
    expect(zoneAt(nearLon, nearLat, ZONES, { previousZoneId: 'west', accuracy: 24 })).toBe('west');
  });

  /**
   * Worth an assertion rather than a comment: the number is what decides how
   * long a player waits, and a change to it is a change to the game. At 1,4 m/s
   * the cap is the worst-case walk before the QTH catches up.
   */
  it('is a cap a player can walk out of in under ten seconds', () => {
    expect(ZONE_HOLD_MAX_METRES / 1.4).toBeLessThan(10);
  });
});
