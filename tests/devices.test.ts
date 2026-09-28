import { describe, expect, it } from 'vitest';

import {
  applyPing,
  applyStatus,
  applyStatusToTrayEntry,
  derivePositionState,
  feedStopped,
  upsertTrayEntry,
  zoneAt,
} from '@q4413/core';
import type { Game, OsmAndPing, OsmAndStatus, Player } from '@q4413/shared';

const ping = (over: Partial<OsmAndPing> = {}): OsmAndPing => ({
  deviceId: 'dev-1',
  lat: 40.42,
  lon: -3.7,
  receivedAt: 1_756_000_000_000,
  ts: 1_756_000_000_000,
  attributes: {},
  ...over,
});

const status = (over: Partial<OsmAndStatus> = {}): OsmAndStatus => ({
  deviceId: 'dev-1',
  receivedAt: 1_756_000_000_000,
  attributes: {},
  ...over,
});

const player = (): Player => ({
  id: 'p1',
  callsign: 'ALFA',
  fullName: 'Nombre Real',
  teamId: 't1',
  sessionToken: 'tok',
});

const GAME_CONFIG: Game['config'] = {
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

/** applyPing's options when the test does not care about zones. */
const LINK = { linkThresholdMs: GAME_CONFIG.linkThresholdMs };

describe('upsertTrayEntry — unpaired device tray (R-06)', () => {
  it('creates an entry for an unknown device instead of discarding the ping', () => {
    const entry = upsertTrayEntry(undefined, ping());
    expect(entry).toEqual({
      deviceId: 'dev-1',
      firstSeen: 1_756_000_000_000,
      lastSeen: 1_756_000_000_000,
      lat: 40.42,
      lon: -3.7,
      pings: 1,
    });
  });

  it('updates last seen, coordinates and ping count, keeping first seen', () => {
    const first = upsertTrayEntry(undefined, ping());
    const second = upsertTrayEntry(
      first,
      ping({ receivedAt: 1_756_000_060_000, lat: 40.421, lon: -3.701 }),
    );

    expect(second).toMatchObject({
      firstSeen: 1_756_000_000_000,
      lastSeen: 1_756_000_060_000,
      lat: 40.421,
      lon: -3.701,
      pings: 2,
    });
  });

  it('does not mutate the previous entry', () => {
    const first = upsertTrayEntry(undefined, ping());
    upsertTrayEntry(first, ping({ receivedAt: 1_756_000_060_000 }));
    expect(first.pings).toBe(1);
  });
});

describe('applyPing', () => {
  it('records position, accuracy and battery on the player', () => {
    const updated = applyPing(player(), ping({ accuracy: 8, battery: 91, bearing: 12, speed: 1.1 }), LINK);
    expect(updated.position).toEqual({
      lat: 40.42,
      lon: -3.7,
      accuracy: 8,
      bearing: 12,
      speed: 1.1,
      ts: 1_756_000_000_000,
      state: 'MOVING',
    });
    expect(updated.battery).toBe(91);
  });

  it('defaults accuracy to 0 when the device sent none, rather than undefined', () => {
    const updated = applyPing(player(), ping(), LINK);
    expect(updated.position?.accuracy).toBe(0);
  });

  /**
   * The whole snapshot, not just the coordinates. M5 made knownPosition carry its
   * own accuracy and zone so that OPERATIONAL cannot fill them in from the live
   * position — see the elimination cases in tests/projection.test.ts for what that
   * would give away.
   */
  it('tracks knownPosition while the feed is active (R-22)', () => {
    const updated = applyPing(player(), ping(), LINK);
    expect(updated.knownPosition).toEqual({
      lat: 40.42,
      lon: -3.7,
      ts: 1_756_000_000_000,
      accuracy: 0,
    });
  });

  it('freezes the game-known snapshot once the player is eliminated (R-22)', () => {
    const live = applyPing(player(), ping({ battery: 80 }), LINK);
    const eliminated = {
      ...live,
      eliminated: { ts: 1_756_000_030_000, dropPoint: { lat: 40.42, lon: -3.7 }, selfDeclared: true },
    };
    // Their phone is still on and still reporting, which is the only way a ping
    // arrives for a feed R-22 calls stopped.
    const afterwards = applyPing(
      eliminated,
      ping({ lat: 40.5, lon: -3.6, receivedAt: 1_756_000_060_000, battery: 79 }),
      LINK,
    );
    expect(afterwards.knownPosition).toEqual(live.knownPosition);
    expect(afterwards.knownBattery).toBe(80);
    // What the system knows still advances: AUTHORITATIVE is entitled to it.
    expect(afterwards.position?.lat).toBe(40.5);
    expect(afterwards.battery).toBe(79);
  });

  it('leaves battery untouched when the ping carries none', () => {
    const withBattery = applyPing(player(), ping({ battery: 50 }), LINK);
    const withoutBattery = applyPing(withBattery, ping({ receivedAt: 1_756_000_060_000 }), LINK);
    expect(withoutBattery.battery).toBe(50);
  });

  it('does not mutate the player it was given', () => {
    const original = player();
    applyPing(original, ping(), LINK);
    expect(original.position).toBeUndefined();
  });
});

describe('applyPing — the stored clock is the server\'s (R-36)', () => {
  it('stores the receive time, not the fix time the device claimed', () => {
    const updated = applyPing(
      player(),
      ping({ receivedAt: 1_756_000_000_000, ts: 1_756_000_000_000 - 600_000 }),
      LINK,
    );
    expect(updated.position?.ts).toBe(1_756_000_000_000);
    expect(updated.knownPosition?.ts).toBe(1_756_000_000_000);
  });

  it('ignores a device clock running ahead of the server', () => {
    const updated = applyPing(
      player(),
      ping({ receivedAt: 1_756_000_000_000, ts: 1_756_000_000_000 + 86_400_000 }),
      LINK,
    );
    // A phone a day into the future would otherwise stay MOVING for a day.
    expect(updated.position?.ts).toBe(1_756_000_000_000);
  });

  /**
   * The airplane-mode case from M3's exit criterion. Traccar Client buffers
   * while offline and flushes on reconnect with the original fix times, so the
   * newest write of the burst carries the *oldest* usable device timestamp.
   */
  it('a buffered flush never moves the timestamp backwards', () => {
    const start = 1_756_000_000_000;
    let subject = applyPing(player(), ping({ receivedAt: start, ts: start }), LINK);

    // Five minutes of airplane mode, flushed in one burst 20 ms apart.
    const buffered = [0, 1, 2, 3, 4].map((i) =>
      ping({
        receivedAt: start + 300_000 + i * 20,
        ts: start + i * 60_000, // fix times from during the blackout
        lat: 40.42 + i * 0.001,
      }),
    );

    let previous = subject.position!.ts;
    for (const flushed of buffered) {
      subject = applyPing(subject, flushed, LINK);
      expect(subject.position!.ts).toBeGreaterThan(previous);
      previous = subject.position!.ts;
    }

    expect(subject.position?.ts).toBe(start + 300_080);
  });

  it('a player who just flushed a backlog does not read as a stopped feed', () => {
    const now = 1_756_000_300_000;
    const subject = applyPing(
      player(),
      // Arrived now; the device says the fix is five minutes old.
      ping({ receivedAt: now, ts: now - 300_000 }),
      LINK,
    );
    // Under the fix-time reading this was `true`, and the growing uncertainty
    // circle appeared around a phone transmitting normally (R-12).
    expect(feedStopped(subject, GAME_CONFIG, now)).toBe(false);
  });
});

describe('applyPing — the state written on arrival (R-10)', () => {
  it('records STATIONARY with a run start when the ping carries evidence', () => {
    const updated = applyPing(player(), ping({ event: 'heartbeat' }), LINK);
    expect(updated.position?.state).toBe('STATIONARY');
    expect(updated.position?.stationarySince).toBe(1_756_000_000_000);
  });

  it('records MOVING with no run start when it does not', () => {
    const updated = applyPing(player(), ping({ isMoving: true }), LINK);
    expect(updated.position?.state).toBe('MOVING');
    expect(updated.position).not.toHaveProperty('stationarySince');
  });

  it('drops the run start the moment the device moves again', () => {
    const parked = applyPing(player(), ping({ event: 'heartbeat' }), LINK);
    const walking = applyPing(
      parked,
      ping({ receivedAt: 1_756_000_030_000, isMoving: true }),
      LINK,
    );
    expect(walking.position?.state).toBe('MOVING');
    expect(walking.position).not.toHaveProperty('stationarySince');
  });

  it('never writes NO_LINK, which is derived from age and never stored', () => {
    for (const evidence of [{}, { event: 'heartbeat' }, { isMoving: false }] as const) {
      expect(applyPing(player(), ping(evidence), LINK).position?.state).not.toBe('NO_LINK');
    }
  });

  /**
   * The GrapheneOS phone, end to end: a motionchange into stillness followed by
   * heartbeats, and `activity` never sent. The run has to hold on two sources.
   */
  it('holds a stationary run without activity ever arriving', () => {
    let subject = applyPing(
      player(),
      ping({ event: 'motionchange', isMoving: false }),
      LINK,
    );
    const began = subject.position!.stationarySince;

    for (let i = 1; i <= 10; i += 1) {
      subject = applyPing(
        subject,
        ping({ receivedAt: 1_756_000_000_000 + i * 60_000, event: 'heartbeat' }),
        LINK,
      );
      expect(subject.position?.state).toBe('STATIONARY');
    }

    expect(subject.position?.stationarySince).toBe(began);
    expect(subject.position?.stationarySince).toBe(1_756_000_000_000);
  });
});

describe('zoneAt — zone assignment on ping arrival', () => {
  const zones = [
    {
      id: 'zone-north',
      name: 'Norte',
      sector: 'norte',
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [-4.48, 36.66],
            [-4.47, 36.66],
            [-4.47, 36.67],
            [-4.48, 36.67],
            [-4.48, 36.66],
          ],
        ],
      },
    },
    {
      id: 'zone-south',
      name: 'Sur',
      sector: 'sur',
      geometry: {
        type: 'Polygon' as const,
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
  ];

  it('names the zone a point falls in', () => {
    expect(zoneAt(-4.475, 36.665, zones)).toBe('zone-north');
    expect(zoneAt(-4.475, 36.655, zones)).toBe('zone-south');
  });

  it('returns nothing outside every zone, rather than guessing the nearest', () => {
    expect(zoneAt(-4.4, 36.6, zones)).toBeUndefined();
  });

  it('returns nothing when no zones are configured', () => {
    expect(zoneAt(-4.475, 36.665, [])).toBeUndefined();
  });

  it('assigns the zone when a ping is applied', () => {
    const updated = applyPing(player(), ping({ lat: 36.665, lon: -4.475 }), { ...LINK, zones });
    expect(updated.position?.zoneId).toBe('zone-north');
  });

  it('leaves zoneId absent for a ping outside every zone', () => {
    const updated = applyPing(player(), ping({ lat: 36.6, lon: -4.4 }), { ...LINK, zones });
    expect(updated.position?.zoneId).toBeUndefined();
  });
});

describe('upsertTrayEntry — battery and accuracy', () => {
  it('records battery and accuracy from the first ping', () => {
    const entry = upsertTrayEntry(undefined, ping({ battery: 42, accuracy: 5 }));
    expect(entry.battery).toBe(42);
    expect(entry.accuracy).toBe(5);
  });

  it('updates them as pings arrive', () => {
    const first = upsertTrayEntry(undefined, ping({ battery: 42 }));
    const second = upsertTrayEntry(first, ping({ battery: 41, receivedAt: 1_756_000_060_000 }));
    expect(second.battery).toBe(41);
  });

  it('keeps the last reading when a ping omits battery', () => {
    // Traccar Client does not send batt on every ping on every platform.
    const first = upsertTrayEntry(undefined, ping({ battery: 42 }));
    const second = upsertTrayEntry(first, ping({ receivedAt: 1_756_000_060_000 }));
    expect(second.battery).toBe(42);
  });

  it('leaves them absent when no ping ever carried them', () => {
    const entry = upsertTrayEntry(undefined, ping());
    expect(entry.battery).toBeUndefined();
    expect(entry.accuracy).toBeUndefined();
  });
});

describe('a status report may update a device and may never update a position', () => {
  const LATER = 1_756_000_600_000; // ten minutes after the ping fixtures

  it('records the battery on a paired player', () => {
    const updated = applyStatus(player(), status({ battery: 91 }));
    expect(updated.battery).toBe(91);
  });

  it('leaves the position exactly as it was, timestamp included', () => {
    const before = applyPing(player(), ping(), LINK);
    const after = applyStatus(before, status({ receivedAt: LATER, battery: 42 }));

    expect(after.position).toEqual(before.position);
    expect(after.knownPosition).toEqual(before.knownPosition);
  });

  /**
   * The reason the rule above is a rule. A phone with no fix sends status reports
   * and nothing else; if they refreshed the position's timestamp, R-11 would call
   * a player live over coordinates from ten minutes ago and R-12 would draw the
   * confident circle it reserves for a position somebody may act on.
   */
  it('does not resurrect a feed that has stopped', () => {
    const stale = applyPing(player(), ping(), LINK);
    const after = applyStatus(stale, status({ receivedAt: LATER, battery: 42 }));

    expect(derivePositionState(after.position, GAME_CONFIG.linkThresholdMs, LATER)).toBe('NO_LINK');
    expect(feedStopped(after, GAME_CONFIG, LATER)).toBe(true);
  });

  /**
   * The captured status shape carries an FCM registration token in `attributes`
   * and nothing else. A push credential must not reach storage, and the property
   * that keeps it out is that both apply functions read the battery and never the
   * map — so with no battery they return their input untouched, and the Worker
   * writes nothing at all.
   */
  it('cannot carry a credential into a player, because it reads only the battery', () => {
    const before = player();
    const withToken = status({
      attributes: { notificationToken: 'NOT-A-REAL-TOKEN:APA91bEXAMPLE' },
    });

    expect(applyStatus(before, withToken)).toBe(before);
    expect(JSON.stringify(applyStatus(before, withToken))).not.toContain('APA91b');
  });

  it('cannot carry a credential into a tray entry either', () => {
    const entry = upsertTrayEntry(undefined, ping());
    const withToken = status({
      attributes: { notificationToken: 'NOT-A-REAL-TOKEN:APA91bEXAMPLE' },
      battery: 64,
    });
    const after = applyStatusToTrayEntry(entry, withToken);

    expect(after.battery).toBe(64);
    expect(JSON.stringify(after)).not.toContain('APA91b');
  });

  it('returns the same object when there is no battery, so a caller can skip the write', () => {
    const before = player();
    expect(applyStatus(before, status())).toBe(before);
  });

  it('records the battery on a tray entry', () => {
    const entry = upsertTrayEntry(undefined, ping());
    expect(applyStatusToTrayEntry(entry, status({ battery: 77 })).battery).toBe(77);
  });

  it('leaves lastSeen, the coordinates and the ping count untouched in the tray', () => {
    const entry = upsertTrayEntry(undefined, ping());
    const after = applyStatusToTrayEntry(entry, status({ receivedAt: LATER, battery: 77 }));

    // lastSeen is the position's timestamp under another name: dotsOf() derives
    // the stray dot's link state from it and pairing copies it into
    // knownPosition.ts, so moving it here would make a stale dot render live.
    expect(after.lastSeen).toBe(entry.lastSeen);
    expect(after.lat).toBe(entry.lat);
    expect(after.lon).toBe(entry.lon);
    expect(after.pings).toBe(entry.pings);
  });

  it('returns the same tray entry when there is no battery', () => {
    const entry = upsertTrayEntry(undefined, ping());
    expect(applyStatusToTrayEntry(entry, status())).toBe(entry);
  });

  it('does not mutate what it is given', () => {
    const before = applyPing(player(), ping(), LINK);
    const snapshot = structuredClone(before);
    applyStatus(before, status({ battery: 5 }));
    expect(before).toEqual(snapshot);
  });
});
