import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  checkPingAccepted,
  cutSwitchOnStateChange,
  geofenceApplies,
  ingestOpen,
  insideIngestArea,
  playerFeedOpen,
} from '@q4413/core';
import type { GameGeoJson, GameState, Polygon } from '@q4413/shared';

const geo = JSON.parse(
  readFileSync(new URL('../packages/shared/geo/madrid.geojson', import.meta.url), 'utf8'),
) as GameGeoJson;

const ingestArea = geo.features.find((f) => f.properties.featureType === 'INGEST_AREA')!
  .geometry as Polygon;

/** Centre of the perimeter, and therefore inside the ingest area. */
const INSIDE = { lat: 40.4168, lon: -3.7038 };
/** North-east of the ingest area bbox by several kilometres — outside both. */
const OUTSIDE = { lat: 40.5, lon: -3.6 };

const ACCEPTING: GameState[] = ['PREPARATION', 'IN_PROGRESS', 'PAUSED'];

describe('ingestOpen — R-05', () => {
  it.each(ACCEPTING)('accepts pings while %s', (state) => {
    expect(ingestOpen(state, false).open).toBe(true);
  });

  it('rejects pings once the game is FINISHED', () => {
    const result = ingestOpen('FINISHED', false);
    expect(result.open).toBe(false);
    if (result.open) return;
    expect(result.rejection).toEqual({ reason: 'GAME_FINISHED' });
  });

  it.each(ACCEPTING)('rejects pings in %s when the cut switch is on (R-34)', (state) => {
    const result = ingestOpen(state, true);
    expect(result.open).toBe(false);
    if (result.open) return;
    expect(result.rejection).toEqual({ reason: 'CUT_SWITCH' });
  });
});

describe('geofenceApplies — R-04', () => {
  it('applies only while IN_PROGRESS', () => {
    expect(geofenceApplies('IN_PROGRESS')).toBe(true);
  });

  it.each<GameState>(['PREPARATION', 'PAUSED', 'FINISHED'])('does not apply in %s', (state) => {
    expect(geofenceApplies(state)).toBe(false);
  });
});

describe('insideIngestArea', () => {
  it('places a venue coordinate inside', () => {
    expect(insideIngestArea(INSIDE.lon, INSIDE.lat, ingestArea)).toBe(true);
  });

  it('places a distant coordinate outside', () => {
    expect(insideIngestArea(OUTSIDE.lon, OUTSIDE.lat, ingestArea)).toBe(false);
  });
});

describe('checkPingAccepted', () => {
  it('accepts a ping from anywhere during PREPARATION, or pairing is impossible (R-04, R-06)', () => {
    const result = checkPingAccepted({
      state: 'PREPARATION',
      cutSwitch: false,
      ...OUTSIDE,
      ingestArea,
    });
    expect(result.accepted).toBe(true);
  });

  it('rejects a ping from outside the ingest area once IN_PROGRESS', () => {
    const result = checkPingAccepted({
      state: 'IN_PROGRESS',
      cutSwitch: false,
      ...OUTSIDE,
      ingestArea,
    });
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.rejection).toEqual({
      reason: 'OUTSIDE_INGEST_AREA',
      lat: OUTSIDE.lat,
      lon: OUTSIDE.lon,
    });
  });

  it('accepts a ping from inside the ingest area while IN_PROGRESS', () => {
    const result = checkPingAccepted({
      state: 'IN_PROGRESS',
      cutSwitch: false,
      ...INSIDE,
      ingestArea,
    });
    expect(result.accepted).toBe(true);
  });

  it('reports the cut switch before the geofence, so a cut game says why', () => {
    const result = checkPingAccepted({
      state: 'IN_PROGRESS',
      cutSwitch: true,
      ...OUTSIDE,
      ingestArea,
    });
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.rejection).toEqual({ reason: 'CUT_SWITCH' });
  });

  it('does not geofence a PAUSED game, since play resumes in place', () => {
    const result = checkPingAccepted({
      state: 'PAUSED',
      cutSwitch: false,
      ...OUTSIDE,
      ingestArea,
    });
    expect(result.accepted).toBe(true);
  });
});

/**
 * R-60 — the half of R-34's cut switch that was never built.
 *
 * R-34 says the cut halts **ingest and broadcast**, and only the ingest half
 * existed: with the cut on, a master action still reached every player and a
 * player who reloaded was handed a complete, current projection. The half that
 * was missing is the one that matters when the reason for cutting is that
 * something is being *seen* that should not be.
 */
describe('playerFeedOpen — R-60', () => {
  it('is open until the switch is thrown', () => {
    expect(playerFeedOpen(false)).toBe(true);
    expect(playerFeedOpen(true)).toBe(false);
  });

  /**
   * The pairing with `ingestOpen` is the whole point: one switch, both halves,
   * and neither depends on the game's state. A cut in PREPARATION stops as much
   * as a cut mid-game.
   */
  it('goes with the ingest gate, and neither asks what state the game is in', () => {
    for (const state of ['PREPARATION', 'IN_PROGRESS', 'PAUSED'] as const) {
      expect(ingestOpen(state, true).open).toBe(false);
      expect(playerFeedOpen(true)).toBe(false);
      expect(ingestOpen(state, false).open).toBe(true);
      expect(playerFeedOpen(false)).toBe(true);
    }
  });
});

/**
 * R-34b. Finishing a game throws the cut switch, and the switch is the third
 * thing that stops a finished game listening — R-05 refuses every ping on the
 * state, and `#endSession()` closes every socket. It is not redundant with
 * them: those two are consequences, and **the switch is what a master reads to
 * know whether the machine is listening**. A panel saying ingest is open on a
 * game refusing every ping is the machine lying about itself.
 */
describe('cutSwitchOnStateChange — R-34b', () => {
  const game = (
    state: GameState,
    cutSwitch = false,
    cutByFinish?: boolean,
  ): { state: GameState; cutSwitch: boolean; cutByFinish?: boolean } =>
    cutByFinish === undefined ? { state, cutSwitch } : { state, cutSwitch, cutByFinish };

  it('throws the switch when a game finishes', () => {
    expect(cutSwitchOnStateChange('FINISHED', game('IN_PROGRESS'))).toEqual({
      cutSwitch: true,
      cutByFinish: true,
    });
  });

  /**
   * A master who cut mid-game and then finished it keeps the switch: the throw
   * was theirs, so the release has to be theirs too.
   */
  it('leaves a cut a master already threw alone', () => {
    expect(cutSwitchOnStateChange('FINISHED', game('IN_PROGRESS', true))).toBeNull();
  });

  /**
   * The half that needs the flag. A cut left on from a finished game makes the
   * *next* session start deaf — pings refused for a reason belonging to a game
   * that is over — which is worse than what the throw fixes, because it happens
   * during setup and looks like broken ingest.
   */
  it('releases its own cut when the game is opened again', () => {
    for (const next of ['PREPARATION', 'IN_PROGRESS', 'PAUSED'] as const) {
      expect(cutSwitchOnStateChange(next, game('FINISHED', true, true))).toEqual({
        cutSwitch: false,
        cutByFinish: false,
      });
    }
  });

  it('never releases a cut a master threw by hand', () => {
    expect(cutSwitchOnStateChange('PREPARATION', game('FINISHED', true, false))).toBeNull();
    // Absent means "not ours", for a game seeded before the field existed.
    expect(cutSwitchOnStateChange('PREPARATION', game('FINISHED', true))).toBeNull();
  });

  it('has nothing to say about the transitions in between', () => {
    expect(cutSwitchOnStateChange('IN_PROGRESS', game('PREPARATION'))).toBeNull();
    expect(cutSwitchOnStateChange('PAUSED', game('IN_PROGRESS'))).toBeNull();
    expect(cutSwitchOnStateChange('FINISHED', game('FINISHED', true, true))).toBeNull();
  });
});
