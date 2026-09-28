import {
  activeMarkers,
  applyPing,
  authoritativeLapsed,
  basemapBbox,
  commsReachOf,
  cutSwitchOnStateChange,
  declareEliminated,
  eliminationOpen,
  gameGeoFromGeoJson,
  placeMarker,
  playAreaOf,
  playerIdFor,
  reviveEliminated,
  sampleOf,
  teamIdFor,
  type Roster,
  type RosterResult,
  type World,
} from '@q4413/core';
import type {
  Game,
  GameEvent,
  GameGeoJson,
  GameState,
  MasterMarker,
  Player,
  Polygon,
  TrackSample,
  Team,
  ViewMode,
} from '@q4413/shared';
// The tool's own walk, imported rather than reimplemented — see tools/walk.mjs
// for why those functions live in a file of their own.
import { mulberry32, randomPointInRing, ringOf, walkStep } from '../../../../tools/walk.mjs';

/**
 * The demo's stand-in for `GameDurableObject`'s state.
 *
 * **It holds a `World` and nothing else clever.** Every decision about who may
 * see what is `project()`'s, unchanged, in `packages/core` — the same function
 * the Worker calls — which is what makes this a demo of the app rather than a
 * drawing of one. What is reimplemented here is the orchestration the Durable
 * Object does around it: storage, the seed, the five master actions, and the
 * broadcast. None of that is game logic and none of it may become game logic.
 *
 * Anything that genuinely needs a server is absent rather than faked. See
 * `server.ts` for the list and what each one answers.
 */

/* ------------------------------------------------------------------ */
/* The bundled geometry (§11)                                          */
/* ------------------------------------------------------------------ */

/**
 * The profiles, **passed in** rather than imported here.
 *
 * The files are read with Vite's `?raw`, and a query specifier is a thing only a
 * bundler understands — `tsconfig.tests.json` compiles plain TypeScript and
 * cannot read one, which is the same reason `map-worker.ts` sits beside `map/`
 * rather than in it. Keeping the import in one leaf module (`profiles.ts`) is
 * what lets the root suite construct this object and exercise the five actions
 * without a browser.
 */
export type GeoProfiles = Readonly<Record<string, string>>;

const DEFAULT_GEO_PROFILE = 'madrid';
const BASEMAP_VERSION = 'v3';
const BASEMAP_MAX_ZOOM = 19;

/** Every bundled profile is a city centre, so every one draws street names (R-69). */
const streetNamesFor = (_profile: string): boolean => true;

const basemapUrlOf = (profile: string): string =>
  `/basemap/${BASEMAP_VERSION}/${profile}.pmtiles`;

/* ------------------------------------------------------------------ */
/* The seed                                                            */
/* ------------------------------------------------------------------ */

/**
 * Six records in two teams, and the two identity fields carry the same string:
 * this is a public demo and there is nobody here to name. It is the Worker's
 * seed, kept in step by hand — the Worker's own is unreachable from a browser,
 * since `game-do.ts` imports `cloudflare:workers`.
 */
const ROSTER: ReadonlyArray<{ callsign: string; team: string }> = [
  { callsign: 'ALFA-1', team: 'ALFA' },
  { callsign: 'ALFA-2', team: 'ALFA' },
  { callsign: 'ALFA-3', team: 'ALFA' },
  { callsign: 'BRAVO-1', team: 'BRAVO' },
  { callsign: 'BRAVO-2', team: 'BRAVO' },
  { callsign: 'BRAVO-3', team: 'BRAVO' },
];

const TEAM_NAMES = ['ALFA', 'BRAVO'];

/** Fixed, so a reload puts everybody back where the last one left them. */
const WALK_SEED = 4413;
/** One step every five seconds at 1,4 m/s, which is R-45's walking speed. */
export const TICK_MS = 5_000;
const STEP_METRES = 7;

function seedGame(profile: string, geo: Game['geo'], bbox: [number, number, number, number]): Game {
  return {
    id: 'demo',
    name: 'Q-4413',
    /**
     * `PREPARATION`, which is what the Worker's own seed does — and here it is
     * also what makes the demo work on arrival. Two of the things a visitor
     * comes to try are refused while a game is `IN_PROGRESS`, on purpose and in
     * both servers: swapping the geometry would move the zones under the players
     * and take R-04's geofence and §4's projection with them, and editing the
     * roster mid-game would take somebody's invite link. Starting the game is
     * one press on the panel, and the refusals are worth seeing too.
     */
    state: 'PREPARATION',
    // Not a secret and not used: nothing ingests here, and `/i/` answers 501.
    ingestSecret: 'demo',
    cutSwitch: false,
    commsReach: 3,
    geo,
    basemap: {
      pmtilesUrl: basemapUrlOf(profile),
      styleUrl: '/src/map/style.json',
      bbox,
      maxZoom: BASEMAP_MAX_ZOOM,
      streetNames: streetNamesFor(profile),
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

const seedTeams = (): Team[] =>
  TEAM_NAMES.map((name) => ({
    id: teamIdFor(name),
    name,
    playerIds: ROSTER.filter((entry) => entry.team === name).map((entry) =>
      playerIdFor(entry.callsign),
    ),
  }));

const seedPlayers = (): Player[] =>
  ROSTER.map((entry) => ({
    id: playerIdFor(entry.callsign),
    callsign: entry.callsign,
    fullName: entry.callsign,
    teamId: teamIdFor(entry.team),
    // The invite path is what `/j/<token>` redeems, which in the demo is how a
    // visitor gets to look at the player's own view.
    sessionToken: `demo-${playerIdFor(entry.callsign)}`,
    battery: 60 + ((ROSTER.indexOf(entry) * 7) % 35),
  }));

/* ------------------------------------------------------------------ */
/* The object                                                          */
/* ------------------------------------------------------------------ */

export type Session =
  | { kind: 'MASTER'; sessionId: string }
  | { kind: 'PLAYER'; playerId: string };

interface Walker {
  lon: number;
  lat: number;
  heading: number;
  random: () => number;
}

/** What survives a reload. Deliberately small: geometry is rebuilt from the bundle. */
interface Persisted {
  geoProfile: string;
  state: GameState;
  cutSwitch: boolean;
  commsReach: 3 | 4 | 5;
  hiddenPois: string[];
  disabledZones: string[];
  markers: MasterMarker[];
  session: Session | null;
}

const STORAGE_KEY = 'q4413-demo';

export class DemoWorld {
  game!: Game;
  players!: Player[];
  teams!: Team[];
  markers: MasterMarker[] = [];
  events: GameEvent[] = [];
  geoProfile = DEFAULT_GEO_PROFILE;
  hiddenPois: string[] = [];
  disabledZones: string[] = [];
  playArea: Polygon[] = [];
  viewModes: Record<string, { mode: ViewMode; lastActionAt?: number }> = {};
  session: Session | null = null;
  /** R-53's archive, in memory. Trimmed to the window a demo can possibly want. */
  track: TrackSample[] = [];

  readonly profiles: GeoProfiles;
  readonly profileNames: string[];

  #walkers = new Map<string, Walker>();
  #listeners = new Set<() => void>();
  #ring: Array<[number, number]> = [];
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(profiles: GeoProfiles) {
    this.profiles = profiles;
    this.profileNames = Object.keys(profiles);
    const stored = read();
    this.geoProfile =
      stored && stored.geoProfile in profiles
        ? stored.geoProfile
        : (this.profileNames.includes(DEFAULT_GEO_PROFILE)
            ? DEFAULT_GEO_PROFILE
            : this.profileNames[0]!);
    const { geo, bbox } = this.geoOf(this.geoProfile);
    this.game = seedGame(this.geoProfile, geo, bbox);
    this.players = seedPlayers();
    this.teams = seedTeams();
    if (stored) {
      this.game.state = stored.state;
      this.game.cutSwitch = stored.cutSwitch;
      this.game.commsReach = stored.commsReach;
      this.hiddenPois = stored.hiddenPois;
      this.disabledZones = stored.disabledZones;
      this.markers = stored.markers;
      this.session = stored.session;
    }
    this.#reseat();
    this.derivePlayArea();
  }

  geoOf(profile: string): {
    geo: Game['geo'];
    bbox: [number, number, number, number];
    raw: GameGeoJson;
  } {
    const raw = JSON.parse(this.profiles[profile]!) as GameGeoJson;
    const geo = gameGeoFromGeoJson(raw);
    return { geo, bbox: basemapBbox(geo), raw };
  }

  /* -- the world project() is given -------------------------------- */

  world(): World {
    return {
      game: this.game,
      players: this.players,
      teams: this.teams,
      markers: this.markers,
      tray: [],
      events: this.events,
      geoProfile: this.geoProfile,
      hiddenPois: this.hiddenPois,
      disabledZones: this.disabledZones,
      playArea: this.playArea,
    };
  }

  derivePlayArea(): void {
    this.playArea = playAreaOf(this.game.geo.zones, this.disabledZones);
  }

  /* -- the walk ---------------------------------------------------- */

  /**
   * Puts every player back inside the live perimeter. Called on the seed and on
   * every profile change, because a profile change moves the ground out from
   * under them — the Worker recomputes their zone for the same reason, and here
   * there is no phone to walk them across a city.
   */
  #reseat(): void {
    const { raw } = this.geoOf(this.geoProfile);
    this.#ring = ringOf(raw, 'PERIMETER') as Array<[number, number]>;
    this.#walkers.clear();
    const now = Date.now();
    this.players.forEach((player, index) => {
      const random = mulberry32(WALK_SEED + index);
      const [lon, lat] = randomPointInRing(this.#ring, random) as [number, number];
      this.#walkers.set(player.id, { lon, lat, heading: random() * 360, random });
      this.#apply(player, lon, lat, now);
    });
  }

  /**
   * One ping's worth of movement, through `applyPing()` — the same function the
   * ingest endpoint calls. The zone hold (R-15), the stationary run (R-11) and
   * R-22's freeze therefore behave here exactly as they do in a game, rather
   * than being approximated by writing `position` directly.
   */
  #apply(player: Player, lon: number, lat: number, now: number): void {
    const updated = applyPing(
      player,
      {
        deviceId: `demo-${player.id}`,
        lat,
        lon,
        receivedAt: now,
        ts: now,
        accuracy: 8,
        isMoving: true,
        attributes: {},
      },
      { zones: this.game.geo.zones, linkThresholdMs: this.game.config.linkThresholdMs },
    );
    Object.assign(player, updated);
  }

  tick(): void {
    const now = Date.now();
    for (const player of this.players) {
      const walker = this.#walkers.get(player.id);
      if (!walker) continue;
      // An eliminated player has stopped walking, which is also what R-22's
      // freeze expects to see. Nothing else about them is special-cased.
      if (player.eliminated) continue;
      const next = walkStep(
        { lon: walker.lon, lat: walker.lat, heading: walker.heading },
        { ring: this.#ring, metres: STEP_METRES, random: walker.random },
      ) as Walker;
      walker.lon = next.lon;
      walker.lat = next.lat;
      walker.heading = next.heading;
      this.#apply(player, next.lon, next.lat, now);
      this.record(player);
    }
    this.broadcast();
  }

  /** R-53's archive, through `sampleOf()` so `TRACK_ATTRIBUTES` stays the only writer. */
  record(player: Player): void {
    const sample = sampleOf(player, {});
    if (!sample) return;
    this.track.push(sample);
    // A demo is not a four-hour game. One hour of six players at this cadence is
    // about 4.300 rows, which is the most a replay here can ever ask for.
    const cutoff = Date.now() - 60 * 60_000;
    if (this.track.length > 6_000) this.track = this.track.filter((row) => row.ts >= cutoff);
  }

  start(): void {
    this.#timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  /* -- the log ----------------------------------------------------- */

  log(event: GameEvent): void {
    this.events.push(event);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }

  /* -- broadcast --------------------------------------------------- */

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  broadcast(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Every mutation ends here: persist what survives a reload, then push. */
  commit(): void {
    save({
      geoProfile: this.geoProfile,
      state: this.game.state,
      cutSwitch: this.game.cutSwitch,
      commsReach: commsReachOf(this.game),
      hiddenPois: this.hiddenPois,
      disabledZones: this.disabledZones,
      markers: this.markers,
      session: this.session,
    });
    this.broadcast();
  }

  /* -- the actions ------------------------------------------------- */

  setGeoProfile(profile: string): void {
    const { geo, bbox } = this.geoOf(profile);
    this.geoProfile = profile;
    this.game.geo = geo;
    // Both lists are ids belonging to the geometry they came from, so both go —
    // the same reason the Worker clears them, spelled out in #setGeoProfile.
    this.hiddenPois = [];
    this.disabledZones = [];
    this.derivePlayArea();
    this.game.basemap.bbox = bbox;
    this.game.basemap.pmtilesUrl = basemapUrlOf(profile);
    this.game.basemap.streetNames = streetNamesFor(profile);
    this.#reseat();
    this.log({
      ts: Date.now(),
      kind: 'GEO_PROFILE',
      data: { profile, zones: geo.zones.length },
      visibility: 'MASTER',
    });
  }

  setDisabledZones(wanted: string[]): { closed: string[]; opened: string[] } {
    const before = new Set(this.disabledZones);
    const closed = wanted.filter((id) => !before.has(id));
    const opened = this.disabledZones.filter((id) => !wanted.includes(id));
    if (closed.length === 0 && opened.length === 0) return { closed, opened };

    this.disabledZones = this.game.geo.zones
      .map((zone) => zone.id)
      .filter((id) => wanted.includes(id));
    this.derivePlayArea();
    this.log({
      ts: Date.now(),
      kind: 'GEOMETRY_TOGGLED',
      ...(closed.length + opened.length === 1 ? { target: closed[0] ?? opened[0]! } : {}),
      data: {
        active: this.game.geo.zones
          .map((zone) => zone.id)
          .filter((id) => !this.disabledZones.includes(id)),
        closed,
        opened,
      },
      visibility: 'MASTER',
    });
    return { closed, opened };
  }

  setPoiVisibility(poiId: string, hidden: boolean): boolean {
    if (this.hiddenPois.includes(poiId) === hidden) return false;
    this.hiddenPois = hidden
      ? [...this.hiddenPois, poiId]
      : this.hiddenPois.filter((id) => id !== poiId);
    this.log({
      ts: Date.now(),
      kind: 'POI_VISIBILITY',
      target: poiId,
      data: { hidden },
      visibility: 'MASTER',
    });
    return true;
  }

  place(input: Parameters<typeof placeMarker>[0], id: string, now: number) {
    this.markers = activeMarkers(this.markers, now);
    const result = placeMarker(
      input,
      {
        players: this.players,
        teams: this.teams,
        ingestArea: this.game.geo.ingestArea,
        config: this.game.config,
        existing: this.markers,
      },
      id,
      now,
    );
    if (result.ok) {
      this.markers.push(result.value);
      this.log({
        ts: now,
        kind: 'MARKER_PLACED',
        target: result.value.id,
        data: {
          label: result.value.label,
          lat: result.value.lat,
          lon: result.value.lon,
          audience: result.value.audience,
          ...(result.value.expiresAt === undefined
            ? { indefinite: true }
            : { expiresAt: result.value.expiresAt }),
          live: this.markers.length,
        },
        visibility: 'MASTER',
      });
    }
    return result;
  }

  clearMarkers(id: string | undefined, now: number): MasterMarker[] | null {
    const live = activeMarkers(this.markers, now);
    const removed = id === undefined ? live : live.filter((marker) => marker.id === id);
    if (id !== undefined && removed.length === 0) return null;
    this.markers = live.filter((marker) => !removed.includes(marker));
    for (const marker of removed) {
      this.log({
        ts: now,
        kind: 'MARKER_EXPIRED',
        target: marker.id,
        data: { label: marker.label, cleared: true },
        visibility: 'MASTER',
      });
    }
    return removed;
  }

  setGameState(state: GameState): void {
    const previous = this.game.state;
    this.game.state = state;
    const cut = cutSwitchOnStateChange(state, { ...this.game, state: previous });
    if (cut !== null) {
      this.game.cutSwitch = cut.cutSwitch;
      this.game.cutByFinish = cut.cutByFinish;
    }
    if (state === 'IN_PROGRESS' && this.game.startedAt === undefined) {
      this.game.startedAt = Date.now();
    }
    if (state === 'FINISHED') this.game.finishedAt = Date.now();
    this.log({
      ts: Date.now(),
      kind: 'GAME_STATE',
      data: { from: previous, to: state },
      visibility: 'ALL',
    });
  }

  /* -- roster, which is `packages/core`'s and not this file's ------- */

  roster(): Roster {
    return { players: this.players, teams: this.teams };
  }

  applyRoster<T extends { roster: Roster }>(result: RosterResult<T>): RosterResult<T> {
    if (result.ok) {
      this.players = result.value.roster.players;
      this.teams = result.value.roster.teams;
    }
    return result;
  }

  eliminate(playerId: string, now: number): boolean {
    if (!eliminationOpen(this.game)) return false;
    const player = this.players.find((candidate) => candidate.id === playerId);
    if (!player) return false;
    const updated = declareEliminated(player, now);
    if (updated === player) return false;
    this.players = this.players.map((candidate) =>
      candidate.id === playerId ? updated : candidate,
    );
    this.log({
      ts: now,
      kind: 'ELIMINATION',
      target: playerId,
      data: { selfDeclared: true },
      visibility: 'MASTER_AUTHORITATIVE',
    });
    return true;
  }

  revive(playerId: string, now: number): boolean {
    const player = this.players.find((candidate) => candidate.id === playerId);
    if (!player?.eliminated) return false;
    this.players = this.players.map((candidate) =>
      candidate.id === playerId ? reviveEliminated(candidate) : candidate,
    );
    this.log({
      ts: now,
      kind: 'ELIMINATION_REVERSED',
      target: playerId,
      visibility: 'MASTER_AUTHORITATIVE',
    });
    return true;
  }

  radioContact(playerId: string, reportedBy: string, now: number): boolean {
    const player = this.players.find((candidate) => candidate.id === playerId);
    if (!player) return false;
    player.radioContact = { ts: now, reportedBy };
    this.log({
      ts: now,
      kind: 'RADIO_CONTACT',
      target: playerId,
      actor: reportedBy,
      visibility: 'ALL',
    });
    return true;
  }

  /* -- R-25's revert, applied the way the Worker applies it --------- */

  revertLapsedViewModes(now: number): void {
    for (const [sessionId, session] of Object.entries(this.viewModes)) {
      if (!authoritativeLapsed(session, this.game, now)) continue;
      this.viewModes[sessionId] = { mode: 'OPERATIONAL' };
      this.log({
        ts: now,
        kind: 'AUTHORITATIVE_REVERTED',
        actor: sessionId,
        visibility: 'MASTER_AUTHORITATIVE',
      });
    }
  }

  reset(): void {
    clear();
    this.geoProfile = this.profileNames.includes(DEFAULT_GEO_PROFILE)
      ? DEFAULT_GEO_PROFILE
      : this.profileNames[0]!;
    const { geo, bbox } = this.geoOf(this.geoProfile);
    this.game = seedGame(this.geoProfile, geo, bbox);
    this.players = seedPlayers();
    this.teams = seedTeams();
    this.markers = [];
    this.events = [];
    this.track = [];
    this.hiddenPois = [];
    this.disabledZones = [];
    this.viewModes = {};
    this.#reseat();
    this.derivePlayArea();
  }
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/*                                                                     */
/* `localStorage` and nothing else, which is the whole of what this     */
/* demo keeps. It is per browser and reachable by nobody: there is no   */
/* server here, so a visitor's closures, markers and hidden points are  */
/* theirs and are never anybody else's.                                 */
/* ------------------------------------------------------------------ */

/**
 * Whether there is a browser to store in at all. The root suite drives this
 * object under Node, where a `localStorage` global exists and warns on every
 * touch — and where nothing should be persisted between tests anyway.
 */
const inBrowser = (): boolean => 'document' in globalThis;

function read(): Persisted | null {
  if (!inBrowser()) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as Persisted);
  } catch {
    // Private windows, blocked site data, a shape from an older build. A demo
    // that refuses to start because its saved state is unreadable is worse than
    // one that starts fresh.
    return null;
  }
}

function save(state: Persisted): void {
  if (!inBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota, or a browser that does not allow it. Nothing here is worth failing for.
  }
}

function clear(): void {
  if (!inBrowser()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // As above.
  }
}
