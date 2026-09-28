/**
 * How often a repeated ingest rejection is worth a line in the log (R-04b).
 *
 * R-04 says a ping outside the ingest area is dropped and logged, and that was
 * built as *every* one. One device in the wrong place therefore writes a line
 * every reporting interval, for as long as it is on — and the live event tail is
 * capped at 500, so it pushes every other event out of the master's panel.
 * Measured on a local Worker forty minutes into a test game, with a single
 * device outside the area: **212 of 238 events in the tail were
 * `INGEST_REJECTED`**, all from the same device, all saying the same thing.
 *
 * Since M8 it costs twice: `#log()` also writes a `track_log` row, so the
 * archive R-56 replays from fills with the same noise and a replay's event list
 * is mostly rejections.
 *
 * The first rejection from a device is the useful one — that phone is outside
 * the area, or the secret is wrong, and somebody should go and look. The four
 * hundredth says nothing new. So the first is logged at once and the rest are
 * counted, with one line per window carrying how many there were.
 *
 * Pure and keyed by caller, like `throttle.ts`, so every branch is testable
 * without a Worker and without waiting out a window.
 */

export interface RejectionRecord {
  /** When a line was last written for this key. */
  lastLoggedAt: number;
  /** Rejections dropped since that line. */
  suppressed: number;
}

export type RejectionState = Record<string, RejectionRecord>;

/**
 * Five minutes.
 *
 * At Traccar's shortest sensible interval this turns about thirty lines into
 * one, and over a four-hour game it turns 1.440 into 48 — enough to see that a
 * device is still out there and how much it has been rejected, few enough that
 * the tail stays a log of the game.
 */
export const REJECTION_LOG_WINDOW_MS = 5 * 60 * 1000;

/**
 * Ceiling on tracked keys, for the same reason `throttle.ts` has one: a Durable
 * Object never forgets, and a fleet with rotating ids — or somebody pointing a
 * script at the ingest path — would otherwise grow this map without limit. The
 * eviction is the least recently logged, which is the one whose window is
 * closest to having expired anyway.
 */
export const REJECTION_MAX_KEYS = 64;

/**
 * Whether this rejection is written, and what to say about the ones that were
 * not.
 *
 * Mutates `state` rather than returning a new one: this runs on a path whose
 * whole purpose is to throw the request away, and a fresh object per rejected
 * ping is the cost the feature exists to avoid.
 *
 * @param key    the device id, or the rejection reason when a ping is too
 *               malformed to carry one — coalescing those by reason is right,
 *               since what a master needs to know is that something is sending
 *               rubbish, not how much of it
 */
export function noteRejection(
  state: RejectionState,
  key: string,
  now: number,
  windowMs: number = REJECTION_LOG_WINDOW_MS,
): { log: boolean; suppressed: number } {
  const record = state[key];
  if (record && now - record.lastLoggedAt < windowMs) {
    record.suppressed += 1;
    return { log: false, suppressed: 0 };
  }

  const suppressed = record?.suppressed ?? 0;
  state[key] = { lastLoggedAt: now, suppressed: 0 };
  evict(state, now);
  return { log: true, suppressed };
}

function evict(state: RejectionState, now: number): void {
  const keys = Object.keys(state);
  if (keys.length <= REJECTION_MAX_KEYS) return;
  let oldestKey = keys[0]!;
  let oldest = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    const at = state[key]?.lastLoggedAt ?? now;
    if (at < oldest) {
      oldest = at;
      oldestKey = key;
    }
  }
  delete state[oldestKey];
}
