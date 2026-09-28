import { setWorkerUrl } from 'maplibre-gl';

/**
 * MapLibre's tile-parsing Web Worker, as an asset this build actually emits.
 *
 * MapLibre 6 ships the worker as a **separate file** and finds it at runtime
 * with `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. That expression
 * is computed, so no bundler can see it:
 *
 * - in `vite dev` it resolves against the module's own URL under
 *   `/node_modules/maplibre-gl/dist/`, where the real file is sitting, and the
 *   dev server serves it — so the map works;
 * - in a build it resolves against the entry chunk, `/assets/main-<hash>.js`,
 *   and nothing ever copied a worker next to it. `/assets/maplibre-gl-worker.mjs`
 *   is a 404, which `not_found_handling = "single-page-application"` answers
 *   with `index.html` and a **200** — so the worker is handed a page of HTML to
 *   run, every tile fails to parse, and the map is black.
 *
 * Same symptom as the `optimizeDeps.exclude` trap in
 * [vite.config.ts](../vite.config.ts) — background paints, nothing else does —
 * and the exact mirror image of it: that one is dev-only, this one cannot
 * happen in dev. Which is why M7 shipped it. The map was verified on the dev
 * server, which is the one arrangement where it needs no help.
 *
 * Beside `src/map` rather than inside it, and that is not arbitrary:
 * `tsconfig.tests.json` compiles every `.ts` under `src/map` into the root
 * suite, whose modules are plain TypeScript that a bare `tsc` and `node` can
 * both read. A Vite query specifier is neither, and it would fail the typecheck
 * before it ever failed a test.
 *
 * `?worker&url` makes Vite bundle the worker as its own entry — following the
 * `maplibre-gl-shared.mjs` import inside it, which a plain file copy would
 * leave dangling — and hands back the hashed URL of the emitted asset.
 * `setWorkerUrl()` is MapLibre's own override for exactly this, so nothing here
 * depends on where the entry chunk ends up.
 */
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

/**
 * Call before the first `new MapLibreMap()`. MapLibre keeps the URL in
 * module-global config, so calling it again with the same value is a no-op.
 */
export function useBundledMapWorker(): void {
  setWorkerUrl(workerUrl);
}
