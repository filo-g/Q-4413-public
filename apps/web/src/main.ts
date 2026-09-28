import { mount } from 'svelte';
import App from './App.svelte';
import { display } from './display.svelte.ts';
import { registerServiceWorker } from './sw-register.ts';

// §9's art direction, and the only global stylesheet. Imported here rather than
// linked from index.html so the fonts it pulls in are bundled assets the service
// worker caches like any other (R-52).
import './styles/terminal.css';

// R-52. The map has to survive dead spots and basements, and neither of those
// is a good moment to discover the archive was never downloaded.
registerServiceWorker();

// Before the mount, deliberately: §9's high-contrast mode applied after the
// first frame would flash the full effect at exactly the person who asked not
// to see it.
display.start();

/**
 * The demo's fake server, and the only line in `apps/web/src` that knows it
 * exists (§6.1).
 *
 * A dynamic import behind a build-time flag, so `vite build` without
 * `VITE_DEMO=1` removes the branch and emits no demo chunk at all — the real
 * app is byte-for-byte what it was. **Before the mount**, because `App.svelte`
 * opens the socket on mount and a socket opened against the real `WebSocket`
 * would never come back.
 *
 * Everything the demo does is underneath `api.ts`: see `demo/install.ts` for why
 * it may not be anywhere else.
 */
if (import.meta.env.VITE_DEMO === '1') await import('./demo/install.ts');

const target = document.getElementById('app');
if (!target) throw new Error('missing #app mount target');

export default mount(App, { target });
