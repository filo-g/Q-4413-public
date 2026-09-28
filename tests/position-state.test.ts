import { describe, expect, it } from 'vitest';

import {
  accountabilityOf,
  derivePositionState,
  feedStopped,
  radioContactFresh,
  stateFromPing,
  stationaryEvidence,
  stationarySinceFor,
  uncertaintyRadiusMetres,
} from '@q4413/core';
import type { Game, OsmAndPing, Player } from '@q4413/shared';

const LINK_THRESHOLD_MS = 90_000;
const T0 = 1_756_000_000_000;

/** Only the fields R-10 reads; the rest of a ping is irrelevant to these rules. */
type Evidence = Pick<OsmAndPing, 'isMoving' | 'activity' | 'event'>;

const stored = (
  over: Partial<NonNullable<Player['position']>> = {},
): NonNullable<Player['position']> => ({
  lat: 40.42,
  lon: -3.7,
  accuracy: 5,
  ts: T0,
  state: 'MOVING',
  ...over,
});

describe('stationaryEvidence — R-10 lists three sources and only three', () => {
  it('accepts a motionchange carrying is_moving: false', () => {
    expect(stationaryEvidence({ event: 'motionchange', isMoving: false })).toBe(true);
  });

  it('accepts a heartbeat', () => {
    expect(stationaryEvidence({ event: 'heartbeat' })).toBe(true);
  });

  it('accepts activity: still', () => {
    expect(stationaryEvidence({ activity: 'still' })).toBe(true);
  });

  it('rejects a motionchange that does not say is_moving: false', () => {
    // R-10 pairs the event with the flag; the event alone is just a transition,
    // and the transition it announces might be into motion.
    expect(stationaryEvidence({ event: 'motionchange' })).toBe(false);
  });

  it('rejects a moving activity', () => {
    expect(stationaryEvidence({ activity: 'walking' })).toBe(false);
    expect(stationaryEvidence({ activity: 'in_vehicle' })).toBe(false);
  });

  it('rejects an event R-10 does not list', () => {
    expect(stationaryEvidence({ event: 'geofence', isMoving: false })).toBe(false);
  });

  it('rejects a ping carrying no evidence at all', () => {
    expect(stationaryEvidence({})).toBe(false);
  });

  describe('is_moving: true vetoes every source', () => {
    const cases: ReadonlyArray<readonly [string, Evidence]> = [
      ['a heartbeat', { event: 'heartbeat', isMoving: true }],
      ['activity: still', { activity: 'still', isMoving: true }],
      ['a motionchange', { event: 'motionchange', isMoving: true }],
      ['all three at once', { event: 'heartbeat', activity: 'still', isMoving: true }],
    ];

    for (const [label, ping] of cases) {
      it(`overrides ${label}`, () => {
        expect(stationaryEvidence(ping)).toBe(false);
      });
    }
  });

  /**
   * The gap R-10 leaves: MOVING is "is_moving: true **or absent**", so a plain
   * location update carrying `false` matches neither state's description. It is
   * resolved toward MOVING, because reading it as stationary would render a
   * walking player as parked on any build that sends `false` by default.
   */
  it('does not treat a bare is_moving: false as evidence', () => {
    expect(stationaryEvidence({ isMoving: false })).toBe(false);
  });
});

describe('stationaryEvidence — a phone with no Play services', () => {
  /**
   * One player's phone runs GrapheneOS and logs
   * `ActivityRecognition.API is not available on this device`, so `activity`
   * never arrives from it. Two of R-10's three sources have to be enough.
   */
  it('reads a stationary phone from motionchange and heartbeat alone', () => {
    expect(stationaryEvidence({ event: 'motionchange', isMoving: false })).toBe(true);
    expect(stationaryEvidence({ event: 'heartbeat' })).toBe(true);
  });

  it('still reads a moving phone as moving without activity', () => {
    expect(stationaryEvidence({ isMoving: true })).toBe(false);
    expect(stationaryEvidence({})).toBe(false);
  });
});

describe('stateFromPing — a ping that just arrived is never NO_LINK', () => {
  it('maps evidence to STATIONARY and its absence to MOVING', () => {
    expect(stateFromPing({ event: 'heartbeat' })).toBe('STATIONARY');
    expect(stateFromPing({ isMoving: true })).toBe('MOVING');
    expect(stateFromPing({})).toBe('MOVING');
  });
});

describe('stationarySinceFor — when the current stationary run began', () => {
  const heartbeat = (receivedAt: number): Evidence & Pick<OsmAndPing, 'receivedAt'> => ({
    event: 'heartbeat',
    receivedAt,
  });

  it('is undefined while the device is moving', () => {
    expect(
      stationarySinceFor(stored(), { isMoving: true, receivedAt: T0 }, LINK_THRESHOLD_MS),
    ).toBeUndefined();
  });

  it('starts at the ping that first shows evidence', () => {
    expect(stationarySinceFor(stored(), heartbeat(T0 + 5_000), LINK_THRESHOLD_MS)).toBe(T0 + 5_000);
  });

  it('starts now for a player who has never reported a position', () => {
    expect(stationarySinceFor(undefined, heartbeat(T0), LINK_THRESHOLD_MS)).toBe(T0);
  });

  it('keeps the original start across a continuous run', () => {
    let previous = stored();
    let since = 0;
    // Fifteen minutes of heartbeats a minute apart: inside the threshold, so the
    // run never restarts and the answer stays the moment it began.
    for (let i = 1; i <= 15; i += 1) {
      const receivedAt = T0 + i * 60_000;
      const next = stationarySinceFor(previous, heartbeat(receivedAt), LINK_THRESHOLD_MS);
      expect(next).toBeDefined();
      since = next!;
      previous = stored({ ts: receivedAt, state: 'STATIONARY', stationarySince: since });
    }
    expect(since).toBe(T0 + 60_000);
  });

  it('continues when the gap is exactly the threshold', () => {
    const previous = stored({ state: 'STATIONARY', stationarySince: T0 - 30_000 });
    expect(
      stationarySinceFor(previous, heartbeat(T0 + LINK_THRESHOLD_MS), LINK_THRESHOLD_MS),
    ).toBe(T0 - 30_000);
  });

  /**
   * The pocket-for-two-hours case. The device was NO_LINK across the gap and
   * R-10 calls that position unreliable, so the run cannot claim the gap.
   */
  it('restarts after a gap longer than the threshold', () => {
    const previous = stored({ state: 'STATIONARY', stationarySince: T0 - 30_000 });
    const back = T0 + 7_200_000;
    expect(stationarySinceFor(previous, heartbeat(back), LINK_THRESHOLD_MS)).toBe(back);
  });

  it('restarts when the device was previously moving', () => {
    const previous = stored({ state: 'MOVING', ts: T0 });
    expect(stationarySinceFor(previous, heartbeat(T0 + 5_000), LINK_THRESHOLD_MS)).toBe(T0 + 5_000);
  });

  it('restarts when a stored STATIONARY record carries no start', () => {
    const previous = stored({ state: 'STATIONARY' });
    expect(stationarySinceFor(previous, heartbeat(T0 + 5_000), LINK_THRESHOLD_MS)).toBe(T0 + 5_000);
  });
});

describe('derivePositionState — silence outranks the last claim (R-11)', () => {
  const at = (age: number, state: 'MOVING' | 'STATIONARY') => ({ ts: T0 - age, state } as const);

  it('is NO_LINK for a player who has never reported a position', () => {
    expect(derivePositionState(undefined, LINK_THRESHOLD_MS, T0)).toBe('NO_LINK');
  });

  it('keeps the stored claim while the ping is fresh', () => {
    expect(derivePositionState(at(5_000, 'MOVING'), LINK_THRESHOLD_MS, T0)).toBe('MOVING');
    expect(derivePositionState(at(5_000, 'STATIONARY'), LINK_THRESHOLD_MS, T0)).toBe('STATIONARY');
  });

  it('keeps it at exactly the threshold, and drops it one millisecond later', () => {
    expect(derivePositionState(at(LINK_THRESHOLD_MS, 'MOVING'), LINK_THRESHOLD_MS, T0)).toBe(
      'MOVING',
    );
    expect(derivePositionState(at(LINK_THRESHOLD_MS + 1, 'MOVING'), LINK_THRESHOLD_MS, T0)).toBe(
      'NO_LINK',
    );
  });

  /**
   * The decision this milestone had to make. A device that declared itself
   * stationary buys no exemption from the threshold: otherwise a flat battery in a
   * pocket renders STATIONARY forever, with the confident circle R-12 reserves for
   * a valid position, and R-22 loses the single branch a stopped feed shares with
   * an eliminated player.
   */
  it('sends a stationary device to NO_LINK once it stops sending', () => {
    expect(derivePositionState(at(600_000, 'STATIONARY'), LINK_THRESHOLD_MS, T0)).toBe('NO_LINK');
  });

  it('does not age a position out while heartbeats keep arriving', () => {
    // A phone parked for an hour, heartbeating every 60 s: each ping resets the
    // age, so the derived state never leaves STATIONARY.
    for (let minute = 0; minute < 60; minute += 1) {
      const lastPing = T0 + minute * 60_000;
      const askedAt = lastPing + 59_000;
      expect(
        derivePositionState({ ts: lastPing, state: 'STATIONARY' }, LINK_THRESHOLD_MS, askedAt),
      ).toBe('STATIONARY');
    }
  });
});

describe('uncertaintyRadiusMetres — the circle grows only in NO_LINK (R-12)', () => {
  const config = { linkThresholdMs: LINK_THRESHOLD_MS, walkingSpeed: 1.4 };
  const at = (age: number, state: 'MOVING' | 'STATIONARY', accuracy = 10) =>
    ({ accuracy, ts: T0 - age, state }) as const;

  it('is zero with no position to draw around', () => {
    expect(uncertaintyRadiusMetres(undefined, config, T0)).toBe(0);
  });

  it("is the fix's own accuracy while the feed is live", () => {
    expect(uncertaintyRadiusMetres(at(5_000, 'MOVING'), config, T0)).toBe(10);
  });

  it('does not grow for a device that declared itself stationary', () => {
    // R-12 is explicit: the position is still true, so the circle does not grow.
    expect(uncertaintyRadiusMetres(at(LINK_THRESHOLD_MS, 'STATIONARY'), config, T0)).toBe(10);
  });

  it('appears at a step rather than fading in from the accuracy', () => {
    // Growth is measured from the last ping, so crossing 90 s of silence puts the
    // circle straight at ~126 m: the player could have been walking all along.
    const justOver = uncertaintyRadiusMetres(at(LINK_THRESHOLD_MS + 1, 'MOVING'), config, T0);
    expect(justOver).toBeCloseTo(10 + 1.4 * 90.001, 2);
    expect(justOver).toBeGreaterThan(130);
  });

  it('grows linearly with the silence', () => {
    const twoMinutes = uncertaintyRadiusMetres(at(120_000, 'MOVING'), config, T0);
    const fourMinutes = uncertaintyRadiusMetres(at(240_000, 'MOVING'), config, T0);
    expect(twoMinutes).toBeCloseTo(10 + 1.4 * 120, 6);
    expect(fourMinutes - 10).toBeCloseTo((twoMinutes - 10) * 2, 6);
  });

  it('grows for a stationary device too, once the silence outlasts the threshold', () => {
    // The flat-battery-in-a-pocket case: the claim expired, so the circle opens up.
    expect(uncertaintyRadiusMetres(at(600_000, 'STATIONARY'), config, T0)).toBeCloseTo(
      10 + 1.4 * 600,
      6,
    );
  });

  it('is uncapped, so four hours of silence exceeds the play area', () => {
    expect(uncertaintyRadiusMetres(at(4 * 3_600_000, 'MOVING'), config, T0)).toBeGreaterThan(
      20_000,
    );
  });

  it('ignores detourFactor, which would put the bound beyond reach', () => {
    // R-45 inflates a route by 1.35 for streets; this is a straight-line bound.
    const tenMinutes = uncertaintyRadiusMetres(at(600_000, 'MOVING'), config, T0);
    expect(tenMinutes).toBeLessThan(10 + 1.4 * 600 * 1.35);
  });
});

describe('feedStopped — one threshold, shared with R-11', () => {
  const config: Game['config'] = {
    linkThresholdMs: LINK_THRESHOLD_MS,
    radioContactValidityMs: 300_000,
    authoritativeIdleRevertMs: 600_000,
    markerDefaultTtlMs: 300_000,
    detourFactor: 1.35,
    walkingSpeed: 1.4,
    bearingFreezeSpeed: 0.5,
    bearingSmoothing: 0.12,
    poiProximityRadius: 50,
  };
  const subject = (over: Partial<Player> = {}): Player => ({
    id: 'p1',
    callsign: 'ALFA',
    fullName: 'Nombre Real',
    teamId: 't1',
    sessionToken: 'tok',
    ...over,
  });

  it('is true for a player who has never reported a position', () => {
    expect(feedStopped(subject(), config, T0)).toBe(true);
  });

  it('is false while the feed is live', () => {
    expect(feedStopped(subject({ position: stored({ ts: T0 - 5_000 }) }), config, T0)).toBe(false);
  });

  it('is true once the feed goes quiet past the threshold', () => {
    expect(feedStopped(subject({ position: stored({ ts: T0 - 600_000 }) }), config, T0)).toBe(true);
  });

  /** The mechanism of OPERATIONAL: same branch as a flat battery, by design (R-22). */
  it('is true for an eliminated player whose phone is still transmitting', () => {
    const eliminated = subject({
      position: stored({ ts: T0 }),
      eliminated: { ts: T0 - 60_000, dropPoint: { lat: 40.42, lon: -3.7 }, selfDeclared: true },
    });
    expect(feedStopped(eliminated, config, T0)).toBe(true);
  });

  it('agrees with derivePositionState on where the line falls', () => {
    for (const age of [0, 89_999, LINK_THRESHOLD_MS, LINK_THRESHOLD_MS + 1, 600_000]) {
      const position = stored({ ts: T0 - age });
      expect(feedStopped(subject({ position }), config, T0)).toBe(
        derivePositionState(position, LINK_THRESHOLD_MS, T0) === 'NO_LINK',
      );
    }
  });
});

describe('radioContactFresh — five minutes, and then nothing (R-13)', () => {
  const config = { radioContactValidityMs: 300_000 };

  it('is false when nobody has reported contact', () => {
    expect(radioContactFresh(undefined, config, T0)).toBe(false);
  });

  it('is true inside the window and at its edge', () => {
    expect(radioContactFresh({ ts: T0 - 1_000 }, config, T0)).toBe(true);
    expect(radioContactFresh({ ts: T0 - 300_000 }, config, T0)).toBe(true);
  });

  it('is false one millisecond past it', () => {
    expect(radioContactFresh({ ts: T0 - 300_001 }, config, T0)).toBe(false);
  });
});

describe('accountabilityOf — a label, never an alarm (R-13)', () => {
  const config = { linkThresholdMs: LINK_THRESHOLD_MS, radioContactValidityMs: 300_000 };
  const live = { ts: T0 - 5_000, state: 'MOVING' as const };
  const dark = { ts: T0 - 600_000, state: 'MOVING' as const };

  it('says nothing at all while the feed is alive', () => {
    // "While pings are flowing it is neither displayed nor tracked."
    expect(accountabilityOf(live, undefined, config, T0)).toBeUndefined();
    expect(accountabilityOf(live, { ts: T0 - 1_000 }, config, T0)).toBeUndefined();
  });

  it('says nothing while a stationary phone keeps heartbeating', () => {
    const parked = { ts: T0 - 30_000, state: 'STATIONARY' as const };
    expect(accountabilityOf(parked, undefined, config, T0)).toBeUndefined();
  });

  it('is UNACCOUNTED for a dark player nobody has spoken to', () => {
    expect(accountabilityOf(dark, undefined, config, T0)).toBe('UNACCOUNTED');
  });

  it('is ACCOUNTED for a dark player with fresh contact', () => {
    expect(accountabilityOf(dark, { ts: T0 - 60_000 }, config, T0)).toBe('ACCOUNTED');
  });

  it('falls back to UNACCOUNTED when the contact itself goes stale', () => {
    expect(accountabilityOf(dark, { ts: T0 - 400_000 }, config, T0)).toBe('UNACCOUNTED');
  });

  it('is UNACCOUNTED for a player who has never reported a position', () => {
    expect(accountabilityOf(undefined, undefined, config, T0)).toBe('UNACCOUNTED');
  });

  /**
   * The ordinary sequence: you speak to someone, and only afterwards notice they
   * have gone quiet. A record made while they were still live has to count.
   */
  it('counts contact recorded before the player went dark', () => {
    const spokeAt = T0 - 120_000;
    const lastPing = T0 - 100_000;
    expect(
      accountabilityOf({ ts: lastPing, state: 'MOVING' }, { ts: spokeAt }, config, T0),
    ).toBe('ACCOUNTED');
  });

  /**
   * One player, one ping, one walkie call, and nothing else ever sent. Both
   * crossings happen on arithmetic alone — which is the point of R-15.
   */
  it('crosses twice with no new message: silent, then unaccounted', () => {
    const at = (offset: number) =>
      accountabilityOf({ ts: T0, state: 'MOVING' }, { ts: T0 }, config, T0 + offset);

    // Feed still live: R-13 says nothing at all yet.
    expect(at(60_000)).toBeUndefined();
    // Past 90 s of silence, and the walkie call is still worth something.
    expect(at(120_000)).toBe('ACCOUNTED');
    expect(at(299_000)).toBe('ACCOUNTED');
    // Five minutes after the call, it stops counting.
    expect(at(301_000)).toBe('UNACCOUNTED');
  });
});
