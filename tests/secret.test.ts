import { describe, expect, it } from 'vitest';

import { constantTimeEquals, isUrlSafeId } from '@q4413/core';

describe('constantTimeEquals — ingest path secret (R-02)', () => {
  it('matches an identical secret', () => {
    expect(constantTimeEquals('s3cr3t-value', 's3cr3t-value')).toBe(true);
  });

  it('rejects a wrong secret of the same length', () => {
    expect(constantTimeEquals('s3cr3t-valuf', 's3cr3t-value')).toBe(false);
  });

  it('rejects a correct prefix', () => {
    expect(constantTimeEquals('s3cr3t', 's3cr3t-value')).toBe(false);
  });

  it('rejects a longer candidate that starts correctly', () => {
    expect(constantTimeEquals('s3cr3t-value-more', 's3cr3t-value')).toBe(false);
  });

  it('rejects everything when the Worker has no secret configured', () => {
    // A missing INGEST_SECRET is a misconfiguration, not an open door.
    expect(constantTimeEquals('', '')).toBe(false);
    expect(constantTimeEquals('anything', '')).toBe(false);
  });

  it('handles multi-byte characters without throwing', () => {
    expect(constantTimeEquals('señal-🜃', 'señal-🜃')).toBe(true);
    expect(constantTimeEquals('senal-🜃', 'señal-🜃')).toBe(false);
  });
});

describe('ingest path secret shape (R-02)', () => {
  /**
   * The router reads the secret out of a single path segment:
   * `url.pathname.split('/')[2]`. Anything that does not survive that round trip
   * cannot authenticate a ping, however correct the configured value is.
   */
  const throughPath = (secret: string): string => `/i/${secret}/`.split('/')[2] ?? '';

  it('a hex secret survives the path segment', () => {
    const hex = 'f4c1a90b7e2d5836a1bc04ef79d23a5518c6b0e4f27a9d31cc85b60fa7e42193';
    expect(isUrlSafeId(hex)).toBe(true);
    expect(throughPath(hex)).toBe(hex);
    expect(constantTimeEquals(throughPath(hex), hex)).toBe(true);
  });

  it('what randomToken() produces survives it too', () => {
    // base64url: the invite tokens already conform, which is why they work.
    // Invented, with the shape of one — what is checked is that a value of this
    // form survives a path segment, never the value itself.
    const token = 'Zx-1qP_aB4tKm9Rv0sYw2Ce7Nf5Lh8Jd3Gi6Uo-xTr0';
    expect(isUrlSafeId(token)).toBe(true);
    expect(throughPath(token)).toBe(token);
  });

  it('a base64 secret containing a slash is truncated, and can never match', () => {
    // This is why the generation command is `openssl rand -hex`, not `-base64`:
    // a 32-byte base64 value contains a '/' about half the time, and the failure
    // is a silent 404 on every ping.
    const base64 = 'Ck9/2fQ1tYb8Xz3PmLr0aW7eNsJhVuGd4RcTpQiOxAk=';
    expect(isUrlSafeId(base64)).toBe(false);
    expect(throughPath(base64)).toBe('Ck9');
    expect(constantTimeEquals(throughPath(base64), base64)).toBe(false);
  });

  it('rejects an unconfigured secret before it is ever compared', () => {
    // A missing secret is a misconfiguration, not an open door.
    expect(isUrlSafeId('')).toBe(false);
  });
});
