import { describe, expect, it } from 'vitest';

import {
  afterSocketClose,
  nextRetryMs,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
} from '../apps/web/src/link.ts';

/**
 * R-74. The suite has no `WebSocket` and no DOM, which is why the decision lives
 * in a module of its own: what the class does with a closed socket is the part
 * that was wrong, and it is the part that can be held still.
 */
describe('afterSocketClose — R-74', () => {
  /**
   * The bug this requirement came from. `reload()` closes the socket, the close
   * listener arms a reconnect, `#hydrate()` then finds no session and returns
   * without connecting — and the armed timer connects anyway. On the login
   * screen, for ever, at whatever rate a backgrounded tab throttles a 15 s timer
   * to.
   */
  it('does nothing when the app closed the socket itself', () => {
    expect(afterSocketClose({ wanted: false, opened: true })).toBe('STOP');
    expect(afterSocketClose({ wanted: false, opened: false })).toBe('STOP');
  });

  /** A link that was working and dropped is M1's case and keeps M1's answer. */
  it('retries a socket that had come up', () => {
    expect(afterSocketClose({ wanted: true, opened: true })).toBe('RETRY');
  });

  /**
   * The one the app had no name for. A refused handshake and a phone in a lift
   * are the same event with the same empty reason, so the only thing that tells
   * them apart is that one of them never opened — and then `/api/state` is what
   * answers which.
   */
  it('asks the server about a socket that never came up', () => {
    expect(afterSocketClose({ wanted: true, opened: false })).toBe('PROBE');
  });
});

describe('nextRetryMs', () => {
  it('doubles up to the ceiling and stays there', () => {
    let wait = RETRY_FIRST_MS;
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      wait = nextRetryMs(wait);
      waits.push(wait);
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);
  });
});
