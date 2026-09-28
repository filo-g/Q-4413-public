import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  activeMarkers,
  gameGeoFromGeoJson,
  markerExpired,
  nextMarkerExpiry,
  placeMarker,
  MARKER_LABEL_MAX,
  MARKER_MAX,
  MARKER_TTL_MAX_MS,
  MARKER_TTL_MIN_MS,
  type MarkerInput,
} from '@q4413/core';
import type { GameGeoJson, MasterMarker, Player, Team } from '@q4413/shared';

/**
 * The master markers (R-19, R-20b, R-21c).
 *
 * Everything a marker can get wrong is decided in `placeMarker()` so it can be
 * checked here rather than against a running Durable Object: an audience nobody
 * is in, a TTL that outlives the game, a coordinate pair typed the wrong way
 * round. The Worker's remaining share — one alarm, one storage write, one
 * broadcast — is the part a field rehearsal checks.
 */
const geo = gameGeoFromGeoJson(
  JSON.parse(
    readFileSync(new URL('../packages/shared/geo/madrid.geojson', import.meta.url), 'utf8'),
  ) as GameGeoJson,
);

const NOW = 1_760_000_000_000;
const CONFIG = { markerDefaultTtlMs: 300_000 };

const PLAYERS: Player[] = [
  {
    id: 'player-romeo',
    callsign: 'ROMEO',
    fullName: 'Nombre de ROMEO',
    teamId: 'team-zulu',
    sessionToken: 'token-romeo',
  },
];
const TEAMS: Team[] = [{ id: 'team-zulu', name: 'ZULU', playerIds: ['player-romeo'] }];

/** Inside the venue: the first vertex of the perimeter, nudged nowhere. */
const INSIDE = (() => {
  const ring = geo.perimeter.coordinates[0] ?? [];
  const lons = ring.map(([lon]) => lon!);
  const lats = ring.map(([, lat]) => lat!);
  return {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lon: (Math.min(...lons) + Math.max(...lons)) / 2,
  };
})();

const place = (input: MarkerInput, now = NOW, existing: MasterMarker[] = []) =>
  placeMarker(
    input,
    { players: PLAYERS, teams: TEAMS, ingestArea: geo.ingestArea, config: CONFIG, existing },
    'marker-test',
    now,
  );

/** `count` live markers, each with a TTL, for filling the slots. */
const filled = (count: number, ttlMs = 300_000): MasterMarker[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `marker-${index}`,
    label: `M${index}`,
    ...INSIDE,
    audience: { kind: 'all' as const },
    placedAt: NOW,
    expiresAt: NOW + ttlMs,
  }));

const valid: MarkerInput = { label: 'Punto de reunion', ...INSIDE, audience: { kind: 'all' } };

describe('placeMarker() — what a master supplies', () => {
  it('builds a marker with the default TTL when none is given (R-19)', () => {
    const result = place(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      id: 'marker-test',
      label: 'Punto de reunion',
      audience: { kind: 'all' },
      placedAt: NOW,
      expiresAt: NOW + CONFIG.markerDefaultTtlMs,
    });
  });

  it('trims the label and refuses an empty one', () => {
    const trimmed = place({ ...valid, label: '  Aqui  ' });
    expect(trimmed.ok && trimmed.value.label).toBe('Aqui');
    expect(place({ ...valid, label: '   ' })).toMatchObject({
      ok: false,
      error: { reason: 'LABEL_REQUIRED' },
    });
  });

  it('refuses a label longer than a phrase', () => {
    expect(place({ ...valid, label: 'x'.repeat(MARKER_LABEL_MAX + 1) })).toMatchObject({
      ok: false,
      error: { reason: 'LABEL_TOO_LONG' },
    });
    expect(place({ ...valid, label: 'x'.repeat(MARKER_LABEL_MAX) }).ok).toBe(true);
  });

  it('refuses a position that is not a pair of finite numbers', () => {
    for (const broken of [
      { lat: undefined, lon: INSIDE.lon },
      { lat: INSIDE.lat, lon: undefined },
      { lat: Number.NaN, lon: INSIDE.lon },
      { lat: 91, lon: INSIDE.lon },
      { lat: INSIDE.lat, lon: 181 },
    ]) {
      expect(place({ ...valid, ...broken })).toMatchObject({
        ok: false,
        error: { reason: 'BAD_POSITION' },
      });
    }
  });

  /**
   * The mistake this catches is a swapped pair: 36,66 / -4,48 typed the other way
   * round is a point off the Horn of Africa, and a marker there is silently
   * invisible on every map instead of being an error anybody sees.
   */
  it('refuses a position outside the ingest area', () => {
    expect(place({ ...valid, lat: INSIDE.lon, lon: INSIDE.lat })).toMatchObject({
      ok: false,
      error: { reason: 'OUTSIDE_INGEST_AREA' },
    });
  });

  it('accepts a marker between the perimeter and the ingest area', () => {
    // Deliberate: the car park entrance and the gate are legitimate instructions
    // and sit outside the playable area.
    const ring = geo.ingestArea.coordinates[0] ?? [];
    const lats = ring.map(([, lat]) => lat!);
    const perimeterLats = (geo.perimeter.coordinates[0] ?? []).map(([, lat]) => lat!);
    const between = (Math.max(...perimeterLats) + Math.max(...lats)) / 2;
    expect(place({ ...valid, lat: between }).ok).toBe(true);
  });
});

describe('placeMarker() — the audience (R-19, R-20)', () => {
  it('takes a team or a single player', () => {
    const team = place({ ...valid, audience: { kind: 'team', teamId: 'team-zulu' } });
    expect(team.ok && team.value.audience).toEqual({ kind: 'team', teamId: 'team-zulu' });
    const player = place({ ...valid, audience: { kind: 'player', playerId: 'player-romeo' } });
    expect(player.ok && player.value.audience).toEqual({
      kind: 'player',
      playerId: 'player-romeo',
    });
  });

  /**
   * A marker addressed to nobody is worse than a refused one: it is on no screen,
   * expires from no map, and looks to the master exactly like one that worked.
   */
  it('refuses an audience nobody is in', () => {
    expect(place({ ...valid, audience: { kind: 'team', teamId: 'team-nope' } })).toMatchObject({
      ok: false,
      error: { reason: 'UNKNOWN_TEAM' },
    });
    expect(
      place({ ...valid, audience: { kind: 'player', playerId: 'player-nope' } }),
    ).toMatchObject({ ok: false, error: { reason: 'UNKNOWN_PLAYER' } });
  });

  /** Not defaulted by absence: R-19 has the master choose, and "everyone" is a choice. */
  it('refuses an absent or unrecognised audience', () => {
    expect(place({ ...valid, audience: undefined })).toMatchObject({
      ok: false,
      error: { reason: 'BAD_AUDIENCE' },
    });
    expect(
      place({ ...valid, audience: { kind: 'zone', zoneId: 'zone-parque' } as never }),
    ).toMatchObject({ ok: false, error: { reason: 'BAD_AUDIENCE' } });
  });
});

describe('placeMarker() — the cap (R-20b)', () => {
  it('fills five slots and refuses the sixth', () => {
    for (let count = 0; count < MARKER_MAX; count += 1) {
      expect(place(valid, NOW, filled(count)).ok).toBe(true);
    }
    expect(place(valid, NOW, filled(MARKER_MAX))).toMatchObject({
      ok: false,
      error: { reason: 'MARKER_LIMIT', max: MARKER_MAX },
    });
  });

  /**
   * A slot held by a marker whose TTL has passed is not a slot. The alarm may be
   * late — it was measured not running at all while the object was idle — so the
   * cap has to be counted against what is live, not against what is stored.
   */
  it('does not count an expired marker against the cap', () => {
    const expired = filled(MARKER_MAX, 60_000);
    expect(place(valid, NOW + 61_000, expired).ok).toBe(true);
  });

  /**
   * The cap is checked before anything else: a master who is at five and typed a
   * bad label should be told about the five, not sent to fix the label on a
   * request that was going to be refused anyway.
   */
  it('reports the limit rather than a second problem with the same request', () => {
    expect(place({ ...valid, label: '  ' }, NOW, filled(MARKER_MAX))).toMatchObject({
      error: { reason: 'MARKER_LIMIT' },
    });
  });
});

describe('placeMarker() — the TTL (R-19, R-21c)', () => {
  it('takes an explicit TTL and expires from it', () => {
    const result = place({ ...valid, ttlMs: 600_000 });
    expect(result.ok && result.value.expiresAt).toBe(NOW + 600_000);
  });

  /**
   * `null` is "no expiry" and `undefined` is "you did not say" (R-21c). Collapsing
   * them would make a forgotten field place a permanent marker, which is the one
   * mistake an indefinite TTL makes possible.
   */
  it('takes null as no expiry, and absent as the default', () => {
    const indefinite = place({ ...valid, ttlMs: null });
    expect(indefinite.ok).toBe(true);
    expect(indefinite.ok && 'expiresAt' in indefinite.value).toBe(false);

    const defaulted = place({ ...valid, ttlMs: undefined });
    expect(defaulted.ok && defaulted.value.expiresAt).toBe(NOW + CONFIG.markerDefaultTtlMs);
  });

  it('does not apply the TTL bounds to a marker that has no TTL', () => {
    expect(place({ ...valid, ttlMs: null }).ok).toBe(true);
  });

  it('refuses a TTL outside the bounds', () => {
    for (const ttlMs of [0, -1, MARKER_TTL_MIN_MS - 1, MARKER_TTL_MAX_MS + 1, Number.NaN]) {
      expect(place({ ...valid, ttlMs })).toMatchObject({ ok: false, error: { reason: 'BAD_TTL' } });
    }
    expect(place({ ...valid, ttlMs: MARKER_TTL_MIN_MS }).ok).toBe(true);
    expect(place({ ...valid, ttlMs: MARKER_TTL_MAX_MS }).ok).toBe(true);
  });
});

describe('expiry is derived, not waited for (R-21c)', () => {
  const marker: MasterMarker = {
    id: 'marker-1',
    label: 'Aqui',
    ...INSIDE,
    audience: { kind: 'all' },
    placedAt: NOW,
    expiresAt: NOW + 300_000,
  };

  it('is not expired before its TTL, and is at it', () => {
    expect(markerExpired(marker, NOW + 299_999)).toBe(false);
    expect(markerExpired(marker, NOW + 300_000)).toBe(true);
    expect(markerExpired(null, NOW)).toBe(false);
  });

  /** The whole of "indefinite", in one place so no caller has to remember it. */
  it('never expires a marker with no TTL, however late it is asked', () => {
    const { expiresAt: _dropped, ...forever } = marker;
    expect(markerExpired(forever, NOW + 86_400_000)).toBe(false);
    expect(activeMarkers([forever], NOW + 86_400_000)).toHaveLength(1);
  });

  /**
   * The guard that matters: an alarm is a scheduled request, and it can be late or
   * lost to a deploy replacing the object. A marker past its TTL must be absent
   * from the next projection whether or not anything has cleared it yet.
   */
  it('reads as absent once the TTL has passed, with nothing having run', () => {
    expect(activeMarkers([marker], NOW + 1_000)).toHaveLength(1);
    expect(activeMarkers([marker], NOW + 300_001)).toHaveLength(0);
    expect(activeMarkers([], NOW)).toHaveLength(0);
  });

  /**
   * Soonest first, indefinite last. What is about to disappear is what a master
   * needs to see first, and a marker that never expires has no place in a queue
   * ordered by urgency.
   */
  it('orders the live ones by how soon they go', () => {
    const { expiresAt: _dropped, ...forever } = { ...marker, id: 'marker-forever' };
    const soon = { ...marker, id: 'marker-soon', expiresAt: NOW + 10_000 };
    const later = { ...marker, id: 'marker-later', expiresAt: NOW + 200_000 };
    expect(activeMarkers([forever, later, soon], NOW).map((m) => m.id)).toEqual([
      'marker-soon',
      'marker-later',
      'marker-forever',
    ]);
  });
});

describe('nextMarkerExpiry() — one alarm for the whole set (R-21c, §6.3)', () => {
  const base = {
    label: 'Aqui',
    ...INSIDE,
    audience: { kind: 'all' as const },
    placedAt: NOW,
  };

  it('is the earliest expiry among them', () => {
    expect(
      nextMarkerExpiry([
        { ...base, id: 'a', expiresAt: NOW + 90_000 },
        { ...base, id: 'b', expiresAt: NOW + 30_000 },
        { ...base, id: 'c', expiresAt: NOW + 60_000 },
      ]),
    ).toBe(NOW + 30_000);
  });

  /** Five indefinite markers schedule nothing, which is the point of the field. */
  it('is undefined when nothing expires', () => {
    expect(nextMarkerExpiry([])).toBeUndefined();
    expect(nextMarkerExpiry([{ ...base, id: 'a' }, { ...base, id: 'b' }])).toBeUndefined();
  });

  it('ignores the indefinite ones rather than treating them as due', () => {
    expect(
      nextMarkerExpiry([{ ...base, id: 'a' }, { ...base, id: 'b', expiresAt: NOW + 45_000 }]),
    ).toBe(NOW + 45_000);
  });
});
