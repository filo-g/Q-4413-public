import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The installed app's window, which is three files agreeing with each other and
 * no code at all.
 *
 * §6.4 wants the invite link to install as an app rather than open a tab, and on
 * a phone that is where most of this game is played. Everything checked here is
 * a value with no runtime — nothing imports it, nothing renders it, and a wrong
 * one is a layout complaint at a venue rather than a failure anywhere a test
 * usually looks.
 */
const manifest = JSON.parse(
  readFileSync(new URL('../apps/web/public/manifest.webmanifest', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const indexHtml = readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8');

describe('the web app manifest', () => {
  /**
   * **`standalone`, and `fullscreen` is a button instead** (R-68c).
   *
   * `fullscreen` was tried and reverted. It takes the system bars, which is
   * worth a fifth of the screen on a phone held sideways — and it takes them in
   * portrait too, where there is room for them and no complaint to answer. A
   * manifest cannot tell the two apart: `display` is read once, when the app is
   * installed, and does not vary by orientation.
   *
   * What can tell them apart is the player, so the reclaim moved to
   * `requestFullscreen()` behind a control on the map. This assertion is here to
   * stop `fullscreen` coming back to the manifest as an apparent simplification:
   * it is not the same feature, and it was already rejected once with a reason.
   */
  it('asks for standalone, and leaves fullscreen to the button', () => {
    expect(manifest['display']).toBe('standalone');
  });

  /**
   * The other half, and the reason these two are asserted in one file: the case
   * pads itself with `env(safe-area-inset-*)`, and those resolve to zero without
   * `viewport-fit=cover`. Dropping the meta would not break a layout anywhere it
   * could be seen — it would quietly stop the app reaching the edges it is now
   * padding itself away from.
   */
  it('keeps the viewport covering the whole screen', () => {
    expect(indexHtml).toContain('viewport-fit=cover');
  });

  /**
   * Not a token. A home-screen icon carries no `/j/<token>`, because a token is
   * a player's whole authentication (R-08) and it expires with the game — an
   * icon that opened a dead invite would be an app that stopped working between
   * games, silently, on somebody's phone.
   */
  it('starts at the root, never at an invite', () => {
    expect(manifest['start_url']).toBe('/');
    expect(String(manifest['start_url'])).not.toContain('/j/');
  });
});
