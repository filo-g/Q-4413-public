/// <reference lib="webworker" />

import { contentRange, parseRange, sliceFor } from './sw-range.ts';

/**
 * The service worker (R-52). It owns `.pmtiles` precaching, which is why the
 * bundler is plain Vite and not SvelteKit (§15.2).
 *
 * The map has to survive dead spots and basements, and the venue has both. The
 * archive is **a single immutable file at a versioned path**, so it is cached
 * by URL and **never revalidated**: a new extract is a new path (`/v2/...`),
 * and the old one being stale is impossible rather than unlikely.
 *
 * ## What it must never cache
 *
 * `/api/*` and `/ws`. Every payload is projected per recipient (§4), so a
 * cached one is both a lie — it describes where people were, not where they are
 * — and a copy of somebody's location written to disk, which §10 has opinions
 * about. They are passed straight through, and a request that fails offline
 * fails, which is what the client's own derivation of link state is for (R-15).
 */

declare const self: ServiceWorkerGlobalScope;

/**
 * Bump to evict everything. The app shell is content-hashed by Vite, so this is
 * mostly about changing the *strategy*, not the assets — with one exception that
 * cost this bump.
 *
 * **`/manifest.webmanifest` is served from here, cache-first, under a name that
 * never changes.** It is a same-origin GET that is neither `/api/` nor
 * `.pmtiles`, so it falls through to `shellResponse()`, and its request mode is
 * not `navigate`, so it takes the cache-first half. Vite hashes the bundle and
 * does not hash this, so an installed app would have gone on being handed the
 * copy it cached on the day it was installed — and a manifest is where
 * `display` lives, which is the one value that decides whether Android keeps its
 * status and navigation bars on top of the app.
 *
 * `v2` therefore shipped with the `fullscreen` change rather than after somebody
 * worked out why the phones did not take it. Same shape as `GEO_VERSION` and
 * `BASEMAP_VERSION`: a thing seeded once that a deploy does not refresh.
 *
 * **`v3` is the way back, and that is the half that was missed.** The manifest
 * went to `fullscreen` and then to `standalone` again — R-68c made filling the
 * screen a *control* rather than a setting, because the manifest's `display` is
 * read once at install and cannot differ between one orientation and the other.
 * The revert did not bump this, so every phone installed during that window went
 * on being handed the cached `fullscreen` manifest for ever: the app started
 * against the glass, the button had nothing to exit from, and Android's sticky
 * immersive mode put the bars back a few seconds after each attempt. It read
 * exactly like a broken toggle and was a stale cache entry.
 *
 * **A revert needs the bump as much as the change did.** Nothing here can tell
 * them apart, which is the whole reason this constant exists.
 */
const SHELL_CACHE = 'q4413-shell-v3';

/**
 * Separate from the shell, and deliberately not versioned with it: the archive
 * is tens of megabytes over a phone's data, and a deploy must not throw it away
 * and re-download it at the venue.
 */
const BASEMAP_CACHE = 'q4413-basemap';

/** What the page sends once it knows the archive's URL (it arrives on the payload). */
interface PrecacheBasemapMessage {
  type: 'PRECACHE_BASEMAP';
  url: string;
}

self.addEventListener('install', (event) => {
  // The shell is cached on first fetch rather than listed here: Vite hashes the
  // asset names at build time and nothing generates a manifest for this file.
  // index.html is the one fixed name, and it is what a navigation needs.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(new Request('/', { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== BASEMAP_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * The precache itself, triggered by the page rather than by `install`.
 *
 * The archive's URL is configuration (`Game.basemap.pmtilesUrl`, §14.6) and
 * arrives on the projected payload, so this file cannot know it at install
 * time. The page hands it over as soon as it has one; downloading tens of
 * megabytes is worth doing while there is still signal, which is the whole
 * point of R-52.
 *
 * Fetched **whole**, without a range header, because the cache entry has to be
 * the entire file for `rangeFromCache()` to slice it.
 */
async function precacheBasemap(url: string): Promise<void> {
  if (!url) return;
  const cache = await caches.open(BASEMAP_CACHE);
  // Immutable by construction: a different archive is a different path, so a
  // hit is always current and revalidating would cost a download for nothing.
  if (await cache.match(url)) return;
  // No `range` header, deliberately — see rangeFromCache().
  const response = await fetch(url);
  if (!response.ok) return;
  await cache.put(url, response);
}

self.addEventListener('message', (event) => {
  const data = event.data as PrecacheBasemapMessage | undefined;
  if (data?.type === 'PRECACHE_BASEMAP') {
    event.waitUntil(precacheBasemap(data.url));
  }
});

/**
 * A range request answered out of the cached whole file.
 *
 * `pmtiles` reads the archive in ranges — a header, then a directory, then
 * individual tiles — so without this the cache entry is useless to it: the
 * Cache API matches on the URL and would return the entire archive for a
 * request that asked for 16 bytes.
 */
async function rangeFromCache(request: Request): Promise<Response> {
  const cache = await caches.open(BASEMAP_CACHE);
  let cached = await cache.match(request.url);

  if (!cached) {
    // **The whole file, never the range.** Two reasons, and the second is the
    // one that decides where the archive can live:
    //
    // - a cache entry has to be the entire archive for the slicing below to
    //   work at all, and a 206 stored here would poison it;
    // - `pmtiles` throws outright on a 200 answer to a range request — "Check
    //   that your storage backend supports HTTP Byte Serving" — and Cloudflare
    //   static assets answer 200. Fetching whole means the origin never has to
    //   serve bytes, so the archive can sit next to the bundle instead of
    //   needing object storage that speaks Range.
    await precacheBasemap(request.url);
    cached = await cache.match(request.url);
  }
  // Still nothing: offline before the archive was ever downloaded, or the fetch
  // failed. Let it through to the network, which is where the real error is.
  if (!cached) return fetch(request);

  const header = request.headers.get('range');
  if (!header) return cached;

  const buffer = await cached.arrayBuffer();
  const range = parseRange(header, buffer.byteLength);
  if (range === null) {
    return new Response(buffer, { status: 200, headers: cached.headers });
  }
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': contentRange(null, buffer.byteLength) },
    });
  }

  const { start, endExclusive } = sliceFor(range);
  return new Response(buffer.slice(start, endExclusive), {
    status: 206,
    headers: {
      'content-type': cached.headers.get('content-type') ?? 'application/octet-stream',
      'content-length': String(endExclusive - start),
      'content-range': contentRange(range, buffer.byteLength),
      'accept-ranges': 'bytes',
    },
  });
}

/**
 * The manifest, which is the one same-origin GET that must not be cache-first.
 *
 * Everything else the shell holds is content-hashed by Vite, so a changed file
 * is a changed URL and the cache cannot go stale. This is not: its name never
 * changes, and `display` is read out of it once, when the app is installed. A
 * stale copy therefore does not look stale — it looks like a feature that does
 * not work, which is what the `v2`/`v3` story above is.
 *
 * Network-first with the cache behind it costs nothing real. A manifest is read
 * at install and at the browser's own update check, both of which need the
 * network anyway; the cached copy is there so an offline install attempt gets
 * *something* rather than nothing.
 */
const NETWORK_FIRST = '/manifest.webmanifest';

/** Cache-first for the hashed bundle, network-first for the document it loads. */
async function shellResponse(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);

  if (new URL(request.url).pathname === NETWORK_FIRST) {
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request);
      if (cached) return cached;
      throw new Error('offline and no cached manifest');
    }
  }

  if (request.mode === 'navigate') {
    try {
      const response = await fetch(request);
      // The invite link (/j/<token>) is a redirect that sets a cookie; caching
      // the document it lands on is fine, caching the redirect is not.
      if (response.ok && new URL(request.url).pathname === '/') {
        await cache.put('/', response.clone());
      }
      return response;
    } catch {
      const cached = await cache.match('/');
      if (cached) return cached;
      throw new Error('offline and no cached shell');
    }
  }

  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cached, never intercepted: projected per recipient, stale within
  // seconds, and somebody's location (§4, §10).
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  if (url.pathname.endsWith('.pmtiles')) {
    event.respondWith(rangeFromCache(request));
    return;
  }

  if (url.origin !== self.location.origin) return;
  event.respondWith(shellResponse(request));
});
