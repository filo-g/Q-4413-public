import { constantTimeEquals, isUrlSafeId } from '@q4413/core';

import { GameDurableObject } from './game-do.ts';

export interface Env {
  GAME: DurableObjectNamespace<GameDurableObject>;
  /** Rotating path secret for the ingest endpoint (R-02). */
  INGEST_SECRET: string;
  /** HMAC key for session cookies (§6.4). */
  SESSION_SECRET: string;
  /** Master login (§6.4). Players never use a password. */
  MASTER_PASSWORD: string;
}

/** One game for now. Multi-game routing arrives when a second game exists. */
const GAME_NAME = 'default';

/**
 * Router. Everything stateful is delegated to the game Durable Object; this
 * layer resolves which game a request belongs to and checks the ingest secret.
 *
 * No message reaches a socket without passing through project() (§4). That rule
 * lives in the Durable Object, and this file must never gain a shortcut around it.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.GAME.get(env.GAME.idFromName(GAME_NAME));

    // POST /i/<secret>/ — OsmAnd protocol, no session auth (R-01, R-02, R-09).
    // Needs a Cloudflare Access bypass rule, or Traccar Client gets a login page
    // and nobody finds out until everyone is at the venue (§6.2).
    if (url.pathname.startsWith('/i/')) {
      const [, , secret = ''] = url.pathname.split('/');

      // The secret is read out of a single path segment, so a configured value
      // containing a `/` is truncated by that split and can never match: ingest
      // would answer 404 to every ping with no other symptom. `openssl rand
      // -base64 32` produces such a value about half the time, so this is a
      // misconfiguration worth failing loudly about rather than silently — it is
      // the §6.2 failure, discovered at the venue with six people waiting.
      if (!isUrlSafeId(env.INGEST_SECRET ?? '')) {
        console.error(
          'INGEST_SECRET is missing or not URL-path-safe, so ingest can never match. ' +
            'Generate it with `openssl rand -hex 32`.',
        );
        return new Response('not found', { status: 404 });
      }

      if (!constantTimeEquals(secret, env.INGEST_SECRET ?? '')) {
        // 404, not 403: an unknown path secret should look like an unknown path.
        return new Response('not found', { status: 404 });
      }
      return stub.fetch(request);
    }

    // Sessions, state and sockets all live in the Durable Object: it holds the
    // epoch that decides whether a cookie is still valid.
    if (
      url.pathname === '/ws' ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/j/')
    ) {
      return stub.fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { GameDurableObject };
