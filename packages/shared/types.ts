/**
 * Data model — HANDOFF-v3.md §3, verbatim.
 *
 * This file is the single source of truth for shapes crossing the wire. It is
 * runtime-agnostic on purpose (§6.5): no Cloudflare types, no DOM types.
 *
 * GeoJSON shapes are imported from the 'geojson' module rather than read off the
 * ambient `GeoJSON` namespace: TypeScript 7 does not auto-include the namespace
 * from a nested node_modules/@types, so the ambient form compiles under 6 and
 * silently degrades to `any` under 7.
 */
import type { Feature, FeatureCollection, MultiLineString, Point, Polygon } from 'geojson';

export type { Feature, FeatureCollection, MultiLineString, Point, Polygon };

export type PositionState = 'MOVING' | 'STATIONARY' | 'NO_LINK';
export type GameState = 'PREPARATION' | 'IN_PROGRESS' | 'PAUSED' | 'FINISHED';
export type ViewMode = 'OPERATIONAL' | 'AUTHORITATIVE';
export type PoiCategory = 'OBJECTIVE' | 'MEETING_POINT' | 'ENTRANCE' | 'HAZARD' | 'OTHER';

export type Audience =
  | { kind: 'all' }
  | { kind: 'team'; teamId: string }
  | { kind: 'player'; playerId: string };

export interface Game {
  id: string;
  name: string;
  state: GameState;
  startedAt?: number;
  finishedAt?: number;

  ingestSecret: string;
  cutSwitch: boolean;
  /**
   * Whether the cut above was thrown by the game finishing rather than by a
   * master (R-34b).
   *
   * It exists so the release can be as automatic as the throw and no more:
   * leaving `FINISHED` clears a cut this put on, and never one somebody put on
   * by hand. Without it the choice is between a game that starts deaf — pings
   * silently refused because the *previous* session ended — and a machine that
   * quietly undoes a master's emergency stop.
   *
   * Optional for the reason `extendedComms` is: a game is seeded, not deployed,
   * so absent has to mean "not ours", which is also what a fresh game wants.
   */
  cutByFinish?: boolean;
  /**
   * R-21d, on QSA's scale rather than as a switch (R-72).
   *
   * **Only the team's reach widens.** §4's zone scoping is untouched at every
   * level; what moves is how far a player's own team reaches:
   *
   * - **3** — §4 as built. Everyone in your zone, nobody else.
   * - **4** — and your own team anywhere in your **sector**.
   * - **5** — and your own team anywhere at all, which is R-21d exactly as it
   *   behaved when it was a boolean.
   *
   * Optional because a game is **seeded, not deployed**: the games in storage
   * were created when this was `extendedComms?: boolean`, and a deploy does not
   * reseed them. `#load()` lifts the old key — `true` becomes 5 and anything
   * else becomes 3 — and every reader goes through `commsReachOf()` rather than
   * testing the field, so absent reads as 3 wherever the migration has not run.
   */
  commsReach?: CommsReach;

  geo: {
    perimeter: Polygon; // playable area
    ingestArea: Polygon; // larger; enforced only when IN_PROGRESS
    zones: Zone[]; // static drawn areas
    pois: Poi[]; // static, always visible
    /**
     * R-70's two groupings, derived from the zones rather than stored beside
     * them: both are built by `sectorsOf()` from what each zone declares, so a
     * sector cannot list a zone that does not exist and a zone cannot be in two.
     */
    sectors: Sector[];
    districts: District[];
  };

  basemap: {
    pmtilesUrl: string;
    styleUrl: string;
    bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
    maxZoom: number;
    /**
     * Whether the basemap draws street names (R-69, §14.3).
     *
     * **Per location, not per taste.** A town is coordinated by street name
     * over the radio — "estoy en Cortijo de Mazas" is the whole message — and
     * that is what R-69 relaxed §14.3's no-symbol-layer rule for. A single
     * venue is not: the names there are a shopping centre's internal roads,
     * they land on top of the zone geometry that *is* the vocabulary, and
     * §14's hierarchy puts the basemap under the game.
     *
     * Derived from the geo profile, like `pmtilesUrl` and `bbox`, so switching
     * geometry switches this with it. It is deliberately **not** on
     * `Game.basemap`'s override route: `POST /api/master/game/basemap` exists
     * for an archive too big for the 25 MiB ceiling, which is a question about
     * where bytes live and not about what the map says.
     *
     * Optional because a game is seeded, not deployed, and **absent means
     * off** — which is §14.3's original invariant, so the stale case fails
     * back to the rule rather than through it.
     */
    streetNames?: boolean;
  };

  config: {
    linkThresholdMs: number; // 90_000
    radioContactValidityMs: number; // 300_000
    authoritativeIdleRevertMs: number; // 600_000
    markerDefaultTtlMs: number; // 300_000
    detourFactor: number; // 1.35
    walkingSpeed: number; // 1.4 m/s
    bearingFreezeSpeed: number; // 0.5 m/s
    bearingSmoothing: number; // 0.12
    poiProximityRadius: number; // m, display only
  };
}

export interface Player {
  id: string;
  callsign: string; // public
  fullName: string; // master only, both view modes (R-27)
  teamId: string;

  sessionToken: string;
  deviceId?: string;

  /** Real position as last received from the device. */
  position?: {
    lat: number;
    lon: number;
    accuracy: number;
    bearing?: number;
    speed?: number;
    /**
     * When the server received this position, UTC ms — not the fix time the
     * device reported (R-36). Everything that asks "how old is this" reads it,
     * so it has to come from the one clock the system trusts. See applyPing().
     */
    ts: number;
    state: PositionState;
    stationarySince?: number;
    zoneId?: string;
  };

  /**
   * Position the game layer knows. Frozen once the feed stops (R-22).
   *
   * A whole snapshot rather than coordinates, because `OPERATIONAL` must not be
   * able to borrow a fresher field from `position` to fill in the rest. It used to
   * carry only lat/lon/ts and take accuracy and zone from the live position, which
   * is identical for a dead phone — no pings arrive — and a spoiler for an
   * eliminated player whose phone is still on: their circle would stay tight while
   * a flat battery's grew, and they would change zone while frozen.
   *
   * `accuracy` and `zoneId` are optional for the games already in storage, which
   * were written before this was a snapshot; the readers fall back to the live
   * position, which is what those games have always done.
   */
  knownPosition?: { lat: number; lon: number; ts: number; accuracy?: number; zoneId?: string };

  /** Battery the game layer knows, frozen with knownPosition and for the same reason (R-22). */
  knownBattery?: number;

  battery?: number;
  radioContact?: { ts: number; reportedBy: string }; // playerId | 'MASTER'

  eliminated?: {
    ts: number;
    /**
     * Absent when the player had no fix at all when they declared (M6).
     *
     * R-30.5 says the drop point is recorded with exact coordinates and time, and
     * says nothing about a phone that lost GPS indoors — which is a real case, and
     * not one worth refusing a declaration over. `AUTHORITATIVE` renders the
     * absence rather than inventing a position.
     */
    dropPoint?: { lat: number; lon: number };
    selfDeclared: boolean;
  };
}

export interface Team {
  id: string;
  name: string;
  playerIds: string[];
}

/** Static. No activation, no timer, no kind. */
/**
 * How far a player's own team reaches (R-21d, R-72), on QSA's 1-to-5 scale.
 *
 * Three points and not a boolean, and **only three**: 1 and 2 are absent on
 * purpose. The scale the meter draws is a signal report, and what this app puts
 * on it is how much of the game a screen is being told — 0 is the socket being
 * down, which is not a setting, and there is nothing between "your zone" and
 * "your zone plus your team somewhere" worth a level of its own.
 */
export type CommsReach = 3 | 4 | 5;

export interface Zone {
  id: string;
  name: string;
  geometry: Polygon;
  /**
   * The `Sector['id']` this belongs to (R-70). Every zone has one.
   *
   * Not optional, and that is the whole design: §4 decides who can see whom by
   * zone, and a sector switch that had to cope with zones belonging to no
   * sector would need a fallback on the one axis of the system where a branch
   * is a visibility leak.
   */
  sector: string;
}

/**
 * A grouping of zones, and **the unit the master switches** (R-70).
 *
 * Its boundary is the union of its zones and is never drawn. That is not
 * economy, it closes a class of defect: ground inside a drawn sector but inside
 * none of its zones is ground where §4 can see nobody and nobody can be seen,
 * which was a real fault at a real venue, found on a 10 m sample and corrected
 * by hand. Derived, it cannot exist.
 *
 * A sector with nothing drawn inside it still has one zone — an area that is not
 * subdivided gets a single leaf zone covering the sector — for the same reason
 * `Zone['sector']` is required.
 */
export interface Sector {
  id: string;
  name: string;
  /** The `District['id']` this belongs to. */
  district: string;
  /** Its zones, in file order. Never empty. */
  zoneIds: string[];
}

/**
 * A grouping of sectors, and a **group control rather than a third rule**
 * (R-70).
 *
 * Nothing in §4 or R-04 reads a district: visibility is by zone, the switch is
 * by sector, and this exists so that closing a town is one press instead of
 * thirteen. Keeping it out of the rules is what stops it becoming a second place
 * that can disagree about who sees what.
 */
export interface District {
  id: string;
  name: string;
  /** Its sectors, in file order. Never empty. */
  sectorIds: string[];
}

export interface Poi {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: PoiCategory;
  /**
   * Which zone this is an entrance **to**, for `category: 'ENTRANCE'`.
   *
   * It cannot be derived, and the attempt is instructive.
   *
   * An entrance is placed **exactly on the ring of the zone it serves** — its
   * own note says so. `booleanPointInPolygon` counts a boundary as inside, so
   * such a point is inside its target *and* inside whatever neighbour it also
   * sits in, and `zoneAt()` answers with whichever comes first in the file. The
   * containing zone is therefore not merely unhelpful here, it is
   * **arbitrary**: reordering the features would relabel it.
   *
   * Nor does a ring of samples fix it. That finds the neighbours but not which
   * of them is the *destination* — the same 5 m step separates one entrance from
   * the place it opens into and another from a car park nobody is walking
   * towards. The distinction is semantic and geometry does not carry it.
   *
   * It was already written down twice, in the id — `poi-acceso-norte` — and in
   * the note beside it. This makes the same fact readable by something
   * other than a person, rather than teaching the app to parse an id, which is
   * meant to be opaque, or a sentence, which is meant for a human.
   *
   * Absent on every other category, and absent is not a defect: only an entrance
   * leads somewhere.
   */
  entranceTo?: string; // Zone['id']
  /**
   * The `Zone['id']` this point closes with (R-71). **Derived, never drawn.**
   *
   * `gameGeoFromGeoJson()` fills it: the zone the point falls in, or — for an
   * entrance — the zone it opens **into**. That second rule is not a nicety.
   * Every entrance sits exactly on the ring of the zone it serves, so it is
   * geometrically inside its target *and* inside whatever neighbour shares that
   * ring, and `zoneAt()` answers with whichever comes first in the file: see
   * `entranceTo` above, where the same arbitrariness is spelt out. An entrance
   * is closed with the place it leads to.
   *
   * Absent means the point belongs to no zone and no switch can close it. No
   * such point exists in any profile today — all thirty-four, five and
   * thirty-three fall inside one — but the shape has to say what happens if one
   * is ever drawn outside the zones.
   */
  zone?: string;
  audience?: Audience; // defaults to { kind: 'all' }
  description?: string;
}

/**
 * Up to five exist at a time, globally (R-20b). A sixth is refused rather than
 * replacing anything, so nothing ever leaves a player's map because the master
 * placed something else.
 */
export interface MasterMarker {
  id: string;
  label: string;
  lat: number;
  lon: number;
  audience: Audience;
  placedAt: number;
  /**
   * Absent means **no expiry** (R-21c): the marker stays until the master clears
   * it, or until the session ends and takes everything with it (R-08).
   *
   * Optional rather than `number | null` so an indefinite marker carries no field
   * at all — there is then no value for a reader to compare against `now` by
   * mistake, and `markerExpired()` is the only thing that decides the question.
   */
  expiresAt?: number;
}

export interface Device {
  id: string; // Traccar Client device id
  playerId?: string; // absent while unpaired
  firstSeen: number;
  lastSeen: number;
  pings: number;
  gameId: string; // expires with the game (R-08)
}

/**
 * One archived position (R-53..R-57). Written per accepted ping, read back as a
 * window by `GET /api/track`.
 *
 * `ts` is the server's receive time (R-36), the same clock everything else in
 * the system is measured against. The device's own fix time is parsed by R-03
 * and discarded, and it stays discarded here: two clocks in one table is an
 * ordering bug waiting for the first phone whose own is wrong.
 */
export interface TrackSample {
  ts: number;
  playerId: string;
  lat: number;
  lon: number;
  accuracy: number;
  bearing?: number;
  state: PositionState;
  battery?: number;
  /**
   * Beyond §3, and worth the byte: the zone is decided by `applyPing()` at
   * ingest (R-39), and re-deriving it during replay would be a second
   * implementation of the thing that decides who can see whom.
   */
  zoneId?: string;
  /**
   * R-03's unrecognised parameters, **filtered by an allowlist and never taken
   * whole** — see `TRACK_ATTRIBUTES` in `packages/core/src/track.ts` and the
   * hazard note on `OsmAndStatus` below. M8 was planned around this field holding
   * "the R-03 attribute map"; it is not that map, on purpose.
   */
  attributes?: Record<string, string>;
}

export interface GameEvent {
  ts: number;
  kind:
    | 'PING'
    | 'ELIMINATION'
    | 'ELIMINATION_REVERSED'
    | 'RADIO_CONTACT'
    | 'MARKER_PLACED'
    | 'MARKER_EXPIRED'
    /**
     * Not in §3's list, and added for the reason GEO_PROFILE was: R-21d's setting
     * rewrites who can see whom (§4) with nothing on any screen to say it
     * happened, so the log is the only place it can be audited afterwards.
     * Folding it into GAME_STATE would make the log lie about what changed.
     */
    | 'EXTENDED_COMMS'
    | 'PERIMETER'
    | 'MESSAGE'
    | 'DEVICE_SEEN'
    | 'DEVICE_PAIRED'
    /**
     * Not in §3's list, and added rather than folded into GAME_STATE. §3 was
     * written when there was one geometry per deploy; a game that can be switched
     * between a venue and a test area needs the switch to be auditable, since it
     * silently rewrites which zone every player is in and therefore who can see
     * whom (§4). Logging it as a game-state change would make the log lie about
     * what happened.
     */
    | 'GEO_PROFILE'
    /**
     * Which `.pmtiles` archive the map draws (§14.4). Added for the same reason
     * as GEO_PROFILE: it is configuration that changes what everyone sees, on a
     * different schedule from a deploy, and the log is the only place it can be
     * audited afterwards.
     */
    | 'BASEMAP'
    /**
     * Also not in §3, and for the same reason: the roster was a literal in the
     * Worker when §3 was written. R-07 makes it configuration, and a player
     * appearing or disappearing changes who is on every map and who holds a valid
     * invite link, which is worth a line in the log.
     */
    | 'ROSTER'
    | 'AUTHORITATIVE_OPENED'
    /**
     * The other end of R-25's audit trail. `AUTHORITATIVE_OPENED` alone leaves
     * every window in the log open-ended, so a master cannot show when they
     * stopped seeing real information about eliminated players — which is the
     * question the log exists to answer.
     */
    | 'AUTHORITATIVE_REVERTED'
    | 'GAME_STATE'
    /**
     * R-34's cut switch, thrown or released. Not folded into GAME_STATE for the
     * reason GEO_PROFILE and EXTENDED_COMMS are not: the cut is explicitly
     * **independent of state**, so recording it as a state change would make the
     * log say something that did not happen. It halts every player's feed and
     * rejects every ping, and neither of those leaves a trace anywhere else — the
     * rejections do, one per ping, which is the flood rather than the fact.
     */
    | 'CUT_SWITCH'
    /**
     * R-61. A point disappearing from every player's map is a change to what the
     * game looks like, made by one person, with nothing on any screen to say who
     * or when — the same argument that gave EXTENDED_COMMS and GEO_PROFILE their
     * own kinds. `target` is the point; `data.hidden` is which way.
     */
    | 'POI_VISIBILITY'
    /**
     * R-71. Ground opened or closed, and **`data.active` is the whole set of
     * open zones, not the ones that moved**.
     *
     * That is not redundancy, it is what makes the closure replayable.
     * `replayAt()` says in as many words that the live geometry is safe to
     * replay *because* `POST /api/master/game/geo` is refused while the game is
     * `IN_PROGRESS` — and R-70 stops that being true, since a sector may be
     * closed mid-game on purpose. An event naming only the sector touched would
     * leave the replay reconstructing the set by folding every event from the
     * start of the window, which fails the moment the window does not reach the
     * start of the game. Carrying the set lets the cursor read the last one
     * before it, the way `stateAt()` already reconstructs eliminations and radio
     * contact.
     *
     * Same shape, and the same reason, as `MARKER_PLACED` having to start
     * carrying `lat`/`lon` in M8. `target` is the zone, when exactly one moved;
     * a sector or a district going is several at once and naming any of them
     * would be picking one arbitrarily.
     */
    | 'GEOMETRY_TOGGLED'
    /**
     * R-73. The recorded game was cut back to `data.from`, and everything
     * before it dropped from the track.
     *
     * **The one event that records a deletion**, which is why it exists rather
     * than the trim being silent: R-26 makes the track outlive the session that
     * produced it, so a master who removes part of it is editing the only copy
     * of what happened. `data.removed` is how many samples went, and the row
     * itself sits after the cut and therefore survives it.
     *
     * `MASTER`, not `MASTER_AUTHORITATIVE`: it is housekeeping on the archive,
     * and it says nothing about who was where.
     */
    | 'TRACK_TRIMMED'
    | 'INGEST_REJECTED';
  actor?: string;
  target?: string;
  data?: Record<string, unknown>;
  visibility: 'MASTER' | 'MASTER_AUTHORITATIVE' | 'TEAM' | 'ALL';
}

/* ------------------------------------------------------------------ */
/* Game geometry file (R-51)                                          */
/*                                                                    */
/* geo/game.geojson feeds both the renderer and server-side geometry.  */
/* Every feature carries featureType so one file can serve both.       */
/* ------------------------------------------------------------------ */

export type FeatureType = 'PERIMETER' | 'INGEST_AREA' | 'ZONE' | 'POI';

export interface GameFeatureProperties {
  featureType: FeatureType;
  /** Stable id. Zones and POIs need one; perimeter and ingest area do not. */
  id?: string;
  name?: string;
  /** POI only. */
  category?: PoiCategory;
  /** POI `ENTRANCE` only: the `Zone['id']` it opens into. See Poi.entranceTo. */
  entranceTo?: string;
  /**
   * ZONE only (R-70): the sector and district it belongs to, and their names.
   *
   * **Resolved onto every zone rather than declared once**, which is redundant
   * in a way the rest of this file is not. The reason is that the `.geojson` is
   * the only copy anybody reads: it is hand-maintained, it travels on its own,
   * and a location is a file rather than code (§11) — so a grouping that lived
   * in a generator would be a fact about the venue kept somewhere the venue's
   * file does not go.
   */
  sector?: string;
  sectorName?: string;
  district?: string;
  districtName?: string;
  /** POI only. Absent means { kind: 'all' }. */
  audience?: Audience;
  description?: string;
  /** Free-form note; placeholder geometry is flagged here. */
  note?: string;
}

export type GameFeature = Feature<Polygon | Point, GameFeatureProperties>;
export type GameGeoJson = FeatureCollection<
  Polygon | Point,
  GameFeatureProperties
>;

/* ------------------------------------------------------------------ */
/* Ingest wire shapes (R-01..R-06)                                    */
/* ------------------------------------------------------------------ */

/**
 * A ping that carries no position at all.
 *
 * Traccar Client posts one when its location service starts, and what it carries
 * depends on the build. Captured from a real phone on 2026-09-01, one shape is a
 * push-token registration and nothing else:
 *
 *     id=<device>&notificationToken=<FCM registration token>
 *
 * No coordinates, no battery, no fix time. Other builds send bodies of a size
 * consistent with the position minus its coordinate pair, which would carry a
 * battery; `battery` is optional here so both are handled without guessing which
 * arrives.
 *
 * It is a report that the phone is **on**, not a report of where it is, and that
 * distinction is load-bearing rather than pedantic: a status report may update a
 * device, and may never update a position. See `applyStatus()`.
 *
 * ## The attribute map holds a credential, and nothing may persist it
 *
 * `notificationToken` is unrecognised by R-03, so it lands in `attributes` — and
 * an FCM registration token is a per-device push credential, not telemetry.
 * Nothing stores it today: `applyPing()` deliberately drops `attributes`, and
 * `applyStatus()` reads only the battery.
 *
 * **This is a live hazard for M8.** R-03 parks unrecognised parameters in
 * `attributes` and `TrackSample` was earmarked for exactly that map, so a track
 * writer that persists attributes wholesale will write push credentials into the
 * game's history. Whatever M8 keeps has to be an allowlist, not the map.
 */
export interface OsmAndStatus {
  deviceId: string;
  /** Server-side receive time, UTC ms. Clocks are never taken from clients (R-36). */
  receivedAt: number;
  battery?: number;
  /** R-03's unrecognised parameters, kept whole. */
  attributes: Record<string, string>;
}

/**
 * One decoded Traccar Client ping. `attributes` holds every parameter the
 * protocol sent that R-03 does not consume — kept here, and deliberately not
 * stored: `applyPing()` drops the map, and OsmAndStatus explains why that has
 * become a rule rather than a tidiness preference.
 */
export interface OsmAndPing {
  deviceId: string;
  lat: number;
  lon: number;
  /** Server-side receive time, UTC ms. Clocks are never taken from clients (R-36). */
  receivedAt: number;
  /** Fix time, UTC ms. Falls back to receivedAt when the device sent none. */
  ts: number;
  accuracy?: number;
  /** Sole heading source (R-50). */
  bearing?: number;
  /** Gates bearing validity only. Never used for ETAs. */
  speed?: number;
  battery?: number;
  isMoving?: boolean;
  activity?: 'still' | 'walking' | 'in_vehicle' | (string & {});
  event?: 'motionchange' | 'heartbeat' | (string & {});
  attributes: Record<string, string>;
}

export type PingRejection =
  | { reason: 'MISSING_FIELD'; field: string }
  | { reason: 'BAD_NUMBER'; field: string; value: string }
  | { reason: 'GAME_FINISHED' }
  | { reason: 'CUT_SWITCH' }
  | { reason: 'OUTSIDE_INGEST_AREA'; lat: number; lon: number };

/**
 * Unpaired device tray entry (R-06). A ping with an unknown id lands here.
 *
 * Not a §3 type: §3 defines `Device`, for bindings that already exist. The tray
 * is what the master pairs *from*, so it carries what helps tell one anonymous
 * phone from another — including battery and accuracy, which would otherwise be
 * decoded and thrown away until the device had an owner.
 */
export interface TrayEntry {
  deviceId: string;
  firstSeen: number;
  lastSeen: number;
  lat: number;
  lon: number;
  pings: number;
  battery?: number;
  accuracy?: number;
}

/* ------------------------------------------------------------------ */
/* Projected payloads (§4)                                            */
/*                                                                    */
/* What a socket is allowed to hold, not what the server knows. Every  */
/* field here survived project(); anything absent was withheld, and    */
/* the absence is the point — a player with devtools open must not be  */
/* able to see anything the UI does not show them.                     */
/* ------------------------------------------------------------------ */

/** Which position a projected player carries, and therefore how to draw it. */
export type PositionSource = 'LIVE' | 'LAST_KNOWN';

export interface ProjectedPosition {
  lat: number;
  lon: number;
  accuracy: number;
  bearing?: number;
  /**
   * R-50's freeze gate, and nothing else. The requirement makes freezing the
   * bearing below `bearingFreezeSpeed` mandatory, and this is the only input it
   * has: the alternative — deriving speed from consecutive fixes — was measured
   * at 10,73 m/s for a walk down a corridor, so it decides a 0,5 m/s threshold
   * at random.
   *
   * Never an ETA (R-45 forbids instantaneous speed), and `LAST_KNOWN` carries
   * none: a position frozen ten minutes ago has no current speed to report, and
   * a stale one would rotate the camera on the strength of a dead reading.
   */
  speed?: number;
  ts: number;
  state: PositionState;
  source: PositionSource;
  zoneId?: string;
}

/** Another player, as one recipient may see them. */
export interface ProjectedPlayer {
  id: string;
  callsign: string;
  /** Master only, in both view modes (R-27). Never on a player socket. */
  fullName?: string;
  /** Present for the recipient's own record and for masters. */
  teamId?: string;
  /** Master only: the pairing tray is a master control (R-06, R-07, R-59). */
  deviceId?: string;
  position?: ProjectedPosition;
  battery?: number;
  /** Crosses zone boundaries on purpose: liveness, not location (R-29). */
  radioContact?: { ts: number; reportedBy: string };
  /** Metres, same-zone players only. Never for the out-of-zone group (R-42). */
  distanceMetres?: number;
  /** Callsign-only group at the end of the list (R-40). */
  outOfZone?: boolean;
  /** Master AUTHORITATIVE, and the eliminated player's own record. */
  eliminated?: { ts: number; dropPoint?: { lat: number; lon: number }; selfDeclared: boolean };
}

export interface Payload {
  game: {
    id: string;
    name: string;
    state: GameState;
    cutSwitch: boolean;
    /**
     * R-21d / R-72, sent to players as well as masters. The level says nothing
     * about anybody — it is the reason a teammate in another zone is on their
     * screen, and a player who can see one deserves to know why rather than
     * concluding the zone rules broke. It is also what the QSA meter draws.
     */
    commsReach: CommsReach;
    startedAt?: number;
    finishedAt?: number;
  };
  /**
   * When the server built this snapshot, UTC ms.
   *
   * R-15 has the client derive position ages locally and R-36 forbids trusting a
   * client clock; both hold at once only if the client is told what time it is by
   * the authority. It rides on a snapshot that was being sent anyway, so it costs
   * nothing and needs no tick (§6.3).
   */
  serverNow: number;
  /**
   * The §3 tuning block, verbatim. The client cannot apply R-11's threshold,
   * R-12's circle, R-43's boundary warnings or R-45's ETA without it, and all
   * four are specified as client-side work.
   *
   * Sent whole rather than filtered per recipient: every field is a tuning
   * constant that says nothing about the game or anybody in it, so withholding
   * the two a player has no use for would be theatre, and one shape is one fewer
   * thing for M4 and M5 to keep in step.
   */
  config: Game['config'];
  /**
   * §14's basemap, verbatim, for the same reason as `config`: R-47 needs the
   * bounds and the zoom range, R-52's service worker needs the archive's URL,
   * and neither is derivable from anything else on the wire.
   *
   * Public by nature — it is an R2 object every client fetches directly and a
   * bounding box already drawn on the screen — so it is recipient-independent
   * like the geometry beside it.
   */
  basemap: Game['basemap'];
  /** The recipient's own record, when the recipient is a player. */
  self?: ProjectedPlayer;
  /** Everyone else the recipient may see, same-zone first (R-42). */
  players: ProjectedPlayer[];
  /** Own team for a player, all teams for a master. */
  teams: Team[];
  /**
   * Audience-filtered (R-16..R-18), R-61-filtered for a player, and R-70-filtered
   * for everybody — the three run in that order and are different kinds of thing.
   */
  pois: Poi[];
  /**
   * Which points the master has taken off every map (R-61). **Master only**, and
   * it has to be: a player is told what they can see, never what is being kept
   * from them, so sending this to one would be a list of the places they are not
   * being shown — which is more information than the unfiltered list was.
   *
   * The points themselves are still in `pois` above for a master, because the
   * list is the only place a hidden point can be found again and turned back on.
   */
  hiddenPois?: string[];
  /** Everyone sees zone geometry (§4), of the sectors that are open (R-70). */
  zones: Zone[];
  /**
   * The sectors these zones belong to (R-70).
   *
   * **Open ones for a player, every one for a master**, and that asymmetry is
   * R-61's exactly: the panel's list is the only place a closed sector can be
   * found again and opened, so a master who stopped seeing it would have nothing
   * to press. A player is told what is in play, never what has been taken out of
   * it.
   */
  sectors: Sector[];
  /**
   * The group control (R-70). **Master only**, with `disabledZones`, because
   * together they are the control surface and a player has no use for either —
   * their card names a sector, and that name is already on `sectors` above.
   */
  districts?: District[];
  /**
   * Which zones are closed right now (R-71). **Master only**, same reasoning as
   * `hiddenPois`: a player is told what they can see, never what is being kept
   * from them.
   *
   * Zones and not sectors, because the zone is the unit: a sector is closed when
   * every zone of it is, and a district when every zone of every sector is. One
   * set rather than three means "close the sector, then reopen one zone of it"
   * has an obvious answer instead of a rule.
   */
  disabledZones?: string[];
  /**
   * Public geometry, needed by every client and offline: the perimeter drives the
   * client-side boundary warnings (R-43) and both frame the map (R-47).
   *
   * `perimeter` is the whole recinto and **does not move** with R-71's switch —
   * it is what the archive was cut to (§14.2), and an archive that shrank with a
   * master's decision would be a download the phones cannot redo at the venue.
   */
  perimeter: Polygon;
  ingestArea: Polygon;
  /**
   * Where play actually stops right now (R-71): the union of the open zones.
   *
   * **This is what the map draws and what R-43 warns about**, and `perimeter`
   * above is what frames them. Two boundaries because they answer two
   * questions — how far the map reaches, and how far the game does — and before
   * sectors could close they happened to be the same polygon.
   *
   * A list rather than one polygon, because closing the road between the two
   * towns leaves two islands and there is no reason a master may not. Empty when
   * every zone is closed, which is a state a master can reach: nothing is in
   * play, so there is no boundary to warn about.
   */
  playArea: Polygon[];
  /**
   * The live markers this recipient is in the audience of (R-20b), soonest expiry
   * first, with the indefinite ones last. Never more than five, and each one has
   * already survived both audience filtering and its own TTL.
   */
  markers: MasterMarker[];
  /** Master only. */
  tray?: TrayEntry[];
  /**
   * Master only, filtered by `visibility`. Player-visible events (messages,
   * elimination) arrive with the milestones that introduce them — M5 and M6 —
   * rather than being invented here.
   */
  events?: GameEvent[];
  /** Master only. */
  viewMode?: ViewMode;
  /**
   * When this master's `AUTHORITATIVE` lapses (R-25), absent in `OPERATIONAL`.
   *
   * A deadline and not a remaining time, because it is derived rather than
   * counted down on the server (§6.3): the client subtracts `serverNow` the same
   * way it does for position ages and marker expiry.
   */
  authoritativeExpiresAt?: number;
  /**
   * Which bundled geometry is live. Master only: it is a control, and a player has
   * no use for the name of the file their map came from.
   */
  geoProfile?: string;
  /** Master AUTHORITATIVE only (R-26, R-57). */
  replayAvailable: boolean;
}

/* ------------------------------------------------------------------ */
/* WebSocket messages (§5)                                            */
/*                                                                    */
/* Server to client only. Clients send presence pings; everything that */
/* mutates state goes over HTTP so it stays idempotent and auditable.  */
/* ------------------------------------------------------------------ */

/**
 * Server to client. Every payload here has been through project() (§4): a
 * socket holds what its recipient may see and nothing more.
 *
 * ## One message, where §5 lists five
 *
 * §5's surface has `positions`, `event`, `marker` and `game` alongside
 * `snapshot`, and this deliberately implements only `snapshot`. The four others
 * are deltas, and a delta is a second way to compute what a recipient may hold.
 *
 * That is the part that decides it. §4 is the only security boundary in the
 * system and its hard rule is that no message is emitted without passing through
 * `project()` — with one shape there is exactly one code path that can leak, and
 * it is the one every test covers. A `marker` delta, for instance, would have to
 * re-derive audience membership at send time: correct today, and the obvious
 * place for a bug the day somebody adds an audience kind.
 *
 * What it costs is bandwidth, and the arithmetic says not much: a projected
 * snapshot for this game is a few kB, they are sent on ping arrival rather than
 * on a tick (§6.3), and R-15 has the client age its own dots between them. The
 * deltas become worth their risk when a snapshot stops being cheap — a replay
 * scrubber (M8) streaming positions is the case that will ask.
 *
 * R-21's "vanish from the audience's map" is met by the broadcast that follows
 * the expiry alarm: every socket gets a fresh projection with `marker: null`.
 */
export type WsServerMessage = { t: 'snapshot'; payload: Payload };
