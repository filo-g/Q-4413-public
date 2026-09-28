import {
  addPlayer,
  addTeam,
  geoJsonFromPayload,
  isMasterAction,
  masterRecipient,
  movePlayer,
  project,
  removePlayer,
  removeTeam,
  renameTeam,
  replayAllowed,
  REPLAY_DEFAULT_WINDOW_MS,
  type Recipient,
} from '@q4413/core';
import type { CommsReach, GameState, Payload, ViewMode } from '@q4413/shared';

import { DemoWorld, type GeoProfiles, type Session } from './world.ts';

/**
 * The Durable Object's HTTP surface (§5), re-answered in the page.
 *
 * **Nothing leaves here without passing through `project()`** — the same rule
 * the Worker holds itself to, and the reason this is a demo of the app rather
 * than a second app: §4 is one pure function in `packages/core`, and both
 * callers hand it the same `World`.
 *
 * ## What is absent, and why it is absent rather than faked
 *
 * A demo that shows a button which does not do what it says is worse than one
 * that does not show it. Three things need a server and are answered `501`:
 *
 * - **Ingest** (`/i/<secret>`, R-01..R-04). There are no phones. The players
 *   here walk because this file walks them; nothing is being tracked.
 * - **The invite link as an invitation.** `/j/<token>` switches *this* browser
 *   to that player's view rather than authenticating a phone — which is the
 *   useful half, and is why the panel's links are left in. On a static host it
 *   arrives as a navigation rather than as a `fetch`, so `install.ts` redeems
 *   it on boot; see `INVITE_PATH` below.
 * - **`POST /api/master/game/basemap`.** The archives ship with the bundle and
 *   there is no object storage to point at.
 *
 * Everything else is here, including the replay (R-53..R-57): the walk records
 * through `sampleOf()` as it goes, so `/api/track` has a real window to answer
 * with and the scrubber replays what actually happened.
 */

const MASTER_SESSION_ID = 'demo-master';

/**
 * The invite path, exported because **two** things have to recognise it and
 * only one of them is the router.
 *
 * A static host has no redirect to give, so `/j/<token>` reaches the browser as
 * a *navigation*: the shell comes back as `404.html` and the patched `fetch`
 * never sees the path that brought it here. `install.ts` matches on this and
 * makes the request itself. Two copies of the pattern would be two answers to
 * what a link the panel printed actually is.
 */
export const INVITE_PATH = /^\/j\/([A-Za-z0-9_-]+)$/;

export class DemoServer {
  readonly world: DemoWorld;

  constructor(profiles: GeoProfiles, options: { walk?: boolean } = {}) {
    this.world = new DemoWorld(profiles);
    // The suite drives `tick()` by hand; a timer there would make every
    // assertion depend on how long the assertion before it took.
    if (options.walk !== false) this.world.start();
  }

  /* -- sessions ---------------------------------------------------- */

  /**
   * The projection this session is entitled to, or `null` for no session.
   *
   * A player whose record has been removed has no session whatever is stored,
   * which is the Worker's rule and matters here for the same reason: the panel
   * can remove a player while that player's view is open in another tab.
   */
  #recipient(session: Session): Recipient | null {
    if (session.kind === 'MASTER') {
      return masterRecipient(this.world.viewModes[session.sessionId], this.world.game, Date.now());
    }
    if (!this.world.players.some((player) => player.id === session.playerId)) return null;
    return { kind: 'PLAYER', playerId: session.playerId };
  }

  payloadFor(session: Session, now = Date.now()): Payload | null {
    const recipient = this.#recipient(session);
    if (!recipient) return null;
    return project(this.world.world(), recipient, now);
  }

  /* -- the router -------------------------------------------------- */

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const now = Date.now();

    this.world.revertLapsedViewModes(now);

    // Ingest, and the one honest 501 that is about the world rather than the
    // code: a browser is not six phones.
    if (path.startsWith('/i/')) return unimplemented('ingest needs a device posting to a server');

    const invite = INVITE_PATH.exec(path);
    if (invite) return this.#redeemInvite(invite[1]!);

    if (request.method === 'POST' && path === '/api/session/master') {
      return this.#login();
    }
    if (request.method === 'POST' && path === '/api/session/logout') {
      this.world.session = null;
      this.world.commit();
      return new Response(null, { status: 204 });
    }

    const session = this.world.session;
    if (!session) return unauthorised();

    if (session.kind === 'MASTER' && isMasterAction(request.method, path)) {
      const stored = this.world.viewModes[session.sessionId];
      if (stored) stored.lastActionAt = now;
    }

    if (path === '/api/state') {
      const payload = this.payloadFor(session, now);
      if (!payload) return unauthorised();
      return json(payload);
    }

    if (path === '/api/geo') {
      const payload = this.payloadFor(session, now);
      if (!payload) return unauthorised();
      return new Response(JSON.stringify(geoJsonFromPayload(payload)), {
        headers: { 'content-type': 'application/geo+json; charset=utf-8' },
      });
    }

    // Before the master gate: R-14 gives players and masters the same right.
    if (request.method === 'POST' && path === '/api/radio-contact') {
      const body = await readJson<{ playerId?: string }>(request);
      const reportedBy = session.kind === 'MASTER' ? 'MASTER' : session.playerId;
      if (!body?.playerId || !this.world.radioContact(body.playerId, reportedBy, now)) {
        return new Response('unknown player', { status: 404 });
      }
      this.world.commit();
      return json({ ok: true });
    }

    if (request.method === 'POST' && path === '/api/me/eliminated') {
      if (session.kind !== 'PLAYER') return new Response('players only', { status: 403 });
      if (!this.world.eliminate(session.playerId, now)) {
        return json({ ok: true });
      }
      this.world.commit();
      return json({ ok: true });
    }

    if (session.kind !== 'MASTER') return new Response('forbidden', { status: 403 });

    if (request.method === 'GET' && path === '/api/track') return this.#track(url, session, now);

    if (request.method === 'GET' && path === '/api/master/invites') {
      return json({
        invites: this.world.players.map((player) => ({
          playerId: player.id,
          callsign: player.callsign,
          fullName: player.fullName,
          path: `/j/${player.sessionToken}`,
        })),
      });
    }

    if (path === '/api/master/marker') {
      if (request.method === 'POST') return this.#placeMarker(request, now);
      if (request.method === 'DELETE') return this.#clearMarkers(undefined, now);
    }
    const markerId = /^\/api\/master\/marker\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
    if (markerId !== undefined && request.method === 'DELETE') {
      return this.#clearMarkers(markerId, now);
    }

    const revive = /^\/api\/master\/players\/([A-Za-z0-9_-]+)\/revive$/.exec(path)?.[1];
    if (revive !== undefined && request.method === 'POST') {
      if (!this.world.revive(revive, now)) return new Response('unknown player', { status: 404 });
      this.world.commit();
      return json({ ok: true });
    }

    if (request.method === 'POST') {
      switch (path) {
        case '/api/master/view':
          return this.#setViewMode(request, session, now);
        case '/api/master/comms':
          return this.#setComms(request);
        case '/api/master/game/state':
          return this.#setState(request);
        case '/api/master/game/geo':
          return this.#setGeo(request);
        case '/api/master/game/zones':
          return this.#setZones(request);
        case '/api/master/pois/visibility':
          return this.#setPoiVisibility(request);
        case '/api/master/game/reset':
          return this.#reset(request);
        case '/api/master/players/add':
          return this.#roster(request, (body) =>
            this.world.applyRoster(
              addPlayer(
                this.world.roster(),
                {
                  callsign: String(body.callsign ?? ''),
                  fullName: String(body.fullName ?? ''),
                  ...(body.teamId === undefined ? {} : { teamId: String(body.teamId) }),
                },
                `demo-${Math.random().toString(36).slice(2, 10)}`,
              ),
            ),
          );
        case '/api/master/players/remove':
          return this.#roster(request, (body) =>
            this.world.applyRoster(removePlayer(this.world.roster(), String(body.playerId ?? ''))),
          );
        case '/api/master/players/team':
          return this.#roster(request, (body) =>
            this.world.applyRoster(
              movePlayer(this.world.roster(), String(body.playerId ?? ''), String(body.teamId ?? '')),
            ),
          );
        case '/api/master/teams/add':
          return this.#roster(request, (body) =>
            this.world.applyRoster(addTeam(this.world.roster(), { name: String(body.name ?? '') })),
          );
        case '/api/master/teams/rename':
          return this.#roster(request, (body) =>
            this.world.applyRoster(
              renameTeam(this.world.roster(), String(body.teamId ?? ''), {
                name: String(body.name ?? ''),
              }),
            ),
          );
        case '/api/master/teams/remove':
          return this.#roster(request, (body) =>
            this.world.applyRoster(removeTeam(this.world.roster(), String(body.teamId ?? ''))),
          );
        case '/api/master/game/cut':
          return this.#setCut(request);
        case '/api/master/game/basemap':
          return unimplemented('the archives ship with the bundle; there is nothing to point at');
        case '/api/master/game/track':
          return unimplemented('the demo keeps one hour and trims itself');
        case '/api/master/devices/pair':
          return unimplemented('nothing ingests here, so the tray is always empty');
        default:
          break;
      }
    }

    return new Response('not found', { status: 404 });
  }

  /* -- handlers ---------------------------------------------------- */

  /**
   * **Any password, including none.** There is no secret to check against — the
   * bundle is public and a password in it would be theatre — so this accepts
   * whatever is typed and says so on the login screen.
   *
   * What is deliberately unchanged is everything around it: `Login.svelte`, its
   * boot sequence, and M2b's throttle are the app's, and a demo that shortcut
   * them would be demonstrating a different login.
   */
  #login(): Response {
    this.world.session = { kind: 'MASTER', sessionId: MASTER_SESSION_ID };
    this.world.viewModes[MASTER_SESSION_ID] ??= { mode: 'OPERATIONAL' };
    this.world.commit();
    return json({ ok: true });
  }

  #redeemInvite(token: string): Response {
    const player = this.world.players.find((candidate) => candidate.sessionToken === token);
    if (!player) return new Response('not found', { status: 404 });
    this.world.session = { kind: 'PLAYER', playerId: player.id };
    this.world.commit();
    // 303 to the app root, as the Worker does: the token must not stay in the
    // address bar of the page that gets installed to a home screen.
    return new Response(null, { status: 303, headers: { location: '/' } });
  }

  async #setViewMode(request: Request, session: Session, now: number): Promise<Response> {
    const body = await readJson<{ mode?: ViewMode }>(request);
    if (body?.mode !== 'OPERATIONAL' && body?.mode !== 'AUTHORITATIVE') {
      return new Response('mode required', { status: 400 });
    }
    if (session.kind !== 'MASTER') return new Response('forbidden', { status: 403 });
    this.world.viewModes[session.sessionId] = { mode: body.mode, lastActionAt: now };
    if (body.mode === 'AUTHORITATIVE') {
      this.world.log({
        ts: now,
        kind: 'AUTHORITATIVE_OPENED',
        actor: session.sessionId,
        visibility: 'MASTER_AUTHORITATIVE',
      });
    }
    this.world.commit();
    return json({ ok: true, mode: body.mode });
  }

  async #setComms(request: Request): Promise<Response> {
    const body = await readJson<{ reach?: CommsReach }>(request);
    if (body?.reach !== 3 && body?.reach !== 4 && body?.reach !== 5) {
      return new Response('reach must be 3, 4 or 5', { status: 400 });
    }
    this.world.game.commsReach = body.reach;
    this.world.log({
      ts: Date.now(),
      kind: 'EXTENDED_COMMS',
      data: { reach: body.reach },
      visibility: 'MASTER',
    });
    this.world.commit();
    return json({ ok: true, reach: body.reach });
  }

  async #setState(request: Request): Promise<Response> {
    const body = await readJson<{ state?: GameState }>(request);
    const states: GameState[] = ['PREPARATION', 'IN_PROGRESS', 'PAUSED', 'FINISHED'];
    if (!body?.state || !states.includes(body.state)) {
      return new Response('unknown state', { status: 400 });
    }
    this.world.setGameState(body.state);
    this.world.commit();
    return json({ ok: true, state: body.state });
  }

  async #setGeo(request: Request): Promise<Response> {
    const body = await readJson<{ profile?: string }>(request);
    const profile = this.world.profileNames.find((name) => name === body?.profile);
    if (!profile) {
      return new Response(`profile must be one of ${this.world.profileNames.join(', ')}`, {
        status: 400,
      });
    }
    // The same refusal as the Worker's, for the same reason: zones decide who
    // sees whom, and moving them under players rewrites that silently.
    if (this.world.game.state === 'IN_PROGRESS') {
      return new Response('cannot change geometry while the game is in progress', { status: 409 });
    }
    this.world.setGeoProfile(profile);
    this.world.commit();
    return json({ ok: true, profile });
  }

  async #setZones(request: Request): Promise<Response> {
    const body = await readJson<{ disabled?: unknown }>(request);
    if (!Array.isArray(body?.disabled) || body.disabled.some((id) => typeof id !== 'string')) {
      return new Response('disabled must be an array of zone ids', { status: 400 });
    }
    const known = new Set(this.world.game.geo.zones.map((zone) => zone.id));
    const wanted = [...new Set(body.disabled as string[])];
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return new Response(`unknown zone: ${unknown.join(', ')}`, { status: 404 });
    }
    this.world.setDisabledZones(wanted);
    this.world.commit();
    return json({ ok: true, disabledZones: this.world.disabledZones });
  }

  async #setPoiVisibility(request: Request): Promise<Response> {
    const body = await readJson<{ poiId?: string; hidden?: boolean }>(request);
    if (typeof body?.poiId !== 'string' || typeof body.hidden !== 'boolean') {
      return new Response('poiId and hidden required', { status: 400 });
    }
    if (!this.world.game.geo.pois.some((poi) => poi.id === body.poiId)) {
      return new Response('unknown point', { status: 404 });
    }
    this.world.setPoiVisibility(body.poiId, body.hidden);
    this.world.commit();
    return json({ ok: true, hiddenPois: this.world.hiddenPois });
  }

  async #setCut(request: Request): Promise<Response> {
    const body = await readJson<{ on?: boolean }>(request);
    if (typeof body?.on !== 'boolean') return new Response('on required', { status: 400 });
    this.world.game.cutSwitch = body.on;
    delete this.world.game.cutByFinish;
    this.world.log({
      ts: Date.now(),
      kind: 'CUT_SWITCH',
      data: { on: body.on },
      visibility: 'MASTER',
    });
    this.world.commit();
    return json({ ok: true, cutSwitch: body.on });
  }

  async #placeMarker(request: Request, now: number): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    const result = this.world.place(
      {
        label: body?.label as string | undefined,
        lat: body?.lat as number | undefined,
        lon: body?.lon as number | undefined,
        audience: body?.audience as never,
        ttlMs: body?.ttlMs as number | null | undefined,
      },
      `marker-${Math.random().toString(36).slice(2, 10)}`,
      now,
    );
    if (!result.ok) {
      const status = result.error.reason === 'MARKER_LIMIT' ? 409 : 400;
      return json({ ok: false, error: result.error }, status);
    }
    this.world.commit();
    return json({ ok: true, marker: result.value, live: this.world.markers.length });
  }

  #clearMarkers(id: string | undefined, now: number): Response {
    const removed = this.world.clearMarkers(id, now);
    if (removed === null) return new Response('unknown marker', { status: 404 });
    this.world.commit();
    return json({ ok: true, cleared: removed.map((marker) => marker.id) });
  }

  async #roster(
    request: Request,
    run: (body: Record<string, unknown>) => { ok: boolean; error?: unknown; value?: unknown },
  ): Promise<Response> {
    // The same refusal as the Worker's (R-07): the roster is set up before
    // anyone leaves, and a stray tap mid-game must not take somebody's link.
    if (this.world.game.state === 'IN_PROGRESS') {
      return new Response('in progress', { status: 409 });
    }
    const body = (await readJson<Record<string, unknown>>(request)) ?? {};
    const result = run(body);
    if (!result.ok) return json({ ok: false, error: result.error }, 400);
    this.world.log({
      ts: Date.now(),
      kind: 'ROSTER',
      visibility: 'MASTER',
    });
    this.world.commit();
    const player = (result.value as { player?: { sessionToken?: string } } | undefined)?.player;
    return json({
      ok: true,
      ...(player?.sessionToken === undefined ? {} : { path: `/j/${player.sessionToken}` }),
    });
  }

  async #reset(request: Request): Promise<Response> {
    const body = await readJson<{ confirm?: string }>(request);
    if (body?.confirm !== this.world.game.name) {
      return new Response('confirm must be the game name', { status: 400 });
    }
    this.world.reset();
    this.world.session = { kind: 'MASTER', sessionId: MASTER_SESSION_ID };
    this.world.viewModes[MASTER_SESSION_ID] = { mode: 'OPERATIONAL' };
    this.world.commit();
    return json({ ok: true, archive: null });
  }

  /**
   * R-53..R-57 over the in-memory track.
   *
   * **A read, so it does not stop R-25's clock** — the same decision the Worker
   * makes and for the same reason: counting it would let the panel hold
   * `AUTHORITATIVE` open by scrubbing.
   */
  #track(url: URL, session: Session, now: number): Response {
    const recipient = this.#recipient(session);
    if (
      !recipient ||
      recipient.kind !== 'MASTER' ||
      !replayAllowed(recipient.viewMode, this.world.game.state)
    ) {
      return new Response('replay requires AUTHORITATIVE', { status: 403 });
    }
    const to = Number(url.searchParams.get('to')) || now;
    const from = Number(url.searchParams.get('from')) || to - REPLAY_DEFAULT_WINDOW_MS;
    if (!(from < to)) return new Response('from must be before to', { status: 400 });

    const samples = this.world.track.filter((row) => row.ts >= from && row.ts <= to);
    const events = this.world.events.filter((row) => row.ts >= from && row.ts <= to);
    // One GEOMETRY_TOGGLED from before the window, so a cursor can know the
    // geometry exactly (R-71, R-56). See the Worker's #trackWindow.
    if (!events.some((row) => row.kind === 'GEOMETRY_TOGGLED')) {
      const previous = this.world.events
        .filter((row) => row.ts < from && row.kind === 'GEOMETRY_TOGGLED')
        .at(-1);
      if (previous) events.unshift(previous);
    }
    return json({ from, to, samples, events });
  }
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const unauthorised = (): Response => new Response('unauthorised', { status: 401 });

/** 501 and a sentence, rather than a 404 that reads like a routing mistake. */
const unimplemented = (why: string): Response =>
  new Response(`not implemented in the demo: ${why}`, { status: 501 });

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
