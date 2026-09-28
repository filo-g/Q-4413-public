import { isUrlSafeId, type Signer } from '@q4413/core';

/**
 * Platform half of §6.4: the HMAC key, the cookie, and the random generator.
 * The session format, its verification and the token lookup are pure and live in
 * packages/core.
 */

const COOKIE_NAME = 'q4413_session';
/** A session must not outlive the game it belongs to; the epoch check does the rest. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 3;

export function hmacSigner(secret: string): Signer {
  const encoder = new TextEncoder();
  // Imported once per isolate, then reused: signing happens on every request.
  const keyPromise = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return {
    async sign(message: string): Promise<string> {
      const mac = await crypto.subtle.sign('HMAC', await keyPromise, encoder.encode(message));
      return base64Url(new Uint8Array(mac));
    },
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 bytes, URL-safe. Invite tokens are the whole of a player's authentication. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

/**
 * httpOnly so script cannot read it, SameSite=Lax so the invite link works when
 * tapped from a message, Secure because everything is behind TLS in production —
 * dropped over plain http so `wrangler dev` on a LAN address still works.
 */
export function sessionCookieHeader(value: string, url: URL): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

export function clearedCookieHeader(url: URL): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

/** The token in `/j/<token>`, or null if the path is not that shape. */
export function inviteTokenFromPath(pathname: string): string | null {
  const match = /^\/j\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

export { isUrlSafeId };
