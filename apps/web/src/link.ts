/**
 * What to do when the socket closes (R-74).
 *
 * Pure, and separate from `game.svelte.ts` for one reason: the suite has no DOM
 * and no `WebSocket`, so the decision is the only part of a reconnect that can
 * be held still and tested. The class keeps the timers and the socket; this
 * keeps the rule.
 *
 * **A close is three different events wearing one listener.** The link dropped
 * on a walk, the app closed the socket itself, or the handshake was refused —
 * and the third one is the one the app had no name for. A WebSocket cannot say
 * why: the browser hands `close` and `error` with no status, so a `401` that
 * ends the connection looks exactly like a phone in a lift. Treating all three
 * as the first is what left the login screen reconnecting for ever against a
 * session that had been revoked hours earlier.
 */
export type LinkOutcome =
  /** The app closed it on purpose. Nothing to do; something else is in charge. */
  | 'STOP'
  /** It was working and stopped. Back off and try again — the M8 behaviour. */
  | 'RETRY'
  /**
   * It never opened at all, so the session is a suspect. One `/api/state` says
   * which: a `401` means there is nothing to reconnect to and the login screen
   * is the honest answer, and anything else means the network and a retry.
   */
  | 'PROBE';

export function afterSocketClose(socket: { wanted: boolean; opened: boolean }): LinkOutcome {
  if (!socket.wanted) return 'STOP';
  return socket.opened ? 'RETRY' : 'PROBE';
}

/**
 * The first wait after a link that was working drops, and the ceiling it climbs
 * to. Carried over from M1 unchanged: a phone on a walk loses the link often,
 * and hammering the Worker costs requests the free tier counts.
 */
export const RETRY_FIRST_MS = 1_000;
export const RETRY_MAX_MS = 15_000;

/** Doubling, capped. Held here so the cap and the first wait sit together. */
export function nextRetryMs(current: number): number {
  return Math.min(current * 2, RETRY_MAX_MS);
}
