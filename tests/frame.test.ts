import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { gameGeoFromGeoJson } from '@q4413/core';
import {
  dotsOf,
  frameOf,
  UNCERTAINTY_CAP_METRES,
  zonesOutOfPlay,
} from '../apps/web/src/map/frame.ts';
import type {
  Game,
  GameGeoJson,
  MasterMarker,
  Payload,
  ProjectedPlayer,
  TrayEntry,
} from '@q4413/shared';

/**
 * The map layer, which is where R-11 and R-12 become visible. Tested here rather
 * than through a component: what could go wrong is the arithmetic, not the SVG.
 */
const NOW = 1_756_000_000_000;

const CONFIG: Game['config'] = {
  linkThresholdMs: 90_000,
  radioContactValidityMs: 300_000,
  authoritativeIdleRevertMs: 600_000,
  markerDefaultTtlMs: 300_000,
  detourFactor: 1.35,
  walkingSpeed: 1.4,
  bearingFreezeSpeed: 0.5,
  bearingSmoothing: 0.12,
  poiProximityRadius: 50,
};

const square = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };

const at = (
  ts: number,
  state: 'MOVING' | 'STATIONARY',
  accuracy = 10,
): NonNullable<ProjectedPlayer['position']> => ({
  lat: 36.65,
  lon: -4.48,
  accuracy,
  ts,
  state,
  source: 'LIVE',
});

const payload = (players: ProjectedPlayer[], self?: ProjectedPlayer): Payload => ({
  game: {
    id: 'g',
    name: 'Q-4413',
    state: 'IN_PROGRESS',
    cutSwitch: false,
    commsReach: 3,
  },
  serverNow: NOW,
  config: CONFIG,
  basemap: { pmtilesUrl: '', styleUrl: '/src/map/style.json', bbox: [0, 0, 1, 1], maxZoom: 17 },
  ...(self === undefined ? {} : { self }),
  players,
  teams: [],
  pois: [],
  zones: [],
  sectors: [],
  playArea: [],
  perimeter: square,
  ingestArea: square,
  markers: [],
  replayAvailable: false,
});

describe('dotsOf — link state is derived when the dot is drawn, not when it was sent', () => {
  it('keeps a fresh claim', () => {
    const dots = dotsOf(payload([{ id: 'a', callsign: 'ALFA', position: at(NOW - 5_000, 'MOVING') }]), NOW);
    expect(dots[0]?.state).toBe('MOVING');
    expect(dots[0]?.uncertaintyMetres).toBe(10);
  });

  /**
   * The snapshot says STATIONARY because that was true when it was built. Three
   * minutes later, with nothing having arrived, the dot has to say otherwise —
   * that is R-15 with no server tick behind it.
   */
  it('ages a snapshot that stopped being true after it was sent', () => {
    const sent = at(NOW, 'STATIONARY');
    const fresh = dotsOf(payload([{ id: 'a', callsign: 'ALFA', position: sent }]), NOW);
    const later = dotsOf(payload([{ id: 'a', callsign: 'ALFA', position: sent }]), NOW + 180_000);

    expect(fresh[0]?.state).toBe('STATIONARY');
    expect(later[0]?.state).toBe('NO_LINK');
    // R-12: the circle only opens once the state does.
    expect(fresh[0]?.uncertaintyMetres).toBe(10);
    expect(later[0]?.uncertaintyMetres).toBeCloseTo(10 + 1.4 * 180, 6);
  });

  it('draws no dot for a player §4 withheld a position from (R-40)', () => {
    const dots = dotsOf(payload([{ id: 'c', callsign: 'CHARLIE', outOfZone: true }]), NOW);
    expect(dots).toEqual([]);
  });

  it('carries the recipient own dot with its own derived state', () => {
    const dots = dotsOf(
      payload([], { id: 'a', callsign: 'ALFA', position: at(NOW - 600_000, 'MOVING') }),
      NOW,
    );
    expect(dots[0]?.kind).toBe('SELF');
    expect(dots[0]?.state).toBe('NO_LINK');
  });

  it('draws an unpaired device from when it was last seen', () => {
    const tray: TrayEntry[] = [
      { deviceId: 'stray', firstSeen: NOW - 600_000, lastSeen: NOW - 600_000, lat: 36.6, lon: -4.4, pings: 4 },
      { deviceId: 'live', firstSeen: NOW - 600_000, lastSeen: NOW - 2_000, lat: 36.6, lon: -4.4, pings: 90 },
    ];
    const dots = dotsOf(payload([]), NOW, tray);
    expect(dots.map((dot) => [dot.key, dot.state])).toEqual([
      ['stray', 'NO_LINK'],
      ['live', 'MOVING'],
    ]);
  });

  it('reads the same threshold the server used, from the payload', () => {
    const sent = at(NOW - 120_000, 'MOVING');
    const strict = dotsOf(payload([{ id: 'a', callsign: 'ALFA', position: sent }]), NOW);
    const relaxed = dotsOf(
      { ...payload([{ id: 'a', callsign: 'ALFA', position: sent }]), config: { ...CONFIG, linkThresholdMs: 300_000 } },
      NOW,
    );
    expect(strict[0]?.state).toBe('NO_LINK');
    expect(relaxed[0]?.state).toBe('MOVING');
  });
});

describe('frameOf — map furniture, exactly as projected', () => {
  const marker: MasterMarker = {
    id: 'marker-1',
    label: 'Aqui',
    lat: 36.65,
    lon: -4.48,
    audience: { kind: 'all' },
    placedAt: NOW,
    expiresAt: NOW + 300_000,
  };

  /**
   * Whether this recipient is in a marker's audience (R-20b) and whether its TTL
   * has passed (R-21c) were both decided by project(). The renderer's whole share
   * is drawing what arrived — a client that filtered again would be a second
   * opinion on the one security boundary, and a client that filtered *less* would
   * be a leak.
   */
  it('carries the markers the payload arrived with, and nothing when there are none', () => {
    const withMarker = payload([]);
    withMarker.markers = [marker];
    expect(frameOf(withMarker, NOW).markers.map((m) => m.id)).toEqual(['marker-1']);
    expect(frameOf(payload([]), NOW).markers).toEqual([]);
  });

  /** Five of them, drawn as five: the cap is the server's business (R-20b). */
  it('carries all five without thinning them out', () => {
    const many = payload([]);
    many.markers = Array.from({ length: 5 }, (_unused, index) => ({
      ...marker,
      id: `marker-${index}`,
    }));
    expect(frameOf(many, NOW).markers).toHaveLength(5);
  });

  /**
   * R-21 on this side of the wire. The server withholds an expired marker and
   * broadcasts when the alarm clears it, but a client with nothing arriving would
   * keep drawing the last one it was sent — and on a local Worker with no traffic
   * the alarm was measured not running at all, which is exactly the case a phone
   * looking at a map with the game quiet is in.
   */
  it('drops a marker whose TTL has passed, with no new snapshot', () => {
    const withMarker = payload([]);
    withMarker.markers = [marker];
    const expiresAt = marker.expiresAt!;
    expect(frameOf(withMarker, expiresAt - 1).markers).toHaveLength(1);
    expect(frameOf(withMarker, expiresAt).markers).toEqual([]);
    expect(frameOf(withMarker, expiresAt + 60_000).markers).toEqual([]);
  });

  /**
   * And keeps the one that has no TTL, in the same breath (R-21c): the guard has
   * to drop what expired without touching what cannot.
   */
  it('keeps an indefinite marker while dropping an expired one beside it', () => {
    const { expiresAt: _dropped, ...forever } = { ...marker, id: 'marker-forever' };
    const both = payload([]);
    both.markers = [marker, forever];
    expect(frameOf(both, marker.expiresAt! + 1).markers.map((m) => m.id)).toEqual([
      'marker-forever',
    ]);
  });
});


/**
 * The render-layer cap, carried into M7 from M3 with the design already
 * written: R-12 leaves the radius uncapped on purpose and delegates the
 * clamping to the map.
 */
describe('UNCERTAINTY_CAP_METRES — the circle stops being a drawing', () => {
  /** Every geometry that ships, because the constant claims to serve all of them. */
  const PROFILES = ['madrid', 'barcelona', 'sevilla'] as const;

  const geoOf = (profile: string) =>
    gameGeoFromGeoJson(
      JSON.parse(
        readFileSync(new URL(`../packages/shared/geo/${profile}.geojson`, import.meta.url), 'utf8'),
      ) as GameGeoJson,
    );

  const shortAxisMetres = (polygon: Payload['perimeter']): number => {
    const ring = polygon.coordinates[0] ?? [];
    const lons = ring.map(([lon]) => lon ?? 0);
    const lats = ring.map(([, lat]) => lat ?? 0);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    return Math.min(
      (Math.max(...lons) - Math.min(...lons)) * 111_320 * Math.cos((midLat * Math.PI) / 180),
      (Math.max(...lats) - Math.min(...lats)) * 111_132,
    );
  };

  /** Half a perimeter's short axis, which for the bundled profiles is 1 km. */
  it('is half the perimeter short axis', () => {
    expect(UNCERTAINTY_CAP_METRES).toBeCloseTo(shortAxisMetres(geoOf('madrid').perimeter) / 2, -1);
  });

  /**
   * The constant is only honest while every profile is the same order of scale.
   * This is the check that would fail if a profile were added at a wildly
   * different one — at which point the cap goes back to being derived per
   * perimeter, which is what its own docblock promises.
   */
  it('is a meaningful fraction of every profile short axis, not a rounding error', () => {
    for (const profile of PROFILES) {
      const axis = shortAxisMetres(geoOf(profile).perimeter);
      // Below a fifth it would blank dots that were still locatable; above the
      // axis it would never fire at all. Every profile sits inside that band,
      // which is what makes one number defensible for all of them.
      expect(UNCERTAINTY_CAP_METRES).toBeGreaterThan(axis / 5);
      expect(UNCERTAINTY_CAP_METRES).toBeLessThan(axis);
    }
  });
});

describe('dotsOf — the cap, applied', () => {
  const venue = () =>
    gameGeoFromGeoJson(
      JSON.parse(
        readFileSync(
          new URL('../packages/shared/geo/madrid.geojson', import.meta.url),
          'utf8',
        ),
      ) as GameGeoJson,
    );

  const atVenue = (ts: number): NonNullable<ProjectedPlayer['position']> => ({
    lat: 40.4168,
    lon: -3.7038,
    accuracy: 10,
    ts,
    state: 'MOVING',
    source: 'LIVE',
  });

  const inVenue = (players: ProjectedPlayer[], now: number): Payload => ({
    ...payload(players),
    perimeter: venue().perimeter,
    ingestArea: venue().ingestArea,
    serverNow: now,
  });

  it('leaves a dot locatable while the circle still says something', () => {
    // 5 minutes of silence: 10 + 1,4 × 300 = 430 m, under the 500 m cap.
    const now = NOW + 300_000;
    const dots = dotsOf(inVenue([{ id: 'a', callsign: 'ALFA', position: atVenue(NOW) }], now), now);
    expect(dots[0]?.state).toBe('NO_LINK');
    expect(dots[0]?.unlocatable).toBe(false);
  });

  it('marks it unlocatable once the circle would span half the venue', () => {
    // 7 minutes: 598 m, past it. R-12 reaches the cap at about 5,8 minutes.
    const now = NOW + 420_000;
    const dots = dotsOf(inVenue([{ id: 'a', callsign: 'ALFA', position: atVenue(NOW) }], now), now);
    expect(dots[0]?.unlocatable).toBe(true);
    // The dot survives, and so does the true radius: "we last saw them here" is
    // information, and the roster still prints the number.
    expect(dots[0]?.lat).toBe(40.4168);
    expect(dots[0]?.uncertaintyMetres).toBeCloseTo(10 + 1.4 * 420, 6);
  });

  it('never marks a live dot, whose radius is its own accuracy', () => {
    const dots = dotsOf(
      inVenue([{ id: 'a', callsign: 'ALFA', position: atVenue(NOW - 1_000) }], NOW),
      NOW,
    );
    expect(dots[0]?.unlocatable).toBe(false);
  });
});

/**
 * R-71's one asymmetry on the master's own map.
 *
 * A closed **sector** stays drawn, dim, because the panel row naming it has to
 * have ground to point at — §14.3 leaves the map without labels, so a name with
 * nothing to light is a name and nothing else. A closed **district** is
 * different in kind, and the geometry says why: two districts can be kilometres
 * apart, so with one shut the half still in play is the smaller half of the
 * frame and a dozen dim outlines around nobody crowd it.
 */
describe('zonesOutOfPlay — R-71', () => {
  const SECTORS = [
    { id: 'norte', name: 'Norte', district: 'uno', zoneIds: ['z-n'] },
    { id: 'ribera', name: 'Ribera', district: 'dos', zoneIds: ['z-rib'] },
    { id: 'carretera', name: 'Carretera', district: 'dos', zoneIds: ['z-car'] },
  ];
  const DISTRICTS = [
    { id: 'uno', name: 'Uno', sectorIds: ['norte'] },
    { id: 'dos', name: 'Dos', sectorIds: ['ribera', 'carretera'] },
  ];

  it('drops nothing while any zone of a district is still open', () => {
    expect(zonesOutOfPlay(DISTRICTS, SECTORS, ['z-rib'])).toEqual(new Set());
  });

  it('drops the whole district once its last zone closes', () => {
    expect(zonesOutOfPlay(DISTRICTS, SECTORS, ['z-rib', 'z-car'])).toEqual(
      new Set(['z-rib', 'z-car']),
    );
  });

  /**
   * The zone is the unit (R-71), so a district is shut when its *ground* is —
   * not when its sectors are, which is the same thing said one level up and
   * would be a second rule to keep in step. One zone of a ten-zone sector left
   * open keeps the whole district drawn, because there is still somewhere to
   * play in it.
   */
  it('counts ground rather than sectors, so one open zone keeps the district', () => {
    const wide = [
      { id: 'norte', name: 'Norte', district: 'uno', zoneIds: ['z-n'] },
      { id: 'ribera', name: 'Ribera', district: 'dos', zoneIds: ['z-rib', 'z-alto'] },
      { id: 'carretera', name: 'Carretera', district: 'dos', zoneIds: ['z-car'] },
    ];
    expect(zonesOutOfPlay(DISTRICTS, wide, ['z-rib', 'z-car'])).toEqual(new Set());
    expect(zonesOutOfPlay(DISTRICTS, wide, ['z-rib', 'z-alto', 'z-car'])).toEqual(
      new Set(['z-rib', 'z-alto', 'z-car']),
    );
  });

  /**
   * The exception that keeps the list an index. A whole district is one press to
   * reopen, so its rows having nothing to light costs nothing — except at the
   * moment somebody is actually pointing at one, which is the moment they are
   * deciding whether to press it.
   */
  it('draws the one being pointed at, so the row still finds its ground', () => {
    expect(zonesOutOfPlay(DISTRICTS, SECTORS, ['z-rib', 'z-car'], ['z-car'])).toEqual(
      new Set(['z-rib']),
    );
  });

  /**
   * `every()` on an empty list is true, so a district with no sectors would
   * otherwise report itself entirely closed and vanish. `sectorsOf()` cannot
   * build one — which is exactly why this is guarded rather than trusted.
   */
  it('does not read an empty district as a closed one', () => {
    const empty = [{ id: 'nowhere', name: 'Nowhere', sectorIds: [] }];
    expect(zonesOutOfPlay(empty, SECTORS, [])).toEqual(new Set());
    // Nor one whose sectors exist and hold no ground, which is the same
    // `every()`-on-nothing trap one level down.
    const hollow = [{ id: 'hollow', name: 'Hollow', sectorIds: ['ghost'] }];
    const ghost = [{ id: 'ghost', name: 'Ghost', district: 'hollow', zoneIds: [] }];
    expect(zonesOutOfPlay(hollow, ghost, [])).toEqual(new Set());
  });
});
