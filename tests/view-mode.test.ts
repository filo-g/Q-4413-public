import { describe, expect, it } from 'vitest';

import type { GameState } from '@q4413/shared';

import {
  authoritativeExpiresAt,
  authoritativeLapsed,
  effectiveViewMode,
  idleRevertApplies,
  isMasterAction,
  masterRecipient,
  replayAllowed,
  viewModeInForce,
  type ViewModeClock,
  type ViewModeSession,
} from '@q4413/core';

/**
 * R-25's ten-minute revert, and the decision R-25 does not make: **what counts as
 * interaction**. Actions only — the argument is in ROADMAP under M5.
 *
 * Every answer here is derived from a timestamp against `now`, because there is no
 * tick (§6.3). That is what makes it testable at all: the alternative would need
 * ten minutes of wall clock per case.
 */
const CONFIG = { authoritativeIdleRevertMs: 600_000 };
const NOW = 1_760_000_000_000;

/**
 * The clock the revert reads: how long, and whether it runs at all (R-25b).
 * `IN_PROGRESS` unless a case says otherwise, because that is the state every
 * R-25 case was written against.
 */
const clock = (
  state: GameState = 'IN_PROGRESS',
  config: { authoritativeIdleRevertMs: number } = CONFIG,
): ViewModeClock => ({ state, config });
const GAME = clock();

const session = (mode: ViewModeSession['mode'], lastActionAt?: number): ViewModeSession =>
  lastActionAt === undefined ? { mode } : { mode, lastActionAt };

describe('effectiveViewMode() — R-25', () => {
  it('holds AUTHORITATIVE while the ten minutes have not run out', () => {
    expect(effectiveViewMode(session('AUTHORITATIVE', NOW), GAME, NOW)).toBe('AUTHORITATIVE');
    expect(effectiveViewMode(session('AUTHORITATIVE', NOW - 599_999), GAME, NOW)).toBe(
      'AUTHORITATIVE',
    );
  });

  it('reverts to OPERATIONAL at the deadline, not one tick after it', () => {
    expect(effectiveViewMode(session('AUTHORITATIVE', NOW - 600_000), GAME, NOW)).toBe(
      'OPERATIONAL',
    );
  });

  /**
   * Fail closed, and it is the migration case as much as a defensive default: a
   * `viewModes` entry written before R-25 existed is a bare mode string with no
   * clock, and #load() lifts it without inventing one. A session restored across a
   * deploy does not get to keep AUTHORITATIVE on the strength of having once asked.
   */
  it('reverts a session with no action stamped at all', () => {
    expect(effectiveViewMode(session('AUTHORITATIVE'), GAME, NOW)).toBe('OPERATIONAL');
  });

  it('is OPERATIONAL for a session that never left it, and for no session at all', () => {
    expect(effectiveViewMode(session('OPERATIONAL', NOW), GAME, NOW)).toBe('OPERATIONAL');
    expect(effectiveViewMode(undefined, GAME, NOW)).toBe('OPERATIONAL');
  });

  /** The clock is the config's, not a constant here: R-25's ten minutes are tunable. */
  it('takes the window from the game config', () => {
    const short = { authoritativeIdleRevertMs: 60_000 };
    expect(effectiveViewMode(session('AUTHORITATIVE', NOW - 90_000), clock('IN_PROGRESS', short), NOW)).toBe(
      'OPERATIONAL',
    );
    expect(effectiveViewMode(session('AUTHORITATIVE', NOW - 90_000), GAME, NOW)).toBe(
      'AUTHORITATIVE',
    );
  });
});

/**
 * R-25b. The timeout protects against a master who sees who is out **during
 * play** and lets it change what they say over the radio; a finished game has no
 * radio and nobody left to tell, and R-26 makes AUTHORITATIVE the only way to
 * read a replay at all. So in FINISHED, and only there, the clock stops.
 *
 * Every session below is idle well past the window: the only variable is the
 * state, which is the whole requirement.
 */
describe('idleRevertApplies() — the debrief, R-25b', () => {
  const idle = session('AUTHORITATIVE', NOW - 3 * 600_000);

  it('holds AUTHORITATIVE indefinitely once the game is FINISHED', () => {
    expect(effectiveViewMode(idle, clock('FINISHED'), NOW)).toBe('AUTHORITATIVE');
    expect(effectiveViewMode(idle, clock('FINISHED'), NOW + 86_400_000)).toBe('AUTHORITATIVE');
    expect(authoritativeLapsed(idle, clock('FINISHED'), NOW)).toBe(false);
  });

  /**
   * PAUSED is the state most likely to be added to the exemption later by
   * somebody reasoning that nothing is happening in it. A paused game is a game
   * still being played, and a master who pauses to talk on the radio is exactly
   * who R-25 is about.
   */
  it('still runs in every other state, PAUSED included', () => {
    for (const state of ['PREPARATION', 'IN_PROGRESS', 'PAUSED'] as const) {
      expect(idleRevertApplies(state)).toBe(true);
      expect(effectiveViewMode(idle, clock(state), NOW)).toBe('OPERATIONAL');
    }
    expect(idleRevertApplies('FINISHED')).toBe(false);
  });

  /**
   * The order of the tests inside effectiveViewMode(). A session with no action
   * stamped never evidenced being asked for — a different fact from an idle one
   * — and R-25b does not rescue it, in any state.
   */
  it('does not resurrect a session with no action stamped', () => {
    expect(effectiveViewMode(session('AUTHORITATIVE'), clock('FINISHED'), NOW)).toBe('OPERATIONAL');
  });

  /** No clock, no deadline: there is nothing to send and nothing to count down. */
  it('sends no deadline, so the panel has no countdown to draw', () => {
    expect(authoritativeExpiresAt(idle, clock('FINISHED'))).toBeUndefined();
    expect(masterRecipient(idle, clock('FINISHED'), NOW)).toEqual({
      kind: 'MASTER',
      viewMode: 'AUTHORITATIVE',
    });
  });
});

describe('authoritativeExpiresAt()', () => {
  it('is the last action plus the window', () => {
    expect(authoritativeExpiresAt(session('AUTHORITATIVE', NOW), GAME)).toBe(NOW + 600_000);
  });

  it('does not apply in OPERATIONAL, or with no clock', () => {
    expect(authoritativeExpiresAt(session('OPERATIONAL', NOW), GAME)).toBeUndefined();
    expect(authoritativeExpiresAt(session('AUTHORITATIVE'), GAME)).toBeUndefined();
    expect(authoritativeExpiresAt(undefined, GAME)).toBeUndefined();
  });
});

/**
 * The transition, which is what the `AUTHORITATIVE_REVERTED` event records.
 * Distinct from `effectiveViewMode()` answering OPERATIONAL, which is also true of
 * a session that was never anything else — logging that would put a line in the
 * event log on every request from every master.
 */
describe('authoritativeLapsed()', () => {
  it('is true only for a stored AUTHORITATIVE whose clock ran out', () => {
    expect(authoritativeLapsed(session('AUTHORITATIVE', NOW - 600_000), GAME, NOW)).toBe(true);
    expect(authoritativeLapsed(session('AUTHORITATIVE'), GAME, NOW)).toBe(true);
    expect(authoritativeLapsed(session('AUTHORITATIVE', NOW), GAME, NOW)).toBe(false);
    expect(authoritativeLapsed(session('OPERATIONAL'), GAME, NOW)).toBe(false);
    expect(authoritativeLapsed(undefined, GAME, NOW)).toBe(false);
  });
});

/**
 * The rule is the method and the surface, never a list of paths — a list would be
 * a second place to remember when a route is added.
 */
describe('isMasterAction() — what stops the clock', () => {
  it('counts every mutating master route, including ones that do not exist yet', () => {
    expect(isMasterAction('POST', '/api/master/marker')).toBe(true);
    expect(isMasterAction('DELETE', '/api/master/marker/marker-abc')).toBe(true);
    expect(isMasterAction('POST', '/api/master/comms')).toBe(true);
    expect(isMasterAction('POST', '/api/master/game/state')).toBe(true);
    expect(isMasterAction('POST', '/api/master/view')).toBe(true);
    expect(isMasterAction('POST', '/api/master/something-from-m6')).toBe(true);
  });

  /** R-14 gives masters and players the same right to record radio contact. */
  it('counts radio contact, which lives outside the master surface', () => {
    expect(isMasterAction('POST', '/api/radio-contact')).toBe(true);
  });

  /**
   * The case that makes the method test load-bearing: a master surface can be
   * read, and reading is exactly what R-25 refuses to count.
   */
  it('does not count reads, on the master surface or anywhere else', () => {
    expect(isMasterAction('GET', '/api/master/invites')).toBe(false);
    expect(isMasterAction('GET', '/api/state')).toBe(false);
    expect(isMasterAction('GET', '/api/geo')).toBe(false);
    expect(isMasterAction('GET', '/ws')).toBe(false);
  });

  it('does not count a player route that happens to mutate', () => {
    expect(isMasterAction('POST', '/api/session/master')).toBe(false);
    expect(isMasterAction('POST', '/j/token')).toBe(false);
  });
});

/**
 * The only way a stored session becomes a recipient. It exists so that there is
 * exactly one place that could forget the revert, rather than one per call site.
 */
describe('masterRecipient()', () => {
  it('carries the effective mode and the deadline the panel counts down to', () => {
    const recipient = masterRecipient(session('AUTHORITATIVE', NOW - 60_000), GAME, NOW);
    expect(recipient).toEqual({
      kind: 'MASTER',
      viewMode: 'AUTHORITATIVE',
      authoritativeExpiresAt: NOW + 540_000,
    });
  });

  it('omits the deadline once the mode is OPERATIONAL, however it got there', () => {
    expect(masterRecipient(session('AUTHORITATIVE', NOW - 600_000), GAME, NOW)).toEqual({
      kind: 'MASTER',
      viewMode: 'OPERATIONAL',
    });
    expect(masterRecipient(session('OPERATIONAL', NOW), GAME, NOW)).toEqual({
      kind: 'MASTER',
      viewMode: 'OPERATIONAL',
    });
    expect(masterRecipient(undefined, GAME, NOW)).toEqual({
      kind: 'MASTER',
      viewMode: 'OPERATIONAL',
    });
  });
});

/**
 * The client's half of the same rule. It matters because the server has no tick:
 * a panel holding a snapshot on a quiet game receives nothing at the deadline, so
 * if it trusted `payload.viewMode` it would keep rendering drop points for as long
 * as the game stayed quiet. This is what makes it stop.
 */
describe('viewModeInForce() — what a payload in hand is still allowed to show', () => {
  const payload = (viewMode: 'OPERATIONAL' | 'AUTHORITATIVE', authoritativeExpiresAt?: number) =>
    authoritativeExpiresAt === undefined ? { viewMode } : { viewMode, authoritativeExpiresAt };

  it('holds AUTHORITATIVE until the deadline the payload carries', () => {
    expect(viewModeInForce(payload('AUTHORITATIVE', NOW + 1), NOW)).toBe('AUTHORITATIVE');
    expect(viewModeInForce(payload('AUTHORITATIVE', NOW), NOW)).toBe('OPERATIONAL');
    expect(viewModeInForce(payload('AUTHORITATIVE', NOW - 60_000), NOW)).toBe('OPERATIONAL');
  });

  /**
   * A snapshot claiming AUTHORITATIVE with no deadline cannot be checked, so it is
   * not believed. It should not happen — project() emits the pair together — and
   * the point is that it fails closed if it ever does.
   */
  it('does not believe an AUTHORITATIVE payload that carries no deadline', () => {
    expect(viewModeInForce(payload('AUTHORITATIVE'), NOW)).toBe('OPERATIONAL');
  });

  /**
   * The client half of R-25b, and the case that matters most: a finished game
   * sends no deadline, and an absent deadline is exactly what this function
   * treats as already lapsed. Without the state test the panel would hide what
   * the payload in its own hand contains while the server went on projecting it,
   * which is the worst of the three ways the two sides can disagree.
   */
  it('holds AUTHORITATIVE with no deadline once the game is FINISHED', () => {
    expect(viewModeInForce({ viewMode: 'AUTHORITATIVE', game: { state: 'FINISHED' } }, NOW)).toBe(
      'AUTHORITATIVE',
    );
    expect(viewModeInForce({ viewMode: 'AUTHORITATIVE', game: { state: 'PAUSED' } }, NOW)).toBe(
      'OPERATIONAL',
    );
  });

  it('leaves OPERATIONAL alone, and answers nothing for a player payload', () => {
    expect(viewModeInForce(payload('OPERATIONAL'), NOW)).toBe('OPERATIONAL');
    expect(viewModeInForce({}, NOW)).toBeUndefined();
    expect(viewModeInForce(undefined, NOW)).toBeUndefined();
    expect(viewModeInForce(null, NOW)).toBeUndefined();
  });
});

/**
 * R-57b. Who may read the track, which is a different question from who may see
 * the panel — and the one the server asks before it answers `GET /api/track`.
 *
 * The window is sent **whole**, with no visibility filter, so this predicate is
 * the only thing standing between an OPERATIONAL session and every
 * `ELIMINATION` row in the game. That is why it lives in core and is tested
 * here: the Worker and the panel both call it, and a second copy of the rule at
 * either call site would be a copy that could drift open.
 */
describe('replayAllowed', () => {
  const STATES: GameState[] = ['PREPARATION', 'IN_PROGRESS', 'PAUSED', 'FINISHED'];

  it('lets AUTHORITATIVE read the track in every state', () => {
    for (const state of STATES) {
      expect(replayAllowed('AUTHORITATIVE', state)).toBe(true);
    }
  });

  /**
   * The requirement, stated as the pair it is: the same mode is refused while
   * the game is being played and admitted once it is over. `PAUSED` is the case
   * worth holding — a paused game is still a game, which is the same line R-25b
   * draws for the idle timeout.
   */
  it('lets OPERATIONAL read it only once the game is FINISHED', () => {
    expect(replayAllowed('OPERATIONAL', 'FINISHED')).toBe(true);
    expect(replayAllowed('OPERATIONAL', 'PAUSED')).toBe(false);
    expect(replayAllowed('OPERATIONAL', 'IN_PROGRESS')).toBe(false);
    expect(replayAllowed('OPERATIONAL', 'PREPARATION')).toBe(false);
  });

  /**
   * An absent state fails closed, the way `viewModeInForce()` does: a caller
   * that cannot say what state the game is in does not get the relaxation on the
   * strength of not having said.
   *
   * An absent **mode** is not the same question and is not defended here — a
   * finished game admits it, because this predicate answers *what this mode
   * grants* and nothing about who is asking. Whether the asker is a master is
   * the caller's check, and in the Worker it is the half of the condition that
   * runs first. Pinned so that stays a decision rather than a gap somebody
   * closes by tightening this and breaking the requirement.
   */
  it('fails closed on the state, and leaves who is asking to the caller', () => {
    expect(replayAllowed('OPERATIONAL', undefined)).toBe(false);
    expect(replayAllowed(undefined, 'IN_PROGRESS')).toBe(false);
    expect(replayAllowed(undefined, undefined)).toBe(false);
    expect(replayAllowed(undefined, 'FINISHED')).toBe(true);
  });
});
