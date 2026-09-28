import type {
  Audience,
  Game,
  GameEvent,
  MasterMarker,
  Payload,
  Player,
  CommsReach,
  Poi,
  Polygon,
  ProjectedPlayer,
  ProjectedPosition,
  Team,
  TrayEntry,
  ViewMode,
} from '@q4413/shared';

import { activeMarkers } from './marker.ts';
import { derivePositionState, distanceMetres, feedStopped } from './position-state.ts';
import {
  authoritativeExpiresAt,
  effectiveViewMode,
  type ViewModeClock,
  type ViewModeSession,
} from './view-mode.ts';

/**
 * project() — the §4 visibility matrix. THE critical piece.
 *
 * One pure function decides what every socket is allowed to hold. It is the only
 * security boundary in the system: there is no second layer behind it, and a
 * player with devtools open must not be able to see anything the UI does not
 * show them. **No message may be emitted without passing through it** — masters
 * included, since view mode is applied here.
 *
 * Two independent axes, all but never merged:
 *   - position scope is the **zone** (R-39..R-42)
 *   - marker and POI audience scope is **team or player** (R-16..R-21)
 *
 * **The one crossing between them is a setting, not a rule.** With extended comms
 * on (R-21d, R-41b) a teammate is treated as same-zone, which is the only thing
 * in the system that lets team membership touch the position axis. It is off by
 * default, it never changes what a master sees, and it reaches nobody who is not
 * on the viewer's own team.
 *
 * The §4 table is normative and every row is a test case in
 * tests/projection.test.ts across all six recipient columns.
 */

export type Recipient =
  | { kind: 'PLAYER'; playerId: string }
  | {
      kind: 'MASTER';
      viewMode: ViewMode;
      /** When this master's `AUTHORITATIVE` lapses (R-25). Only ever set by `masterRecipient()`. */
      authoritativeExpiresAt?: number;
    };

/**
 * The only way a stored master session becomes a recipient.
 *
 * R-25's revert is derived, so the stored mode is what was asked for and not
 * necessarily what is in force. Every caller goes through here rather than
 * reading the mode itself: there is one place that can forget the revert, and it
 * is this function.
 */
export function masterRecipient(
  session: ViewModeSession | undefined,
  game: ViewModeClock,
  now: number,
): Recipient {
  const viewMode = effectiveViewMode(session, game, now);
  // Absent in a finished game, where there is no deadline to count down to
  // (R-25b) — which is why the mode is asked for separately rather than inferred
  // from this being set.
  const expiresAt = viewMode === 'AUTHORITATIVE' ? authoritativeExpiresAt(session, game) : undefined;
  return {
    kind: 'MASTER',
    viewMode,
    ...(expiresAt === undefined ? {} : { authoritativeExpiresAt: expiresAt }),
  };
}

/**
 * Everything project() may read. Bundled because §3 keeps players, teams and the
 * marker outside `Game`, while §4 speaks of one projection over all of it.
 */
export interface World {
  game: Game;
  players: Player[];
  teams: Team[];
  /** Up to five, unfiltered and possibly expired; project() decides both (R-20b). */
  markers: MasterMarker[];
  tray: TrayEntry[];
  events: GameEvent[];
  /**
   * Which bundled geometry is live. Outside `Game` because §3 does not define it,
   * and threaded through here rather than read from a module so this package stays
   * free of bundled files (§6.5).
   */
  geoProfile?: string;
  /**
   * Points the master has taken off every player's map (R-61).
   *
   * Outside `Game.geo` and outside `Poi` deliberately: the geometry is
   * configuration, seeded once and shared by every game that loads the profile,
   * and this is a decision somebody made during *this* game. Putting a
   * `hidden` flag on the point would mean a master's afternoon editing the
   * venue.
   */
  hiddenPois?: string[];
  /**
   * Which zones the master has closed (R-71).
   *
   * Outside `Game.geo` for the same reason as `hiddenPois` above: the geometry is
   * configuration, seeded once and shared by every game that loads the profile,
   * and this is a decision somebody makes during *one* game. A flag on the zone
   * would mean a master's afternoon editing the venue.
   *
   * **Zones and not sectors.** The zone is the unit of ground; a sector is
   * closed when every zone of it is, and a district when every zone under it is.
   * One set rather than three is what makes "close the sector, then reopen one
   * zone of it" an obvious answer instead of a rule somebody has to remember.
   */
  disabledZones?: string[];
  /**
   * R-71's boundary, the union of the open zones, computed by the caller.
   *
   * Passed in rather than derived here because `project()` runs once per
   * recipient per broadcast and this is a polygon union over twenty-three
   * rings — work that changes only when a zone is switched or the profile
   * moves. The Durable Object recomputes it at exactly those two moments.
   *
   * Absent means nothing has been closed, which is the seeded state and reads
   * as the whole perimeter. That is the same answer the union would give, so
   * the fallback is a shortcut rather than a different rule.
   */
  playArea?: Polygon[];
}

/**
 * Event visibility (§3). MASTER_AUTHORITATIVE events exist so that opening
 * AUTHORITATIVE is itself auditable (R-25); showing them in OPERATIONAL would
 * leak the elimination state that mode is built to hide.
 */
function visibleEvents(events: GameEvent[], viewMode: ViewMode): GameEvent[] {
  if (viewMode === 'AUTHORITATIVE') return events;
  return events.filter((event) => event.visibility !== 'MASTER_AUTHORITATIVE');
}

function inAudience(audience: Audience | undefined, recipient: Recipient, player?: Player): boolean {
  // Masters see every audience, in both view modes (§4).
  if (recipient.kind === 'MASTER') return true;
  // Absent audience means { kind: 'all' } (§3); the default lives in one place.
  const scope = audience ?? { kind: 'all' as const };
  switch (scope.kind) {
    case 'all':
      return true;
    case 'team':
      return player?.teamId === scope.teamId;
    case 'player':
      return player?.id === scope.playerId;
    default:
      return false;
  }
}

/**
 * R-21d on QSA's scale (R-72), read through a function because the field is
 * optional: a game seeded before the ladder existed carries no value at all,
 * and absent has to mean 3 — the narrowest reach, which is the safe direction
 * and the default a fresh game wants anyway.
 */
export function commsReachOf(game: Pick<Game, 'commsReach'>): CommsReach {
  return game.commsReach === 4 || game.commsReach === 5 ? game.commsReach : 3;
}

/**
 * `state` is derived here, not copied (R-11). What the player record stores is the
 * claim the device last made, and a claim from eleven minutes ago is not a state —
 * a snapshot saying `MOVING` about a phone that died ten minutes back is wrong on
 * the wire, before any client gets a chance to be wrong about it. Every recipient
 * then re-derives from `ts` as time passes with no new message (R-15), so this is
 * the same arithmetic run once at send time to make the snapshot self-consistent.
 */
function positionOf(
  player: Player,
  source: 'LIVE' | 'LAST_KNOWN',
  linkThresholdMs: number,
  now: number,
): ProjectedPosition | undefined {
  if (source === 'LIVE') {
    const position = player.position;
    if (!position) return undefined;
    return {
      lat: position.lat,
      lon: position.lon,
      accuracy: position.accuracy,
      ...(position.bearing === undefined ? {} : { bearing: position.bearing }),
      // R-50's freeze gate travels with the bearing it gates, and only on a LIVE
      // position. It is the same visibility axis — a recipient who may not see
      // where somebody is does not receive this object at all.
      ...(position.speed === undefined ? {} : { speed: position.speed }),
      ts: position.ts,
      state: derivePositionState(position, linkThresholdMs, now),
      source: 'LIVE',
      ...(position.zoneId === undefined ? {} : { zoneId: position.zoneId }),
    };
  }

  const known = player.knownPosition;
  if (!known) return undefined;
  const knownZoneId = known.zoneId ?? player.position?.zoneId;
  return {
    lat: known.lat,
    lon: known.lon,
    // The uncertainty circle grows from the accuracy of the fix it is frozen at;
    // it only grows at all in NO_LINK (R-12), which the client derives from ts.
    // Falling back to the live position covers the games in storage from before
    // knownPosition carried its own — for those the two agree, because a feed that
    // stopped stopped writing both.
    accuracy: known.accuracy ?? player.position?.accuracy ?? 0,
    ts: known.ts,
    state: 'NO_LINK',
    source: 'LAST_KNOWN',
    ...(knownZoneId === undefined ? {} : { zoneId: knownZoneId }),
  };
}

/** The recipient's own record. Self sees own fullName, own live position, own elimination. */
function projectSelf(player: Player, linkThresholdMs: number, now: number): ProjectedPlayer {
  const position = positionOf(player, 'LIVE', linkThresholdMs, now);
  return {
    id: player.id,
    callsign: player.callsign,
    fullName: player.fullName,
    teamId: player.teamId,
    ...(position === undefined ? {} : { position }),
    ...(player.battery === undefined ? {} : { battery: player.battery }),
    ...(player.radioContact === undefined ? {} : { radioContact: player.radioContact }),
    ...(player.eliminated === undefined ? {} : { eliminated: player.eliminated }),
  };
}

function projectForMaster(
  player: Player,
  viewMode: ViewMode,
  config: Game['config'],
  now: number,
): ProjectedPlayer {
  const stopped = feedStopped(player, config, now);
  const authoritative = viewMode === 'AUTHORITATIVE';

  // OPERATIONAL differs from AUTHORITATIVE on exactly one axis: which position
  // source is used for players whose feed has stopped (R-22).
  const source = stopped && !authoritative ? 'LAST_KNOWN' : 'LIVE';
  const position =
    positionOf(player, source, config.linkThresholdMs, now) ??
    positionOf(player, 'LAST_KNOWN', config.linkThresholdMs, now);

  // The battery belongs to the same snapshot as the position, or it dates it. A
  // flat battery and an eliminated player report the same last value here, because
  // knownBattery stopped advancing with knownPosition; reading `battery` instead
  // would put a live percentage next to a frozen dot, which is the cause showing
  // through (R-22).
  const battery = source === 'LAST_KNOWN' ? (player.knownBattery ?? player.battery) : player.battery;

  return {
    id: player.id,
    callsign: player.callsign,
    // fullName reaches the master in both view modes (R-27).
    fullName: player.fullName,
    teamId: player.teamId,
    // Which device feeds which player is a master control, never a player's business.
    ...(player.deviceId === undefined ? {} : { deviceId: player.deviceId }),
    ...(position === undefined ? {} : { position }),
    ...(battery === undefined ? {} : { battery }),
    ...(player.radioContact === undefined ? {} : { radioContact: player.radioContact }),
    // Elimination state and drop points are hidden in OPERATIONAL (R-22, R-31):
    // knowing exactly who is out is a spoiler for a master who plays alongside.
    ...(authoritative && player.eliminated !== undefined
      ? { eliminated: player.eliminated }
      : {}),
  };
}

function projectForPlayer(
  player: Player,
  viewer: Player,
  config: Game['config'],
  now: number,
  reach: CommsReach,
  sectorOf?: (player: Player) => string | undefined,
): ProjectedPlayer {
  const sameZone =
    viewer.position?.zoneId !== undefined && player.position?.zoneId === viewer.position.zoneId;

  /**
   * R-21d and R-41b, now on R-72's ladder. A teammate within the reach is
   * treated as same-zone, and identically — position, distance, battery, link
   * state, and a place in the proximity order. One predicate rather than a
   * third branch, because a third branch is a third set of §4 rows to keep in
   * step, and this one is the security boundary.
   *
   * **The ladder only widens the team's reach**, which is why it lives entirely
   * inside this one expression. §4's zone scoping above is the same at 3, 4 and
   * 5; what changes is how far `teammateAcrossZones` looks.
   *
   * Note what it deliberately does not do: it does not reveal a teammate with no
   * zone at all differently, it does not reach a player on another team, and it
   * says nothing about elimination — the eliminated player's own view is handled
   * by the caller under R-30.4, and their record here is as silent as anyone
   * else's whose feed has stopped.
   */
  const teammateAcrossZones =
    player.teamId === viewer.teamId &&
    (reach === 5 ||
      // 4 reaches the sector and no further, so a teammate with no sector at
      // all — no fix yet, or standing on ground R-71 just closed — is not
      // reached by it. `undefined === undefined` would have said they were.
      (reach === 4 && sectorOf !== undefined && sectorOf(player) !== undefined &&
        sectorOf(player) === sectorOf(viewer)));

  if (!sameZone && !teammateAcrossZones) {
    // Callsign only. No position, no distance, no last known position, no ghost
    // marker (R-40) — and radio contact, which deliberately crosses zones (R-29).
    return {
      id: player.id,
      callsign: player.callsign,
      outOfZone: true,
      ...(player.radioContact === undefined ? {} : { radioContact: player.radioContact }),
    };
  }

  const stopped = feedStopped(player, config, now);
  const position = positionOf(player, stopped ? 'LAST_KNOWN' : 'LIVE', config.linkThresholdMs, now);

  const projected: ProjectedPlayer = {
    id: player.id,
    callsign: player.callsign,
    ...(position === undefined ? {} : { position }),
    ...(player.radioContact === undefined ? {} : { radioContact: player.radioContact }),
    // Battery, accuracy and link state travel with a same-zone position (§4).
    ...(player.battery === undefined ? {} : { battery: player.battery }),
  };

  // Elimination is never revealed to a player: to everyone else an eliminated
  // player simply becomes NO_LINK, indistinguishable from a flat battery
  // (R-30.2, R-30.3). The ambiguity is intentional and good.

  if (position && viewer.position) {
    projected.distanceMetres = Math.round(distanceMetres(viewer.position, position));
  }

  return projected;
}

/**
 * A player standing in a sector that has just been closed (R-70).
 *
 * **They keep their dot and lose their zone.** The ingest area does not move
 * with the switch, so R-04 goes on accepting their pings and the master goes on
 * seeing them normally in both view modes — this is applied on the player axis
 * only. What they lose is `zoneId`, and §4 does the rest with no new rule: they
 * are in no zone, so no player sees them and they see no player. With R-21d at 4
 * or 5 they still see their own team, which is the ladder working rather than a
 * leak.
 *
 * Their own card reads as out of play for the same reason, which is the point.
 * Players have no event feed, so a closure is told by the map, the card and
 * R-43's boundary warning, and a card still naming a sector that is no longer in
 * play would be the one surface saying nothing happened.
 *
 * The zone is dropped rather than blanked: `exactOptionalPropertyTypes` makes
 * absent and `undefined` different shapes, and absent is what "no zone" already
 * means everywhere else on this type.
 */
function onOpenGround(player: Player, openZoneIds: ReadonlySet<string>): Player {
  const zoneId = player.position?.zoneId;
  if (zoneId === undefined || openZoneIds.has(zoneId)) return player;
  const { zoneId: _closed, ...position } = player.position!;
  return { ...player, position };
}

export function project(world: World, recipient: Recipient, now: number): Payload {
  const { game, players, teams, tray, events } = world;
  // An expired marker is absent, whether or not the alarm that clears it has run
  // yet (R-21c). See activeMarkers(): an alarm is a scheduled request, it can be
  // late, and it was measured not running at all while the object was idle — a
  // marker past its TTL must not still be on a map because the platform was busy.
  const markers = activeMarkers(world.markers, now);
  const reach = commsReachOf(game);

  /**
   * R-70's switch, applied first and to everyone.
   *
   * **It is not a visibility rule.** §4 answers *who may see what*, and every
   * filter under it is per recipient; this answers *what is in play*, which is
   * the same answer for a master and a player and is why a closed sector's zones
   * and points leave the master's map too. The master's control is the sector
   * list below, not the geometry — the R-61 shape, where the list is what makes
   * a thing findable again, rather than the map.
   *
   * A point with no sector at all cannot be closed. None exists in any profile
   * today, and the alternative — treating "no sector" as closed — would make a
   * point drawn outside the zones vanish for a reason nobody could see.
   */
  const closed = new Set(world.disabledZones ?? []);
  const openZones = game.geo.zones.filter((zone) => !closed.has(zone.id));
  const openZoneIds = new Set(openZones.map((zone) => zone.id));
  const inPlay = game.geo.pois.filter((poi) => poi.zone === undefined || !closed.has(poi.zone));
  /**
   * A sector is open while **any** of its zones is, and its `zoneIds` are
   * narrowed to those — so a player is handed a sector that describes the
   * ground still in play rather than the ground that was drawn. A sector with
   * nothing left open is gone, which is what makes closing every zone of one
   * indistinguishable from closing the sector.
   */
  /**
   * Which sector a player is standing in, for R-72's level 4.
   *
   * Walked from the zone rather than carried on the player: §4 scopes by zone
   * and a sector is a grouping of zones (R-70), so the one step up belongs
   * where the geometry is. It reads `position.zoneId`, which `onOpenGround()`
   * has already cleared for anybody on ground R-71 closed — so a closure takes
   * a player out of their team's reach at 4 by the same rule that takes them
   * out of everyone's sight, with nothing here that knows about it.
   */
  const sectorByZone = new Map(game.geo.zones.map((zone) => [zone.id, zone.sector] as const));
  const sectorOf = (player: Player): string | undefined => {
    const zoneId = player.position?.zoneId;
    return zoneId === undefined ? undefined : sectorByZone.get(zoneId);
  };

  const openSectors = game.geo.sectors
    .map((sector) => ({ ...sector, zoneIds: sector.zoneIds.filter((id) => openZoneIds.has(id)) }))
    .filter((sector) => sector.zoneIds.length > 0);

  const base: Payload = {
    game: {
      id: game.id,
      name: game.name,
      state: game.state,
      cutSwitch: game.cutSwitch,
      // Sent to players too: the flag says nothing about anybody, and a player who
      // can suddenly see a teammate two zones away deserves to know why (R-21d).
      commsReach: reach,
      ...(game.startedAt === undefined ? {} : { startedAt: game.startedAt }),
      ...(game.finishedAt === undefined ? {} : { finishedAt: game.finishedAt }),
    },
    // The clock every recipient derives ages against (R-15, R-36), and the
    // constants those derivations need. Both are recipient-independent, so they
    // belong in the base rather than in each branch below.
    serverNow: now,
    config: game.config,
    // §14, R-47 and R-52. Configuration, like the block above it: a public
    // archive URL, the bounds it covers and the zoom it was cut at.
    basemap: game.basemap,
    players: [],
    teams: [],
    // Everyone sees drawn zone geometry, eliminated players included (§4, R-30.4),
    // and the perimeter, which the client needs offline for R-43. Only the zones
    // of the open sectors (R-71); the master branch below puts the closed ones
    // back, and says why.
    zones: openZones,
    sectors: openSectors,
    playArea: world.playArea ?? [game.geo.perimeter],
    perimeter: game.geo.perimeter,
    ingestArea: game.geo.ingestArea,
    pois: [],
    markers: [],
    replayAvailable: false,
  };

  if (recipient.kind === 'MASTER') {
    return {
      ...base,
      players: players.map((player) =>
        projectForMaster(player, recipient.viewMode, game.config, now),
      ),
      teams,
      /**
       * **Every point, hidden and closed alike**, which is the `hiddenPois`
       * contract applied to R-71 as well: the master is handed everything and
       * told which decisions are in force, and the panel renders the
       * consequence. `MasterView` subtracts both before it draws.
       *
       * It has to be this way round for R-56. A replay reconstructs the open
       * set at the cursor from `GEOMETRY_TOGGLED` and filters this list against
       * it — so a point closed *now* has to be here, or the debrief could never
       * show a point that was on the map twenty minutes ago and is not now.
       * Filtering here would make the past unrecoverable from the present,
       * which is the one thing a replay exists to do.
       */
      pois: game.geo.pois,
      hiddenPois: world.hiddenPois ?? [],
      // Every sector, open and closed, and the districts that group them. Same
      // reasoning as `hiddenPois` beside it: the panel's list is the only place a
      // closed sector can be opened again, so a master who stopped seeing it
      // would have nothing to press.
      sectors: game.geo.sectors,
      districts: game.geo.districts,
      disabledZones: world.disabledZones ?? [],
      /**
       * **Every zone, closed ones included**, and this is the same argument as
       * the sector list above rather than a second one: a name is not a place.
       *
       * The map carries no labels (§14.3), so a master looking at the panel's
       * list of fourteen sectors has fourteen names and no way to tell which
       * ground any of them is — and with two towns in play, a master directing
       * somebody through a district they have never walked is the normal case,
       * not the edge one. Pointing at a row has to light something, and after a
       * closure there would be nothing left to light.
       *
       * Drawn dimmed rather than the same as the rest: the panel knows which are
       * closed because `disabledZones` is right here, and every zone carries
       * its own id. The points do **not** come back with them — a point
       * is a thing to send somebody to and there is nobody to send.
       */
      zones: game.geo.zones,
      // Every marker, in both view modes (§4): a master placed them.
      markers,
      tray,
      events: visibleEvents(events, recipient.viewMode),
      viewMode: recipient.viewMode,
      // The deadline rather than the remaining time, so the panel counts down
      // from a timestamp the way every other age does (R-15, R-25).
      ...(recipient.authoritativeExpiresAt === undefined
        ? {}
        : { authoritativeExpiresAt: recipient.authoritativeExpiresAt }),
      // A master control, and master-only: a player has no use for the name of the
      // file their map came from.
      ...(world.geoProfile === undefined ? {} : { geoProfile: world.geoProfile }),
      // Post-game replay with full detail requires AUTHORITATIVE (R-26, R-57).
      replayAvailable: recipient.viewMode === 'AUTHORITATIVE',
    };
  }

  const found = players.find((player) => player.id === recipient.playerId);
  if (!found) {
    // An unknown recipient gets the map furniture and nothing about anybody.
    // Failing closed is the only safe direction for the one security boundary.
    return base;
  }
  const viewer = onOpenGround(found, openZoneIds);

  /**
   * Three filters, in order, and they are three different kinds of thing.
   *
   * R-70 is first and is not about visibility at all: a closed sector is ground
   * that is out of play, so its points are gone for everyone including the
   * master, and `inPlay` above has already dropped them. R-61 is a master
   * reaching in during a game and taking a point off **every** map at once, so
   * it is not per-recipient either. R-16..R-18 are the game's own rule about who
   * a point is addressed to, and they are the only one of the three that is.
   *
   * The order matters, and not only for tidiness. A point in a closed sector
   * must never enter `hiddenPois`: if it did, opening the sector again would not
   * bring it back, and R-61's list would fill with ids nobody chose.
   */
  const hidden = new Set(world.hiddenPois ?? []);
  const audienceOf = (poi: Poi) => inAudience(poi.audience, recipient, viewer);
  const pois = inPlay.filter((poi) => audienceOf(poi) && !hidden.has(poi.id));
  const visibleMarkers = markers.filter((marker) =>
    inAudience(marker.audience, recipient, viewer),
  );
  const ownTeam = teams.filter((team) => team.id === viewer.teamId);

  // An eliminated player keeps map furniture — POIs visible to them, a marker
  // addressed to them, zone geometry — and their own position, and loses all
  // other players (R-30.4).
  if (viewer.eliminated) {
    return {
      ...base,
      self: projectSelf(viewer, game.config.linkThresholdMs, now),
      players: [],
      teams: ownTeam,
      pois,
      markers: visibleMarkers,
    };
  }

  const others = players
    .filter((player) => player.id !== viewer.id)
    .map((player) => onOpenGround(player, openZoneIds));
  const projected = others.map((player) =>
    projectForPlayer(player, viewer, game.config, now, reach, sectorOf),
  );

  // Sorted by proximity among the players who have a position here — same zone,
  // plus teammates while extended comms is on (R-21d). The out-of-zone group
  // carries no ordering derived from position (R-42), because the distance to
  // somebody you may not see is itself information.
  const sameZone = projected
    .filter((player) => !player.outOfZone)
    .sort((a, b) => (a.distanceMetres ?? Infinity) - (b.distanceMetres ?? Infinity));
  const outOfZone = projected
    .filter((player) => player.outOfZone)
    .sort((a, b) => a.callsign.localeCompare(b.callsign));

  return {
    ...base,
    self: projectSelf(viewer, game.config.linkThresholdMs, now),
    players: [...sameZone, ...outOfZone],
    teams: ownTeam,
    pois,
    markers: visibleMarkers,
  };
}
