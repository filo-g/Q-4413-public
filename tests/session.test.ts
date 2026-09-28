import { describe, expect, it } from 'vitest';

import {
  base64UrlDecodeAscii,
  base64UrlEncodeAscii,
  isUrlSafeId,
  playerForToken,
  signSession,
  verifySession,
  type SessionEpochs,
  type SessionPayload,
  type Signer,
} from '@q4413/core';

/**
 * Sessions decide who project() thinks it is talking to, so every failure here
 * has to fail closed. A real WebCrypto HMAC drives the round trips; Node has the
 * same standard the Worker does.
 */
async function hmacSigner(secret: string): Promise<Signer> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return {
    async sign(message: string): Promise<string> {
      const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
      return btoa(String.fromCharCode(...new Uint8Array(mac)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    },
  };
}

const EPOCH = 3;

/**
 * Both epochs at the same number, which is every case that predates R-33b: the
 * split matters only where they differ, and those cases say so.
 */
const epochs = (value: number): SessionEpochs => ({ player: value, master: value });
const PLAYER: SessionPayload = {
  kind: 'PLAYER',
  playerId: 'alfa',
  epoch: EPOCH,
  issuedAt: 1_756_000_000_000,
};
const MASTER: SessionPayload = {
  kind: 'MASTER',
  sessionId: 'sid-1',
  epoch: EPOCH,
  issuedAt: 1_756_000_000_000,
};

describe('base64url ascii codec', () => {
  it.each(['a', 'ab', 'abc', 'abcd', '{"kind":"PLAYER"}', ''])(
    'round-trips %j',
    (input) => {
      expect(base64UrlDecodeAscii(base64UrlEncodeAscii(input))).toBe(input);
    },
  );

  it('produces nothing that needs escaping in a cookie or a URL', () => {
    const encoded = base64UrlEncodeAscii(JSON.stringify(PLAYER));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses non-ASCII rather than mangling it', () => {
    expect(() => base64UrlEncodeAscii('señal')).toThrow(/ASCII/);
  });
});

describe('isUrlSafeId', () => {
  it.each(['alfa', 'player-1', 'sid_9', 'AbC123'])('accepts %s', (id) => {
    expect(isUrlSafeId(id)).toBe(true);
  });

  it.each(['', 'has space', 'señal', 'a.b', 'a/b', 'a+b'])('rejects %j', (id) => {
    expect(isUrlSafeId(id)).toBe(false);
  });
});

describe('signSession / verifySession', () => {
  it('round-trips a player session', async () => {
    const signer = await hmacSigner('secret-a');
    const cookie = await signSession(PLAYER, signer);
    expect(await verifySession(cookie, signer, epochs(EPOCH))).toEqual(PLAYER);
  });

  it('round-trips a master session', async () => {
    const signer = await hmacSigner('secret-a');
    const cookie = await signSession(MASTER, signer);
    expect(await verifySession(cookie, signer, epochs(EPOCH))).toEqual(MASTER);
  });

  it('rejects a cookie signed with a different secret', async () => {
    const mint = await hmacSigner('secret-a');
    const check = await hmacSigner('secret-b');
    const cookie = await signSession(PLAYER, mint);
    expect(await verifySession(cookie, check, epochs(EPOCH))).toBeNull();
  });

  it('rejects a tampered player id, which is the whole point', async () => {
    const signer = await hmacSigner('secret-a');
    const cookie = await signSession(PLAYER, signer);
    const forged = await signSession({ ...PLAYER, playerId: 'bravo' }, signer);
    const [, mac] = cookie.split('.');
    const [body] = forged.split('.');
    expect(await verifySession(`${body}.${mac}`, signer, epochs(EPOCH))).toBeNull();
  });

  it('rejects a cookie from a previous epoch, so finishing a game logs everyone out', async () => {
    const signer = await hmacSigner('secret-a');
    const cookie = await signSession(PLAYER, signer);
    expect(await verifySession(cookie, signer, epochs(EPOCH + 1))).toBeNull();
  });

  /**
   * R-33b, and the whole reason there are two numbers: finishing a game bumps
   * the player epoch and leaves the master's alone, so the same call has to
   * answer differently for the two kinds of cookie. This is the milestone's
   * blunt check, written where it can be run rather than only at a venue.
   */
  describe('the two epochs — R-33b', () => {
    it('revokes the player and keeps the master when the game finishes', async () => {
      const signer = await hmacSigner('secret-a');
      const finished = { player: EPOCH + 1, master: EPOCH };
      expect(await verifySession(await signSession(PLAYER, signer), signer, finished)).toBeNull();
      expect(await verifySession(await signSession(MASTER, signer), signer, finished)).toEqual(
        MASTER,
      );
    });

    /**
     * A reset moves both, which is the difference between a game that ended and
     * a game that was thrown away.
     */
    it('revokes both when the master epoch moves too', async () => {
      const signer = await hmacSigner('secret-a');
      const reset = epochs(EPOCH + 1);
      expect(await verifySession(await signSession(PLAYER, signer), signer, reset)).toBeNull();
      expect(await verifySession(await signSession(MASTER, signer), signer, reset)).toBeNull();
    });

    /**
     * The cookie does not choose which number it is checked against — its `kind`
     * does. A player cookie carrying the master's epoch is still a player
     * cookie, and is refused on the player's number.
     */
    it('does not let a player cookie borrow the master epoch', async () => {
      const signer = await hmacSigner('secret-a');
      const cookie = await signSession({ ...PLAYER, epoch: EPOCH }, signer);
      expect(await verifySession(cookie, signer, { player: EPOCH + 1, master: EPOCH })).toBeNull();
    });
  });

  it.each(['', '.', 'nodot', '.onlymac', 'body.', 'a.b.c'])(
    'rejects malformed cookie %j',
    async (value) => {
      const signer = await hmacSigner('secret-a');
      expect(await verifySession(value, signer, epochs(EPOCH))).toBeNull();
    },
  );

  it('rejects a valid signature over a payload of the wrong shape', async () => {
    const signer = await hmacSigner('secret-a');
    const body = base64UrlEncodeAscii(JSON.stringify({ kind: 'ADMIN', epoch: EPOCH, issuedAt: 1 }));
    const cookie = `${body}.${await signer.sign(body)}`;
    expect(await verifySession(cookie, signer, epochs(EPOCH))).toBeNull();
  });

  it('rejects a player session with no player id', async () => {
    const signer = await hmacSigner('secret-a');
    const body = base64UrlEncodeAscii(JSON.stringify({ kind: 'PLAYER', epoch: EPOCH, issuedAt: 1 }));
    const cookie = `${body}.${await signer.sign(body)}`;
    expect(await verifySession(cookie, signer, epochs(EPOCH))).toBeNull();
  });
});

describe('playerForToken', () => {
  const players = [
    { id: 'alfa', sessionToken: 'token-alfa-long' },
    { id: 'bravo', sessionToken: 'token-bravo-long' },
    { id: 'charlie', sessionToken: 'token-charlie-x' },
  ];

  it('finds the owner of a token', () => {
    expect(playerForToken(players, 'token-bravo-long')?.id).toBe('bravo');
  });

  it('finds the last player as readily as the first', () => {
    expect(playerForToken(players, 'token-charlie-x')?.id).toBe('charlie');
  });

  it('returns nothing for an unknown token', () => {
    expect(playerForToken(players, 'token-unknown-xx')).toBeUndefined();
  });

  it('returns nothing for a prefix of a real token', () => {
    expect(playerForToken(players, 'token-alfa')).toBeUndefined();
  });

  it('returns nothing for an empty token, rather than the first player', () => {
    expect(playerForToken(players, '')).toBeUndefined();
  });

  it('returns nothing when a player has no token yet', () => {
    expect(playerForToken([{ id: 'x', sessionToken: '' }], '')).toBeUndefined();
  });
});
