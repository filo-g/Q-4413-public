import { describe, expect, it } from 'vitest';

import {
  checkLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
  MASTER_LOGIN_THROTTLE,
  type AttemptRecord,
  type ThrottleConfig,
} from '@q4413/core';

/**
 * M2b: `POST /api/session/master` is the only bruteforceable surface in the
 * system, so its throttle is tested at the same level as the ingest gates.
 *
 * The clock is a parameter, so a five-minute lockout is exercised without
 * waiting five minutes.
 */

const CONFIG: ThrottleConfig = MASTER_LOGIN_THROTTLE;
const T0 = 1_700_000_000_000;

/** n consecutive failures from one caller, all at the same instant. */
function failTimes(n: number, now = T0, key = 'ip'): Record<string, AttemptRecord> {
  let records: Record<string, AttemptRecord> = {};
  for (let i = 0; i < n; i += 1) records = recordLoginFailure(records, key, now, CONFIG);
  return records;
}

describe('master login throttle — the budget', () => {
  it('allows a guess when nothing is recorded', () => {
    expect(checkLoginAllowed({}, 'ip', T0)).toEqual({ allowed: true });
  });

  it('allows guesses up to the limit', () => {
    const records = failTimes(CONFIG.maxFailures - 1);
    expect(checkLoginAllowed(records, 'ip', T0)).toEqual({ allowed: true });
  });

  it('locks out on the last allowed failure, not the one after', () => {
    const records = failTimes(CONFIG.maxFailures);
    const decision = checkLoginAllowed(records, 'ip', T0);
    expect(decision.allowed).toBe(false);
  });

  it('reports the remaining lockout, rounded up', () => {
    const records = failTimes(CONFIG.maxFailures);
    // 1 ms into a 300 s lockout still has 300 s to go, never 299.
    const decision = checkLoginAllowed(records, 'ip', T0 + 1);
    expect(decision).toEqual({ allowed: false, retryAfterSeconds: CONFIG.lockoutMs / 1000 });
  });

  it('never reports a retryAfter of zero while still locked', () => {
    const records = failTimes(CONFIG.maxFailures);
    const decision = checkLoginAllowed(records, 'ip', T0 + CONFIG.lockoutMs - 1);
    expect(decision).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('allows guesses again once the lockout has been served', () => {
    const records = failTimes(CONFIG.maxFailures);
    expect(checkLoginAllowed(records, 'ip', T0 + CONFIG.lockoutMs)).toEqual({ allowed: true });
  });

  it('gives a full budget after a served lockout, not one guess', () => {
    const served = T0 + CONFIG.lockoutMs;
    let records = failTimes(CONFIG.maxFailures);
    records = recordLoginFailure(records, 'ip', served, CONFIG);
    expect(records['ip']?.failures).toBe(1);
    expect(checkLoginAllowed(records, 'ip', served)).toEqual({ allowed: true });
  });
});

describe('master login throttle — the window', () => {
  it('forgets failures spread wider than the window', () => {
    // A master who mistypes once an hour must never be locked out.
    let records: Record<string, AttemptRecord> = {};
    for (let i = 0; i < CONFIG.maxFailures * 3; i += 1) {
      records = recordLoginFailure(records, 'ip', T0 + i * CONFIG.windowMs, CONFIG);
      expect(records['ip']?.failures).toBe(1);
    }
    expect(checkLoginAllowed(records, 'ip', T0 + CONFIG.maxFailures * 3 * CONFIG.windowMs)).toEqual({
      allowed: true,
    });
  });

  it('counts failures inside the window as one run', () => {
    let records: Record<string, AttemptRecord> = {};
    const step = Math.floor(CONFIG.windowMs / CONFIG.maxFailures) - 1;
    for (let i = 0; i < CONFIG.maxFailures; i += 1) {
      records = recordLoginFailure(records, 'ip', T0 + i * step, CONFIG);
    }
    expect(checkLoginAllowed(records, 'ip', T0 + CONFIG.maxFailures * step).allowed).toBe(false);
  });
});

describe('master login throttle — isolation between callers', () => {
  it('does not let one caller lock out another', () => {
    // The reason the throttle is per address: a global counter would let anyone
    // lock the master out of their own game (§6.2).
    const records = failTimes(CONFIG.maxFailures, T0, 'attacker');
    expect(checkLoginAllowed(records, 'attacker', T0).allowed).toBe(false);
    expect(checkLoginAllowed(records, 'master', T0)).toEqual({ allowed: true });
  });

  it('clears one caller without touching the others', () => {
    let records = failTimes(CONFIG.maxFailures, T0, 'attacker');
    records = recordLoginFailure(records, 'master', T0, CONFIG);
    records = clearLoginFailures(records, 'master');
    expect(records['master']).toBeUndefined();
    expect(records['attacker']?.failures).toBe(CONFIG.maxFailures);
  });

  it('clearing an unknown caller is not an error', () => {
    expect(clearLoginFailures({}, 'nobody')).toEqual({});
  });
});

describe('master login throttle — bounded state', () => {
  it('drops records that can no longer refuse anything', () => {
    // Otherwise a rotating-address attack grows a map inside a Durable Object
    // that never forgets.
    let records: Record<string, AttemptRecord> = {};
    for (let i = 0; i < 50; i += 1) records = recordLoginFailure(records, `ip-${i}`, T0, CONFIG);
    expect(Object.keys(records)).toHaveLength(50);

    // One more failure a window later, and every stale single-failure record goes.
    records = recordLoginFailure(records, 'ip-fresh', T0 + CONFIG.windowMs, CONFIG);
    expect(Object.keys(records)).toEqual(['ip-fresh']);
  });

  it('keeps live lockouts while pruning', () => {
    let records = failTimes(CONFIG.maxFailures, T0, 'locked');
    records = recordLoginFailure(records, 'other', T0 + CONFIG.windowMs, CONFIG);
    expect(Object.keys(records).sort()).toEqual(['locked', 'other']);
    expect(checkLoginAllowed(records, 'locked', T0 + CONFIG.windowMs).allowed).toBe(false);
  });

  it('enforces the key ceiling, keeping the newest windows', () => {
    const config: ThrottleConfig = { ...CONFIG, maxTrackedKeys: 3 };
    let records: Record<string, AttemptRecord> = {};
    for (let i = 0; i < 6; i += 1) {
      records = recordLoginFailure(records, `ip-${i}`, T0 + i, config);
    }
    expect(Object.keys(records).sort()).toEqual(['ip-3', 'ip-4', 'ip-5']);
  });
});

describe('master login throttle — configured rate', () => {
  it('permits 60 guesses an hour under a sustained attack', () => {
    // The number the password strength has to survive. Asserted rather than
    // left in a comment, so changing the config surfaces the consequence.
    const perLockout = CONFIG.maxFailures;
    const cycleMs = CONFIG.lockoutMs;
    expect((perLockout * 3_600_000) / cycleMs).toBe(60);
  });
});
