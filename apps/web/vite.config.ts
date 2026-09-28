import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

/**
 * Plain Vite, not SvelteKit (§15.2). The PWA is a static bundle on Pages with
 * the API on Workers; the service worker owns .pmtiles precaching (R-52) and
 * an adapter layer between us and it is not acceptable.
 */
/**
 * wrangler dev's origin. Overridable because its default port is often already
 * taken, and a dev server that cannot reach the Worker looks exactly like a
 * Worker that is broken.
 */
const worker = process.env.WORKER_ORIGIN ?? 'http://127.0.0.1:8787';

/**
 * GitHub Pages has no SPA fallback: an unknown path gets `404.html`, or GitHub's
 * own 404 page when there is none. So the shell is emitted under both names.
 * Without it, a cold load of anything but `/` — an invite link pasted into a
 * phone, say — is GitHub's 404 rather than the app.
 *
 * In the build rather than in the workflow, so `vite preview` behaves the way
 * Pages does. `vite preview` is the only place the second black-map failure can
 * be seen at all (see CLAUDE.md), and a preview that differs from production is
 * worth less than no preview.
 */
function pagesSpaFallback(): Plugin {
  return {
    name: 'q4413-pages-404',
    closeBundle() {
      const dist = fileURLToPath(new URL('dist', import.meta.url));
      const shell = join(dist, 'index.html');
      if (existsSync(shell)) copyFileSync(shell, join(dist, '404.html'));
    },
  };
}

export default defineConfig({
  plugins: [svelte(), pagesSpaFallback()],
  /**
   * MapLibre parses tiles in a **Web Worker**, and Vite's dependency
   * pre-bundler cannot follow it: it rewrites the entry, loses
   * `maplibre-gl-worker.mjs`, and every tile then fails to parse silently. The
   * style still loads, so the background paints and nothing else does — an
   * absolutely black map, which is the same symptom as a wrong `source-layer`
   * or a broken CORS policy and is not any of them.
   *
   * Dev only: `vite build` does no pre-bundling, so the production bundle was
   * always fine. It surfaces after any lockfile change, because that is what
   * makes the optimizer re-run.
   */
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  /**
   * MapLibre constructs its tile parser with `new Worker(url, { type: 'module' })`
   * and only falls back to a classic worker if that *throws*. The default `iife`
   * output would be handed to a module worker and evaluated under module scope
   * rules, which is not what it was written for — so the worker Vite emits for
   * `?worker&url` (see src/map/worker.ts) is ESM, matching what MapLibre asks
   * the browser for.
   */
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      // The service worker is a second entry point, emitted unhashed at the
      // root: its scope is the path it is served from, so /assets/sw-a1b2.js
      // would control /assets and nothing else. R-52's precaching is the reason
      // this project is plain Vite rather than SvelteKit (§15.2), so it is
      // wired here by hand rather than through a plugin.
      input: { main: 'index.html', sw: 'src/sw.ts' },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    proxy: {
      '/api': worker,
      '/i': worker,
      // Without this, Vite's SPA fallback answers the invite link with index.html
      // and a 200, the cookie is never set, and the player lands on the master
      // login screen holding a password they do not have.
      '/j': worker,
      '/ws': { target: worker.replace(/^http/, 'ws'), ws: true },
    },
  },
});
