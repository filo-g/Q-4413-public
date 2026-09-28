/**
 * Login throttling (M2b). `POST /api/session/master` is the only bruteforceable
 * surface in the system: players redeem a token and ingest carries a path secret,
 * so this one endpoint is the whole of the attack surface that accepts guesses.
 *
 * Acceptable debt on a LAN, not acceptable facing the internet — which is what
 * M2b changes.
 *
 * Pure and keyed by caller, so every branch is testable without a Worker and
 * without waiting out a real lockout. The Durable Object owns the state and the
 * clock; this module only decides.
 */

/** Failures by one caller, inside one window. */
export interface AttemptRecord {
  failures: number;
  /** Start of the current counting window. */
  windowStartedAt: number;
  /** Set once the budget is spent; before this, guesses are refused outright. */
  lockedUntil?: number;
}

export interface ThrottleConfig {
  /** Guesses allowed inside `windowMs` before the lockout starts. */
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  /**
   * Ceiling on tracked callers. A bruteforce from rotating addresses would
   * otherwise grow this map without limit inside a Durable Object that never
   * forgets. Reached only under attack, and the eviction is the oldest window.
   */
  maxTrackedKeys: number;
}

/**
 * Five guesses a minute, then locked out for five.
 *
 * The sustained rate this permits is the number worth checking: a locked-out
 * attacker who waits out every lockout gets 5 guesses per 5 minutes, so 60 an
 * hour, so about 525.000 a year. Against the 24-character random password M2b
 * generates that is not a threat; against a password someone chose by hand it
 * is, which is why the deploy step pipes `openssl rand` into `wrangler secret
 * put` rather than inviting a typed one.
 */
export const MASTER_LOGIN_THROTTLE: ThrottleConfig = {
  maxFailures: 5,
  windowMs: 60_000,
  lockoutMs: 300_000,
  maxTrackedKeys: 1_000,
};

export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Whether `key` may attempt a guess now. Call before checking the password, so a
 * locked-out caller learns nothing about whether its guess was right.
 */
export function checkLoginAllowed(
  records: Readonly<Record<string, AttemptRecord>>,
  key: string,
  now: number,
): ThrottleDecision {
  const record = records[key];
  if (!record?.lockedUntil) return { allowed: true };
  if (record.lockedUntil <= now) return { allowed: true };

  return {
    allowed: false,
    // Rounded up: a Retry-After of 0 would invite an immediate retry that is
    // still inside the lockout.
    retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000),
  };
}

/**
 * Records one failed guess, returning the new map. A window that has expired —
 * or a lockout that has been served — starts the count again from one, so an
 * honest master who mistypes twice an hour is never locked out.
 */
export function recordLoginFailure(
  records: Readonly<Record<string, AttemptRecord>>,
  key: string,
  now: number,
  config: ThrottleConfig = MASTER_LOGIN_THROTTLE,
): Record<string, AttemptRecord> {
  const existing = records[key];
  const stale =
    !existing ||
    (existing.lockedUntil !== undefined && existing.lockedUntil <= now) ||
    now - existing.windowStartedAt >= config.windowMs;

  const record: AttemptRecord = stale
    ? { failures: 1, windowStartedAt: now }
    : { failures: existing.failures + 1, windowStartedAt: existing.windowStartedAt };

  if (record.failures >= config.maxFailures) record.lockedUntil = now + config.lockoutMs;

  return prune({ ...records, [key]: record }, now, config);
}

/** Clears one caller's failures. A correct password is not a failed attempt. */
export function clearLoginFailures(
  records: Readonly<Record<string, AttemptRecord>>,
  key: string,
): Record<string, AttemptRecord> {
  if (!(key in records)) return { ...records };
  const next = { ...records };
  delete next[key];
  return next;
}

/**
 * Drops records that can no longer refuse anything, then enforces the key
 * ceiling by evicting the oldest windows. Both are safe: an evicted record is
 * one whose caller gets a fresh budget, never one that was holding a lock open
 * for someone else.
 */
function prune(
  records: Record<string, AttemptRecord>,
  now: number,
  config: ThrottleConfig,
): Record<string, AttemptRecord> {
  const live: Record<string, AttemptRecord> = {};
  for (const [key, record] of Object.entries(records)) {
    const lockActive = record.lockedUntil !== undefined && record.lockedUntil > now;
    const windowActive = now - record.windowStartedAt < config.windowMs;
    if (lockActive || windowActive) live[key] = record;
  }

  const keys = Object.keys(live);
  if (keys.length <= config.maxTrackedKeys) return live;

  // Keep the newest windows: they are the ones an in-flight attack is using.
  const kept = keys
    .sort((a, b) => live[b]!.windowStartedAt - live[a]!.windowStartedAt)
    .slice(0, config.maxTrackedKeys);
  const capped: Record<string, AttemptRecord> = {};
  for (const key of kept) capped[key] = live[key]!;
  return capped;
}
