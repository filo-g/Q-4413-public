import type { WsServerMessage } from '@q4413/shared';

import { GEO_PROFILES } from './profiles.ts';
import { DemoServer } from './server.ts';

/**
 * The whole of the demo's contact with the app: `fetch` and `WebSocket`.
 *
 * **It goes underneath `api.ts`, never inside a view.** `apps/web/src/api.ts`
 * and one `new WebSocket()` in `game.svelte.ts` are the entire client/server
 * boundary of this app, so patching the two globals is enough — and it is the
 * only way that leaves the views, the map and the panel running the code they
 * run in a real game. A second code path above this line would be a parallel
 * renderer that drifts from the real one and stops demonstrating anything. It is
 * the rule R-53 imposed on replay, applied to the same kind of problem: replay
 * is a clock, and this is a server.
 *
 * Everything that is not the API goes to the network unchanged — most of all
 * `/basemap/v3/*.pmtiles`, which is a real file fetched over HTTP and cached by
 * the real service worker (R-52).
 */

const server = new DemoServer(GEO_PROFILES);

/** The paths this answers. Everything else is somebody's real asset. */
const isApi = (pathname: string): boolean =>
  pathname.startsWith('/api/') || pathname.startsWith('/i/') || pathname.startsWith('/j/');

export function installDemoServer(): void {
  installFetch();
  installSocket();
}

function installFetch(): void {
  const real = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url, location.href);
    if (url.origin !== location.origin || !isApi(url.pathname)) return real(input as RequestInfo, init);
    return server.handle(request);
  };
}

/**
 * A socket that is a function call.
 *
 * `game.svelte.ts` uses four things — `addEventListener`, `close`, and the
 * `open`/`message`/`close` events — so this implements those and nothing else,
 * and hands anything that is not our `/ws` to the real constructor. The cast is
 * deliberate and narrow: implementing the rest of the `WebSocket` interface
 * would be inventing behaviour nothing calls.
 */
function installSocket(): void {
  const RealWebSocket = globalThis.WebSocket;

  class DemoSocket extends EventTarget {
    readyState = 0;
    #off: (() => void) | undefined;

    constructor(url: string | URL) {
      super();
      // A macrotask rather than synchronously: a socket that is open before its
      // caller has attached a listener is not a socket, and `#connect()` attaches
      // them after the constructor returns.
      setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
        this.#send();
        this.#off = server.world.onChange(() => this.#send());
      }, 0);
      void url;
    }

    #send(): void {
      const session = server.world.session;
      if (!session) return;
      const payload = server.payloadFor(session);
      if (!payload) return;
      const message: WsServerMessage = { t: 'snapshot', payload };
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    }

    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.#off?.();
      this.#off = undefined;
      this.dispatchEvent(new CloseEvent('close'));
    }
  }

  globalThis.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === '/ws' && url.host === location.host) {
        return new DemoSocket(url) as unknown as WebSocket;
      }
      return Reflect.construct(target, args) as WebSocket;
    },
  });
}

installDemoServer();
