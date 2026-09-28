import { DurableObject } from 'cloudflare:workers';
import {
  applyPing,
  applyStatus,
  applyStatusToTrayEntry,
  checkLoginAllowed,
  checkPingAccepted,
  clearLoginFailures,
  constantTimeEquals,
  basemapBbox,
  gameGeoFromGeoJson,
  geoJsonFromPayload,
  activeMarkers,
  ingestOpen,
  playerFeedOpen,
  nextMarkerExpiry,
  placeMarker,
  playerForToken,
  project,
  recordLoginFailure,
  signSession,
  upsertTrayEntry,
  verifySession,
  zoneAt,
  addPlayer,
  addTeam,
  movePlayer,
  playerIdFor,
  teamIdFor,
  removePlayer,
  removeTeam,
  renameTeam,
  reviveEliminated,
  authoritativeLapsed,
  declareEliminated,
  eliminationOpen,
  cutSwitchOnStateChange,
  isMasterAction,
  noteRejection,
  replayAllowed,
  type RejectionState,
  masterRecipient,
  sampleOf,
  REPLAY_DEFAULT_WINDOW_MS,
  TRACK_RETENTION_MS,
  trackTrimRefusal,
  playAreaOf,
  type AttemptRecord,
  type Recipient,
  type Roster,
  type RosterResult,
  type SessionPayload,
  type Signer,
  type ViewModeSession,
  type World,
} from '@q4413/core';
import type {
  Device,
  Game,
  GameEvent,
  GameGeoJson,
  GameState,
  MasterMarker,
  OsmAndStatus,
  Player,
  Polygon,
  Team,
  TrackSample,
  TrayEntry,
  ViewMode,
  WsServerMessage,
} from '@q4413/shared';
import barcelonaGeoJsonText from '@q4413/shared/geo/barcelona.geojson';
import madridGeoJsonText from '@q4413/shared/geo/madrid.geojson';
import sevillaGeoJsonText from '@q4413/shared/geo/sevilla.geojson';

import type { Env } from './index.ts';
import { decodePing } from './ingest.ts';
import {
  clearedCookieHeader,
  hmacSigner,
  inviteTokenFromPath,
  randomToken,
  readSessionCookie,
  sessionCookieHeader,
} from './session.ts';

const GAME_STATES: GameState[] = ['PREPARATION', 'IN_PROGRESS', 'PAUSED', 'FINISHED'];
const VIEW_MODES: ViewMode[] = ['OPERATIONAL', 'AUTHORITATIVE'];
/** The log is for the master's eyes during a game, not an audit archive. */
const MAX_EVENTS = 500;

/**
 * How many samples are written between retention sweeps.
 *
 * A `DELETE ... WHERE ts < ?` on every ping is an index seek for nothing 199
 * times out of 200: six phones at one fix per five seconds put roughly 17
 * minutes between sweeps, against a 48-hour retention. The sweep is
 * opportunistic on purpose — there is no alarm to spare (R-21 owns the only one)
 * and nothing goes wrong if the object is evicted before the next one.
 */
const TRACK_SWEEP_EVERY = 200;

interface SocketIdentity {
  kind: 'PLAYER' | 'MASTER';
  id: string;
}

/**
 * One Durable Object per game. Owns ingest, sessions, position state, projection,
 * the single marker slot and the SQLite track (§6.1).
 *
 * Event-driven, never ticked (§6.3): state is recomputed and broadcast on ping
 * arrival, inside a request already paid for.
 *
 * **Nothing leaves this class without passing through project()** — masters
 * included, since view mode is applied in the projection (§4, hard rule 1). The
 * only exceptions are /api/geo, which is the same configuration the renderer
 * already has, and the ingest acknowledgement, which carries no state.
 */
/**
 * The geometries that ship in the bundle (§11), and the one a fresh game starts
 * with.
 *
 * Three exist so that switching between them is something the panel can be shown
 * doing, and they are deliberately interchangeable: each one is a 1 km square
 * over the centre of a Spanish city, tiled by four zones in two sectors under a
 * single district. **None of them describes a real venue** — the shapes are
 * invented, the names are generic, and the whole point is that a location is a
 * file rather than code (§11). Describe your own ground by adding a `.geojson`
 * beside these and naming it here; see the README.
 *
 * One district rather than two, on purpose. With two districts and two sectors
 * each district would hold one sector, and closing a district would be identical
 * to closing a sector — the grouping R-70 adds would stop being visible in the
 * one geometry that exists to show it. With one, the hierarchy is
 * `district(1) → sectors(2) → zones(4)` and closing the district is a press that
 * closes both sectors.
 *
 * **Switching profiles is what loads a changed file.** The geometry is seeded
 * into storage, not read from the bundle per request, so editing a .geojson and
 * deploying changes nothing for a game that already exists — POST the profile
 * again to pick it up, or bump GEO_VERSION below.
 */
const GEO_PROFILES = {
  madrid: madridGeoJsonText,
  barcelona: barcelonaGeoJsonText,
  sevilla: sevillaGeoJsonText,
} as const;

export type GeoProfile = keyof typeof GEO_PROFILES;

const GEO_PROFILE_NAMES = Object.keys(GEO_PROFILES) as GeoProfile[];
const DEFAULT_GEO_PROFILE: GeoProfile = 'madrid';

/**
 * The path prefix the archives are installed under, and the one thing here that
 * has to be bumped by hand.
 *
 * R-52 caches by version path and never revalidates, so a new extract must land
 * at a new path or every phone that already cached the old one stays on it with
 * no way to notice. A constant rather than configuration because under R-52b
 * the archive ships **inside the bundle**: a new extract is a new file, a new
 * commit and a deploy, so the version and the bytes move together or not at all.
 */
const BASEMAP_VERSION = 'v3';
// v2 (M9): the box the archive covers stopped being the ingest area's square
// bounds and became `basemapBbox()`, wide enough to frame the play area in 16:9
// and 9:16. The bytes at a given path are immutable by contract — R-52's cache
// never revalidates — so re-cutting v1 in place would have left every phone
// that already held it on the old, too-small archive with no way to notice.
// v3: three new archives, one per profile, cut against the geometry below. The
// old paths are gone with the geometry they framed, which is the case this
// constant exists for: a game seeded on v2 would keep asking for a file the
// deploy removed, and under an SPA fallback that 404 comes back as index.html
// with a 200 — "wrong magic number for pmtiles archive", a message about bytes
// for a problem about deployment. #load() lifts it.

/**
 * The bundled geometry's revision, so a fix to a `.geojson` reaches a game that
 * was seeded before it.
 *
 * A game is seeded once, and `game.geo` is written from the bundle at that
 * moment and never again — which is correct on the axis that matters and wrong
 * on every other one. Zones must not move under players in the middle of a
 * game: R-04's geofence, §4's whole projection and R-43's warning are all
 * decided against them, which is why `POST /api/master/game/geo` refuses while
 * `IN_PROGRESS`. But outside a game it left every deploy a lie — M7 shrank
 * `pruebas` from 27 x 23 km to a 1,73 km square and nothing changed on screen,
 * and the strip of ground in **no zone at all** that §4 makes invisible was
 * fixed in a file the running game was not reading.
 *
 * So the migration below re-derives the geometry when this number moves, and
 * only while the game is not `IN_PROGRESS` — the same condition the endpoint
 * enforces, applied in the same place the other seeded-once migrations live.
 * It is safe to overwrite for the same reason `maxZoom` is: `game.geo` is a
 * pure function of `geoProfile`, and nothing but this constant and that profile
 * can write it.
 *
 * **Bump it when a bundled `.geojson` changes in a way that matters.** Getting
 * that wrong costs a stale geometry until somebody re-applies the profile,
 * which is exactly where this started.
 */
const GEO_VERSION = 6;
// 2 (M9): POIs of category ENTRANCE gained `entranceTo`, the zone they open
// into — see Poi.entranceTo. Without this the field exists in the file, in the
// types and in the card, and is absent from the only copy anybody reads.
// 3 (M12): every ZONE carries its sector and district (R-70), and `game.geo`
// gained `sectors` and `districts` derived from them. A game seeded before this
// has zones with no sector, which is the one shape `zonesOf()` refuses — so
// without the bump the switch has nothing to switch and the panel lists
// nothing, on a geometry that looks perfectly fine on the map.
// 4 (M12): R-71 moved the switch down to the zone, so a POI now carries `zone`
// where it carried `sector`. **This is the case the constant's own docblock is
// about, in its least visible form:** the `.geojson` did not change at all, the
// *derivation* did — and `game.geo` is seeded, so a game already on version 3
// keeps POIs with the old field. Nothing throws. `poi.zone` is simply undefined
// on every one of them, which the filter reads as "belongs to no zone", so
// closing a zone takes its ground and leaves its points standing on it. Found
// against a running object: closing one zone put a hole in the play area and
// left all five of its points standing on it.
// 5 (M12): a single POI removed from one profile, because the place it named no
// longer existed on the ground. The smallest kind of change there is and it
// still needed the bump: a game seeded on that profile would go on offering a
// point nobody can walk to, and the master's list is where a point is found
// again, so an absence there is not visible as one.
// 6: the three bundled profiles replaced wholesale. Every zone id, sector id and
// POI id in storage belongs to geometry that is no longer in the bundle, so a
// game seeded before this would draw rings nothing else knows the names of.

/**
 * How far in a client may zoom, and **not** how deep the archive goes.
 *
 * The two get confused because they look like the same number. The archive
 * stops at z15 — `tools/basemap.sh` says why: the daily Protomaps planet build
 * does, so `--maxzoom 17` is accepted and quietly produces z15 anyway. This is
 * the camera's floor on scale, and MapLibre overzooms vector tiles past a
 * source's maximum, so the two are independent.
 *
 * Raised from 17 because 17 stops at about a city block, and the two things a
 * master does at the far end of the zoom are place a marker on a doorway and
 * tell apart two players standing a few metres apart. At 19 the span across a
 * phone is roughly fifty metres, which is the scale those are decided at.
 *
 * It costs no bytes: the archive is unchanged and vector geometry does not
 * blur, it generalises. Past z15 the roads are drawn with z15's simplification
 * scaled up, so casings look heavy and small buildings are missing — the map
 * gets *coarser*, never fuzzier, and everything this app draws on top of it is
 * at full precision regardless.
 */
const BASEMAP_MAX_ZOOM = 19;

/**
 * Where a profile's archive is, derived rather than stored.
 *
 * `tools/basemap.sh --install` writes exactly here, so switching geometry
 * switches the map under it with nothing to remember. A master can still
 * override it (`POST /api/master/game/basemap`), which is what a location too
 * big for the 25 MiB asset ceiling needs — that one goes to object storage and
 * an absolute URL.
 */
function basemapUrlOf(profile: GeoProfile): string {
  return `/basemap/${BASEMAP_VERSION}/${profile}.pmtiles`;
}

/**
 * Which profiles draw street names (R-69), and why it is a list rather than a
 * rule.
 *
 * §14.3 forbade symbol layers outright, and R-69 narrowed that to an exception
 * for a reason that is about **the place, not the map**: in a town, players
 * coordinate over the radio by street, and a player who cannot read the street
 * they are standing on cannot say where they are. At venue scale the opposite
 * holds — a shopping centre's internal lanes and slip roads mean nothing to
 * anybody standing on them, the names land on top of the zone outlines, and the
 * vocabulary there is the zone name (R-51), which the game already draws.
 *
 * Every profile bundled here is a city centre, so every one of them is in the
 * set. That is the answer for *these three files* and not a rule: add a
 * venue-scale profile and leave it out, which is what the list is for. Derived,
 * so switching geometry switches this with it and there is nothing to remember
 * — the same contract as `basemapUrlOf()` directly above.
 */
const STREET_NAME_PROFILES: ReadonlySet<GeoProfile> = new Set<GeoProfile>([
  'madrid',
  'barcelona',
  'sevilla',
]);

function streetNamesFor(profile: GeoProfile): boolean {
  return STREET_NAME_PROFILES.has(profile);
}

function geoOf(profile: GeoProfile): {
  geo: Game['geo'];
  bbox: [number, number, number, number];
} {
  const geo = gameGeoFromGeoJson(JSON.parse(GEO_PROFILES[profile]) as GameGeoJson);
  // Derived, never written down twice, and derived in `core` so that
  // `tools/basemap.sh` can cut the archive to the same box. It was a literal
  // beside the geometry once — switching profiles left the map framing the other
  // venue — and the ingest area's bounds after that, which was square and could
  // not frame the play area on a 16:9 or 9:16 screen. See basemapBbox().
  return { geo, bbox: basemapBbox(geo) };
}

export class GameDurableObject extends DurableObject<Env> {
  /**
   * `| undefined` rather than optional: under exactOptionalPropertyTypes an
   * optional field may be absent but not explicitly set to undefined, and the
   * reset has to drop this memo or the object would keep serving state that has
   * just been deleted.
   */
  #loaded: Promise<void> | undefined;
  #game!: Game;
  #players!: Player[];
  #teams!: Team[];
  #devices!: Device[];
  #tray!: TrayEntry[];
  #events!: GameEvent[];
  /**
   * Up to five (R-20b). Held as an array rather than a slot, and the storage key
   * changed with it — see #load() for the migration, which matters because a game
   * is seeded once and a deploy does not reseed it.
   */
  #markers: MasterMarker[] = [];
  /**
   * Bumped when a game finishes, which invalidates every **player** cookie at
   * once. Kept outside Game because §3 does not define it.
   */
  #epoch!: number;
  /**
   * The master's own epoch (R-33b), and the reason there are two.
   *
   * One number revoking everything is what makes `FINISHED` cheap — no register
   * of who is logged in, one write. It also revoked the master, so the debrief
   * began by logging in again and confirming R-24, on the one screen R-26 keeps
   * the track for. This one is moved by `POST /api/master/game/reset` and by
   * nothing else; **SALIR clears the cookie in that browser**, which is the right
   * grain for logging out, because bumping an epoch would sign out a second
   * master who is still working.
   *
   * Migrated from `#epoch` on first load, so master cookies issued before this
   * existed keep working across the deploy that introduces it.
   */
  #masterEpoch!: number;
  /**
   * Per master session, defaulting to OPERATIONAL (R-22).
   *
   * The value is a record of what was **asked for**, not what is in force: R-25's
   * revert is derived from `lastActionAt`, so every read goes through
   * `masterRecipient()`. It used to be a bare `ViewMode` — see #load() for the
   * migration, which matters because a game is seeded once and a deploy does not
   * reseed it.
   */
  #viewModes!: Record<string, ViewModeSession>;
  /** Failed master logins by caller address (M2b). Persisted, see #masterLogin. */
  #loginFailures!: Record<string, AttemptRecord>;
  /**
   * Points the master has taken off every player's map (R-61).
   *
   * Its own key rather than a field on `Game`, and outside the geometry
   * entirely: the profile is configuration that a deploy reseeds and every game
   * on it shares, and this is a decision made during one game. A `hidden` flag
   * on a `Poi` would make hiding a point an edit to the venue.
   */
  #hiddenPois!: string[];
  /**
   * Which zones the master has closed (R-71).
   *
   * Its own key, beside `hiddenPois` and for the same reason: the geometry is
   * configuration a deploy reseeds and every game on the profile shares, and
   * this is a decision somebody makes during one game. A flag on the zone would
   * make closing a town an edit to the venue.
   *
   * **Zones and not sectors**, so there is one set rather than three. A sector
   * is closed when every zone of it is and a district when every zone under it
   * is, which means the group controls need nothing here at all — they send a
   * longer list and the server never learns what either word means.
   *
   * Stored as the **closed** set rather than the open one so that a geometry
   * nobody has touched needs no entry, and so that a profile change clearing it
   * means everything open rather than everything shut.
   */
  #disabledZones!: string[];
  /**
   * R-71's boundary, the union of the open zones — cached, never persisted.
   *
   * Derived from two things that are both already durable, so storing it would
   * be a third copy that can go stale. Recomputed at the two moments it can
   * change: a zone switched, and the geometry replaced. Not on every projection,
   * because that is a union over twenty-three rings per recipient per broadcast.
   */
  #playArea!: Polygon[];
  /**
   * Which bundled geometry is live. Kept outside Game because §3 does not define
   * it, and persisted because the geometry itself is persisted — a deploy does not
   * reseed a game, so the profile has to survive alongside what it produced.
   */
  #geoProfile!: GeoProfile;
  #signer?: Signer;

  /** Samples written since the last retention sweep. See TRACK_SWEEP_EVERY. */
  #sinceSweep = 0;

  /**
   * When each caller's last rejection was logged, and how many since (R-04b).
   *
   * **In memory and deliberately not persisted.** This exists to stop a write
   * per rejected ping, so paying a storage write to remember that would undo
   * the whole point. An eviction resets it, which costs one extra line per
   * device afterwards — the cheapest possible way to be wrong.
   */
  #rejections: RejectionState = {};

  /**
   * Every response leaves through here so the request body is always drained.
   *
   * This object is reached by `stub.fetch(request)` from the router, and
   * returning a response while that forwarded request still has an unread body
   * kills the Worker with "Can't read from request stream after response has
   * been sent" — taking the next request on the connection down with a network
   * error. Any unauthenticated `POST /api/...` triggers it, which is a one-line
   * denial of service once this faces the internet rather than a LAN.
   *
   * Draining here rather than at each early return means a handler added later
   * cannot reintroduce it by forgetting.
   */
  override async fetch(request: Request): Promise<Response> {
    const response = await this.#route(request);
    await discardUnreadBody(request);
    return response;
  }

  async #route(request: Request): Promise<Response> {
    await this.#load();
    await this.#revertLapsedViewModes(Date.now());
    const url = new URL(request.url);

    // Ingest carries no session: Traccar Client cannot log in (R-01, R-09).
    if (url.pathname.startsWith('/i/')) return this.#ingest(request);

    const inviteToken = inviteTokenFromPath(url.pathname);
    if (inviteToken !== null) return this.#redeemInvite(inviteToken, url);

    if (request.method === 'POST' && url.pathname === '/api/session/master') {
      return this.#masterLogin(request, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/session/logout') {
      return new Response(null, { status: 204, headers: { 'set-cookie': clearedCookieHeader(url) } });
    }

    const session = await this.#session(request);
    if (!session) return this.#unauthorised();

    // A player who is no longer on the roster has no session, whatever their
    // cookie says. Removal has to revoke access and not merely hide the row: the
    // cookie was signed before they were removed and stays valid on its own terms
    // until the epoch bumps at the end of the game (§6.4), so without this check a
    // removed player keeps a working /api/state and can reopen the socket that
    // #removePlayer just closed. project() would fail closed and hand them map
    // furniture, which is not a leak but is not a removal either.
    if (session.kind === 'PLAYER' && !this.#players.some((p) => p.id === session.playerId)) {
      return this.#unauthorised();
    }

    // R-25's clock, both ends of it, and the order matters: a lapsed session is
    // reverted *before* the action is stamped, so an action arriving after the ten
    // minutes does not resurrect AUTHORITATIVE — the master confirms R-24 again,
    // which is the requirement working rather than a rough edge.
    if (session.kind === 'MASTER' && isMasterAction(request.method, url.pathname)) {
      await this.#noteMasterAction(session.sessionId);
    }

    if (url.pathname === '/ws') return this.#upgrade(request, session);

    if (url.pathname === '/api/geo') {
      // R-60, the third way out. This is the projection in another wrapper, so
      // leaving it open would make the cut a thing you route around.
      if (session.kind === 'PLAYER' && !playerFeedOpen(this.#game.cutSwitch)) {
        return new Response('cut', { status: 503 });
      }
      // Built from the projection, never from the file: game.geojson holds every
      // POI, including the ones scoped to a team or a single player (§4).
      const payload = project(this.#world(), this.#recipient(session), Date.now());
      return new Response(JSON.stringify(geoJsonFromPayload(payload)), {
        headers: { 'content-type': 'application/geo+json; charset=utf-8' },
      });
    }

    if (url.pathname === '/api/state') {
      // R-60. A silent socket is only half of it: a player who reloads goes
      // through here, and answering would hand them a complete, current
      // projection the moment the cut is supposed to have stopped everything.
      if (session.kind === 'PLAYER' && !playerFeedOpen(this.#game.cutSwitch)) {
        return new Response('cut', { status: 503 });
      }
      return this.#json(project(this.#world(), this.#recipient(session), Date.now()));
    }

    // Before the master gate, and deliberately: R-14 gives players and masters the
    // same right to record radio contact, and R-29 makes a player doing it for
    // another player part of how the walkie-driven game works.
    if (request.method === 'POST' && url.pathname === '/api/radio-contact') {
      return this.#recordRadioContact(request, session);
    }

    // Self-declaration is a player's own act (R-30), so it lives on /api/me and
    // before the gate. A master has no record to declare: they are a session, not
    // a row on the roster, and R-32 gives them the reversal instead.
    if (request.method === 'POST' && url.pathname === '/api/me/eliminated') {
      return this.#declareEliminated(session);
    }

    if (session.kind !== 'MASTER') return this.#forbidden();

    if (request.method === 'GET' && url.pathname === '/api/track') {
      return this.#trackWindow(url, session);
    }

    if (request.method === 'GET' && url.pathname === '/api/master/invites') {
      return this.#json({
        invites: this.#players.map((player) => ({
          playerId: player.id,
          callsign: player.callsign,
          fullName: player.fullName,
          path: `/j/${player.sessionToken}`,
        })),
      });
    }

    // Not in the POST switch below because the markers have three verbs (§5):
    // place one, clear one by id, clear all. Clearing is its own instruction
    // rather than a marker with a zero TTL.
    if (url.pathname === '/api/master/marker') {
      if (request.method === 'POST') return this.#placeMarker(request);
      if (request.method === 'DELETE') return this.#clearMarkers();
    }
    const markerId = markerIdFromPath(url.pathname);
    if (markerId !== null && request.method === 'DELETE') {
      return this.#clearMarkers(markerId);
    }

    const revivePlayerId = revivePlayerIdFromPath(url.pathname);
    if (revivePlayerId !== null && request.method === 'POST') {
      return this.#revivePlayer(revivePlayerId);
    }

    if (request.method === 'POST') {
      switch (url.pathname) {
        case '/api/master/devices/pair':
          return this.#pair(request);
        case '/api/master/game/state':
          return this.#setState(request);
        case '/api/master/pois/visibility':
          return this.#setPoiVisibility(request);
        case '/api/master/game/zones':
          return this.#setDisabledZones(request);
        case '/api/master/game/cut':
          return this.#setCut(request);
        case '/api/master/game/geo':
          return this.#setGeoProfile(request);
        case '/api/master/game/basemap':
          return this.#setBasemapUrl(request);
        case '/api/master/game/track':
          return this.#trimTrack(request);
        case '/api/master/game/reset':
          return this.#resetGame(request);
        case '/api/master/players/add':
          return this.#addPlayer(request);
        case '/api/master/players/remove':
          return this.#removePlayer(request);
        case '/api/master/players/team':
          return this.#movePlayer(request);
        case '/api/master/teams/add':
          return this.#addTeam(request);
        case '/api/master/teams/rename':
          return this.#renameTeam(request);
        case '/api/master/teams/remove':
          return this.#removeTeam(request);
        case '/api/master/view':
          return this.#setViewMode(request, session);
        case '/api/master/comms':
          return this.#setCommsReach(request);
        default:
          break;
      }
    }

    return new Response('not found', { status: 404 });
  }

  /* ---------------------------------------------------------------- */
  /* Sessions (§6.4)                                                  */
  /* ---------------------------------------------------------------- */

  #hmac(): Signer {
    this.#signer ??= hmacSigner(this.env.SESSION_SECRET ?? '');
    return this.#signer;
  }

  async #session(request: Request): Promise<SessionPayload | null> {
    if (!this.env.SESSION_SECRET) return null;
    const cookie = readSessionCookie(request);
    if (!cookie) return null;
    return verifySession(cookie, this.#hmac(), {
      player: this.#epoch,
      master: this.#masterEpoch,
    });
  }

  /** Session to Recipient. A master's view mode is server state, not cookie state. */
  #recipient(session: SessionPayload): Recipient {
    if (session.kind === 'MASTER') {
      return masterRecipient(this.#viewModes[session.sessionId], this.#game, Date.now());
    }
    return { kind: 'PLAYER', playerId: session.playerId };
  }

  async #redeemInvite(token: string, url: URL): Promise<Response> {
    const player = playerForToken(this.#players, token);
    if (!player) {
      // An unknown token looks like an unknown path, as with the ingest secret.
      return new Response('not found', { status: 404 });
    }

    const cookie = await signSession(
      { kind: 'PLAYER', playerId: player.id, epoch: this.#epoch, issuedAt: Date.now() },
      this.#hmac(),
    );

    // 303 to the app root: the invite link is what gets installed to the home
    // screen, so it must not stay in the address bar with the token in it.
    return new Response(null, {
      status: 303,
      headers: { location: '/', 'set-cookie': sessionCookieHeader(cookie, url) },
    });
  }

  /**
   * Throttled per caller (M2b): five guesses a minute, then locked out for five.
   * This is the only endpoint in the system that accepts a guess.
   *
   * Per caller address rather than globally, deliberately. A global counter would
   * let anyone lock the master out of their own game by spamming this endpoint
   * from anywhere, and a master who cannot log in at the venue is a worse failure
   * than a distributed guess against a 24-character random password — that is the
   * §6.2 trade, applied to the login instead of to Access.
   *
   * The state is persisted, not in memory: this object hibernates between pings,
   * and an in-memory counter would hand out a fresh budget on every eviction.
   */
  async #masterLogin(request: Request, url: URL): Promise<Response> {
    const now = Date.now();
    // Cloudflare sets this in production. Absent under `wrangler dev`, where
    // every caller shares one bucket — correct for a laptop.
    const caller = request.headers.get('cf-connecting-ip') ?? 'local';

    // Refused before the body is even parsed. fetch() drains it on the way out.
    const decision = checkLoginAllowed(this.#loginFailures, caller, now);
    if (!decision.allowed) {
      return new Response('too many attempts', {
        status: 429,
        headers: { 'retry-after': String(decision.retryAfterSeconds) },
      });
    }

    const expected = this.env.MASTER_PASSWORD ?? '';
    const body = (await request.json().catch(() => null)) as { password?: string } | null;
    const supplied = typeof body?.password === 'string' ? body.password : '';

    if (!constantTimeEquals(supplied, expected)) {
      this.#loginFailures = recordLoginFailure(this.#loginFailures, caller, now);
      await this.#put('loginFailures', this.#loginFailures);
      // Deliberately identical for a wrong password and an unconfigured Worker.
      return new Response('unauthorised', { status: 401 });
    }

    // A correct password is not a failed attempt, and clears the budget so a
    // master who mistyped four times is not one slip from a lockout.
    this.#loginFailures = clearLoginFailures(this.#loginFailures, caller);
    await this.#put('loginFailures', this.#loginFailures);

    const sessionId = randomToken(12);
    this.#viewModes[sessionId] = { mode: 'OPERATIONAL' };
    await this.#put('viewModes', this.#viewModes);

    const cookie = await signSession(
      { kind: 'MASTER', sessionId, epoch: this.#masterEpoch, issuedAt: Date.now() },
      this.#hmac(),
    );
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json', 'set-cookie': sessionCookieHeader(cookie, url) },
    });
  }

  /**
   * R-25's revert, applied lazily — there is no tick and no alarm (§6.3).
   *
   * Called on the way into every request rather than on a schedule, which is the
   * same shape as marker pruning in #load(): the mode a master is *shown* is
   * already correct without this, because `masterRecipient()` derives it. What
   * this adds is the stored record agreeing with it, and the
   * `AUTHORITATIVE_REVERTED` event that closes the window R-25 opened. Bounded to
   * one write per lapse: afterwards the session is OPERATIONAL and lapses no more.
   */
  async #revertLapsedViewModes(now: number): Promise<void> {
    const lapsed = Object.keys(this.#viewModes).filter((sessionId) =>
      authoritativeLapsed(this.#viewModes[sessionId], this.#game, now),
    );
    if (lapsed.length === 0) return;
    for (const sessionId of lapsed) {
      this.#viewModes[sessionId] = { mode: 'OPERATIONAL' };
      this.#log({
        ts: now,
        kind: 'AUTHORITATIVE_REVERTED',
        actor: sessionId,
        visibility: 'MASTER_AUTHORITATIVE',
      });
    }
    await this.#put('viewModes', this.#viewModes);
    // Persisted for the same reason as the opening: an audit trail that only
    // exists in memory is not one.
    await this.#put('events', this.#events);
  }

  /**
   * Interaction, for R-25's purposes: a master action resets the clock. Stamped
   * before the handler runs and therefore **whether or not the action succeeds** —
   * a marker refused for hitting the cap is still a master with their hands on the
   * panel, which is what the clock measures.
   *
   * Writes nothing in OPERATIONAL, which is the whole game most of the time: only
   * AUTHORITATIVE has a clock to reset.
   */
  async #noteMasterAction(sessionId: string): Promise<void> {
    if (this.#viewModes[sessionId]?.mode !== 'AUTHORITATIVE') return;
    this.#viewModes[sessionId] = { mode: 'AUTHORITATIVE', lastActionAt: Date.now() };
    await this.#put('viewModes', this.#viewModes);
  }

  async #setViewMode(request: Request, session: SessionPayload): Promise<Response> {
    if (session.kind !== 'MASTER') return this.#forbidden();
    const body = (await request.json().catch(() => null)) as { mode?: string } | null;
    const mode = VIEW_MODES.find((candidate) => candidate === body?.mode);
    if (!mode) return new Response('unknown mode', { status: 400 });

    // Asking for the mode is itself an action, so it starts R-25's clock. Without
    // this the mode would arrive already lapsed: `lastActionAt` absent reverts.
    this.#viewModes[session.sessionId] = { mode, lastActionAt: Date.now() };
    await this.#put('viewModes', this.#viewModes);

    if (mode === 'AUTHORITATIVE') {
      // Every activation is logged with a timestamp (R-25) — and **persisted**,
      // which this used to skip. #log() only pushes in memory, so the entry died
      // with the isolate: a Durable Object evicted between an opening and the next
      // write took R-25's only record with it, and the master could no longer show
      // when they had seen real information about eliminated players.
      this.#log({
        ts: Date.now(),
        kind: 'AUTHORITATIVE_OPENED',
        actor: session.sessionId,
        visibility: 'MASTER_AUTHORITATIVE',
      });
      await this.#put('events', this.#events);
    }

    await this.#broadcast();
    return this.#json({ ok: true, mode });
  }

  /* ---------------------------------------------------------------- */
  /* Ingest (R-01..R-06)                                              */
  /* ---------------------------------------------------------------- */

  async #ingest(request: Request): Promise<Response> {
    const receivedAt = Date.now();
    const decoded = await decodePing(request, receivedAt);

    if (!decoded.ok) {
      // Traccar Client retries on non-2xx and cannot fix a malformed ping, so a
      // rejection is logged and acknowledged. The reason is for the master.
      // Keyed by reason: a ping too malformed to carry a device id cannot be
      // attributed to one, and what a master needs to know is that something is
      // sending rubbish rather than how much of it (R-04b).
      const note = noteRejection(this.#rejections, decoded.rejection.reason, receivedAt);
      if (note.log) {
        this.#log({
          ts: receivedAt,
          kind: 'INGEST_REJECTED',
          data: { ...decoded.rejection, ...(note.suppressed > 0 ? { since: note.suppressed } : {}) },
          visibility: 'MASTER',
        });
        await this.#put('events', this.#events);
      }
      return new Response('OK', { status: 200 });
    }

    // A body with no coordinates is a status report, not a malformed ping: the
    // phone is announcing itself before it has a fix.
    if (decoded.kind === 'STATUS') return this.#status(decoded.status);

    const gate = checkPingAccepted({
      state: this.#game.state,
      cutSwitch: this.#game.cutSwitch,
      lat: decoded.ping.lat,
      lon: decoded.ping.lon,
      ingestArea: this.#game.geo.ingestArea,
    });

    if (!gate.accepted) {
      const note = noteRejection(this.#rejections, decoded.ping.deviceId, receivedAt);
      if (note.log) {
        this.#log({
          ts: receivedAt,
          kind: 'INGEST_REJECTED',
          target: decoded.ping.deviceId,
          data: { ...gate.rejection, ...(note.suppressed > 0 ? { since: note.suppressed } : {}) },
          visibility: 'MASTER',
        });
        await this.#put('events', this.#events);
      }
      return new Response('OK', { status: 200 });
    }

    const ping = decoded.ping;
    const device = this.#devices.find((d) => d.id === ping.deviceId);

    if (device?.playerId) {
      device.lastSeen = ping.receivedAt;
      device.pings += 1;
      const index = this.#players.findIndex((p) => p.id === device.playerId);
      if (index >= 0) {
        this.#players[index] = applyPing(this.#players[index]!, ping, {
          zones: this.#game.geo.zones,
          linkThresholdMs: this.#game.config.linkThresholdMs,
        });
        // After applyPing, never before: the sample records the state and the
        // zone the game decided, not a second derivation of them (R-53).
        this.#recordSample(this.#players[index]!, ping.attributes);
      }
      await this.#put('devices', this.#devices);
      await this.#put('players', this.#players);
    } else {
      // Unknown id creates or updates a tray entry, never a discard (R-06).
      const at = this.#tray.findIndex((entry) => entry.deviceId === ping.deviceId);
      const entry = upsertTrayEntry(at >= 0 ? this.#tray[at] : undefined, ping);
      if (at >= 0) this.#tray[at] = entry;
      else {
        this.#tray.push(entry);
        this.#log({
          ts: receivedAt,
          kind: 'DEVICE_SEEN',
          target: ping.deviceId,
          visibility: 'MASTER',
        });
        await this.#put('events', this.#events);
      }
      await this.#put('tray', this.#tray);
    }

    await this.#broadcast();
    return new Response('OK', { status: 200 });
  }

  /**
   * A status report (see OsmAndStatus): the phone is on and says nothing about
   * where it is. So this may update a battery and may not update a position —
   * `applyStatus()` and `applyStatusToTrayEntry()` hold that line, including the
   * part where `lastSeen` stays put.
   */
  async #status(status: OsmAndStatus): Promise<Response> {
    // The state and cut-switch gates still apply: R-08 requires that no code path
    // leaves a device updating past the end of the game. R-04's geofence cannot
    // apply, because there is no position to test — which is also why a status
    // report can never be rejected as OUTSIDE_INGEST_AREA.
    const open = ingestOpen(this.#game.state, this.#game.cutSwitch);
    if (!open.open) {
      const note = noteRejection(this.#rejections, status.deviceId, status.receivedAt);
      if (note.log) {
        this.#log({
          ts: status.receivedAt,
          kind: 'INGEST_REJECTED',
          target: status.deviceId,
          data: { ...open.rejection, ...(note.suppressed > 0 ? { since: note.suppressed } : {}) },
          visibility: 'MASTER',
        });
        await this.#put('events', this.#events);
      }
      return new Response('OK', { status: 200 });
    }

    const device = this.#devices.find((d) => d.id === status.deviceId);

    if (device?.playerId) {
      const index = this.#players.findIndex((p) => p.id === device.playerId);
      const current = index >= 0 ? this.#players[index] : undefined;
      if (current) {
        const updated = applyStatus(current, status);
        // Same object means nothing to record: writing it anyway would cost a row
        // and a broadcast per service restart for no change on any screen.
        if (updated !== current) {
          this.#players[index] = updated;
          await this.#put('players', this.#players);
          await this.#broadcast();
        }
      }
      return new Response('OK', { status: 200 });
    }

    const at = this.#tray.findIndex((entry) => entry.deviceId === status.deviceId);
    const entry = at >= 0 ? this.#tray[at] : undefined;
    if (entry) {
      const updated = applyStatusToTrayEntry(entry, status);
      if (updated !== entry) {
        this.#tray[at] = updated;
        await this.#put('tray', this.#tray);
        await this.#broadcast();
      }
    }

    // An id never seen before brings no position, so there is nothing to put in
    // the tray — TrayEntry requires coordinates, and a row a master cannot place
    // on a map is not one they could pick the right phone from (R-06). It is
    // acknowledged and dropped, and the phone appears on its first real fix.
    return new Response('OK', { status: 200 });
  }

  /* ---------------------------------------------------------------- */
  /* Sockets — WebSocket Hibernation (§6.1)                           */
  /* ---------------------------------------------------------------- */

  async #upgrade(request: Request, session: SessionPayload): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);

    // Identity has to survive hibernation: the Durable Object is evicted between
    // pings and comes back with nothing but the sockets and their attachments.
    const identity: SocketIdentity =
      session.kind === 'MASTER'
        ? { kind: 'MASTER', id: session.sessionId }
        : { kind: 'PLAYER', id: session.playerId };
    server.serializeAttachment(identity);

    // R-60: the socket opens either way — a player is still authenticated and
    // still has a session — but with the cut on it is handed nothing.
    if (identity.kind === 'MASTER' || playerFeedOpen(this.#game.cutSwitch)) {
      server.send(JSON.stringify(this.#messageFor(identity)));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Presence pings only. Everything that mutates state goes over HTTP so it
    // stays idempotent and auditable (§5).
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code === 1006 ? 1000 : code, reason);
  }

  /**
   * One projection per socket. There is no shared payload to accidentally send
   * to the wrong recipient, because no shared payload is ever built.
   */
  async #broadcast(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      const identity = socket.deserializeAttachment() as SocketIdentity | null;
      if (!identity) {
        // A socket with no identity cannot be projected for, so it gets nothing
        // and is closed rather than guessed at.
        socket.close(1011, 'no identity');
        continue;
      }
      // R-60: the cut halts the player feed and leaves the masters' alone.
      // R-35 gives a master access in any state, and a master watching a frozen
      // panel while deciding what to do about the thing they cut for is the
      // opposite of what that is for.
      if (identity.kind === 'PLAYER' && !playerFeedOpen(this.#game.cutSwitch)) continue;
      /**
       * A socket that is on its way out is skipped rather than sent to.
       *
       * `getWebSockets()` still returns one that has been closed in this same
       * request, and `send()` on it throws `Can't call WebSocket send() after
       * close()` — which becomes a **500 on an action that already succeeded**,
       * because every handler broadcasts last. Finishing a game is where it
       * shows: `#endSession()` closes every socket and the broadcast at the
       * bottom of `#setState()` then sends to all of them, so a master pressing
       * FINALIZADA with their own panel open got an error from a state change
       * that had already landed and persisted.
       *
       * The `try` is the other half and is not belt and braces: a client that
       * disconnected between this projection and this line is an ordinary event
       * at a venue, and one phone in a tunnel must not cost every other socket
       * its snapshot.
       */
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(JSON.stringify(this.#messageFor(identity)));
      } catch {
        // Gone between the check and the send. Nothing to do and nobody to tell:
        // the client reconnects on its own and is handed a fresh snapshot.
      }
    }
  }

  #messageFor(identity: SocketIdentity): WsServerMessage {
    const recipient: Recipient =
      identity.kind === 'MASTER'
        ? masterRecipient(this.#viewModes[identity.id], this.#game, Date.now())
        : { kind: 'PLAYER', playerId: identity.id };
    return { t: 'snapshot', payload: project(this.#world(), recipient, Date.now()) };
  }

  /* ---------------------------------------------------------------- */
  /* Master controls                                                  */
  /* ---------------------------------------------------------------- */

  async #pair(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      deviceId?: string;
      playerId?: string;
    } | null;
    const deviceId = body?.deviceId?.trim();
    const playerId = body?.playerId?.trim();
    if (!deviceId || !playerId) {
      return new Response('deviceId and playerId required', { status: 400 });
    }

    const player = this.#players.find((p) => p.id === playerId);
    if (!player) return new Response('unknown player', { status: 404 });

    // One device per player, one player per device: re-pairing moves the binding
    // rather than leaving two live.
    this.#devices = this.#devices.filter((d) => d.id !== deviceId && d.playerId !== playerId);
    for (const other of this.#players) {
      if (other.deviceId === deviceId) delete other.deviceId;
    }

    const trayEntry = this.#tray.find((entry) => entry.deviceId === deviceId);
    this.#devices.push({
      id: deviceId,
      playerId,
      firstSeen: trayEntry?.firstSeen ?? Date.now(),
      lastSeen: trayEntry?.lastSeen ?? Date.now(),
      pings: trayEntry?.pings ?? 0,
      gameId: this.#game.id,
    });
    player.deviceId = deviceId;
    if (trayEntry) {
      // The tray holds what is unpaired; a paired device leaves it, carrying its
      // last position over so the master sees the dot immediately.
      player.knownPosition = { lat: trayEntry.lat, lon: trayEntry.lon, ts: trayEntry.lastSeen };
      if (trayEntry.battery !== undefined) player.battery = trayEntry.battery;
      this.#tray = this.#tray.filter((entry) => entry.deviceId !== deviceId);
    }

    this.#log({
      ts: Date.now(),
      kind: 'DEVICE_PAIRED',
      actor: deviceId,
      target: playerId,
      visibility: 'MASTER',
    });

    await this.#put('devices', this.#devices);
    await this.#put('players', this.#players);
    await this.#put('tray', this.#tray);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true });
  }

  /**
   * R-13, R-14, R-29. A manual record that someone spoke to a player by walkie.
   *
   * Open to players as well as masters, which makes it the first route in the
   * system a player may use to change server state. That is R-14, and R-29 says
   * why it matters: contact is liveness rather than location, so it crosses zone
   * boundaries on purpose and is what keeps the game playable when GPS goes quiet.
   *
   * Three things it deliberately does not do.
   *
   * It does not check whether the target is currently `NO_LINK`. R-13 says contact
   * "only starts mattering" then, which is a rule about display, not about what may
   * be recorded — and the ordinary sequence is that you speak to someone and *then*
   * notice they have gone dark, so a record refused while they were still live
   * would be refused at exactly the moment it was worth making.
   *
   * It does not exclude the caller from the targets. R-14 says any player, and a
   * player whose own GPS has died but whose phone still loads the map has no other
   * way to say so.
   *
   * It raises nothing. No event visible to players, no notification, no flag — R-13
   * is explicit that neither having contact nor lacking it is an alarm. What lands
   * in the log is master-only, as an audit of who reported what.
   */
  async #recordRadioContact(request: Request, session: SessionPayload): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { playerId?: string } | null;
    const playerId = body?.playerId?.trim();
    if (!playerId) return new Response('playerId required', { status: 400 });

    const player = this.#players.find((p) => p.id === playerId);
    if (!player) return new Response('unknown player', { status: 404 });

    // From the session, never the body: a player could otherwise report contact in
    // somebody else's name, and reportedBy is shown on every roster (§4).
    const reportedBy = session.kind === 'MASTER' ? 'MASTER' : session.playerId;
    const ts = Date.now();
    player.radioContact = { ts, reportedBy };

    this.#log({ ts, kind: 'RADIO_CONTACT', actor: reportedBy, target: playerId, visibility: 'MASTER' });
    await this.#put('players', this.#players);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, radioContact: player.radioContact });
  }

  /* ---------------------------------------------------------------- */
  /* Elimination (R-30..R-32)                                         */
  /* ---------------------------------------------------------------- */

  /**
   * R-30. Takes no body: what is being declared is *this session's* player, and
   * accepting an id would be handing one player the ability to eliminate another.
   *
   * **No response body beyond `ok`.** The declaration's effects reach the player
   * through the broadcast that follows, which goes through `project()` like
   * everything else (§5). Echoing the record here would be a second path to the
   * same data with none of the checks on it.
   *
   * The broadcast is not an event, which R-30.2 forbids: it is the same snapshot
   * every socket already receives on every ping, and what changes in it is that
   * one player's feed has stopped. To everyone else that is a dot that froze,
   * exactly like a phone dying mid-stride.
   */
  async #declareEliminated(session: SessionPayload): Promise<Response> {
    if (session.kind !== 'PLAYER') return this.#forbidden();
    if (!eliminationOpen(this.#game)) {
      return new Response('elimination is closed in this game state', { status: 409 });
    }

    const index = this.#players.findIndex((candidate) => candidate.id === session.playerId);
    if (index === -1) return this.#unauthorised();

    const before = this.#players[index]!;
    const after = declareEliminated(before, Date.now());
    // Already out. Not an error and not a write: a second press must not move the
    // drop point, and must not put a second line in the log either.
    if (after === before) return this.#json({ ok: true });

    this.#players[index] = after;
    this.#log({
      ts: after.eliminated!.ts,
      kind: 'ELIMINATION',
      actor: after.id,
      target: after.id,
      // MASTER_AUTHORITATIVE, and this is R-30.2 in the log rather than on the
      // wire: an elimination visible in OPERATIONAL would tell a master who is out
      // just as plainly as the field §4 withholds from them.
      visibility: 'MASTER_AUTHORITATIVE',
      data: {
        selfDeclared: true,
        // Absent for a player who had no fix, which R-31 renders as absent (M6).
        ...(after.eliminated!.dropPoint === undefined
          ? { dropPoint: null }
          : { dropPoint: after.eliminated!.dropPoint }),
      },
    });
    await this.#put('players', this.#players);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true });
  }

  /** R-32. Master only, which the gate in #route() has already established. */
  async #revivePlayer(playerId: string): Promise<Response> {
    const index = this.#players.findIndex((candidate) => candidate.id === playerId);
    if (index === -1) return new Response('unknown player', { status: 404 });

    const before = this.#players[index]!;
    const after = reviveEliminated(before);
    if (after === before) return this.#json({ ok: true, revived: false });

    this.#players[index] = after;
    this.#log({
      ts: Date.now(),
      kind: 'ELIMINATION_REVERSED',
      target: playerId,
      visibility: 'MASTER_AUTHORITATIVE',
    });
    await this.#put('players', this.#players);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, revived: true });
  }

  async #setState(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { state?: string } | null;
    const state = GAME_STATES.find((candidate) => candidate === body?.state);
    if (!state) return new Response('unknown state', { status: 400 });

    /**
     * R-34b, decided before the state moves because the rule reads both ends of
     * the transition: it is the *leaving* of FINISHED that releases a cut this
     * threw, and `this.#game.state` is still the old one here.
     */
    const cut = cutSwitchOnStateChange(state, this.#game);

    this.#game.state = state;
    if (state === 'IN_PROGRESS' && this.#game.startedAt === undefined) {
      this.#game.startedAt = Date.now();
    }
    if (state === 'FINISHED') {
      this.#game.finishedAt = Date.now();
      await this.#endSession();
    }
    if (cut) {
      this.#game.cutSwitch = cut.cutSwitch;
      this.#game.cutByFinish = cut.cutByFinish;
      // Logged like any other throw of the switch, and with the reason, because
      // a line saying the machine stopped listening with nobody having asked it
      // to is the one a master would otherwise have to guess at.
      this.#log({
        ts: Date.now(),
        kind: 'CUT_SWITCH',
        data: { on: cut.cutSwitch, byFinish: true },
        visibility: 'MASTER',
      });
    }

    this.#log({ ts: Date.now(), kind: 'GAME_STATE', data: { state }, visibility: 'ALL' });
    await this.#put('game', this.#game);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, state });
  }

  /**
   * Swaps the live geometry for another bundled profile.
   *
   * This route exists because geometry is **seeded, not deployed**: a game reads
   * game.geojson once, on the storage miss that creates it, and keeps what it got
   * for the rest of its life. Editing the file and shipping it changes what the
   * *next* game would start with and nothing about the one running, which is not
   * obvious and is worth having a route rather than a surprise.
   *
   * Refused while IN_PROGRESS, with 409. Zones are the axis §4 scopes positions
   * on, so replacing them rewrites who can see whom for everyone at once, in the
   * middle of a game, with no indication on any screen that it happened. There is
   * no use for that during play: switching is preparation.
   *
   * Every player's zone is recomputed here, because a stored `zoneId` was decided
   * by the old geometry and means nothing under the new. A player whose last
   * position falls outside every new zone comes back undefined and reads as
   * out-of-zone, which is the honest answer — they are somewhere this geometry
   * does not describe.
   */
  async #setGeoProfile(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { profile?: string } | null;
    const profile = GEO_PROFILE_NAMES.find((name) => name === body?.profile);
    if (!profile) {
      return new Response(`profile must be one of ${GEO_PROFILE_NAMES.join(', ')}`, {
        status: 400,
      });
    }
    if (this.#game.state === 'IN_PROGRESS') {
      return new Response('cannot change geometry while the game is in progress', { status: 409 });
    }


    const { geo, bbox } = geoOf(profile);
    this.#geoProfile = profile;
    this.#game.geo = geo;
    // R-61's list is point ids, and point ids belong to the geometry they came
    // from. Carried across a profile change it is a set of names the new venue
    // has never heard of — silent, unreconcilable, and one id collision away
    // from hiding a point nobody chose.
    this.#hiddenPois = [];
    // And R-71's closed set, for the same reason one line up: zone ids belong
    // to the geometry they came from. Carried across, a name the new venue has
    // never heard of closes nothing — and a name it *has* heard of closes
    // ground nobody chose, which is the worse of the two because it looks
    // deliberate.
    this.#disabledZones = [];
    this.#derivePlayArea();
    this.#game.basemap.bbox = bbox;
    // The archive follows the geometry (R-52b). Leaving the old one would frame
    // the right zones over the wrong town's streets, which is worse than no
    // basemap at all because it looks like it worked.
    this.#game.basemap.pmtilesUrl = basemapUrlOf(profile);
    // And the labels with it (R-69). A town is read by street name and a venue
    // is read by zone name, so this moves with the geometry rather than being a
    // setting somebody has to remember on the way in.
    this.#game.basemap.streetNames = streetNamesFor(profile);

    for (const player of this.#players) {
      if (!player.position) continue;
      const zoneId = zoneAt(player.position.lon, player.position.lat, geo.zones);
      if (zoneId === undefined) delete player.position.zoneId;
      else player.position.zoneId = zoneId;
    }

    this.#log({
      ts: Date.now(),
      kind: 'GEO_PROFILE',
      data: { profile, zones: geo.zones.length },
      visibility: 'MASTER',
    });
    await this.ctx.storage.put('geoProfile', profile);
    // Applying the profile by hand is the other way the geometry becomes
    // current, so it marks it current too — otherwise the migration would
    // re-derive the same geometry on the next cold start.
    await this.ctx.storage.put('geoVersion', GEO_VERSION);
    await this.#put('game', this.#game);
    await this.#put('players', this.#players);
    await this.#put('hiddenPois', this.#hiddenPois);
    await this.#put('disabledZones', this.#disabledZones);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, profile, zones: geo.zones.map((zone) => zone.id) });
  }

  /**
   * Where the `.pmtiles` archive is (§14.4, R-52).
   *
   * A route rather than a var or a build-time constant, because **a game is
   * seeded once**: the one in storage was created before any archive existed,
   * and a deploy does not reseed it. The URL is also per location and per
   * extract — a new archive gets a new versioned path, since R-52 caches by
   * path and never revalidates — so it changes on a different schedule from the
   * code.
   *
   * The bbox is not settable here on purpose. It is derived from the ingest
   * area by `geoOf()` when the geometry profile changes, and a bbox that
   * disagreed with the geometry would frame the map on the wrong town while
   * every dot landed correctly (§14.2).
   *
   * Gated like the geometry switch: swapping the basemap mid-game would blank
   * every player's map while the new archive downloaded.
   */
  async #setBasemapUrl(request: Request): Promise<Response> {
    if (this.#game.state === 'IN_PROGRESS') {
      return new Response('cannot change the basemap while the game is in progress', {
        status: 409,
      });
    }

    const body = (await request.json().catch(() => null)) as { pmtilesUrl?: unknown } | null;
    const pmtilesUrl = typeof body?.pmtilesUrl === 'string' ? body.pmtilesUrl.trim() : null;
    if (pmtilesUrl === null) {
      return new Response('pmtilesUrl must be a string', { status: 400 });
    }
    // An empty string is the documented "no archive yet" state, which
    // buildStyle() handles by drawing the game geometry on the background — so
    // clearing it is a legitimate act rather than a malformed request.
    //
    // A leading slash is the normal case (R-52b): the archive ships with the
    // bundle, so it is same-origin and configured as a path. An absolute https
    // URL is still accepted, because a venue whose extract will not fit under
    // the 25 MiB asset ceiling has to go back to object storage.
    const pathForm = pmtilesUrl.startsWith('/') && pmtilesUrl.endsWith('.pmtiles');
    const urlForm = /^https:\/\/[^\s]+\.pmtiles$/.test(pmtilesUrl);
    if (pmtilesUrl !== '' && !pathForm && !urlForm) {
      return new Response('pmtilesUrl must be a /path or an https URL ending in .pmtiles', {
        status: 400,
      });
    }

    this.#game.basemap.pmtilesUrl = pmtilesUrl;
    this.#log({
      ts: Date.now(),
      kind: 'BASEMAP',
      data: { pmtilesUrl },
      visibility: 'MASTER',
    });
    await this.#put('game', this.#game);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, pmtilesUrl });
  }

  /* ---------------------------------------------------------------- */
  /* The single marker (R-19..R-21)                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Places a marker, up to five (R-20b).
   *
   * Everything that can be refused is refused in `placeMarker()`, where a test
   * can reach it — including the sixth, which comes back as `MARKER_LIMIT` rather
   * than pushing anything off a player's map.
   *
   * Not gated on game state. #configurable() guards the roster and the geometry
   * because those are preparation, but a marker is the opposite — it is the
   * master saying "there, now" in the middle of play, and R-19 exists for that
   * moment. It is also useful in PREPARATION, where placing one is how the
   * audience filtering gets checked against a real phone before anybody leaves.
   */
  async #placeMarker(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      label?: string;
      lat?: number;
      lon?: number;
      audience?: MasterMarker['audience'];
      ttlMs?: number | null;
    } | null;

    const now = Date.now();
    // Expired ones are dropped before the cap is counted, so a slot held by a
    // marker whose TTL has passed does not refuse a new marker (R-21c).
    this.#markers = activeMarkers(this.#markers, now);
    const result = placeMarker(
      {
        label: body?.label,
        lat: body?.lat,
        lon: body?.lon,
        audience: body?.audience,
        // Passed through verbatim, null included: null is "no expiry" and absent
        // is "you did not say", and collapsing them would make a forgotten field
        // place a permanent marker (R-21c).
        ttlMs: body?.ttlMs,
      },
      {
        players: this.#players,
        teams: this.#teams,
        ingestArea: this.#game.geo.ingestArea,
        config: this.#game.config,
        existing: this.#markers,
      },
      // A fresh id per placement, and it matters even with one slot: a client
      // that sees the same id twice cannot tell a replacement from a redraw of
      // the marker it already had. Randomness is the runtime's to provide (§6.5).
      `marker-${randomToken(8)}`,
      now,
    );
    if (!result.ok) {
      // 409 for the cap, because nothing about the request was wrong: the state
      // was. 400 would send a master looking for a typo.
      const status = result.error.reason === 'MARKER_LIMIT' ? 409 : 400;
      return this.#json({ ok: false, error: result.error }, status);
    }

    this.#markers.push(result.value);

    this.#log({
      ts: now,
      kind: 'MARKER_PLACED',
      target: result.value.id,
      data: {
        label: result.value.label,
        // The coordinates are here so that R-56 can stand the marker back up at
        // the right place during a replay; the log is master-only and a marker
        // the master placed is already theirs. A game whose markers predate M8
        // replays without them rather than in the wrong spot.
        lat: result.value.lat,
        lon: result.value.lon,
        audience: result.value.audience,
        // Absent for an indefinite marker, which is what the log should say about
        // it — not a sentinel that reads like a date.
        ...(result.value.expiresAt === undefined ? { indefinite: true } : { expiresAt: result.value.expiresAt }),
        live: this.#markers.length,
      },
      visibility: 'MASTER',
    });

    await this.#put('markers', this.#markers);
    await this.#put('events', this.#events);
    await this.#syncMarkerAlarm();
    await this.#broadcast();
    return this.#json({ ok: true, marker: result.value, live: this.#markers.length });
  }

  /**
   * Clears one marker by id, or all of them (§5). Its own instruction rather than
   * a marker with a zero TTL.
   *
   * An unknown id is a 404 and not a silent success: with five of them, "clear
   * that one" failing quietly leaves the master looking at a marker they believe
   * they have removed.
   */
  async #clearMarkers(id?: string): Promise<Response> {
    const now = Date.now();
    const live = activeMarkers(this.#markers, now);
    const removed = id === undefined ? live : live.filter((marker) => marker.id === id);
    if (id !== undefined && removed.length === 0) {
      return new Response('unknown marker', { status: 404 });
    }

    this.#markers = live.filter((marker) => !removed.includes(marker));
    for (const marker of removed) {
      this.#log({
        ts: now,
        kind: 'MARKER_EXPIRED',
        target: marker.id,
        data: { label: marker.label, cleared: true },
        visibility: 'MASTER',
      });
    }
    await this.#put('markers', this.#markers);
    await this.#put('events', this.#events);
    await this.#syncMarkerAlarm();
    await this.#broadcast();
    return this.#json({ ok: true, cleared: removed.map((marker) => marker.id), live: this.#markers.length });
  }

  /**
   * R-21d. One switch, and the only thing in the system that lets team membership
   * touch the position axis (§4).
   *
   * Allowed in every game state, unlike the roster and the geometry. Those are
   * preparation; this is a comms decision taken in the middle of play, which is
   * when a master decides the teams need to hold together across the venue. It is
   * logged for the same reason the geometry switch is: it silently rewrites who
   * can see whom, and no screen says so.
   */
  async #setCommsReach(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { reach?: unknown } | null;
    // The three points on the scale and nothing else. 1 and 2 are not levels
    // this setting has (R-72), and 0 is the socket being down — which is a fact
    // about a WebSocket rather than something a master can choose.
    if (body?.reach !== 3 && body?.reach !== 4 && body?.reach !== 5) {
      return new Response('reach must be 3, 4 or 5', { status: 400 });
    }

    this.#game.commsReach = body.reach;
    this.#log({
      ts: Date.now(),
      kind: 'EXTENDED_COMMS',
      // `reach` rather than `extended`, and the old key is not written beside
      // it: a log line carrying both would have to say something about a
      // boolean that no longer exists, and R-56 replays this log rather than
      // interpreting it.
      data: { reach: body.reach },
      visibility: 'MASTER',
    });
    await this.#put('game', this.#game);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, commsReach: this.#game.commsReach });
  }

  /**
   * Marker expiry is the **only** recurring alarm in the system (R-21, §6.3),
   * and a Durable Object has exactly one alarm to give: `setAlarm()` replaces
   * whatever was scheduled rather than adding to it. So five markers still cost
   * one alarm — it is armed for the earliest expiry and re-armed from whatever is
   * left after each firing, which is why the cap does not multiply the cost.
   *
   * `getAlarm()` first so an unchanged schedule costs no write. Each alarm bills
   * as a full request (§6.3), which is why this milestone must not grow a second
   * one: a 4-hour game should be under ten alarms, not 2.880.
   */
  async #syncMarkerAlarm(): Promise<void> {
    const scheduled = await this.ctx.storage.getAlarm();
    // The earliest expiry among the live markers, and `undefined` when nothing
    // expires — five indefinite markers schedule no alarm at all (R-21c).
    const due = nextMarkerExpiry(this.#markers);
    if (due === undefined) {
      if (scheduled !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (scheduled !== due) await this.ctx.storage.setAlarm(due);
  }

  /**
   * R-21. The marker vanishes from its audience's map.
   *
   * The broadcast is the point: every socket gets a fresh projection with
   * `marker: null`, so the marker leaves the screens of exactly the people it
   * reached. project() would already withhold an expired marker — expiry is
   * derived at send time too, because an alarm can be late — but nothing would
   * *tell* a client that has been sitting quietly, and a marker that disappears
   * only on the next ping is not what "expires" means.
   *
   * Fires early rather than not at all, in one case: a marker replaced between
   * the schedule and the firing may have a later TTL. Rescheduling is the whole
   * handling, and it is why this checks rather than assumes.
   */
  override async alarm(): Promise<void> {
    await this.#load();
    const now = Date.now();
    // The alarm is the one entry point that does not go through #route, so R-25's
    // revert is applied here too. It is not what the alarm was set for (R-21 —
    // marker expiry is the only alarm the system has), but a broadcast is about to
    // go out and it must not carry a lapsed AUTHORITATIVE.
    await this.#revertLapsedViewModes(now);
    const live = activeMarkers(this.#markers, now);
    const expired = this.#markers.filter((marker) => !live.includes(marker));

    if (expired.length === 0) {
      // Fired early — a marker placed with a later TTL between the schedule and
      // the firing, or clock skew. Re-arm from what is actually there rather than
      // clearing anything.
      await this.#syncMarkerAlarm();
      return;
    }

    this.#markers = live;
    for (const marker of expired) {
      this.#log({
        ts: now,
        kind: 'MARKER_EXPIRED',
        target: marker.id,
        data: { label: marker.label, audience: marker.audience },
        visibility: 'MASTER',
      });
    }
    await this.#put('markers', this.#markers);
    await this.#put('events', this.#events);
    // Re-armed for the next expiry, if any is left: one alarm at a time, so the
    // set drains one firing per marker rather than all at once (R-21c, §6.3).
    await this.#syncMarkerAlarm();
    await this.#broadcast();
  }

  /**
   * The one gate on every configuration route (R-07).
   *
   * Not a view mode. `AUTHORITATIVE` differs from `OPERATIONAL` on exactly one
   * axis (R-22) and is deliberately awkward to enter — a blocking confirmation
   * every time (R-24) and a ten-minute revert (R-25) — because it spoils the game
   * for a master who plays. Hiding setup behind it would mean configuring in
   * spoiler mode, and would cost R-22 the single predicate its whole design rests
   * on.
   *
   * Game state answers the real worry, which is a stray tap during play. R-07's
   * "fully configurable before anyone leaves for the venue" and R-21b's static
   * zones are the same sentence from two directions: this is preparation work.
   */
  #configurable(): Response | null {
    if (this.#game.state !== 'IN_PROGRESS') return null;
    return new Response('cannot change the roster while the game is in progress', { status: 409 });
  }

  async #addPlayer(request: Request): Promise<Response> {
    const locked = this.#configurable();
    if (locked) return locked;

    const body = (await request.json().catch(() => null)) as {
      callsign?: string;
      fullName?: string;
      teamId?: string;
    } | null;

    const result = addPlayer(
      { players: this.#players, teams: this.#teams },
      {
        callsign: body?.callsign ?? '',
        fullName: body?.fullName ?? '',
        ...(body?.teamId === undefined ? {} : { teamId: body.teamId }),
      },
      // One token per player per game (R-08), generated here because randomness
      // is the runtime's to provide and @q4413/core stays portable (§6.5).
      randomToken(),
    );
    if (!result.ok) return this.#json({ ok: false, error: result.error }, 400);

    this.#players = result.value.roster.players;
    this.#teams = result.value.roster.teams;

    this.#log({
      ts: Date.now(),
      kind: 'ROSTER',
      target: result.value.player.id,
      data: { action: 'ADDED', callsign: result.value.player.callsign },
      visibility: 'MASTER',
    });
    await this.#put('players', this.#players);
    await this.#put('teams', this.#teams);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({
      ok: true,
      player: { id: result.value.player.id, callsign: result.value.player.callsign },
      // The invite link is the whole of a player's authentication (§6.4), so it is
      // returned once here rather than making the master go and look for it.
      path: `/j/${result.value.player.sessionToken}`,
    });
  }

  /**
   * Removing a player has to reach three places the pure function cannot: the
   * device binding, the live socket, and the marker audience.
   *
   * The device record is dropped rather than reassigned. An unknown id lands in
   * the tray on its next ping (R-06), so a phone that is still running heals into
   * a re-pairable entry by itself, and one that is switched off leaves nothing
   * behind to go stale.
   *
   * The socket is closed here, and the session is refused in #route: a cookie
   * signed before the removal stays valid on its own terms until the epoch bumps
   * at the end of the game, so closing the socket alone would let the phone
   * reconnect a second later. Both halves are needed, and the smoke test that
   * found this is why the check is a route guard rather than a note here.
   */
  async #removePlayer(request: Request): Promise<Response> {
    const locked = this.#configurable();
    if (locked) return locked;

    const body = (await request.json().catch(() => null)) as { playerId?: string } | null;
    const result = removePlayer(
      { players: this.#players, teams: this.#teams },
      body?.playerId?.trim() ?? '',
    );
    if (!result.ok) {
      return this.#json({ ok: false, error: result.error }, result.error.reason === 'UNKNOWN_PLAYER' ? 404 : 400);
    }

    const { removed, deviceId } = result.value;
    this.#players = result.value.roster.players;
    this.#teams = result.value.roster.teams;
    if (deviceId !== undefined) this.#devices = this.#devices.filter((d) => d.id !== deviceId);

    // A marker addressed to this player alone now has no audience at all, and a
    // marker nobody can see is a marker that quietly never expires (R-20b) —
    // doubly so now that a marker may have no TTL to expire on.
    const orphaned = this.#markers.filter(
      (marker) => marker.audience.kind === 'player' && marker.audience.playerId === removed.id,
    );
    if (orphaned.length > 0) {
      this.#markers = this.#markers.filter((marker) => !orphaned.includes(marker));
      await this.#put('markers', this.#markers);
      // And the alarm with them: an alarm that fires to expire nothing is a billed
      // request for no reason (§6.3).
      await this.#syncMarkerAlarm();
    }

    for (const socket of this.ctx.getWebSockets()) {
      const identity = socket.deserializeAttachment() as SocketIdentity | null;
      if (identity?.kind === 'PLAYER' && identity.id === removed.id) {
        socket.close(1000, 'removed from the roster');
      }
    }

    this.#log({
      ts: Date.now(),
      kind: 'ROSTER',
      target: removed.id,
      data: { action: 'REMOVED', callsign: removed.callsign },
      visibility: 'MASTER',
    });
    await this.#put('players', this.#players);
    await this.#put('teams', this.#teams);
    await this.#put('devices', this.#devices);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, removed: removed.id });
  }

  /**
   * Teams were seeded like everything else, so a running game keeps the two
   * placeholder teams it was created with and every player added by hand lands in
   * the first of them. These four routes are what makes a team a thing the master
   * owns rather than a thing the deploy decided.
   *
   * All four share #configurable(): a team change moves who a POI or a marker is
   * addressed to (R-17, R-19), which is preparation, not play.
   */
  async #rosterWrite(
    request: Request,
    apply: (body: Record<string, string | undefined>) => RosterResult<{ roster: Roster }>,
    describe: (body: Record<string, string | undefined>) => Record<string, unknown>,
  ): Promise<Response> {
    const locked = this.#configurable();
    if (locked) return locked;

    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      body[key] = typeof value === 'string' ? value.trim() : undefined;
    }

    const result = apply(body);
    if (!result.ok) {
      const missing =
        result.error.reason === 'UNKNOWN_PLAYER' || result.error.reason === 'UNKNOWN_TEAM';
      return this.#json({ ok: false, error: result.error }, missing ? 404 : 400);
    }

    this.#players = result.value.roster.players;
    this.#teams = result.value.roster.teams;
    this.#log({ ts: Date.now(), kind: 'ROSTER', data: describe(body), visibility: 'MASTER' });
    await this.#put('players', this.#players);
    await this.#put('teams', this.#teams);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, teams: this.#teams });
  }

  #roster(): Roster {
    return { players: this.#players, teams: this.#teams };
  }

  async #movePlayer(request: Request): Promise<Response> {
    return this.#rosterWrite(
      request,
      (body) => movePlayer(this.#roster(), body.playerId ?? '', body.teamId ?? ''),
      (body) => ({ action: 'MOVED', playerId: body.playerId, teamId: body.teamId }),
    );
  }

  async #addTeam(request: Request): Promise<Response> {
    return this.#rosterWrite(
      request,
      (body) => addTeam(this.#roster(), { name: body.name ?? '' }),
      (body) => ({ action: 'TEAM_ADDED', name: body.name }),
    );
  }

  async #renameTeam(request: Request): Promise<Response> {
    return this.#rosterWrite(
      request,
      (body) => renameTeam(this.#roster(), body.teamId ?? '', { name: body.name ?? '' }),
      (body) => ({ action: 'TEAM_RENAMED', teamId: body.teamId, name: body.name }),
    );
  }

  async #removeTeam(request: Request): Promise<Response> {
    return this.#rosterWrite(
      request,
      (body) => removeTeam(this.#roster(), body.teamId ?? ''),
      (body) => ({ action: 'TEAM_REMOVED', teamId: body.teamId }),
    );
  }

  /**
   * Wipes the game and lets it seed fresh.
   *
   * **No deploy can do this**, which is the whole of the seeding trap this project
   * has now hit three times — geometry, roster, teams. A game reads its seed once,
   * on the storage miss that creates it, so shipping a new literal changes what a
   * *future* game would start with and nothing about the one running. Reseeding is
   * an action, not a release.
   *
   * Refused while IN_PROGRESS, and it asks for the game's own name typed back.
   * There is no undo, and the button sits next to ones that are merely
   * inconvenient.
   *
   * ## The epoch is carried forward, not allowed to reset
   *
   * The part that is not obvious, and the part that would be a security bug if it
   * were left alone. `deleteAll()` takes the epoch with it and a fresh game starts
   * at 1 — so a cookie signed during the *first* game would verify again, and since
   * player ids are derived from callsigns the new roster hands out the same ones. A
   * reset would become a way of resurrecting old sessions.
   *
   * Carrying it across and incrementing is what keeps R-08's "no code path may
   * leave a binding alive past the session" true across a reset as well as a
   * finish.
   */
  async #resetGame(request: Request): Promise<Response> {
    if (this.#game.state === 'IN_PROGRESS') {
      return new Response('cannot reset while the game is in progress', { status: 409 });
    }

    const body = (await request.json().catch(() => null)) as { confirm?: string } | null;
    if (body?.confirm?.trim() !== this.#game.name) {
      return new Response(`confirm must be the game name: ${this.#game.name}`, { status: 400 });
    }

    // Handed back rather than kept: storage is what is about to be wiped, and a
    // Durable Object accumulating archives of its own past is how the SQLite the
    // track needs in M8 fills up with things nobody reads.
    //
    // ingestSecret and every sessionToken are stripped. They are dead the moment
    // this lands — tokens are regenerated on the next seed, the secret comes from
    // the environment — and a file in somebody's downloads folder is a worse home
    // for them than anywhere they currently live.
    const { ingestSecret: _secret, ...game } = this.#game;
    const archive = {
      archivedAt: Date.now(),
      geoProfile: this.#geoProfile,
      game,
      players: this.#players.map(({ sessionToken: _token, ...player }) => player),
      teams: this.#teams,
      devices: this.#devices,
      tray: this.#tray,
      markers: this.#markers,
      events: this.#events,
    };

    const epoch = this.#epoch + 1;
    // Both of them, and this is the only thing that moves the master's (R-33b).
    // A reset is the game being thrown away rather than ended, so the session
    // that outlives a FINISHED game must not outlive this.
    const masterEpoch = this.#masterEpoch + 1;
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'game reset');
    // Explicitly, and not left to deleteAll(): that clears the KV side, and the
    // track is SQL. A reset that left it behind would replay the previous game
    // over the new one's roster, which is the one place a stale sample is worse
    // than no sample. FINISHED deliberately does not do this — R-26 calls the
    // feature post-game replay, so the track has to survive the end of a session.
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS track`);
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS track_log`);
    await this.ctx.storage.deleteAll();

    // #load() memoises itself, so the promise has to be dropped or the object
    // would carry on serving the state that was just deleted.
    this.#loaded = undefined;
    await this.#load();
    this.#epoch = epoch;
    await this.#put('epoch', this.#epoch);
    this.#masterEpoch = masterEpoch;
    await this.#put('masterEpoch', this.#masterEpoch);
    // Storage is gone, so the marker is gone; the alarm that was scheduled for it
    // is a separate thing and has to be dropped explicitly, or a wiped game fires
    // one to expire a marker that no longer exists.
    await this.#syncMarkerAlarm();

    this.#log({
      ts: Date.now(),
      kind: 'GAME_STATE',
      data: { state: this.#game.state, reset: true, epoch },
      visibility: 'MASTER',
    });
    await this.#put('events', this.#events);
    return this.#json({ ok: true, archive });
  }

  /**
   * R-61. A point off every player's map, and it stays off.
   *
   * It was a `$state` array in one master's browser: unpersisted, gone on
   * reload, invisible to a second master and to every player. That was a
   * recorded decision and this reverses it, which is why it arrives as its own
   * requirement rather than as a fix.
   *
   * The id is checked against the live geometry rather than trusted. Hiding an
   * id that is not a point would be harmless today and would survive a geometry
   * change into a list nobody can reconcile.
   */
  async #setPoiVisibility(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      poiId?: string;
      hidden?: boolean;
    } | null;
    if (typeof body?.poiId !== 'string' || typeof body.hidden !== 'boolean') {
      return new Response('poiId and hidden required', { status: 400 });
    }
    if (!this.#game.geo.pois.some((poi) => poi.id === body.poiId)) {
      return new Response('unknown point', { status: 404 });
    }

    const already = this.#hiddenPois.includes(body.poiId);
    if (already === body.hidden) {
      // Idempotent, and silent: a second press must not add a second line to
      // the log or a second broadcast, the same contract as declaring
      // eliminated twice.
      return this.#json({ ok: true, hiddenPois: this.#hiddenPois });
    }

    this.#hiddenPois = body.hidden
      ? [...this.#hiddenPois, body.poiId]
      : this.#hiddenPois.filter((id) => id !== body.poiId);
    await this.#put('hiddenPois', this.#hiddenPois);
    this.#log({
      ts: Date.now(),
      kind: 'POI_VISIBILITY',
      target: body.poiId,
      data: { hidden: body.hidden },
      visibility: 'MASTER',
    });
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, hiddenPois: this.#hiddenPois });
  }

  /**
   * R-71's switch, written as **the whole closed set of zones** rather than one
   * toggle.
   *
   * Three reasons, and the third is the one that decided the shape. It is
   * idempotent by construction, so a double press or a retried request cannot
   * half-apply — the same contract as declaring eliminated twice. The group
   * controls are then nothing at all on this side: closing a sector is a longer
   * list and closing a district a longer one still, so the server never learns
   * what either word means and there is no second place that can disagree with
   * `sectorsOf()` about which zones one holds. And **the zone is the unit**,
   * which is what makes "close the sector, then reopen one zone of it" an
   * obvious answer rather than a rule: a sector is closed when every zone of it
   * is, and nothing has to reconcile two sets.
   *
   * **Allowed while `IN_PROGRESS`, on purpose.** This is the one geometry
   * control that is: the area shrinking around the players is the mechanic, not
   * a configuration change to be kept away from a live game. `POST
   * /api/master/game/geo` is still refused, because that moves the zones
   * themselves and would take R-04's geofence and §4's projection with them.
   *
   * An unknown id is refused rather than ignored. Ignoring it would mean a panel
   * out of step with the geometry — a stale list after a profile change, say —
   * pressing a control that silently closes nothing, which is the hardest kind
   * of failure to see from the far end of a radio.
   */
  /**
   * R-71's boundary, recomputed. Called at the two moments its inputs move —
   * a zone switched and the geometry replaced — and nowhere else, because a
   * union over twenty-three rings is not per-projection work.
   */
  #derivePlayArea(): void {
    this.#playArea = playAreaOf(this.#game.geo.zones, this.#disabledZones);
  }

  async #setDisabledZones(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { disabled?: unknown } | null;
    if (!Array.isArray(body?.disabled) || body.disabled.some((id) => typeof id !== 'string')) {
      return new Response('disabled must be an array of zone ids', { status: 400 });
    }

    const known = new Set(this.#game.geo.zones.map((zone) => zone.id));
    const wanted = [...new Set(body.disabled as string[])];
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return new Response(`unknown zone: ${unknown.join(', ')}`, { status: 404 });
    }

    const before = new Set(this.#disabledZones);
    const closed = wanted.filter((id) => !before.has(id));
    const opened = this.#disabledZones.filter((id) => !wanted.includes(id));
    if (closed.length === 0 && opened.length === 0) {
      // Idempotent and silent: no second line in the log, no second broadcast.
      return this.#json({ ok: true, disabledZones: this.#disabledZones });
    }

    // Kept in the geometry's own order rather than the order they were pressed,
    // so two masters arriving at the same set produce the same array and the
    // replay does not show a change where none happened.
    this.#disabledZones = this.#game.geo.zones
      .map((zone) => zone.id)
      .filter((id) => wanted.includes(id));
    await this.#put('disabledZones', this.#disabledZones);
    this.#derivePlayArea();

    this.#log({
      ts: Date.now(),
      kind: 'GEOMETRY_TOGGLED',
      // The one pressed, when it was one — otherwise a sector or a district
      // went, and naming any single zone would be picking one arbitrarily.
      ...(closed.length + opened.length === 1 ? { target: closed[0] ?? opened[0]! } : {}),
      data: {
        // **The whole open set**, which is what makes the closure replayable
        // rather than a delta the replay has to fold from the start of the game.
        // See GameEvent's GEOMETRY_TOGGLED.
        active: this.#game.geo.zones
          .map((zone) => zone.id)
          .filter((id) => !this.#disabledZones.includes(id)),
        closed,
        opened,
      },
      visibility: 'MASTER',
    });
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, disabledZones: this.#disabledZones });
  }

  async #setCut(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { on?: boolean } | null;
    if (typeof body?.on !== 'boolean') return new Response('on required', { status: 400 });
    this.#game.cutSwitch = body.on;
    // Either way, the switch is the master's from here: a cut they released is
    // not one R-34b may throw back, and a cut they threw is not one it may
    // release when the game reopens.
    this.#game.cutByFinish = false;
    await this.#put('game', this.#game);
    // It logged nothing at all before. The switch rejects every ping and now
    // silences every player, and the only trace either left was a flood of
    // INGEST_REJECTED — which is the consequence, not the decision.
    this.#log({
      ts: Date.now(),
      kind: 'CUT_SWITCH',
      data: { on: this.#game.cutSwitch },
      visibility: 'MASTER',
    });
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, cutSwitch: this.#game.cutSwitch });
  }

  /**
   * Finishing a game expires everything session-shaped in one place: device
   * bindings (R-08), invite tokens, every **player** cookie already handed out —
   * the epoch bump does the last one without tracking individual sessions — and,
   * since M9, the eliminations and the frozen positions R-22 pinned to them.
   *
   * **The master's cookie is not in that list any more (R-33b).** It is signed
   * against `#masterEpoch`, which this deliberately leaves alone: the debrief is
   * a master reading a track that R-26 kept precisely so it could be read after
   * the session it came from, and making them log in first was a cost with
   * nothing on the other side of it.
   */
  async #endSession(): Promise<void> {
    this.#devices = [];
    this.#tray = [];
    this.#epoch += 1;
    /**
     * Cleared, and that is not in tension with the master surviving.
     *
     * A session that outlives the game keeps its **access**, not its view mode:
     * R-24's confirmation is the briefing, and a game ending with the panel left
     * in AUTHORITATIVE would carry that open window into a different situation
     * without anybody deciding to. The master opens it once more for the
     * debrief, and R-25b is what lets that one confirmation last (M11).
     */
    this.#viewModes = {};
    // The markers go too, with the alarm. Every socket is about to be closed and
    // every session invalidated, so a surviving marker is by definition one nobody
    // can see — and it would reappear on the first screen of the next session,
    // addressed to an audience from the last one (R-20b). An indefinite marker
    // makes this load-bearing rather than tidy: without it, one placed with no TTL
    // would outlive every game that follows (R-21c).
    this.#markers = [];
    /**
     * And the hidden points (R-61), for the reason directly below this and the
     * one above it: a decision taken during one game must not arrive in the
     * next one as a fact. A point hidden in September reappearing missing in
     * October, with nobody remembering doing it, is the same shape as the
     * elimination that used to outlive its game — and harder to notice, because
     * what it leaves behind is an absence.
     */
    this.#hiddenPois = [];
    /**
     * And the closed ground (R-71), on the argument directly above. Ground
     * closed in one game reopening the next is the safe direction; the reverse —
     * a town quietly out of play at the start of a session nobody set it for —
     * is an absence, which is the failure mode this whole block exists to avoid.
     */
    this.#disabledZones = [];
    this.#derivePlayArea();
    for (const player of this.#players) {
      delete player.deviceId;
      player.sessionToken = randomToken();
      /**
       * **Elimination does not outlive the game it happened in.**
       *
       * It used to. The roster carries across sessions by design — R-07 has it
       * configured before anyone leaves for the venue — and `eliminated` was
       * being carried with it, so a player who went out in one game started the
       * next one dead, wearing a drop point from a different date. Found eleven
       * days after the fact on a local game: a cross tracking a live phone,
       * with R-31's mark 116 m away from a session nobody remembered.
       *
       * It belongs in this list rather than in `PREPARATION` for the same
       * reason the markers above it do: FINISHED means *this session is over*,
       * and a fact about somebody's participation in it is session-shaped.
       *
       * **Safe for R-26.** Post-game replay rebuilds eliminations from
       * `track_log`, never from the live record — which is why `replayAt()`
       * reads the log in the first place, and why clearing the roster's copy
       * costs the debrief nothing.
       */
      delete player.eliminated;
      delete player.knownPosition;
      delete player.knownBattery;
    }
    await this.#put('devices', this.#devices);
    await this.#put('tray', this.#tray);
    await this.#put('players', this.#players);
    await this.#put('epoch', this.#epoch);
    await this.#put('viewModes', this.#viewModes);
    await this.#put('markers', this.#markers);
    await this.#put('hiddenPois', this.#hiddenPois);
    await this.#put('disabledZones', this.#disabledZones);
    await this.#syncMarkerAlarm();
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'game finished');
  }

  /* ---------------------------------------------------------------- */
  /* State                                                            */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* The track (R-53..R-57)                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Two SQL tables rather than two more KV keys, and the reason is arithmetic:
   * a Durable Object storage value is capped at 128 KiB, and §2.9's own volume
   * note — 6 players x 4 h at one fix per 5 s, about 17.000 points — is well
   * past that as one array. The class is SQLite-backed (`new_sqlite_classes` in
   * wrangler.toml), so `ctx.storage.sql` is the storage that was already paid
   * for, and a replay window becomes a range scan instead of a full read.
   *
   * `track_log` is the second table and it is not redundant with the `events`
   * key. That key is a **live tail capped at MAX_EVENTS**, which a four-hour
   * game will overrun — and R-56 requires the events to replay, so a replay
   * reading the tail would silently lose the beginning of its own window. The
   * key stays what every projection reads; this is what history reads.
   *
   * Idempotent, and called from `#load()` so nothing can reach a handler before
   * the tables exist.
   */
  #ensureTrackTables(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS track (
         ts INTEGER NOT NULL,
         player_id TEXT NOT NULL,
         lat REAL NOT NULL,
         lon REAL NOT NULL,
         accuracy REAL NOT NULL,
         bearing REAL,
         state TEXT NOT NULL,
         battery INTEGER,
         zone_id TEXT,
         attributes TEXT
       )`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS track_ts ON track (ts)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS track_log (
         ts INTEGER NOT NULL,
         kind TEXT NOT NULL,
         actor TEXT,
         target TEXT,
         visibility TEXT NOT NULL,
         data TEXT
       )`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS track_log_ts ON track_log (ts)`);
  }

  /**
   * One archived position, written after `applyPing()` has decided the state and
   * the zone — `sampleOf()` reads the player, not the ping, so the track records
   * what the game believed rather than a second derivation of it.
   *
   * `attributes` is passed through `sampleOf()`, which applies the allowlist. It
   * must never be the R-03 map itself: Traccar Client's status body carries an
   * FCM registration token, and R-03 keeps every parameter it does not
   * recognise (see `TRACK_ATTRIBUTES` and the note on `OsmAndStatus`).
   */
  #recordSample(player: Player, attributes: Record<string, string>): void {
    const sample = sampleOf(player, attributes);
    if (!sample) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO track (ts, player_id, lat, lon, accuracy, bearing, state, battery, zone_id, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sample.ts,
      sample.playerId,
      sample.lat,
      sample.lon,
      sample.accuracy,
      sample.bearing ?? null,
      sample.state,
      sample.battery ?? null,
      sample.zoneId ?? null,
      sample.attributes === undefined ? null : JSON.stringify(sample.attributes),
    );

    this.#sinceSweep += 1;
    if (this.#sinceSweep < TRACK_SWEEP_EVERY) return;
    this.#sinceSweep = 0;
    const cutoff = Date.now() - TRACK_RETENTION_MS;
    this.ctx.storage.sql.exec(`DELETE FROM track WHERE ts < ?`, cutoff);
    this.ctx.storage.sql.exec(`DELETE FROM track_log WHERE ts < ?`, cutoff);
  }

  /**
   * `POST /api/master/game/track` — the recorded game begins here (R-73).
   *
   * **`startedAt` is written once and never again**, on the first transition
   * into `IN_PROGRESS` there has ever been, because when a game started is a
   * fact rather than a field to keep current. `replayWindowFor()` opens the
   * scrub bar there, so a game whose object was put in progress for a pairing
   * test days before replays from the pairing test: the bar spans an afternoon
   * of nobody playing, and the night it was kept for is a fraction of it.
   *
   * So this moves the recorded start **and drops the samples before it**, in one
   * action, because either alone leaves the thing it was asked to fix. Moving
   * the start without deleting leaves a stretch of real movement one scrub
   * outside the window; deleting without moving the start leaves the bar exactly
   * as long, opening onto an empty map — `replayStartCursor()` puts the cursor
   * at the first sample, which is a cursor that cannot be scrubbed left of
   * without everybody vanishing.
   *
   * `startedAt = from` unconditionally, rather than clamped to the later of the
   * two: a master saying where the recording begins is answering a different
   * question from the one the transition answered, and an instant before the
   * press is a legitimate answer — the twenty minutes of people arriving are
   * part of the night even though the game was not running yet.
   *
   * **`track_log` is left alone, and that is deliberate.** It is events rather
   * than positions, it is small, and one of its rows is load-bearing from
   * outside the window: `#trackWindow()` reads the last `GEOMETRY_TOGGLED`
   * before `from` to know which ground was open when the window opens (R-71).
   * Deleting the log by timestamp would take it in exactly the case it exists
   * for — a district closed early and never touched again.
   *
   * Irreversible, and logged for that reason (R-26: the track outlives the
   * session, so this is an edit to the only copy of what happened).
   */
  async #trimTrack(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { from?: unknown } | null;
    const from = typeof body?.from === 'number' ? body.from : Number.NaN;
    if (!Number.isFinite(from)) {
      return new Response('from must be a timestamp in milliseconds', { status: 400 });
    }

    const refusal = trackTrimRefusal(this.#game, from, Date.now());
    if (refusal === 'IN_PROGRESS') {
      return new Response('cannot trim the track while the game is in progress', { status: 409 });
    }
    if (refusal !== undefined) {
      return new Response('from must be before the end of the recorded game', { status: 409 });
    }

    const counted = this.ctx.storage.sql
      .exec<{ removed: number }>(`SELECT count(*) AS removed FROM track WHERE ts < ?`, from)
      .toArray();
    const removed = counted[0]?.removed ?? 0;
    this.ctx.storage.sql.exec(`DELETE FROM track WHERE ts < ?`, from);

    this.#game.startedAt = from;
    this.#log({ ts: Date.now(), kind: 'TRACK_TRIMMED', data: { from, removed }, visibility: 'MASTER' });
    await this.#put('game', this.#game);
    await this.#put('events', this.#events);
    await this.#broadcast();
    return this.#json({ ok: true, from, removed });
  }

  /**
   * `GET /api/track?from&to` (§5, R-57). Master only — the gate above has
   * established that — and **`AUTHORITATIVE` only**, which is R-26 and R-57 in
   * the same sentence: full detail requires the mode, and there is no reduced
   * replay to offer instead. `OPERATIONAL` exists to withhold who is out, and a
   * replay showing a dot freeze at 21:14 says it as plainly as the field does.
   *
   * **A read, so it does not stop R-25's clock.** Scrubbing for longer than ten
   * idle minutes therefore drops the mode and the master confirms R-24 again.
   * That is the documented cost of counting actions and not reads: counting this
   * one would let the panel hold `AUTHORITATIVE` open by polling, which is the
   * failure R-25 exists to prevent. The window is fetched whole and scrubbed
   * locally, so a normal replay is one request.
   */
  #trackWindow(url: URL, session: SessionPayload): Response {
    const recipient = this.#recipient(session);
    if (recipient.kind !== 'MASTER' || !replayAllowed(recipient.viewMode, this.#game.state)) {
      return new Response('replay requires AUTHORITATIVE', { status: 403 });
    }

    const now = Date.now();
    const to = numberParam(url, 'to') ?? now;
    const from = numberParam(url, 'from') ?? to - REPLAY_DEFAULT_WINDOW_MS;
    if (!(from < to)) return new Response('from must be before to', { status: 400 });

    const rows = this.ctx.storage.sql
      .exec<TrackRow>(
        `SELECT ts, player_id, lat, lon, accuracy, bearing, state, battery, zone_id, attributes
           FROM track WHERE ts >= ? AND ts <= ? ORDER BY ts`,
        from,
        to,
      )
      .toArray();

    // No visibility filter, and that is now a decision rather than a
    // consequence. It used to be the latter — the gate admitted only
    // AUTHORITATIVE, which sees every visibility (§3, `visibleEvents()` in
    // projection.ts), so there was nothing to filter. R-57b opens the same
    // window to an OPERATIONAL master in a FINISHED game, and it opens it
    // **whole**: R-26 and R-57 say full detail is the only replay there is, and
    // a debrief with the eliminations filtered out of it is the reduced replay
    // those two refuse to invent. What that costs — the reading happens with no
    // AUTHORITATIVE_OPENED line against it — is R-57b's stated trade.
    const events = this.ctx.storage.sql
      .exec<LogRow>(
        `SELECT ts, kind, actor, target, visibility, data
           FROM track_log WHERE ts >= ? AND ts <= ? ORDER BY ts`,
        from,
        to,
      )
      .toArray();

    /**
     * One row from before the window, and only this kind (R-71, R-56).
     *
     * `GEOMETRY_TOGGLED` carries the whole open set, so a cursor can read the
     * last one at or before it and know the geometry exactly. What it cannot do
     * is read one that is not there — and a master who closed half the ground at
     * the start of a four-hour game and never touched it again produces no
     * toggle inside a window covering the last twenty minutes. The replay would then
     * fall back to the live set, which is right today and wrong the moment
     * somebody reopens it before the debrief.
     *
     * Cheap and bounded: one indexed row, and only when the window does not
     * already begin with one.
     */
    if (!events.some((row) => row.kind === 'GEOMETRY_TOGGLED')) {
      const previous = this.ctx.storage.sql
        .exec<LogRow>(
          `SELECT ts, kind, actor, target, visibility, data
             FROM track_log WHERE ts < ? AND kind = 'GEOMETRY_TOGGLED' ORDER BY ts DESC LIMIT 1`,
          from,
        )
        .toArray();
      events.unshift(...previous);
    }

    return this.#json({
      from,
      to,
      serverNow: now,
      samples: rows.map(trackSampleFromRow),
      events: events.map(gameEventFromRow),
    });
  }

  #world(): World {
    return {
      game: this.#game,
      players: this.#players,
      teams: this.#teams,
      markers: this.#markers,
      tray: this.#tray,
      events: this.#events,
      geoProfile: this.#geoProfile,
      hiddenPois: this.#hiddenPois,
      disabledZones: this.#disabledZones,
      playArea: this.#playArea,
    };
  }

  /**
   * No PING events: 17.000 per game, and positions are the track's job.
   *
   * **Two destinations, and only one of them is durable here.** The in-memory
   * array is the live tail every projection reads, and it still needs its
   * caller's `await this.#put('events', this.#events)` — nothing changed about
   * that. The `track_log` row is the archive R-56 replays from, written
   * synchronously because `sql.exec()` is synchronous, and it is what makes a
   * four-hour replay independent of `MAX_EVENTS`: the tail evicts, the archive
   * does not.
   */
  #log(event: GameEvent): void {
    this.#events.push(event);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    this.ctx.storage.sql.exec(
      `INSERT INTO track_log (ts, kind, actor, target, visibility, data) VALUES (?, ?, ?, ?, ?, ?)`,
      event.ts,
      event.kind,
      event.actor ?? null,
      event.target ?? null,
      event.visibility,
      event.data === undefined ? null : JSON.stringify(event.data),
    );
  }

  #json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  #unauthorised(): Response {
    return new Response('unauthorised', { status: 401 });
  }

  #forbidden(): Response {
    return new Response('forbidden', { status: 403 });
  }

  async #put(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      // Before anything else: #log() writes a row on the way past, and every
      // handler can log.
      this.#ensureTrackTables();
      const stored = await this.ctx.storage.get<Game>('game');
      this.#game = stored ?? seedGame(this.env.INGEST_SECRET ?? 'dev-secret');
      this.#players = (await this.ctx.storage.get<Player[]>('players')) ?? seedPlayers();
      this.#teams = (await this.ctx.storage.get<Team[]>('teams')) ?? seedTeams();
      this.#devices = (await this.ctx.storage.get<Device[]>('devices')) ?? [];
      this.#tray = (await this.ctx.storage.get<TrayEntry[]>('tray')) ?? [];
      this.#events = (await this.ctx.storage.get<GameEvent[]>('events')) ?? [];
      /**
       * The markers, and the migration off the single slot.
       *
       * A game is **seeded once** and a deploy never reseeds it, so the game
       * running in production when R-20b shipped has its marker under the old
       * `marker` key. Reading it and lifting it into the array is the whole
       * migration; the old key is deleted so this cannot happen twice.
       */
      const storedMarkers = await this.ctx.storage.get<MasterMarker[]>('markers');
      if (storedMarkers === undefined) {
        const legacy = (await this.ctx.storage.get<MasterMarker>('marker')) ?? null;
        this.#markers = legacy === null ? [] : [legacy];
        if (legacy !== null) await this.ctx.storage.put('markers', this.#markers);
        await this.ctx.storage.delete('marker');
      } else {
        this.#markers = storedMarkers;
      }
      // Markers whose TTL passed while nothing was running — a lost alarm, or an
      // alarm that never fired because the object was idle — are dropped on the
      // way in rather than left for the next placement to trip over the cap on.
      // project() withholds them anyway (see activeMarkers), so this keeps storage
      // from disagreeing with every screen.
      const live = activeMarkers(this.#markers, Date.now());
      if (live.length !== this.#markers.length) {
        this.#markers = live;
        await this.ctx.storage.put('markers', this.#markers);
      }
      this.#epoch = (await this.ctx.storage.get<number>('epoch')) ?? 1;
      /**
       * Defaults to the player epoch, not to 1 (R-33b).
       *
       * Same reasoning as the `marker` and `viewModes` migrations below: a game
       * is seeded once and a deploy does not reseed it, so the master cookies in
       * circulation when this ships were signed against `#epoch`. Starting this
       * at 1 would log out every master on a game that has finished at least
       * once, on the deploy that exists to stop doing exactly that.
       *
       * **Written back on the first load that finds it absent**, which the
       * migrations below do not need to do and this one does: `#epoch` moves at
       * `FINISHED` and this does not, so a default that keeps deferring to it
       * would follow it up on the next eviction and log the master out one cold
       * start after the game ended — the exact failure R-33b removes, arriving
       * later and looking like a session timeout.
       */
      const storedMasterEpoch = await this.ctx.storage.get<number>('masterEpoch');
      this.#masterEpoch = storedMasterEpoch ?? this.#epoch;
      if (storedMasterEpoch === undefined) await this.#put('masterEpoch', this.#masterEpoch);
      this.#hiddenPois = (await this.ctx.storage.get<string[]>('hiddenPois')) ?? [];
      this.#disabledZones = (await this.ctx.storage.get<string[]>('disabledZones')) ?? [];
      // R-25 gave the stored value a second field, so what is on disk may be a
      // bare mode string from before the idle revert existed. Lifted rather than
      // dropped, and deliberately **without** a lastActionAt: a session restored
      // across a deploy has no evidence of interaction, so an AUTHORITATIVE one
      // lands back in OPERATIONAL, which is where a closed socket should leave it.
      const storedViewModes =
        (await this.ctx.storage.get<Record<string, ViewModeSession | ViewMode>>('viewModes')) ?? {};
      const lifted = Object.entries(storedViewModes).map(
        ([sessionId, value]): [string, ViewModeSession] => [
          sessionId,
          typeof value === 'string' ? { mode: value } : value,
        ],
      );
      this.#viewModes = Object.fromEntries(lifted);
      if (lifted.some(([, value]) => value.lastActionAt === undefined)) {
        const legacy = Object.values(storedViewModes).some((value) => typeof value === 'string');
        if (legacy) await this.ctx.storage.put('viewModes', this.#viewModes);
      }
      this.#loginFailures =
        (await this.ctx.storage.get<Record<string, AttemptRecord>>('loginFailures')) ?? {};
      const storedProfile = await this.ctx.storage.get<GeoProfile>('geoProfile');
      this.#geoProfile =
        storedProfile && storedProfile in GEO_PROFILES ? storedProfile : DEFAULT_GEO_PROFILE;
      /**
       * The basemap, for the game that was seeded before there was one.
       *
       * Same reasoning as the `marker` and `viewModes` migrations above: a game
       * is seeded once and a deploy does not reseed it, so the one running in
       * production has `pmtilesUrl: ''` from before any archive existed and
       * would draw game geometry on a black background for ever. Only filled
       * when empty, so a master who pointed it at object storage keeps that.
       */
      if (stored && !this.#game.basemap.pmtilesUrl) {
        this.#game.basemap.pmtilesUrl = basemapUrlOf(this.#geoProfile);
        await this.#put('game', this.#game);
      }
      /**
       * The bundled geometry, for the game seeded before the current revision.
       *
       * Gated on the game state rather than applied unconditionally: this is the
       * one migration here that changes what the *game* is rather than how it is
       * drawn, and zones moving under players mid-game would take R-04's
       * geofence and §4's projection with them. `POST /api/master/game/geo`
       * refuses for the same reason, so this refuses on the same condition.
       *
       * The version is stored rather than the geometry compared: `game.geo` is
       * two polygons, ten rings and 33 points, and deep-equalling that on every
       * cold start to discover it has not changed is work for nothing.
       */
      const storedGeoVersion = (await this.ctx.storage.get<number>('geoVersion')) ?? 1;
      if (stored && storedGeoVersion !== GEO_VERSION && this.#game.state !== 'IN_PROGRESS') {
        const { geo, bbox } = geoOf(this.#geoProfile);
        this.#game.geo = geo;
        this.#game.basemap.bbox = bbox;
        await this.ctx.storage.put('geoVersion', GEO_VERSION);
        await this.#put('game', this.#game);
      } else if (!stored || storedGeoVersion !== GEO_VERSION) {
        // A fresh game is seeded from the current bundle by definition, and an
        // IN_PROGRESS one must be left alone — but neither should be asked
        // again on the next cold start once it is current.
        if (!stored) await this.ctx.storage.put('geoVersion', GEO_VERSION);
      }
      /**
       * The archive version, for the game that was seeded before the current one.
       *
       * Same shape as the migrations above and a harder failure than any of
       * them. `BASEMAP_VERSION` is bumped whenever an extract changes, and the
       * old path is deleted with it — but a game is seeded once, so the stored
       * URL keeps pointing at a file the deploy just removed. Under
       * `not_found_handling = single-page-application` that 404 comes back as
       * `index.html` with a **200**, and the map dies with *"wrong magic number
       * for pmtiles archive"*: a message about bytes, for a problem about
       * deployment. It happened the first time the version moved.
       *
       * Only a same-origin path under a different version is lifted, and the
       * bbox with it — the two describe one archive and a mismatched pair is a
       * camera bounded to a box the tiles do not cover. **An absolute URL is
       * left alone**, because that is a master pointing at object storage for a
       * location too big for the 25 MiB ceiling, and this has no business
       * overruling them.
       */
      const staleVersion = /^\/basemap\/v\d+\//.exec(this.#game.basemap.pmtilesUrl);
      if (stored && staleVersion && staleVersion[0] !== `/basemap/${BASEMAP_VERSION}/`) {
        this.#game.basemap.pmtilesUrl = basemapUrlOf(this.#geoProfile);
        this.#game.basemap.bbox = geoOf(this.#geoProfile).bbox;
        await this.#put('game', this.#game);
      }
      /**
       * The zoom ceiling, for the same reason and with none of the danger: a
       * game is seeded once, so raising `BASEMAP_MAX_ZOOM` would otherwise
       * reach only games created after the deploy.
       *
       * Overwriting rather than defaulting is safe **because nothing else can
       * set this**. There is no API for the ceiling on its own — the only thing
       * that writes it is the seed and `POST /api/master/game/geo`, and both
       * write this constant — so there is no master's choice here to overrule.
       * The day one exists, this has to become a comparison against the value
       * that shipped rather than a straight assignment.
       */
      if (stored && this.#game.basemap.maxZoom !== BASEMAP_MAX_ZOOM) {
        this.#game.basemap.maxZoom = BASEMAP_MAX_ZOOM;
        await this.#put('game', this.#game);
      }
      /**
       * The street names (R-69), on exactly the argument above it.
       *
       * A pure function of `geoProfile` that nothing else can write — there is
       * no API for it, and the only two places that set it are the seed and
       * `POST /api/master/game/geo`, both from `streetNamesFor()`. So there is
       * no master's choice here to overrule and a straight assignment is
       * correct, rather than the "only when empty" shape `pmtilesUrl` needs.
       *
       * It is ungated on game state on purpose, unlike `geoVersion` directly
       * above: this changes how the basemap is *drawn* and touches neither
       * `game.geo` nor the bbox, so R-04's geofence and §4's projection cannot
       * move under a player mid-game. The worst it can do is add or remove
       * labels between two frames.
       */
      if (stored && this.#game.basemap.streetNames !== streetNamesFor(this.#geoProfile)) {
        this.#game.basemap.streetNames = streetNamesFor(this.#geoProfile);
        await this.#put('game', this.#game);
      }
      /**
       * R-21d's boolean, lifted onto R-72's ladder.
       *
       * Same shape as the `marker` and `viewModes` migrations above, and the
       * same reason: a game is seeded once and a deploy does not reseed it, so
       * the one in storage still carries `extendedComms`. `true` was "your team
       * anywhere", which is 5; anything else was off, which is 3. The old key is
       * deleted, because two fields describing one setting is how they come
       * apart — and `commsReachOf()` already reads an absent value as 3, so a
       * game that somehow reaches this with neither is narrow rather than broken.
       */
      const legacy = this.#game as Game & { extendedComms?: boolean };
      if (legacy.extendedComms !== undefined || this.#game.commsReach === undefined) {
        this.#game.commsReach = legacy.extendedComms === true ? 5 : 3;
        delete legacy.extendedComms;
        await this.#put('game', this.#game);
      }
      // Last, because it reads both the geometry and the closed set and every
      // migration above can still move the first (R-71).
      this.#derivePlayArea();
      if (!stored) {
        await this.#put('game', this.#game);
        await this.#put('players', this.#players);
        await this.#put('teams', this.#teams);
        await this.#put('epoch', this.#epoch);
      }
    })();
    return this.#loaded;
  }
}

/* ------------------------------------------------------------------ */
/* Track rows (R-53..R-57)                                            */
/* ------------------------------------------------------------------ */

/**
 * The SQL side of a `TrackSample`. Snake case and nullable columns, because
 * that is what SQLite stores; the two functions below are the whole of the
 * translation, and they are here rather than in `packages/core` because a
 * storage row is an adapter concern (§6.5).
 */
interface TrackRow extends Record<string, SqlStorageValue> {
  ts: number;
  player_id: string;
  lat: number;
  lon: number;
  accuracy: number;
  bearing: number | null;
  state: string;
  battery: number | null;
  zone_id: string | null;
  attributes: string | null;
}

interface LogRow extends Record<string, SqlStorageValue> {
  ts: number;
  kind: string;
  actor: string | null;
  target: string | null;
  visibility: string;
  data: string | null;
}

function trackSampleFromRow(row: TrackRow): TrackSample {
  return {
    ts: row.ts,
    playerId: row.player_id,
    lat: row.lat,
    lon: row.lon,
    accuracy: row.accuracy,
    state: row.state as TrackSample['state'],
    ...(row.bearing === null ? {} : { bearing: row.bearing }),
    ...(row.battery === null ? {} : { battery: row.battery }),
    ...(row.zone_id === null ? {} : { zoneId: row.zone_id }),
    ...(row.attributes === null
      ? {}
      : { attributes: JSON.parse(row.attributes) as Record<string, string> }),
  };
}

function gameEventFromRow(row: LogRow): GameEvent {
  return {
    ts: row.ts,
    kind: row.kind as GameEvent['kind'],
    visibility: row.visibility as GameEvent['visibility'],
    ...(row.actor === null ? {} : { actor: row.actor }),
    ...(row.target === null ? {} : { target: row.target }),
    ...(row.data === null ? {} : { data: JSON.parse(row.data) as Record<string, unknown> }),
  };
}

/** A finite numeric query parameter, or `undefined`. A bad one is not a zero. */
function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * `/api/master/marker/<id>` → the id, or `null` for anything else.
 *
 * A marker id is generated here (`marker-<token>`), so it is URL-safe by
 * construction; anything that is not is not one of ours and gets no special
 * treatment.
 */
function markerIdFromPath(pathname: string): string | null {
  const match = /^\/api\/master\/marker\/([A-Za-z0-9_-]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * R-32's reversal, addressed by player id (§5). Same shape as the marker route
 * above and the same reasoning: a generated id is url-safe by construction.
 */
function revivePlayerIdFromPath(pathname: string): string | null {
  const match = /^\/api\/master\/players\/([A-Za-z0-9_-]+)\/revive$/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * Reads and throws away a body nothing else read. Already-consumed and absent
 * bodies both land in the no-op case, so this is safe to call on every response.
 */
async function discardUnreadBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  try {
    await request.arrayBuffer();
  } catch {
    // A stream that cannot be drained is one that is already gone. Nothing to do.
  }
}

/* ------------------------------------------------------------------ */
/* Seed configuration                                                 */
/*                                                                    */
/* PLACEHOLDER, like the geometry it reads. R-07 requires the whole    */
/* game to be configurable before anyone leaves for the venue, and the */
/* master panel now edits the roster, the teams and the geometry — so  */
/* what is left here is the first-run seed and nothing that has to be  */
/* edited by hand.                                                    */
/* ------------------------------------------------------------------ */

function seedGame(ingestSecret: string): Game {
  const { geo, bbox } = geoOf(DEFAULT_GEO_PROFILE);
  return {
    id: 'default',
    name: 'Q-4413',
    state: 'PREPARATION',
    ingestSecret,
    cutSwitch: false,
    // R-21d at its narrowest (R-72): zone scoping is the rule and every step up
    // this ladder is an exception to it.
    commsReach: 3,
    geo,
    basemap: {
      // Derived, not blank: the archive ships in the bundle at a path this
      // profile decides (R-52b), so a fresh game has a map without anybody
      // configuring one.
      pmtilesUrl: basemapUrlOf(DEFAULT_GEO_PROFILE),
      styleUrl: '/src/map/style.json',
      // The ingest area's own bounds, which is what `pmtiles extract` is given
      // (§14.2). Per location, not per deploy (§11) — and derived, so switching
      // profiles cannot leave the map framing the wrong town.
      bbox,
      maxZoom: BASEMAP_MAX_ZOOM,
      // R-69, and per location: see streetNamesFor().
      streetNames: streetNamesFor(DEFAULT_GEO_PROFILE),
    },
    config: {
      linkThresholdMs: 90_000,
      radioContactValidityMs: 300_000,
      authoritativeIdleRevertMs: 600_000,
      markerDefaultTtlMs: 300_000,
      detourFactor: 1.35,
      walkingSpeed: 1.4,
      bearingFreezeSpeed: 0.5,
      bearingSmoothing: 0.12,
      poiProximityRadius: 50,
    },
  };
}

/**
 * The seeded roster (R-07, R-27). Callsign is public and spoken on the radio;
 * fullName reaches masters only, in both view modes, and exists so a master who
 * has forgotten who a callsign belongs to can check.
 *
 * Six entries, and the two identity fields carry the same string on purpose:
 * this is a public tree and a demo, so there is nobody here to name. A real
 * game replaces this from the panel (R-07) rather than from a deploy — the
 * roster is seeded, not configured, so editing this file changes what the *next*
 * fresh game starts with and nothing about the one running.
 */
const ROSTER: ReadonlyArray<{ callsign: string; fullName: string; team: string }> = [
  { callsign: 'ALFA-1', fullName: 'ALFA-1', team: 'ALFA' },
  { callsign: 'ALFA-2', fullName: 'ALFA-2', team: 'ALFA' },
  { callsign: 'ALFA-3', fullName: 'ALFA-3', team: 'ALFA' },
  { callsign: 'BRAVO-1', fullName: 'BRAVO-1', team: 'BRAVO' },
  { callsign: 'BRAVO-2', fullName: 'BRAVO-2', team: 'BRAVO' },
  { callsign: 'BRAVO-3', fullName: 'BRAVO-3', team: 'BRAVO' },
];

const TEAM_NAMES = ['ALFA', 'BRAVO'] as const;

/**
 * Two teams, and that is a decision rather than a placeholder.
 *
 * Teams scope POI and marker audiences (R-17, R-19); they do **not** grant
 * visibility, since R-41 is explicit that a teammate in another zone is as
 * invisible as anyone else, and the only thing that changes that is a master
 * raising `CommsReach` (R-21d, R-72). With everybody in one team there is
 * nothing a team could hide from anyone, which is a neutral starting point and
 * shows nothing; with two, an audience actually discriminates and the mechanism
 * is visible. Merging back is a roster edit rather than a migration.
 */
function seedTeams(): Team[] {
  return TEAM_NAMES.map((name) => ({
    id: teamIdFor(name),
    name,
    playerIds: ROSTER.filter((entry) => entry.team === name).map((entry) =>
      playerIdFor(entry.callsign),
    ),
  }));
}

function seedPlayers(): Player[] {
  return ROSTER.map((entry) => ({
    id: playerIdFor(entry.callsign),
    callsign: entry.callsign,
    fullName: entry.fullName,
    teamId: teamIdFor(entry.team),
    // One token per player per game, invalidated when the game finishes.
    sessionToken: randomToken(),
  }));
}
