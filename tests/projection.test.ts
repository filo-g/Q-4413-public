import { beforeEach, describe, expect, it } from 'vitest';

import { geoJsonFromPayload, project, type Recipient, type World } from '@q4413/core';
import type { Game, GameEvent, MasterMarker, Payload, Player, Poi, Team } from '@q4413/shared';

/**
 * The §4 visibility matrix, which is **normative**: every row here is a row
 * there, asserted across all six recipient columns.
 *
 * This is the only security boundary in the system — there is no second layer
 * behind it — so the tests are written against the table rather than against the
 * implementation, and they assert absence as hard as presence.
 */

const NOW = 1_756_000_000_000;
const FRESH = NOW - 5_000;
const STALE = NOW - 200_000; // beyond linkThresholdMs

const square = (lon: number, lat: number, size = 0.01) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ],
  ],
});

const POI_ALL: Poi = {
  id: 'poi-all',
  name: 'Acceso',
  lat: 36.659,
  lon: -4.478,
  category: 'ENTRANCE',
  zone: 'zone-north',
};
const POI_TEAM_A: Poi = {
  id: 'poi-team-a',
  name: 'Objetivo A',
  lat: 36.6591,
  lon: -4.4781,
  category: 'OBJECTIVE',
  zone: 'zone-north',
  audience: { kind: 'team', teamId: 'team-a' },
};
const POI_PLAYER_CHARLIE: Poi = {
  id: 'poi-player-charlie',
  name: 'Encargo Charlie',
  lat: 36.6592,
  lon: -4.4782,
  category: 'OTHER',
  zone: 'zone-north',
  audience: { kind: 'player', playerId: 'charlie' },
};

const MARKER: MasterMarker = {
  id: 'marker-1',
  label: 'Aqui',
  lat: 36.6593,
  lon: -4.4783,
  audience: { kind: 'team', teamId: 'team-a' },
  placedAt: FRESH,
  expiresAt: NOW + 300_000,
};

const EVENTS: GameEvent[] = [
  { ts: FRESH, kind: 'DEVICE_SEEN', target: 'unpaired-1', visibility: 'MASTER' },
  { ts: FRESH, kind: 'GAME_STATE', data: { state: 'IN_PROGRESS' }, visibility: 'ALL' },
  {
    ts: FRESH,
    kind: 'AUTHORITATIVE_OPENED',
    actor: 'master',
    visibility: 'MASTER_AUTHORITATIVE',
  },
];

const TEAMS: Team[] = [
  { id: 'team-a', name: 'Equipo A', playerIds: ['alfa', 'bravo', 'delta', 'foxtrot', 'golf'] },
  { id: 'team-b', name: 'Equipo B', playerIds: ['charlie', 'eco'] },
];

const player = (over: Partial<Player> & Pick<Player, 'id' | 'callsign' | 'teamId'>): Player => ({
  fullName: `Nombre de ${over.callsign}`,
  sessionToken: `token-${over.id}`,
  ...over,
});

const at = (
  lat: number,
  lon: number,
  ts: number,
  zoneId: string,
  extra: { accuracy?: number; bearing?: number } = {},
) => ({
  lat,
  lon,
  accuracy: extra.accuracy ?? 8,
  ...(extra.bearing === undefined ? {} : { bearing: extra.bearing }),
  ts,
  state: 'MOVING' as const,
  zoneId,
});

let world: World;

/**
 * alfa   team-a  north  live          — the usual viewer
 * bravo  team-a  north  live          — same zone, close
 * golf   team-a  north  live          — same zone, far
 * delta  team-a  north  feed stopped  — flat battery
 * foxtrot team-a north  eliminated    — same zone, must look like delta
 * charlie team-b south  live          — other zone
 * eco    team-b south  eliminated     — other zone and eliminated
 */
beforeEach(() => {
  const game: Game = {
    id: 'game-1',
    name: 'Q-4413',
    state: 'IN_PROGRESS',
    startedAt: NOW - 3_600_000,
    ingestSecret: 'secret',
    cutSwitch: false,
    // R-21d off, which is the default and what most rows below assume.
    commsReach: 3,
    geo: {
      perimeter: square(-4.49, 36.65),
      ingestArea: square(-4.5, 36.64, 0.05),
      zones: [
        {
          id: 'zone-north',
          name: 'Zona Norte',
          geometry: square(-4.48, 36.659, 0.002),
          sector: 'norte',
        },
        {
          id: 'zone-south',
          name: 'Zona Sur',
          geometry: square(-4.48, 36.653, 0.002),
          sector: 'sur',
        },
      ],
      pois: [POI_ALL, POI_TEAM_A, POI_PLAYER_CHARLIE],
      // R-70's grouping. Two sectors in one district, which is the smallest
      // shape that can have one switched off and the other left on.
      sectors: [
        { id: 'norte', name: 'Norte', district: 'pueblo', zoneIds: ['zone-north'] },
        { id: 'sur', name: 'Sur', district: 'pueblo', zoneIds: ['zone-south'] },
      ],
      districts: [{ id: 'pueblo', name: 'Pueblo', sectorIds: ['norte', 'sur'] }],
    },
    basemap: { pmtilesUrl: '', styleUrl: '', bbox: [0, 0, 0, 0], maxZoom: 17 },
    config: {
      linkThresholdMs: 90_000,
      radioContactValidityMs: 300_000,
      authoritativeIdleRevertMs: 600_000,
      markerDefaultTtlMs: 300_000,
      detourFactor: 1.35,
      walkingSpeed: 1.4,
      bearingFreezeSpeed: 0.5,
      bearingSmoothing: 0.12,
      poiProximityRadius: 50,
    },
  };

  world = {
    game,
    teams: TEAMS,
    events: EVENTS,
    markers: [MARKER],
    tray: [
      { deviceId: 'unpaired-1', firstSeen: FRESH, lastSeen: FRESH, lat: 36.659, lon: -4.478, pings: 3 },
    ],
    players: [
      player({
        id: 'alfa',
        callsign: 'ALFA',
        teamId: 'team-a',
        position: at(36.659, -4.478, FRESH, 'zone-north', { bearing: 91 }),
        knownPosition: { lat: 36.659, lon: -4.478, ts: FRESH },
        battery: 88,
      }),
      player({
        id: 'bravo',
        callsign: 'BRAVO',
        teamId: 'team-a',
        position: at(36.6592, -4.4781, FRESH, 'zone-north'),
        knownPosition: { lat: 36.6592, lon: -4.4781, ts: FRESH },
        battery: 71,
        radioContact: { ts: FRESH, reportedBy: 'alfa' },
      }),
      player({
        id: 'golf',
        callsign: 'GOLF',
        teamId: 'team-a',
        position: at(36.6598, -4.4788, FRESH, 'zone-north'),
        knownPosition: { lat: 36.6598, lon: -4.4788, ts: FRESH },
        battery: 64,
      }),
      player({
        id: 'delta',
        callsign: 'DELTA',
        teamId: 'team-a',
        // Flat battery: live position is stale, last known is where it stopped.
        position: at(36.6595, -4.4785, STALE, 'zone-north'),
        knownPosition: { lat: 36.6594, lon: -4.4784, ts: STALE },
        battery: 3,
      }),
      player({
        id: 'foxtrot',
        callsign: 'FOXTROT',
        teamId: 'team-a',
        // Eliminated, but still pinging: AUTHORITATIVE sees it move.
        position: at(36.6596, -4.4786, FRESH, 'zone-north'),
        knownPosition: { lat: 36.6593, lon: -4.4783, ts: FRESH - 60_000 },
        battery: 55,
        eliminated: { ts: FRESH - 60_000, dropPoint: { lat: 36.6593, lon: -4.4783 }, selfDeclared: true },
      }),
      player({
        id: 'charlie',
        callsign: 'CHARLIE',
        teamId: 'team-b',
        position: at(36.6535, -4.4785, FRESH, 'zone-south'),
        knownPosition: { lat: 36.6535, lon: -4.4785, ts: FRESH },
        battery: 90,
        radioContact: { ts: FRESH, reportedBy: 'MASTER' },
      }),
      player({
        id: 'eco',
        callsign: 'ECO',
        teamId: 'team-b',
        position: at(36.6536, -4.4786, FRESH, 'zone-south'),
        knownPosition: { lat: 36.6536, lon: -4.4786, ts: FRESH },
        eliminated: { ts: FRESH - 30_000, dropPoint: { lat: 36.6536, lon: -4.4786 }, selfDeclared: true },
      }),
    ],
  };
});

/* ------------------------------------------------------------------ */
/* Recipient columns                                                  */
/* ------------------------------------------------------------------ */

const SAME_ZONE: Recipient = { kind: 'PLAYER', playerId: 'alfa' };
const OTHER_ZONE: Recipient = { kind: 'PLAYER', playerId: 'charlie' };
const ELIMINATED_SELF: Recipient = { kind: 'PLAYER', playerId: 'eco' };
const MASTER_OPERATIONAL: Recipient = { kind: 'MASTER', viewMode: 'OPERATIONAL' };
const MASTER_AUTHORITATIVE: Recipient = { kind: 'MASTER', viewMode: 'AUTHORITATIVE' };

const projectFor = (recipient: Recipient): Payload => project(world, recipient, NOW);
const find = (payload: Payload, id: string) => payload.players.find((p) => p.id === id);

/* ------------------------------------------------------------------ */
/* §4 row by row                                                      */
/* ------------------------------------------------------------------ */

describe('§4 — Callsign', () => {
  it('reaches a player in the same zone', () => {
    expect(find(projectFor(SAME_ZONE), 'bravo')?.callsign).toBe('BRAVO');
  });

  it('reaches a player in another zone — it is all they get (R-40)', () => {
    const charlie = find(projectFor(SAME_ZONE), 'charlie');
    expect(charlie?.callsign).toBe('CHARLIE');
    expect(charlie?.outOfZone).toBe(true);
  });

  it('is on the recipient own record', () => {
    expect(projectFor(SAME_ZONE).self?.callsign).toBe('ALFA');
  });

  it('is on an eliminated recipient own record', () => {
    expect(projectFor(ELIMINATED_SELF).self?.callsign).toBe('ECO');
  });

  it('reaches the master in OPERATIONAL', () => {
    expect(projectFor(MASTER_OPERATIONAL).players.map((p) => p.callsign)).toContain('DELTA');
  });

  it('reaches the master in AUTHORITATIVE', () => {
    expect(projectFor(MASTER_AUTHORITATIVE).players.map((p) => p.callsign)).toContain('DELTA');
  });
});

describe('§4 — Full name (R-27)', () => {
  it('never reaches a player about a same-zone player', () => {
    expect(find(projectFor(SAME_ZONE), 'bravo')?.fullName).toBeUndefined();
  });

  it('never reaches a player about an out-of-zone player', () => {
    expect(find(projectFor(SAME_ZONE), 'charlie')?.fullName).toBeUndefined();
  });

  it('is on the recipient own record', () => {
    expect(projectFor(SAME_ZONE).self?.fullName).toBe('Nombre de ALFA');
  });

  it('is on an eliminated recipient own record', () => {
    expect(projectFor(ELIMINATED_SELF).self?.fullName).toBe('Nombre de ECO');
  });

  it('reaches the master in OPERATIONAL', () => {
    expect(find(projectFor(MASTER_OPERATIONAL), 'bravo')?.fullName).toBe('Nombre de BRAVO');
  });

  it('reaches the master in AUTHORITATIVE', () => {
    expect(find(projectFor(MASTER_AUTHORITATIVE), 'bravo')?.fullName).toBe('Nombre de BRAVO');
  });
});

describe('§4 — Live position, feed active', () => {
  it('reaches a player about a same-zone player', () => {
    const bravo = find(projectFor(SAME_ZONE), 'bravo');
    expect(bravo?.position?.source).toBe('LIVE');
    expect(bravo?.position?.lat).toBe(36.6592);
  });

  it('does not reach a player about an out-of-zone player', () => {
    expect(find(projectFor(SAME_ZONE), 'charlie')?.position).toBeUndefined();
  });

  it('is on the recipient own record', () => {
    expect(projectFor(SAME_ZONE).self?.position?.source).toBe('LIVE');
  });

  it('is on an eliminated recipient own record, and nobody else', () => {
    const payload = projectFor(ELIMINATED_SELF);
    expect(payload.self?.position?.source).toBe('LIVE');
    expect(payload.players).toEqual([]);
  });

  it('reaches the master in OPERATIONAL', () => {
    expect(find(projectFor(MASTER_OPERATIONAL), 'bravo')?.position?.source).toBe('LIVE');
  });

  it('reaches the master in AUTHORITATIVE', () => {
    expect(find(projectFor(MASTER_AUTHORITATIVE), 'bravo')?.position?.source).toBe('LIVE');
  });
});

describe('§4 — Live position, feed stopped', () => {
  it('does not reach a player about a same-zone player: they get last known', () => {
    const delta = find(projectFor(SAME_ZONE), 'delta');
    expect(delta?.position?.source).toBe('LAST_KNOWN');
    expect(delta?.position?.lat).toBe(36.6594);
  });

  it('does not reach a player about an out-of-zone player at all', () => {
    const payload = project(world, { kind: 'PLAYER', playerId: 'charlie' }, NOW);
    expect(find(payload, 'delta')?.position).toBeUndefined();
  });

  it('is hidden from the master in OPERATIONAL, which shows last known instead (R-22)', () => {
    const delta = find(projectFor(MASTER_OPERATIONAL), 'delta');
    expect(delta?.position?.source).toBe('LAST_KNOWN');
    expect(delta?.position?.lat).toBe(36.6594);
  });

  it('reaches the master in AUTHORITATIVE', () => {
    const delta = find(projectFor(MASTER_AUTHORITATIVE), 'delta');
    expect(delta?.position?.source).toBe('LIVE');
    expect(delta?.position?.lat).toBe(36.6595);
  });

  it('treats an eliminated player as a stopped feed for the master in OPERATIONAL', () => {
    // A flat battery and a dead player take the same branch by design (R-22).
    const foxtrot = find(projectFor(MASTER_OPERATIONAL), 'foxtrot');
    expect(foxtrot?.position?.source).toBe('LAST_KNOWN');
    expect(foxtrot?.position?.lat).toBe(36.6593);
  });

  it('shows the eliminated player really moving in AUTHORITATIVE', () => {
    const foxtrot = find(projectFor(MASTER_AUTHORITATIVE), 'foxtrot');
    expect(foxtrot?.position?.source).toBe('LIVE');
    expect(foxtrot?.position?.lat).toBe(36.6596);
  });
});

describe('§4 — Last known position, feed stopped', () => {
  it('reaches a player about a same-zone player', () => {
    expect(find(projectFor(SAME_ZONE), 'delta')?.position?.source).toBe('LAST_KNOWN');
  });

  it('does not reach a player about an out-of-zone player — no ghost marker (R-40)', () => {
    const payload = project(world, OTHER_ZONE, NOW);
    const delta = find(payload, 'delta');
    expect(delta?.outOfZone).toBe(true);
    expect(delta?.position).toBeUndefined();
  });

  it('is on the recipient own record', () => {
    expect(projectFor(SAME_ZONE).self?.position).toBeDefined();
  });

  it('reaches the master in OPERATIONAL', () => {
    expect(find(projectFor(MASTER_OPERATIONAL), 'delta')?.position?.source).toBe('LAST_KNOWN');
  });

  it('reaches the master in AUTHORITATIVE', () => {
    expect(find(projectFor(MASTER_AUTHORITATIVE), 'delta')?.position).toBeDefined();
  });

  it('renders a stopped feed as NO_LINK, so the circle can grow (R-12)', () => {
    expect(find(projectFor(SAME_ZONE), 'delta')?.position?.state).toBe('NO_LINK');
  });
});

describe('§4 — Distance and proximity sort (R-42)', () => {
  it('reaches a player for same-zone players', () => {
    expect(find(projectFor(SAME_ZONE), 'bravo')?.distanceMetres).toBeGreaterThan(0);
  });

  it('never reaches a player for out-of-zone players', () => {
    for (const other of projectFor(SAME_ZONE).players.filter((p) => p.outOfZone)) {
      expect(other.distanceMetres).toBeUndefined();
    }
  });

  it('sorts same-zone players by proximity, closest first', () => {
    const sameZone = projectFor(SAME_ZONE).players.filter((p) => !p.outOfZone);
    const distances = sameZone.map((p) => p.distanceMetres ?? Infinity);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(sameZone[0]?.callsign).toBe('BRAVO');
  });

  it('puts the out-of-zone group last, ordered by callsign and not by position', () => {
    const payload = projectFor(SAME_ZONE);
    const outOfZone = payload.players.filter((p) => p.outOfZone);
    const firstOutOfZoneIndex = payload.players.findIndex((p) => p.outOfZone);
    expect(payload.players.slice(firstOutOfZoneIndex).every((p) => p.outOfZone)).toBe(true);
    expect(outOfZone.map((p) => p.callsign)).toEqual(['CHARLIE', 'ECO']);
  });

  it('does not give the master a distance in OPERATIONAL', () => {
    for (const other of projectFor(MASTER_OPERATIONAL).players) {
      expect(other.distanceMetres).toBeUndefined();
    }
  });
});

describe('§4 — Battery, accuracy, link state', () => {
  it('reaches a player about a same-zone player', () => {
    const bravo = find(projectFor(SAME_ZONE), 'bravo');
    expect(bravo?.battery).toBe(71);
    expect(bravo?.position?.accuracy).toBe(8);
    expect(bravo?.position?.state).toBe('MOVING');
  });

  it('does not reach a player about an out-of-zone player', () => {
    const charlie = find(projectFor(SAME_ZONE), 'charlie');
    expect(charlie?.battery).toBeUndefined();
    expect(charlie?.position).toBeUndefined();
  });

  it('is on the recipient own record', () => {
    expect(projectFor(SAME_ZONE).self?.battery).toBe(88);
  });

  it('reaches the master in both view modes', () => {
    expect(find(projectFor(MASTER_OPERATIONAL), 'delta')?.battery).toBe(3);
    expect(find(projectFor(MASTER_AUTHORITATIVE), 'delta')?.battery).toBe(3);
  });

  /**
   * The link state on the wire is derived at send time (R-11), never copied off
   * the player record. Delta's stored claim is MOVING from 200 s ago; a snapshot
   * repeating that claim would be wrong before any client saw it.
   */
  it('is derived from the position age, not copied from the stored claim', () => {
    const stored = world.players.find((p) => p.id === 'delta')?.position;
    expect(stored?.state).toBe('MOVING');

    // AUTHORITATIVE takes the LIVE source even for a stopped feed (R-22), which
    // is the one path where a stale stored claim could reach a socket.
    const live = find(projectFor(MASTER_AUTHORITATIVE), 'delta')?.position;
    expect(live?.source).toBe('LIVE');
    expect(live?.state).toBe('NO_LINK');
  });

  it('is derived on the recipient own record too', () => {
    // A player whose own phone died still had their own dot claiming MOVING.
    world.players = world.players.map((p) =>
      p.id === 'alfa' ? { ...p, position: at(36.659, -4.478, STALE, 'zone-north') } : p,
    );
    expect(projectFor(SAME_ZONE).self?.position?.state).toBe('NO_LINK');
  });
});

describe('§4 — Radio contact (R-29)', () => {
  it('reaches a player about a same-zone player', () => {
    expect(find(projectFor(SAME_ZONE), 'bravo')?.radioContact?.reportedBy).toBe('alfa');
  });

  it('crosses zones on purpose: it is liveness, not location', () => {
    const charlie = find(projectFor(SAME_ZONE), 'charlie');
    expect(charlie?.outOfZone).toBe(true);
    expect(charlie?.position).toBeUndefined();
    expect(charlie?.radioContact?.reportedBy).toBe('MASTER');
  });

  it('reaches the master in both view modes', () => {
    expect(find(projectFor(MASTER_OPERATIONAL), 'charlie')?.radioContact).toBeDefined();
    expect(find(projectFor(MASTER_AUTHORITATIVE), 'charlie')?.radioContact).toBeDefined();
  });
});

describe('§4 — Elimination state', () => {
  it('never reaches a player about a same-zone player (R-30.2, R-30.3)', () => {
    const foxtrot = find(projectFor(SAME_ZONE), 'foxtrot');
    expect(foxtrot).toBeDefined();
    expect(foxtrot?.eliminated).toBeUndefined();
  });

  it('makes an eliminated same-zone player indistinguishable from a flat battery', () => {
    const payload = projectFor(SAME_ZONE);
    const foxtrot = find(payload, 'foxtrot');
    const delta = find(payload, 'delta');
    expect(foxtrot?.position?.source).toBe(delta?.position?.source);
    expect(foxtrot?.position?.state).toBe(delta?.position?.state);
    expect(Object.keys(foxtrot ?? {}).sort()).toEqual(Object.keys(delta ?? {}).sort());
  });

  it('never reaches a player about an out-of-zone player', () => {
    expect(find(projectFor(SAME_ZONE), 'eco')?.eliminated).toBeUndefined();
  });

  it('is on the eliminated recipient own record', () => {
    expect(projectFor(ELIMINATED_SELF).self?.eliminated?.selfDeclared).toBe(true);
  });

  it('is hidden from the master in OPERATIONAL (R-22)', () => {
    for (const other of projectFor(MASTER_OPERATIONAL).players) {
      expect(other.eliminated).toBeUndefined();
    }
  });

  it('reaches the master in AUTHORITATIVE', () => {
    expect(find(projectFor(MASTER_AUTHORITATIVE), 'foxtrot')?.eliminated).toBeDefined();
  });
});

/**
 * **M5's exit criterion, and the risk it names.** With one player eliminated and
 * one player's phone off, `OPERATIONAL` has to render both identically — frozen,
 * growing circle, no cause shown. Every field that keeps advancing for the
 * eliminated player is a code path that tells the master which is which.
 *
 * The measurement against a local Worker is what found this: FOXTROT was still
 * pinging, so their circle stayed tight while DELTA's grew, and their zone and
 * battery followed the phone. All three came from `knownPosition` borrowing the
 * live position's fields, which is invisible for a dead phone and a spoiler for a
 * live one.
 */
describe('§4 — An eliminated player and a dead phone, from the master seat (R-22)', () => {
  beforeEach(() => {
    const foxtrot = world.players.find((candidate) => candidate.id === 'foxtrot')!;
    // Frozen at elimination: two zones and 40 m of accuracy away from where the
    // phone is now, and eleven percentage points of battery ago.
    foxtrot.knownPosition = {
      lat: 36.6593,
      lon: -4.4783,
      // Eliminated long enough ago that the circle is already growing. The first
      // ninety seconds are covered separately below.
      ts: STALE,
      accuracy: 9,
      zoneId: 'zone-north',
    };
    foxtrot.knownBattery = 55;
    foxtrot.position = at(36.6535, -4.4785, FRESH, 'zone-south', { accuracy: 49 });
    foxtrot.battery = 44;
  });

  it('freezes the position, the accuracy and the zone at the moment of elimination', () => {
    const foxtrot = find(projectFor(MASTER_OPERATIONAL), 'foxtrot');
    expect(foxtrot?.position).toMatchObject({
      lat: 36.6593,
      lon: -4.4783,
      ts: STALE,
      accuracy: 9,
      zoneId: 'zone-north',
      source: 'LAST_KNOWN',
      state: 'NO_LINK',
    });
  });

  it('freezes the battery with it, so the roster does not date the position', () => {
    expect(find(projectFor(MASTER_OPERATIONAL), 'foxtrot')?.battery).toBe(55);
  });

  it('renders the two causes with the same fields and the same position source', () => {
    const payload = projectFor(MASTER_OPERATIONAL);
    const foxtrot = find(payload, 'foxtrot');
    const delta = find(payload, 'delta');
    expect(Object.keys(foxtrot ?? {}).sort()).toEqual(Object.keys(delta ?? {}).sort());
    expect(Object.keys(foxtrot?.position ?? {}).sort()).toEqual(
      Object.keys(delta?.position ?? {}).sort(),
    );
    expect(foxtrot?.position?.source).toBe('LAST_KNOWN');
    expect(delta?.position?.source).toBe('LAST_KNOWN');
    expect(foxtrot?.position?.state).toBe('NO_LINK');
    expect(delta?.position?.state).toBe('NO_LINK');
    expect(foxtrot?.eliminated).toBeUndefined();
  });

  /**
   * Both circles grow, which is the visible half of the criterion: the radius is
   * derived from the age of `ts`, so a frozen `ts` is what makes the eliminated
   * player's circle grow at all.
   */
  it('leaves both positions old enough that the circle is growing', () => {
    const payload = projectFor(MASTER_OPERATIONAL);
    for (const id of ['foxtrot', 'delta']) {
      const position = find(payload, id)?.position;
      expect(position).toBeDefined();
      expect(NOW - position!.ts).toBeGreaterThan(world.game.config.linkThresholdMs);
    }
  });

  /**
   * The first ninety seconds after an elimination, which is the one window where
   * the frozen position is not yet stale. The server says `NO_LINK` and the client
   * re-derives `MOVING` from the age (R-11, R-15) — and that is not a leak, because
   * it is exactly what a phone that has just died looks like: a last fix, a dot
   * that stops, and NO_LINK arriving at the threshold. Both causes tell the same
   * story because both are told by the same timestamp.
   */
  it('is not yet stale for a player eliminated seconds ago, like a phone that just died', () => {
    const foxtrot = world.players.find((candidate) => candidate.id === 'foxtrot')!;
    foxtrot.knownPosition = { ...foxtrot.knownPosition!, ts: FRESH };
    const projected = find(projectFor(MASTER_OPERATIONAL), 'foxtrot')?.position;
    expect(projected?.source).toBe('LAST_KNOWN');
    expect(NOW - projected!.ts).toBeLessThan(world.game.config.linkThresholdMs);
  });

  /** And the master who accepted R-24 sees the phone, not the freeze. */
  it('shows the real position, zone and battery in AUTHORITATIVE', () => {
    const foxtrot = find(projectFor(MASTER_AUTHORITATIVE), 'foxtrot');
    expect(foxtrot?.position).toMatchObject({
      lat: 36.6535,
      zoneId: 'zone-south',
      source: 'LIVE',
      accuracy: 49,
    });
    expect(foxtrot?.battery).toBe(44);
    expect(foxtrot?.eliminated?.dropPoint).toEqual({ lat: 36.6593, lon: -4.4783 });
  });
});

describe('§4 — Drop point (R-31)', () => {
  it('never reaches a player, in or out of zone', () => {
    const payload = projectFor(SAME_ZONE);
    for (const other of payload.players) {
      expect(other.eliminated?.dropPoint).toBeUndefined();
    }
  });

  it('is on the eliminated recipient own record', () => {
    expect(projectFor(ELIMINATED_SELF).self?.eliminated?.dropPoint).toEqual({
      lat: 36.6536,
      lon: -4.4786,
    });
  });

  it('is hidden from the master in OPERATIONAL', () => {
    for (const other of projectFor(MASTER_OPERATIONAL).players) {
      expect(other.eliminated?.dropPoint).toBeUndefined();
    }
  });

  it('reaches the master in AUTHORITATIVE', () => {
    expect(find(projectFor(MASTER_AUTHORITATIVE), 'eco')?.eliminated?.dropPoint).toEqual({
      lat: 36.6536,
      lon: -4.4786,
    });
  });

  /**
   * A player who declared with no fix has no drop point (M6), and the projection
   * passes the absence through rather than filling it in. The panel says so in
   * words: an em dash there would read as "not eliminated", which is the one thing
   * it must not say to a master who is entitled to know.
   */
  it('is absent, not invented, for a player who declared with no fix', () => {
    const eco = world.players.find((candidate) => candidate.id === 'eco')!;
    eco.eliminated = { ts: FRESH - 30_000, selfDeclared: true };
    const projected = find(projectFor(MASTER_AUTHORITATIVE), 'eco');
    expect(projected?.eliminated).toEqual({ ts: FRESH - 30_000, selfDeclared: true });
    expect(projected?.eliminated?.dropPoint).toBeUndefined();
    // Still out, and still their own record to see (§4).
    expect(projectFor(ELIMINATED_SELF).self?.eliminated?.selfDeclared).toBe(true);
  });
});

describe('§4 — POIs with audience all', () => {
  it('reach every recipient, eliminated players included (R-30.4)', () => {
    for (const recipient of [
      SAME_ZONE,
      OTHER_ZONE,
      ELIMINATED_SELF,
      MASTER_OPERATIONAL,
      MASTER_AUTHORITATIVE,
    ]) {
      expect(projectFor(recipient).pois.map((poi) => poi.id)).toContain('poi-all');
    }
  });
});

describe('§4 — POIs scoped to a team or a player', () => {
  it('reach only that team', () => {
    expect(projectFor(SAME_ZONE).pois.map((p) => p.id)).toContain('poi-team-a');
    expect(projectFor(OTHER_ZONE).pois.map((p) => p.id)).not.toContain('poi-team-a');
  });

  it('reach only that player', () => {
    expect(projectFor(OTHER_ZONE).pois.map((p) => p.id)).toContain('poi-player-charlie');
    expect(projectFor(SAME_ZONE).pois.map((p) => p.id)).not.toContain('poi-player-charlie');
  });

  it('still reach an eliminated player who is in the audience', () => {
    // eco is team-b: the team-a POI is not theirs, the all-audience one is.
    const pois = projectFor(ELIMINATED_SELF).pois.map((p) => p.id);
    expect(pois).toContain('poi-all');
    expect(pois).not.toContain('poi-team-a');
  });

  it('reach the master in both view modes, whatever the audience', () => {
    for (const recipient of [MASTER_OPERATIONAL, MASTER_AUTHORITATIVE]) {
      expect(projectFor(recipient).pois).toHaveLength(3);
    }
  });

  it('keeps audience scope on team or player, never on zone', () => {
    // Two independent axes: charlie is out of alfa's zone yet still gets the
    // POI addressed to them, and alfa gets the team POI regardless of zone.
    expect(projectFor(OTHER_ZONE).pois.map((p) => p.id)).toEqual([
      'poi-all',
      'poi-player-charlie',
    ]);
  });
});

describe('§4 — Master markers (R-20b)', () => {
  const ids = (recipient: Recipient) => projectFor(recipient).markers.map((m) => m.id);

  it('reaches a player in the audience', () => {
    expect(ids(SAME_ZONE)).toEqual(['marker-1']);
  });

  it('does not reach a player outside the audience', () => {
    expect(ids(OTHER_ZONE)).toEqual([]);
  });

  it('reaches an eliminated player who is in the audience', () => {
    world.markers = [{ ...MARKER, audience: { kind: 'player', playerId: 'eco' } }];
    expect(ids(ELIMINATED_SELF)).toEqual(['marker-1']);
  });

  it('does not reach an eliminated player outside the audience', () => {
    expect(ids(ELIMINATED_SELF)).toEqual([]);
  });

  it('reaches the master in both view modes', () => {
    expect(ids(MASTER_OPERATIONAL)).toEqual(['marker-1']);
    expect(ids(MASTER_AUTHORITATIVE)).toEqual(['marker-1']);
  });

  /**
   * Five markers, three audiences, one recipient: the audience filter runs per
   * marker rather than over the set, which is the thing a slot-shaped
   * implementation would get wrong on the day the cap was raised.
   */
  it('filters the set per marker, not as a whole', () => {
    world.markers = [
      { ...MARKER, id: 'm-all', audience: { kind: 'all' } },
      { ...MARKER, id: 'm-team-a', audience: { kind: 'team', teamId: 'team-a' } },
      { ...MARKER, id: 'm-team-b', audience: { kind: 'team', teamId: 'team-b' } },
      { ...MARKER, id: 'm-charlie', audience: { kind: 'player', playerId: 'charlie' } },
      { ...MARKER, id: 'm-alfa', audience: { kind: 'player', playerId: 'alfa' } },
    ];
    // alfa is team-a
    expect(ids(SAME_ZONE).sort()).toEqual(['m-alfa', 'm-all', 'm-team-a']);
    // charlie is team-b, and in another zone — the marker axis does not care
    expect(ids(OTHER_ZONE).sort()).toEqual(['m-all', 'm-charlie', 'm-team-b']);
    // the master sees all five, in both modes
    expect(ids(MASTER_OPERATIONAL)).toHaveLength(5);
    expect(ids(MASTER_AUTHORITATIVE)).toHaveLength(5);
  });

  /**
   * R-21c's expiry is derived at send time as well as written down by the alarm.
   * An alarm is a scheduled request — it can run late, a deploy can replace the
   * object while one is in flight, and it was measured not running at all while
   * the object was idle — so a marker past its TTL must be absent from the next
   * snapshot with nothing having cleared it, for the master too.
   */
  it('has already stopped reaching anyone once its TTL has passed', () => {
    world.markers = [{ ...MARKER, expiresAt: NOW - 1 }];
    for (const recipient of [SAME_ZONE, MASTER_OPERATIONAL, MASTER_AUTHORITATIVE]) {
      expect(projectFor(recipient).markers).toEqual([]);
    }
  });

  /** A marker with no TTL outlives every clock this test could pass (R-21c). */
  it('keeps an indefinite marker whatever the time is', () => {
    const { expiresAt: _dropped, ...forever } = MARKER;
    world.markers = [forever];
    expect(ids(SAME_ZONE)).toEqual(['marker-1']);
  });

  it('sends them soonest-expiry first, with the indefinite ones last', () => {
    const { expiresAt: _dropped, ...forever } = { ...MARKER, id: 'm-forever' };
    world.markers = [
      forever,
      { ...MARKER, id: 'm-later', expiresAt: NOW + 200_000 },
      { ...MARKER, id: 'm-soon', expiresAt: NOW + 5_000 },
    ];
    expect(ids(SAME_ZONE)).toEqual(['m-soon', 'm-later', 'm-forever']);
  });
});

/**
 * R-21d and R-41b — the only thing in the system that lets team membership touch
 * the position axis, and therefore the rows worth being most careful about.
 *
 * The fixture has alfa (team-a, north) as the viewer, bravo and golf on team-a in
 * the same zone, charlie on team-b in the south, and eco on team-b eliminated.
 * There is no teammate of alfa's in another zone, so these move one.
 */
describe('§4 — Extended comms (R-21d, R-41b)', () => {
  const projected = (recipient: Recipient, id: string) =>
    projectFor(recipient).players.find((player) => player.id === id);

  /** golf is on team-a; moving them south puts a teammate outside alfa's zone. */
  const moveGolfSouth = () => {
    const golf = world.players.find((player) => player.id === 'golf')!;
    golf.position = { ...golf.position!, lat: 36.653, zoneId: 'zone-south' };
    golf.knownPosition = { lat: 36.653, lon: golf.position.lon, ts: golf.position.ts };
  };

  it('is at 3 by default, so R-41 holds: a teammate in another zone is callsign only', () => {
    moveGolfSouth();
    expect(world.game.commsReach).toBe(3);
    const golf = projected(SAME_ZONE, 'golf');
    expect(golf).toMatchObject({ callsign: 'GOLF', outOfZone: true });
    expect(golf?.position).toBeUndefined();
    expect(golf?.distanceMetres).toBeUndefined();
  });

  it('reads an absent level as the narrowest, since a seeded game has no field at all', () => {
    moveGolfSouth();
    delete world.game.commsReach;
    expect(projected(SAME_ZONE, 'golf')?.outOfZone).toBe(true);
    expect(projectFor(SAME_ZONE).game.commsReach).toBe(3);
  });

  it('shows a teammate in another zone exactly as if they were in this one', () => {
    moveGolfSouth();
    world.game.commsReach = 5;
    const golf = projected(SAME_ZONE, 'golf');
    expect(golf?.outOfZone).toBeUndefined();
    expect(golf?.position?.lat).toBe(36.653);
    expect(golf?.position?.state).toBe('MOVING');
    expect(golf?.distanceMetres).toBeGreaterThan(0);
    expect(golf?.battery).toBeDefined();
  });

  /** The line R-41b draws: teammates only. Everybody else stays as R-40 says. */
  it('reaches nobody outside the own team of the viewer', () => {
    world.game.commsReach = 5;
    const charlie = projected(SAME_ZONE, 'charlie');
    expect(charlie).toMatchObject({ callsign: 'CHARLIE', outOfZone: true });
    expect(charlie?.position).toBeUndefined();
    expect(charlie?.distanceMetres).toBeUndefined();
  });

  /**
   * R-30.4 outranks the setting. An eliminated player keeps map furniture and
   * their own position and loses every other player — a comms setting must not
   * hand them the team back.
   */
  it('gives an eliminated player nothing, however extended the comms are', () => {
    world.game.commsReach = 5;
    const payload = projectFor(ELIMINATED_SELF);
    expect(payload.players).toEqual([]);
    expect(payload.self?.id).toBe('eco');
  });

  it('changes nothing about what a master sees, in either mode', () => {
    moveGolfSouth();
    const before = projectFor(MASTER_OPERATIONAL);
    world.game.commsReach = 5;
    const after = projectFor(MASTER_OPERATIONAL);
    expect(after.players).toEqual(before.players);
    expect(projectFor(MASTER_AUTHORITATIVE).players).toHaveLength(before.players.length);
  });

  /**
   * R-72's middle rung, and the only one that is new: the team reaches across
   * zones but **not across sectors**.
   *
   * The fixture is two sectors of one district with a zone each, which is the
   * smallest geometry that can tell 4 from 5 — at 4 golf in `zone-south` is out
   * of alfa's reach because `sur` is not `norte`, and at 5 they are not.
   */
  it('reaches a teammate in another zone of the same sector, and no further', () => {
    moveGolfSouth();
    world.game.commsReach = 4;
    // Different sector: 4 does not reach.
    expect(projected(SAME_ZONE, 'golf')?.outOfZone).toBe(true);

    // Put zone-south in alfa's own sector and the same level now reaches it,
    // with nothing else changed.
    world.game.geo.zones = world.game.geo.zones.map((zone) =>
      zone.id === 'zone-south' ? { ...zone, sector: 'norte' } : zone,
    );
    const golf = projected(SAME_ZONE, 'golf');
    expect(golf?.outOfZone).toBeUndefined();
    expect(golf?.position?.lat).toBe(36.653);
    expect(golf?.distanceMetres).toBeGreaterThan(0);
  });

  /**
   * **Only the team's reach widens**, at every rung. 4 is not "everyone in your
   * sector" — that would put the position axis on ground rather than on team
   * membership, which is the one thing §4 does not let anything else do.
   */
  it('does not reach somebody of another team in the same sector', () => {
    world.game.geo.zones = world.game.geo.zones.map((zone) =>
      zone.id === 'zone-south' ? { ...zone, sector: 'norte' } : zone,
    );
    world.game.commsReach = 4;
    const charlie = projected(SAME_ZONE, 'charlie');
    expect(charlie).toMatchObject({ callsign: 'CHARLIE', outOfZone: true });
    expect(charlie?.position).toBeUndefined();
  });

  /**
   * A teammate on ground R-71 has closed has no zone, so they have no sector —
   * and 4 reaches sectors. The closure takes them out of their team's reach by
   * the same rule that takes them out of everyone's sight, with nothing in the
   * ladder that knows about it. At 5 they are still reached, because 5 asks
   * nothing about where anybody is.
   */
  it('does not reach a teammate standing on closed ground, at 4 but not at 5', () => {
    moveGolfSouth();
    world.game.geo.zones = world.game.geo.zones.map((zone) =>
      zone.id === 'zone-south' ? { ...zone, sector: 'norte' } : zone,
    );
    world.game.commsReach = 4;
    expect(projected(SAME_ZONE, 'golf')?.outOfZone).toBeUndefined();

    world.disabledZones = ['zone-south'];
    expect(projected(SAME_ZONE, 'golf')?.outOfZone).toBe(true);

    world.game.commsReach = 5;
    expect(projected(SAME_ZONE, 'golf')?.outOfZone).toBeUndefined();
  });

  /** The flag itself reaches every recipient: a player deserves to know why. */
  it('tells every recipient which level is in force', () => {
    world.game.commsReach = 5;
    for (const recipient of [SAME_ZONE, OTHER_ZONE, ELIMINATED_SELF, MASTER_OPERATIONAL]) {
      expect(projectFor(recipient).game.commsReach).toBe(5);
    }
  });

  /**
   * R-42 as it now reads: the proximity order covers everyone with a position,
   * which with the setting on includes a teammate two zones away. The out-of-zone
   * group still carries no ordering derived from position.
   */
  it('puts a teammate from another zone into the proximity order', () => {
    moveGolfSouth();
    world.game.commsReach = 5;
    const players = projectFor(SAME_ZONE).players;
    const positioned = players.filter((player) => !player.outOfZone);
    expect(positioned.map((player) => player.id)).toContain('golf');
    const distances = positioned.map((player) => player.distanceMetres ?? Infinity);
    expect([...distances]).toEqual([...distances].sort((a, b) => a - b));
  });
});

describe('§4 — Drawn zone geometry', () => {
  it('reaches every recipient, eliminated players included', () => {
    for (const recipient of [
      SAME_ZONE,
      OTHER_ZONE,
      ELIMINATED_SELF,
      MASTER_OPERATIONAL,
      MASTER_AUTHORITATIVE,
    ]) {
      expect(projectFor(recipient).zones.map((zone) => zone.id)).toEqual([
        'zone-north',
        'zone-south',
      ]);
    }
  });
});

describe('§4 — Event log (§3 visibility)', () => {
  it('never reaches a player', () => {
    expect(projectFor(SAME_ZONE).events).toBeUndefined();
    expect(projectFor(ELIMINATED_SELF).events).toBeUndefined();
  });

  it('hides MASTER_AUTHORITATIVE entries in OPERATIONAL', () => {
    const kinds = projectFor(MASTER_OPERATIONAL).events?.map((event) => event.kind) ?? [];
    expect(kinds).toEqual(['DEVICE_SEEN', 'GAME_STATE']);
  });

  it('shows every entry in AUTHORITATIVE, so opening it is auditable (R-25)', () => {
    const kinds = projectFor(MASTER_AUTHORITATIVE).events?.map((event) => event.kind) ?? [];
    expect(kinds).toContain('AUTHORITATIVE_OPENED');
  });
});

describe('the clock and the tuning constants every recipient derives with', () => {
  /**
   * R-15 wants the age derived on the client; R-36 forbids trusting the client's
   * clock. Both hold only if the snapshot says what time the server thinks it is.
   */
  it('carries the server clock to every recipient', () => {
    for (const recipient of [SAME_ZONE, OTHER_ZONE, ELIMINATED_SELF, MASTER_OPERATIONAL]) {
      expect(projectFor(recipient).serverNow).toBe(NOW);
    }
  });

  it('carries the config, without which no client-side rule can run', () => {
    const config = projectFor(SAME_ZONE).config;
    expect(config.linkThresholdMs).toBe(90_000);
    expect(config.radioContactValidityMs).toBe(300_000);
    expect(config.walkingSpeed).toBe(1.4);
  });

  it('reaches an unknown recipient too, who gets map furniture and nothing else', () => {
    // The fail-closed branch still has to produce a renderable payload.
    const payload = project(world, { kind: 'PLAYER', playerId: 'nobody' }, NOW);
    expect(payload.serverNow).toBe(NOW);
    expect(payload.config.linkThresholdMs).toBe(90_000);
    expect(payload.players).toEqual([]);
  });

  it('never carries the ingest secret, which lives next to the config on the game', () => {
    // §3 puts ingestSecret on Game, one field away from the block now being sent
    // wholesale; a future field added to config must not become a leak by proximity.
    const serialised = JSON.stringify(projectFor(SAME_ZONE));
    expect(serialised).not.toContain('secret');
  });
});

describe('§4 — Perimeter and ingest area', () => {
  it('reach every recipient: the client needs them offline for R-43', () => {
    for (const recipient of [
      SAME_ZONE,
      OTHER_ZONE,
      ELIMINATED_SELF,
      MASTER_OPERATIONAL,
      MASTER_AUTHORITATIVE,
    ]) {
      const payload = projectFor(recipient);
      expect(payload.perimeter.type).toBe('Polygon');
      expect(payload.ingestArea.type).toBe('Polygon');
    }
  });

  it('reach even an unknown recipient, since they are public geometry', () => {
    const payload = project(world, { kind: 'PLAYER', playerId: 'nobody' }, NOW);
    expect(payload.perimeter).toBeDefined();
  });
});

describe('/api/geo is built from the projection, not the file', () => {
  it('carries only the POIs the recipient may see', () => {
    const forCharlie = geoJsonFromPayload(projectFor(OTHER_ZONE));
    const ids = forCharlie.features
      .filter((f) => f.properties.featureType === 'POI')
      .map((f) => f.properties.id);
    // charlie is team-b: the team-a POI is not theirs, the one addressed to them is.
    expect(ids).toEqual(['poi-all', 'poi-player-charlie']);
  });

  it('gives the master every POI', () => {
    const forMaster = geoJsonFromPayload(projectFor(MASTER_OPERATIONAL));
    expect(forMaster.features.filter((f) => f.properties.featureType === 'POI')).toHaveLength(3);
  });

  it('always carries the perimeter, the ingest area and every zone', () => {
    const geo = geoJsonFromPayload(projectFor(SAME_ZONE));
    const types = geo.features.map((f) => f.properties.featureType);
    expect(types.filter((t) => t === 'PERIMETER')).toHaveLength(1);
    expect(types.filter((t) => t === 'INGEST_AREA')).toHaveLength(1);
    expect(types.filter((t) => t === 'ZONE')).toHaveLength(2);
  });

  it('puts featureType on every feature, like the file it replaces (R-51)', () => {
    for (const feature of geoJsonFromPayload(projectFor(SAME_ZONE)).features) {
      expect(feature.properties.featureType).toBeDefined();
    }
  });
});

describe('§4 — Replay (R-26, R-57)', () => {
  it('is unavailable to players', () => {
    expect(projectFor(SAME_ZONE).replayAvailable).toBe(false);
    expect(projectFor(ELIMINATED_SELF).replayAvailable).toBe(false);
  });

  it('is unavailable to the master in OPERATIONAL', () => {
    expect(projectFor(MASTER_OPERATIONAL).replayAvailable).toBe(false);
  });

  it('is available to the master in AUTHORITATIVE', () => {
    expect(projectFor(MASTER_AUTHORITATIVE).replayAvailable).toBe(true);
  });
});

/**
 * R-25's deadline reaching the screen. project() does not compute it — the revert
 * is derived from the stored session by masterRecipient(), and tests/view-mode.test.ts
 * owns that arithmetic. What is checked here is the boundary: it is a master field,
 * and a player payload has no business carrying a master's clock.
 */
describe('§4 — The AUTHORITATIVE deadline (R-25)', () => {
  const WITH_DEADLINE: Recipient = {
    kind: 'MASTER',
    viewMode: 'AUTHORITATIVE',
    authoritativeExpiresAt: NOW + 540_000,
  };

  it('reaches the master who is in AUTHORITATIVE', () => {
    expect(projectFor(WITH_DEADLINE).authoritativeExpiresAt).toBe(NOW + 540_000);
  });

  it('is absent in OPERATIONAL, where there is nothing to count down', () => {
    expect(projectFor(MASTER_OPERATIONAL).authoritativeExpiresAt).toBeUndefined();
    expect(projectFor(MASTER_AUTHORITATIVE).authoritativeExpiresAt).toBeUndefined();
  });

  it('reaches no player, in any zone or state', () => {
    for (const recipient of [SAME_ZONE, OTHER_ZONE, ELIMINATED_SELF]) {
      expect(projectFor(recipient).authoritativeExpiresAt).toBeUndefined();
      expect(projectFor(recipient).viewMode).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Invariants on top of the table                                     */
/* ------------------------------------------------------------------ */

describe('invariants', () => {
  it('never emits fullName to a player socket, in any view mode (R-27)', () => {
    for (const recipient of [SAME_ZONE, OTHER_ZONE, ELIMINATED_SELF]) {
      const payload = projectFor(recipient);
      const serialised = JSON.stringify(payload.players);
      expect(serialised).not.toContain('Nombre de');
      // The recipient own name is theirs to see.
      expect(payload.self?.fullName).toBeDefined();
    }
  });

  it('never leaks another player fullName through the whole payload', () => {
    const payload = projectFor(SAME_ZONE);
    const names = JSON.stringify(payload).match(/Nombre de [A-Z]+/g) ?? [];
    expect(new Set(names)).toEqual(new Set(['Nombre de ALFA']));
  });

  it('gives a player their own team only, and the master every team', () => {
    expect(projectFor(SAME_ZONE).teams.map((t) => t.id)).toEqual(['team-a']);
    expect(projectFor(OTHER_ZONE).teams.map((t) => t.id)).toEqual(['team-b']);
    expect(projectFor(MASTER_OPERATIONAL).teams).toHaveLength(2);
  });

  it('never tells a player which device feeds whom', () => {
    world.players[1]!.deviceId = 'phone-bravo';
    const payload = projectFor(SAME_ZONE);
    expect(JSON.stringify(payload)).not.toContain('phone-bravo');
    expect(find(projectFor(MASTER_OPERATIONAL), 'bravo')?.deviceId).toBe('phone-bravo');
  });

  it('never sends the unpaired device tray to a player', () => {
    expect(projectFor(SAME_ZONE).tray).toBeUndefined();
    expect(projectFor(MASTER_OPERATIONAL).tray).toHaveLength(1);
  });

  it('never sends a view mode to a player', () => {
    expect(projectFor(SAME_ZONE).viewMode).toBeUndefined();
    expect(projectFor(MASTER_AUTHORITATIVE).viewMode).toBe('AUTHORITATIVE');
  });

  it('never sends the ingest secret or session tokens to anyone', () => {
    for (const recipient of [SAME_ZONE, ELIMINATED_SELF, MASTER_AUTHORITATIVE]) {
      const serialised = JSON.stringify(projectFor(recipient));
      expect(serialised).not.toContain('secret');
      expect(serialised).not.toContain('token-');
    }
  });

  it('keeps map furniture for an eliminated player, and only that (R-30.4)', () => {
    const payload = projectFor(ELIMINATED_SELF);
    expect(payload.players).toEqual([]);
    expect(payload.self).toBeDefined();
    expect(payload.zones).toHaveLength(2);
    expect(payload.pois.length).toBeGreaterThan(0);
  });

  it('fails closed for an unknown recipient', () => {
    const payload = project(world, { kind: 'PLAYER', playerId: 'nobody' }, NOW);
    expect(payload.self).toBeUndefined();
    expect(payload.players).toEqual([]);
    expect(payload.pois).toEqual([]);
    expect(payload.markers).toEqual([]);
    expect(payload.replayAvailable).toBe(false);
    // Zone geometry is public in every column of §4, so it stays.
    expect(payload.zones).toHaveLength(2);
  });

  it('treats a player with no zone as seeing nobody positionally', () => {
    const alfa = world.players.find((p) => p.id === 'alfa')!;
    delete alfa.position;
    const payload = projectFor(SAME_ZONE);
    expect(payload.players.every((p) => p.outOfZone)).toBe(true);
    expect(payload.players.every((p) => p.distanceMetres === undefined)).toBe(true);
  });

  it('is a pure function of its inputs', () => {
    const before = JSON.stringify(world);
    projectFor(MASTER_AUTHORITATIVE);
    projectFor(SAME_ZONE);
    expect(JSON.stringify(world)).toBe(before);
  });
});

/**
 * R-61 — a point a master has taken off every map.
 *
 * Kept apart from the audience block above because it is a different kind of
 * rule. R-16 to R-18 are the game's own answer to *who is this point for*, and
 * they are per-recipient. This is a master reaching in during a game and
 * removing a point from **everyone** at once, which is why it is a separate
 * requirement rather than a widening of the audience one — and why the master
 * keeps seeing it.
 */
describe('R-61 — hidden points', () => {
  it('is gone from every player who could otherwise see it', () => {
    world.hiddenPois = [POI_ALL.id];
    for (const recipient of [SAME_ZONE, OTHER_ZONE, ELIMINATED_SELF]) {
      const ids = project(world, recipient, NOW).pois.map((poi) => poi.id);
      expect(ids, `${recipient.playerId} still has it`).not.toContain(POI_ALL.id);
    }
  });

  /**
   * The list in the panel is the only place a hidden point can be found again,
   * so a master who hid one must still be able to see it — in both view modes,
   * because §4 gives the master every point in both and this is not a §4 rule.
   */
  it('stays in the master payload, with the list of what is hidden', () => {
    world.hiddenPois = [POI_ALL.id];
    for (const viewMode of ['OPERATIONAL', 'AUTHORITATIVE'] as const) {
      const payload = project(world, { kind: 'MASTER', viewMode }, NOW);
      expect(payload.pois.map((poi) => poi.id)).toContain(POI_ALL.id);
      expect(payload.hiddenPois).toEqual([POI_ALL.id]);
    }
  });

  /**
   * A player is told what they can see and never what is being kept from them.
   * The list of hidden points is a list of places somebody is not being shown,
   * which is more information than the unfiltered points were.
   */
  it('never tells a player what is being hidden from them', () => {
    world.hiddenPois = [POI_ALL.id];
    for (const recipient of [SAME_ZONE, OTHER_ZONE, ELIMINATED_SELF]) {
      expect(project(world, recipient, NOW).hiddenPois).toBeUndefined();
    }
  });

  /** It does not reach past its own job: audience filtering still decides the rest. */
  it('leaves the audience rules alone', () => {
    world.hiddenPois = [POI_ALL.id];
    const alfa = project(world, SAME_ZONE, NOW).pois.map((poi) => poi.id);
    // ALFA is in team-a, so the team point survives; CHARLIE's does not.
    expect(alfa).toContain(POI_TEAM_A.id);
    expect(alfa).not.toContain(POI_PLAYER_CHARLIE.id);
  });

  it('changes nothing at all when the list is empty or absent', () => {
    const withEmpty = project(world, SAME_ZONE, NOW).pois.map((poi) => poi.id);
    world.hiddenPois = [];
    expect(project(world, SAME_ZONE, NOW).pois.map((poi) => poi.id)).toEqual(withEmpty);
  });
});

/**
 * R-70 — a sector the master has closed.
 *
 * Third of the three point filters and the only one that is not about
 * visibility at all. R-16..R-18 answer *who a point is for* and are per
 * recipient; R-61 is a master taking one point off every map at once; this is
 * ground going **out of play**, which is the same answer for a master and a
 * player. That is why it is the one filter the master does not see through.
 */
describe('R-70 — a closed sector', () => {
  it('takes its zones off every player map', () => {
    world.disabledZones = ['zone-north'];
    for (const recipient of [SAME_ZONE, OTHER_ZONE, ELIMINATED_SELF]) {
      const ids = project(world, recipient, NOW).zones.map((zone) => zone.id);
      expect(ids).toEqual(['zone-south']);
    }
  });

  /**
   * And keeps them for the master, dimmed on their map rather than absent.
   *
   * The same argument as the sector list below, not a second one: **a name is
   * not a place.** §14.3 leaves the map without labels, so fourteen sectors in
   * the panel are fourteen names with no ground attached — and a master
   * directing somebody through a district they have never walked is the normal
   * case with two towns in play. Pointing at a row has to light something, and
   * after a closure there would be nothing left to light.
   */
  it('keeps the geometry on the master map, so a closed sector can still be pointed at', () => {
    world.disabledZones = ['zone-north'];
    for (const viewMode of ['OPERATIONAL', 'AUTHORITATIVE'] as const) {
      const ids = project(world, { kind: 'MASTER', viewMode }, NOW).zones.map((zone) => zone.id);
      expect(ids).toEqual(['zone-north', 'zone-south']);
    }
  });

  /**
   * The master is handed every point, closed and hidden alike, and told which
   * decisions are in force — the `hiddenPois` contract applied to R-71 as well.
   * `MasterView` subtracts both before it draws.
   *
   * It has to be this way round for R-56: a replay reconstructs the open set at
   * the cursor and filters this list against it, so a point closed **now** must
   * still be here or the debrief could never show ground that was open twenty
   * minutes ago. Filtering on the server would make the past unrecoverable from
   * the present, which is the one thing a replay exists to do.
   */
  it('keeps every point in the master payload, for the panel and the replay to filter', () => {
    world.disabledZones = ['zone-north'];
    for (const viewMode of ['OPERATIONAL', 'AUTHORITATIVE'] as const) {
      const ids = project(world, { kind: 'MASTER', viewMode }, NOW).pois.map((poi) => poi.id);
      expect(ids).toContain(POI_ALL.id);
    }
  });

  /**
   * The master's control is the sector list, not the geometry — the R-61 shape,
   * where what makes a thing findable again is the list rather than the map.
   * Without this a master could close a sector and have nothing left to press.
   */
  it('stays in the master sector list, with the set of what is closed', () => {
    world.disabledZones = ['zone-north'];
    for (const viewMode of ['OPERATIONAL', 'AUTHORITATIVE'] as const) {
      const payload = project(world, { kind: 'MASTER', viewMode }, NOW);
      expect(payload.sectors.map((sector) => sector.id)).toEqual(['norte', 'sur']);
      expect(payload.disabledZones).toEqual(['zone-north']);
      expect(payload.districts?.map((district) => district.id)).toEqual(['pueblo']);
    }
  });

  /**
   * And a player is told what is in play, never what has been taken out of it —
   * the same rule as `hiddenPois`, for the same reason: a list of what is being
   * withheld is more information than the unfiltered list was.
   */
  it('leaves a player only the open sectors, and no list of the closed ones', () => {
    world.disabledZones = ['zone-north'];
    const payload = project(world, OTHER_ZONE, NOW);
    expect(payload.sectors.map((sector) => sector.id)).toEqual(['sur']);
    expect(payload.disabledZones).toBeUndefined();
    expect(payload.districts).toBeUndefined();
  });

  it('takes its points off every player map', () => {
    world.disabledZones = ['zone-north'];
    for (const recipient of [SAME_ZONE, OTHER_ZONE, ELIMINATED_SELF]) {
      const ids = project(world, recipient, NOW).pois.map((poi) => poi.id);
      expect(ids).not.toContain(POI_ALL.id);
    }
  });

  /**
   * The order of the three filters, as a rule rather than as tidiness. A point
   * in a closed sector must never enter `hiddenPois`: if it did, opening the
   * sector again would not bring the point back, and R-61's list would fill
   * with ids nobody chose — an absence, which is the hardest kind of fault to
   * notice at a venue.
   */
  it('does not hide a point, so opening the sector brings it back', () => {
    world.disabledZones = ['zone-north'];
    world.hiddenPois = [];
    expect(project(world, MASTER_AUTHORITATIVE, NOW).hiddenPois).toEqual([]);

    world.disabledZones = [];
    expect(project(world, SAME_ZONE, NOW).pois.map((poi) => poi.id)).toContain(POI_ALL.id);
  });

  /**
   * A point outside every zone belongs to no sector and no switch can close it.
   * None exists in any profile today; the alternative — reading "no sector" as
   * closed — would make such a point vanish for a reason nobody could see.
   */
  it('leaves a point that belongs to no zone alone', () => {
    const { zone: _inNoZone, ...unzoned } = POI_ALL;
    world.game.geo.pois = [unzoned];
    world.disabledZones = ['zone-north', 'zone-south'];
    expect(project(world, SAME_ZONE, NOW).pois.map((poi) => poi.id)).toEqual([POI_ALL.id]);
  });
});

/**
 * R-70 again, and the half that is a §4 rule after all: what happens to the
 * player who is standing in the sector when it closes.
 *
 * The ingest area does not move with the switch, so R-04 goes on accepting
 * their pings — they keep emitting and the master keeps seeing them. What they
 * lose is their zone, and §4 does the rest with no new rule.
 */
describe('R-70 — a player caught in a closing sector', () => {
  beforeEach(() => {
    // alfa, bravo, golf and delta are all in zone-north.
    world.disabledZones = ['zone-north'];
  });

  it('disappears from every other player, and sees none of them', () => {
    const seenByCharlie = project(world, OTHER_ZONE, NOW).players.find(
      (player) => player.id === 'alfa',
    );
    expect(seenByCharlie?.outOfZone).toBe(true);
    expect(seenByCharlie?.position).toBeUndefined();

    // And the other way: alfa was in a zone with bravo and golf a moment ago.
    for (const other of project(world, SAME_ZONE, NOW).players) {
      expect(other.outOfZone, `${other.id} is still visible`).toBe(true);
    }
  });

  /**
   * The master is unaffected, in both view modes. A closure is a decision they
   * are taking; a panel that blinded them to the players it caught would be the
   * opposite of what the control is for — the same reasoning as R-35 keeping
   * masters out of the cut switch.
   */
  it('keeps their dot on the master panel, with the zone they are actually in', () => {
    for (const viewMode of ['OPERATIONAL', 'AUTHORITATIVE'] as const) {
      const alfa = project(world, { kind: 'MASTER', viewMode }, NOW).players.find(
        (player) => player.id === 'alfa',
      );
      expect(alfa?.position).toBeDefined();
      expect(alfa?.position?.zoneId).toBe('zone-north');
    }
  });

  /** Their own position is still their own (R-30.4's shape, not its rule). */
  it('keeps their own dot, without a zone', () => {
    const self = project(world, SAME_ZONE, NOW).self;
    expect(self?.position).toBeDefined();
    expect(self?.position?.zoneId).toBeUndefined();
  });

  /**
   * R-21d still reaches across, which is the ladder working rather than a leak:
   * the setting is about the team's reach and says nothing about which ground
   * is in play.
   */
  it('still reaches its own team while extended comms is on', () => {
    world.game.commsReach = 5;
    const bravo = project(world, SAME_ZONE, NOW).players.find((player) => player.id === 'bravo');
    expect(bravo?.outOfZone).toBeUndefined();
    expect(bravo?.position).toBeDefined();
  });
});
