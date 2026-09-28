import { describe, expect, it } from 'vitest';

import {
  noteRejection,
  REJECTION_LOG_WINDOW_MS,
  REJECTION_MAX_KEYS,
  type RejectionState,
} from '@q4413/core';

/**
 * R-04b. R-04 says a ping outside the ingest area is dropped and logged, and
 * that was built as *every* one — so one device in the wrong place wrote a line
 * every reporting interval, and the live tail is capped at 500.
 *
 * Measured on a local Worker forty minutes into a test game with a single
 * device outside the area: 212 of 238 events in the tail were INGEST_REJECTED,
 * all from the same device, all saying the same thing. The archive R-56 replays
 * from had the same 212.
 */
const NOW = 1_760_000_000_000;

describe('noteRejection — R-04b', () => {
  it('logs the first rejection from a caller at once', () => {
    const state: RejectionState = {};
    expect(noteRejection(state, 'fake-6', NOW)).toEqual({ log: true, suppressed: 0 });
  });

  it('counts the rest of the window instead of logging them', () => {
    const state: RejectionState = {};
    noteRejection(state, 'fake-6', NOW);
    for (let i = 1; i <= 29; i++) {
      expect(noteRejection(state, 'fake-6', NOW + i * 10_000).log).toBe(false);
    }
    expect(state['fake-6']?.suppressed).toBe(29);
  });

  /** The line that ends a window says how many it stands for. */
  it('carries the suppressed count on the next line', () => {
    const state: RejectionState = {};
    noteRejection(state, 'fake-6', NOW);
    for (let i = 1; i <= 29; i++) noteRejection(state, 'fake-6', NOW + i * 10_000);
    expect(noteRejection(state, 'fake-6', NOW + REJECTION_LOG_WINDOW_MS)).toEqual({
      log: true,
      suppressed: 29,
    });
    // And the count starts again, rather than accumulating for the session.
    expect(state['fake-6']?.suppressed).toBe(0);
  });

  /**
   * Per caller, not globally: a second device going wrong while the first is
   * still being suppressed is news, and it is the case the whole feature would
   * be worthless without.
   */
  it('does not let one noisy caller silence another', () => {
    const state: RejectionState = {};
    noteRejection(state, 'fake-6', NOW);
    noteRejection(state, 'fake-6', NOW + 1_000);
    expect(noteRejection(state, 'fake-2', NOW + 2_000).log).toBe(true);
  });

  /**
   * A four-hour game with one device outside, at ten seconds: 1.440 lines
   * becomes 48. The arithmetic is the requirement, so it is checked rather than
   * described.
   */
  it('turns a game of rejections into a readable handful', () => {
    const state: RejectionState = {};
    let logged = 0;
    for (let at = 0; at < 4 * 60 * 60 * 1000; at += 10_000) {
      if (noteRejection(state, 'fake-6', NOW + at).log) logged += 1;
    }
    expect(logged).toBe(48);
  });

  /**
   * A Durable Object never forgets, so the map is bounded for the same reason
   * `throttle.ts`'s is: a fleet with rotating ids, or a script pointed at the
   * ingest path, would otherwise grow it without limit.
   */
  it('bounds the callers it tracks, evicting the least recently logged', () => {
    const state: RejectionState = {};
    for (let i = 0; i < REJECTION_MAX_KEYS + 10; i++) {
      noteRejection(state, `device-${i}`, NOW + i);
    }
    expect(Object.keys(state).length).toBeLessThanOrEqual(REJECTION_MAX_KEYS);
    expect(state['device-0']).toBeUndefined();
    expect(state[`device-${REJECTION_MAX_KEYS + 9}`]).toBeDefined();
  });
});
