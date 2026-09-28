/**
 * Registering the service worker, and telling it what to precache (R-52).
 *
 * Two steps rather than one, because the archive's URL is configuration: it
 * arrives on the projected payload as `Game.basemap.pmtilesUrl` (§14.6), and
 * the worker is installed long before the first snapshot lands.
 *
 * Registration is skipped in dev. Vite serves modules unbundled, and a worker
 * caching them shows yesterday's code with no way to tell — the failure that
 * makes people distrust service workers in general.
 */

/** HTTPS or localhost only, which is the constraint that put M2b before M7. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error) => console.error(error));
  });
}

/**
 * Hand the archive's URL over as soon as the payload carries one, so it is
 * downloaded while there is still signal. The venue has basements.
 *
 * Idempotent on both sides: the same URL is sent on every snapshot and the
 * worker returns early on a cache hit, because the archive is immutable at a
 * versioned path and a hit is therefore always current.
 */
export function precacheBasemap(url: string): void {
  if (!url) return;
  navigator.serviceWorker?.ready
    .then((registration) => {
      registration.active?.postMessage({ type: 'PRECACHE_BASEMAP', url });
    })
    .catch((error) => console.error(error));
}
