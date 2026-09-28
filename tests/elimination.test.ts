import { describe, expect, it } from 'vitest';

import {
  applyPing,
  declareEliminated,
  eliminationOpen,
  reviveEliminated,
  ELIMINATION_STATES,
} from '@q4413/core';
import type { GameState, OsmAndPing, Player } from '@q4413/shared';

/**
 * Self-declaration and its reversal (R-30, R-32).
 *
 * The visibility half of R-30 is not here: §4 has withheld elimination state and
 * drop points since M2, and tests/projection.test.ts owns every row of it. What
 * these check is the writing — and specifically the three cases where "set a
 * field" is not the whole answer: a second press, a player with no fix, and what
 * happens to the frozen snapshot on the way back.
 */
const NOW = 1_760_000_000_000;

const player = (over: Partial<Player> = {}): Player => ({
  id: 'romeo',
  callsign: 'ROMEO',
  fullName: 'Nombre de ROMEO',
  teamId: 'team-zulu',
  sessionToken: 'token',
  position: {
    lat: 36.657,
    lon: -4.478,
    accuracy: 8,
    ts: NOW - 5_000,
    state: 'MOVING',
    zoneId: 'zone-parque',
  },
  knownPosition: { lat: 36.657, lon: -4.478, ts: NOW - 5_000, accuracy: 8, zoneId: 'zone-parque' },
  battery: 62,
  knownBattery: 62,
  ...over,
});

describe('declareEliminated() — R-30', () => {
  it('records the time and the exact coordinates (R-30.5)', () => {
    const out = declareEliminated(player(), NOW);
    expect(out.eliminated).toEqual({
      ts: NOW,
      selfDeclared: true,
      dropPoint: { lat: 36.657, lon: -4.478 },
    });
  });

  /**
   * From `position`, not `knownPosition`. They agree here, which is exactly why
   * the test forces them apart: reading the frozen one would pass on a realistic
   * fixture and be wrong the moment anything froze it first.
   */
  it('takes the drop point from what the system knows, not what the game knows', () => {
    const drifted = player({
      position: {
        lat: 36.6601,
        lon: -4.4751,
        accuracy: 6,
        ts: NOW - 1_000,
        state: 'MOVING',
        zoneId: 'zone-poligono',
      },
      knownPosition: { lat: 36.657, lon: -4.478, ts: NOW - 90_000, accuracy: 8 },
    });
    expect(declareEliminated(drifted, NOW).eliminated?.dropPoint).toEqual({
      lat: 36.6601,
      lon: -4.4751,
    });
  });

  /**
   * A phone that lost GPS indoors is still a player telling the game they are out
   * of play. R-30.5 says what is recorded and not what happens when there is
   * nothing to record; refusing would be the wrong direction for this button.
   */
  it('eliminates a player who has no fix at all, with no drop point', () => {
    // Built by removing the keys rather than setting them undefined:
    // exactOptionalPropertyTypes means an absent field and an undefined one are
    // different types, and absent is what a phone with no fix actually produces.
    const { position: _p, knownPosition: _k, ...blind } = player();
    const out = declareEliminated(blind, NOW);
    expect(out.eliminated).toEqual({ ts: NOW, selfDeclared: true });
    expect(out.eliminated?.dropPoint).toBeUndefined();
  });

  /**
   * A second press must not move the drop point or the time, and the identity
   * check is the contract: the caller skips a storage write, a broadcast and a
   * second line in the log by comparing references.
   */
  it('is not a toggle: declaring twice returns the same object untouched', () => {
    const first = declareEliminated(player(), NOW);
    const second = declareEliminated(first, NOW + 60_000);
    expect(second).toBe(first);
    expect(second.eliminated?.ts).toBe(NOW);
  });
});

describe('reviveEliminated() — R-32', () => {
  it('removes the record rather than blanking it', () => {
    const back = reviveEliminated(declareEliminated(player(), NOW));
    expect(back.eliminated).toBeUndefined();
    expect('eliminated' in back).toBe(false);
  });

  it('returns the same object for a player who is not out', () => {
    const live = player();
    expect(reviveEliminated(live)).toBe(live);
  });

  /**
   * The frozen snapshot stays frozen on the way back. Refreshing it from the live
   * position would put a fresh timestamp on the game's own record without a fix
   * arriving to justify it — R-12's failure, written by hand. The next ping
   * advances it, because applyPing() only freezes while `eliminated` is set.
   */
  it('leaves knownPosition where it was, and lets the next ping move it', () => {
    const out = declareEliminated(player(), NOW);
    const back = reviveEliminated(out);
    expect(back.knownPosition).toEqual(player().knownPosition);

    const ping: OsmAndPing = {
      deviceId: 'phone-romeo',
      lat: 36.6601,
      lon: -4.4751,
      accuracy: 5,
      battery: 55,
      receivedAt: NOW + 30_000,
      ts: NOW + 30_000,
      attributes: {},
    };
    const moved = applyPing(back, ping, { linkThresholdMs: 90_000 });
    expect(moved.knownPosition).toMatchObject({ lat: 36.6601, lon: -4.4751, ts: NOW + 30_000 });
    expect(moved.knownBattery).toBe(55);
  });

  /** And a revived player is live again by the one predicate that decides it. */
  it('is a round trip: declare, revive, and the record is gone', () => {
    const live = player();
    expect(reviveEliminated(declareEliminated(live, NOW)).eliminated).toBeUndefined();
  });
});

/**
 * M6's judgement rather than R-30's text, so it is written down where it can be
 * argued with: nobody is out before the game starts, and afterwards every session
 * is invalidated anyway. R-34 removes the access schedule, so this gates one
 * button and not the socket.
 */
describe('eliminationOpen()', () => {
  it('is open while the game runs and while it is paused', () => {
    expect(eliminationOpen({ state: 'IN_PROGRESS' })).toBe(true);
    expect(eliminationOpen({ state: 'PAUSED' })).toBe(true);
  });

  it('is closed before the game starts and after it ends', () => {
    expect(eliminationOpen({ state: 'PREPARATION' })).toBe(false);
    expect(eliminationOpen({ state: 'FINISHED' })).toBe(false);
  });

  it('covers every game state, so a new one cannot arrive undecided', () => {
    const states: GameState[] = ['PREPARATION', 'IN_PROGRESS', 'PAUSED', 'FINISHED'];
    for (const state of states) {
      expect(eliminationOpen({ state })).toBe(ELIMINATION_STATES.includes(state));
    }
  });
});
