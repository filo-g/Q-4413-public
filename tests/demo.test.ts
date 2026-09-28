import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Payload } from '@q4413/shared';

import { DemoServer, INVITE_PATH } from '../apps/web/src/demo/server.ts';

/**
 * The static demo's fake server (`apps/web/src/demo/`).
 *
 * **What is being checked is that the demo does what it shows**, which is the
 * one rule the thing has: a page that offers a button doing nothing is worse
 * than a page that offers no button. So this exercises the five things a
 * visitor can do — log in, switch geometry, close ground, hide a point, place
 * and clear a marker — and pins the two answers that are deliberately absent.
 *
 * It does **not** re-check §4. `project()` decides who sees what, the demo calls
 * it unchanged, and `tests/projection.test.ts` is where that lives. A second
 * copy of those assertions here would be a second specification.
 *
 * The geometry is read with `readFileSync` rather than Vite's `?raw`, which is
 * why `demo/profiles.ts` exists: a query specifier is a thing only a bundler
 * understands, and the root suite is plain TypeScript.
 */
const PROFILES = Object.fromEntries(
  ['madrid', 'barcelona', 'sevilla'].map((profile) => [
    profile,
    readFileSync(new URL(`../packages/shared/geo/${profile}.geojson`, import.meta.url), 'utf8'),
  ]),
);

const post = (path: string, body: unknown = {}) =>
  new Request(`https://demo.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const del = (path: string) => new Request(`https://demo.invalid${path}`, { method: 'DELETE' });
const get = (path: string) => new Request(`https://demo.invalid${path}`);

describe('the demo server', () => {
  let server: DemoServer;

  const state = async (): Promise<Payload> => {
    const response = await server.handle(get('/api/state'));
    expect(response.status).toBe(200);
    return (await response.json()) as Payload;
  };

  const login = (password = '') => server.handle(post('/api/session/master', { password }));

  /**
   * Shoelace over the outer rings, in square degrees. Only ever compared with
   * itself, so the projection does not matter — closing a quarter of the ground
   * has to make this smaller, and the vertex count does not: an L has more
   * corners than the square it was cut from.
   */
  const areaOf = (area: Payload['playArea']): number =>
    area.reduce((total, polygon) => {
      const ring = polygon.coordinates[0] ?? [];
      let sum = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        sum += (ring[j]![0]! + ring[i]![0]!) * (ring[j]![1]! - ring[i]![1]!);
      }
      return total + Math.abs(sum / 2);
    }, 0);

  const redeemFirstInvite = async (): Promise<string> => {
    const body = (await (await server.handle(get('/api/master/invites'))).json()) as {
      invites: Array<{ path: string; playerId: string }>;
    };
    const first = body.invites[0]!;
    expect((await server.handle(get(first.path))).status).toBe(303);
    return first.playerId;
  };

  beforeEach(() => {
    // No walk timer: the suite steps the clock itself, and a background interval
    // would make one assertion depend on how long the one before it took.
    server = new DemoServer(PROFILES, { walk: false });
    server.world.session = null;
  });

  /* -- 1. the login ------------------------------------------------ */

  /**
   * **401 before, 200 after, and the 401 is the load-bearing half.** `auth` goes
   * `unknown → anonymous → session` in `game.svelte.ts`, and it is the refusal
   * from `/api/state` that makes `App.svelte` render `Login` at all. A demo that
   * answered 200 to an anonymous read would never show its own login screen.
   */
  it('refuses a read with no session, which is what puts the login on screen', async () => {
    expect((await server.handle(get('/api/state'))).status).toBe(401);
  });

  it('accepts any password, including none', async () => {
    for (const password of ['', 'cualquier cosa', '🙂']) {
      server.world.session = null;
      expect((await login(password)).status).toBe(200);
      expect((await server.handle(get('/api/state'))).status).toBe(200);
    }
  });

  it('logs out back to the login screen', async () => {
    await login();
    expect((await server.handle(post('/api/session/logout'))).status).toBe(204);
    expect((await server.handle(get('/api/state'))).status).toBe(401);
  });

  /**
   * Which view a visitor gets is decided by the projection and not by a route: a
   * payload with `viewMode` came from a master recipient. The demo enters as a
   * master because that is the view the five controls are on.
   */
  it('projects the master view, with the panel state a master needs', async () => {
    await login();
    const payload = await state();
    expect(payload.viewMode).toBe('OPERATIONAL');
    expect(payload.self).toBeUndefined();
    expect(payload.districts).toHaveLength(1);
    expect(payload.sectors).toHaveLength(2);
    expect(payload.players).toHaveLength(6);
    expect(payload.teams.map((team) => team.name).sort()).toEqual(['ALFA', 'BRAVO']);
  });

  it('seeds six players inside the perimeter, in two teams', async () => {
    await login();
    const payload = await state();
    for (const player of payload.players) {
      expect(player.position, `${player.callsign} has no position`).toBeDefined();
      expect(player.position!.zoneId, `${player.callsign} is in no zone`).toBeDefined();
    }
    // The names are the callsigns: this is a public tree and there is nobody to name.
    for (const player of payload.players) expect(player.fullName).toBe(player.callsign);
  });

  /* -- 2. switching the geometry ----------------------------------- */

  /**
   * A fresh game is seeded in `PREPARATION`, which is what makes the switch
   * available on arrival — and starting the game is what takes it away again,
   * in both servers and for the same reason.
   */
  it('seeds in PREPARATION, and refuses the switch once the game is in progress', async () => {
    await login();
    expect((await state()).game.state).toBe('PREPARATION');
    expect((await server.handle(post('/api/master/game/geo', { profile: 'barcelona' }))).status).toBe(
      200,
    );

    await server.handle(post('/api/master/game/state', { state: 'IN_PROGRESS' }));
    expect((await server.handle(post('/api/master/game/geo', { profile: 'madrid' }))).status).toBe(
      409,
    );
  });

  it('switches geometry, basemap and players together', async () => {
    await login();
    const before = await state();
    expect(before.geoProfile).toBe('madrid');
    expect(before.basemap.pmtilesUrl).toBe('/basemap/v3/madrid.pmtiles');

    expect((await server.handle(post('/api/master/game/geo', { profile: 'sevilla' }))).status).toBe(
      200,
    );
    const after = await state();
    expect(after.geoProfile).toBe('sevilla');
    expect(after.basemap.pmtilesUrl).toBe('/basemap/v3/sevilla.pmtiles');
    expect(after.basemap.bbox).not.toEqual(before.basemap.bbox);
    // The players moved with the ground. Left where they were they would be
    // outside every zone, which under §4 is six people nobody can see.
    for (const player of after.players) expect(player.position?.zoneId).toBeDefined();
  });

  it('refuses a profile it does not have', async () => {
    await login();
    expect((await server.handle(post('/api/master/game/geo', { profile: 'nowhere' }))).status).toBe(
      400,
    );
  });

  /**
   * Both lists are ids belonging to the geometry they came from, so both are
   * cleared. Carried across, a name the new profile has never heard of closes
   * nothing — and one it *has* heard of closes ground nobody chose.
   */
  it('clears the hidden points and the closed zones on a profile change', async () => {
    await login();
    const poiId = (await state()).pois[0]!.id;
    await server.handle(post('/api/master/pois/visibility', { poiId, hidden: true }));
    await server.handle(post('/api/master/game/zones', { disabled: ['zone-sur-este'] }));
    expect((await state()).hiddenPois).toEqual([poiId]);

    await server.handle(post('/api/master/game/geo', { profile: 'barcelona' }));
    const after = await state();
    expect(after.hiddenPois).toEqual([]);
    expect(after.disabledZones).toEqual([]);
  });

  /* -- 3. closing ground (R-71) ------------------------------------ */

  /**
   * The master keeps every zone and every point and is told which are closed —
   * the panel's list is the only place a closure can be undone, so a master who
   * stopped seeing it would have nothing to press. What actually shrinks on the
   * master's screen is `playArea`, which is what the map draws.
   */
  it('closes a zone: the play area shrinks, the master keeps the list', async () => {
    await login();
    const before = await state();
    const zone = before.zones.find((candidate) => candidate.id === 'zone-sur-este')!;
    expect(zone).toBeDefined();
    const areaBefore = areaOf(before.playArea);

    expect(
      (await server.handle(post('/api/master/game/zones', { disabled: [zone.id] }))).status,
    ).toBe(200);

    const after = await state();
    expect(after.disabledZones).toEqual([zone.id]);
    expect(after.zones.map((z) => z.id)).toEqual(before.zones.map((z) => z.id));
    expect(after.playArea).toHaveLength(1);
    // A quarter of the ground, to a few per cent of rounding.
    expect(areaOf(after.playArea)).toBeCloseTo(areaBefore * 0.75, 8);
    // The perimeter does **not** move with the switch: it is what the archive
    // was cut to, and a download the phones cannot redo at the venue.
    expect(after.perimeter).toEqual(before.perimeter);
  });

  /**
   * And the other half of R-71, on the screen it is for. A player is told what
   * is in play and never what has been taken out of it — so the closed zone and
   * the points standing on it are simply absent, which is the thing the demo
   * exists to let somebody see happen.
   */
  it('takes the closed ground and its points off a player map', async () => {
    await login();
    await server.handle(post('/api/master/game/zones', { disabled: ['zone-sur-este'] }));
    const master = await state();
    const onClosedGround = master.pois
      .filter((poi) => poi.zone === 'zone-sur-este')
      .map((poi) => poi.id);
    expect(onClosedGround.length).toBeGreaterThan(0);

    await redeemFirstInvite();
    const player = await state();
    expect(player.zones.map((zone) => zone.id)).not.toContain('zone-sur-este');
    for (const poi of player.pois) expect(onClosedGround).not.toContain(poi.id);
  });

  it('closes a whole sector as one call with a longer list', async () => {
    await login();
    const sector = (await state()).sectors.find((candidate) => candidate.id === 's-sur')!;
    expect(sector.zoneIds).toHaveLength(2);
    await server.handle(post('/api/master/game/zones', { disabled: sector.zoneIds }));
    expect((await state()).disabledZones?.slice().sort()).toEqual(sector.zoneIds.slice().sort());

    // The server never learns what a sector is: closing one is this call with a
    // longer list, which is why the same code answers both.
    await redeemFirstInvite();
    expect((await state()).zones.map((zone) => zone.id)).toEqual([
      'zone-norte-oeste',
      'zone-norte-este',
    ]);
  });

  it('is idempotent, so a double press cannot half-apply', async () => {
    await login();
    const first = await server.handle(post('/api/master/game/zones', { disabled: ['zone-sur-este'] }));
    const events = ((await state()).events ?? []).filter((e) => e.kind === 'GEOMETRY_TOGGLED');
    await server.handle(post('/api/master/game/zones', { disabled: ['zone-sur-este'] }));
    expect(first.status).toBe(200);
    expect(((await state()).events ?? []).filter((e) => e.kind === 'GEOMETRY_TOGGLED')).toHaveLength(
      events.length,
    );
  });

  it('refuses a zone it does not know rather than closing nothing quietly', async () => {
    await login();
    expect(
      (await server.handle(post('/api/master/game/zones', { disabled: ['zone-nowhere'] }))).status,
    ).toBe(404);
  });

  /* -- 4. hiding a point (R-61) ------------------------------------ */

  it('hides a point from every map and keeps it on the master list', async () => {
    await login();
    const poiId = (await state()).pois[0]!.id;
    expect(
      (await server.handle(post('/api/master/pois/visibility', { poiId, hidden: true }))).status,
    ).toBe(200);

    const after = await state();
    expect(after.hiddenPois).toEqual([poiId]);
    // The master keeps seeing it, because the panel's list is the only place a
    // hidden point can be found again and turned back on.
    expect(after.pois.map((poi) => poi.id)).toContain(poiId);

    await server.handle(post('/api/master/pois/visibility', { poiId, hidden: false }));
    expect((await state()).hiddenPois).toEqual([]);
  });

  it('refuses a point that is not in the geometry', async () => {
    await login();
    expect(
      (await server.handle(post('/api/master/pois/visibility', { poiId: 'poi-nope', hidden: true })))
        .status,
    ).toBe(404);
  });

  /* -- 5. markers (R-19, R-20b, R-21c) ----------------------------- */

  const somewhereInside = async () => {
    const payload = await state();
    const ring = payload.perimeter.coordinates[0]!;
    const lons = ring.map(([lon]) => lon!);
    const lats = ring.map(([, lat]) => lat!);
    return {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lon: (Math.min(...lons) + Math.max(...lons)) / 2,
    };
  };

  it('places a marker and clears it again', async () => {
    await login();
    const at = await somewhereInside();
    const placed = await server.handle(
      post('/api/master/marker', { label: 'PUNTO', ...at, audience: { kind: 'all' } }),
    );
    expect(placed.status).toBe(200);
    const { marker } = (await placed.json()) as { marker: { id: string } };
    expect((await state()).markers.map((m) => m.id)).toEqual([marker.id]);

    expect((await server.handle(del(`/api/master/marker/${marker.id}`))).status).toBe(200);
    expect((await state()).markers).toEqual([]);
  });

  it('refuses a sixth marker rather than pushing one off somebody map (R-20b)', async () => {
    await login();
    const at = await somewhereInside();
    for (let i = 0; i < 5; i += 1) {
      const response = await server.handle(
        post('/api/master/marker', { label: `M${i}`, ...at, audience: { kind: 'all' } }),
      );
      expect(response.status, `marker ${i}`).toBe(200);
    }
    const sixth = await server.handle(
      post('/api/master/marker', { label: 'M5', ...at, audience: { kind: 'all' } }),
    );
    expect(sixth.status).toBe(409);
    expect((await sixth.json()) as { error: { reason: string } }).toMatchObject({
      error: { reason: 'MARKER_LIMIT' },
    });
  });

  it('refuses a marker outside the ingest area', async () => {
    await login();
    const response = await server.handle(
      post('/api/master/marker', { label: 'FUERA', lat: 0, lon: 0, audience: { kind: 'all' } }),
    );
    expect(response.status).toBe(400);
  });

  it('clears every marker at once', async () => {
    await login();
    const at = await somewhereInside();
    await server.handle(post('/api/master/marker', { label: 'A', ...at, audience: { kind: 'all' } }));
    await server.handle(post('/api/master/marker', { label: 'B', ...at, audience: { kind: 'all' } }));
    expect((await server.handle(del('/api/master/marker'))).status).toBe(200);
    expect((await state()).markers).toEqual([]);
  });

  /* -- the player's own view --------------------------------------- */

  /**
   * The invite link is the one place the demo bends a requirement on purpose:
   * it authenticates nobody, it switches *this* browser to that player's view.
   * That is the useful half of R-07's link with no phone to hand it to, and it
   * is what makes §4 visible — a player's payload is a different payload.
   */
  it('redeems an invite into that player own view', async () => {
    await login();
    const playerId = await redeemFirstInvite();

    const payload = await state();
    expect(payload.self?.id).toBe(playerId);
    expect(payload.viewMode).toBeUndefined();
    // A player is told what they can see and never what is withheld from them.
    expect(payload.hiddenPois).toBeUndefined();
    expect(payload.disabledZones).toBeUndefined();
    expect(payload.events).toBeUndefined();
  });

  /**
   * **`INVITE_PATH` is the contract between the panel and `install.ts`,** and it
   * is checked against the paths the panel actually prints rather than against a
   * string written here — a pattern tested on its own examples agrees with
   * itself and with nothing else.
   *
   * It matters because on a static host the link arrives as a *navigation*: the
   * shell comes back as `404.html` and the patched `fetch` never sees it, so the
   * shim matches on this to know it has an invite in the address bar at all. A
   * pattern that stopped covering what the panel hands out would leave the link
   * loading the master's own view, which is the one outcome §4 cannot have.
   *
   * What this cannot reach is the boot itself: `install.ts` patches browser
   * globals, and the suite has no browser. That half is looked at through
   * `pnpm build` and a static server, per CLAUDE.md.
   */
  it('matches every invite path the panel prints, and nothing adjacent', async () => {
    await login();
    const body = (await (await server.handle(get('/api/master/invites'))).json()) as {
      invites: Array<{ path: string }>;
    };

    expect(body.invites.length).toBeGreaterThan(0);
    for (const invite of body.invites) expect(INVITE_PATH.test(invite.path)).toBe(true);

    // The shell is served under every unknown path, so the shim is offered the
    // whole site. A token is one segment and never empty.
    for (const path of ['/', '/j', '/j/', '/january', '/j/a/b', '/api/state']) {
      expect(INVITE_PATH.test(path)).toBe(false);
    }
  });

  /* -- what is absent, and says so --------------------------------- */

  /**
   * The three answers that are `501` rather than faked, because a browser is not
   * a server. Pinned so that a later change cannot quietly start pretending.
   */
  it('answers 501 to the things that genuinely need a server', async () => {
    await login();
    expect((await server.handle(get('/i/secret/?id=x&lat=0&lon=0'))).status).toBe(501);
    expect((await server.handle(post('/api/master/game/basemap', { pmtilesUrl: 'x' }))).status).toBe(
      501,
    );
    expect((await server.handle(post('/api/master/devices/pair', { deviceId: 'a' }))).status).toBe(
      501,
    );
  });

  /**
   * The replay control is master-`AUTHORITATIVE` only (R-57), and the payload is
   * what says so — the panel has no demo branch to read. So the demo either
   * replays for real or does not offer it, and here it replays for real: the
   * walk records through `sampleOf()` as it goes.
   */
  it('offers the replay only in AUTHORITATIVE, and then has a window to answer with', async () => {
    await login();
    expect((await state()).replayAvailable).toBe(false);
    expect((await server.handle(get('/api/track?from=1&to=2'))).status).toBe(403);

    await server.handle(post('/api/master/view', { mode: 'AUTHORITATIVE' }));
    expect((await state()).replayAvailable).toBe(true);

    // Three ticks of the walk, which is what a replay has to have something of.
    for (let i = 0; i < 3; i += 1) server.world.tick();
    const now = Date.now();
    const window = await server.handle(get(`/api/track?from=${now - 600_000}&to=${now + 1_000}`));
    expect(window.status).toBe(200);
    const body = (await window.json()) as { samples: unknown[] };
    expect(body.samples.length).toBeGreaterThan(0);
  });

  /* -- the walk ---------------------------------------------------- */

  it('walks the players without letting them leave the perimeter', async () => {
    await login();
    for (let i = 0; i < 20; i += 1) server.world.tick();
    const payload = await state();
    for (const player of payload.players) {
      expect(player.position?.zoneId, `${player.callsign} walked out of every zone`).toBeDefined();
    }
  });

  it('stops walking a player who has been eliminated (R-22)', async () => {
    await login();
    // Declaring is refused outside a game in progress or paused (R-30), which
    // the player's own button hides for as well.
    await server.handle(post('/api/master/game/state', { state: 'IN_PROGRESS' }));
    const playerId = server.world.players[0]!.id;
    expect(server.world.eliminate(playerId, Date.now())).toBe(true);
    const at = { ...server.world.players.find((p) => p.id === playerId)!.position! };
    for (let i = 0; i < 5; i += 1) server.world.tick();
    const after = server.world.players.find((p) => p.id === playerId)!.position!;
    expect(after.lat).toBe(at.lat);
    expect(after.lon).toBe(at.lon);
  });
});
