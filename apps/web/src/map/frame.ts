import { activeMarkers, derivePositionState, uncertaintyRadiusMetres } from '@q4413/core';
import type {
  District,
  MasterMarker,
  Payload,
  Poi,
  PositionState,
  Polygon,
  Sector,
  TrayEntry,
  Zone,
} from '@q4413/shared';

/**
 * What the drawing components need, taken from a projected payload.
 *
 * Nothing here reads game.geojson: that file holds every POI, including the ones
 * scoped to a team or a single player, and a renderer that reads it directly
 * would draw what §4 says the viewer cannot see. The payload has already been
 * filtered — so drawing it faithfully is enough.
 */
export interface Frame {
  /**
   * Where play stops **now** (R-71), which is the union of the open zones and
   * not `Game.geo.perimeter`.
   *
   * A list, because closing the road between the two towns leaves two islands.
   * Everything downstream treats it as a set: the style draws one feature per
   * piece, R-43 takes the nearest boundary across all of them, and "inside"
   * means inside any one.
   *
   * Empty when every zone is closed. That is a state a master can reach, and it
   * means what it says: nothing is in play and there is no boundary to warn
   * about.
   */
  perimeter: Polygon[];
  ingestArea: Polygon;
  zones: Zone[];
  pois: Poi[];
  /**
   * Where players were when they declared (R-30.5, R-31), for the master in
   * `AUTHORITATIVE` and nobody else — the same gate as `Dot.eliminated`, and for
   * the same reason: the payload does not carry the record otherwise.
   *
   * Frame furniture rather than a dot, because it is a **place**, not a person.
   * A player is somewhere now; a drop point is where one stopped being anywhere,
   * and drawing it as another dot would put two of the same callsign on the map.
   *
   * A record with no `dropPoint` is a player who had no fix when they declared
   * (M6) and simply contributes nothing here.
   */
  dropPoints: Array<{ id: string; label: string; lat: number; lon: number }>;
  /**
   * The markers this recipient is in the audience of (R-20b) whose TTL has not
   * passed (R-21c). Both decisions were made in project(); drawing whatever is
   * here is the whole of the client's share.
   */
  markers: MasterMarker[];
  /**
   * Where the selected player has been, up to the cursor (R-64). Segments, split
   * wherever the feed was not there to draw across — `routeAt()` in core decides
   * both, and this carries the answer.
   *
   * **A field here rather than a question the map asks.** A route exists only
   * during a replay, which makes it the first thing that does — and R-53's whole
   * design is that nothing below the panel's one fallback knows whether a replay
   * is running. So the panel supplies it and `GameMap` draws what it is given,
   * exactly as it does with markers it did not decide the audience of. An
   * `if (replay.active)` inside the map is the fork this milestone records as
   * its risk.
   *
   * Empty in every other case, including live, which is why it needs no flag.
   */
  route: Array<Array<[number, number]>>;
}

export type DotKind = 'SELF' | 'PLAYER' | 'DEVICE';

export interface Dot {
  key: string;
  label: string;
  lat: number;
  lon: number;
  kind: DotKind;
  /**
   * Derived here rather than taken from the payload (R-11, R-15). The snapshot's
   * own `state` was true when it was built; a dot redrawn a minute later without a
   * new snapshot has to age on its own.
   */
  state: PositionState;
  /** R-12's radius in metres. Equal to the fix accuracy unless the dot is NO_LINK. */
  uncertaintyMetres: number;
  /**
   * The circle has stopped saying anything and must not be drawn — the dot
   * still must. See `UNCERTAINTY_CAP_METRES`.
   */
  unlocatable: boolean;
  /**
   * R-22 and R-31, and **the gate is upstream of this field**.
   *
   * An eliminated player's dot keeps moving for a master in `AUTHORITATIVE`,
   * which is the mode's whole purpose — and until M9 it moved looking exactly
   * like a live one, so the one thing the master switched modes to find out was
   * the one thing the map would not tell them.
   *
   * This is only ever true where `project()` sent an `eliminated` record, which
   * it does for a master in `AUTHORITATIVE` and for the eliminated player's own
   * record (R-30.4). In `OPERATIONAL` the field is simply absent and every dot
   * is a circle, which is R-22 working rather than a drawing that failed.
   */
  eliminated: boolean;
}

/**
 * Where R-12's growing circle stops being a drawing, in metres of radius.
 *
 * `uncertaintyRadiusMetres()` is `accuracy + walkingSpeed × age` and grows
 * without limit, on purpose: an hour of silence honestly means "anywhere", and
 * its own docblock says that clamping for rendering is the map's business. This
 * is that business.
 *
 * **500 m — half the perimeter's short axis**, which for every bundled profile
 * is a 1 km square. Past it one circle spans more than half the play area in its
 * narrow direction and has stopped discriminating between anywhere and anywhere
 * else, while covering the map and the other players underneath it. R-12's
 * arithmetic reaches it after about 5,8 minutes of silence; the whole diagonal
 * goes under one circle at about 8, and with six players there would be nothing
 * left to look at.
 *
 * A constant rather than a derivation from whichever perimeter is live. That
 * holds only while every profile is the same order of scale, which is the
 * condition `tests/frame.test.ts` checks rather than assumes: it asserts this is
 * a meaningful fraction of *every* committed perimeter's short axis. **Add a
 * profile an order of magnitude away and this goes back to being half the live
 * perimeter's short axis** — the rule is the proportion, and 500 m is its value
 * here.
 */
export const UNCERTAINTY_CAP_METRES = 500;

/**
 * @param now on the server's clock (`game.serverNow`), for the marker's TTL — the
 *            same reason every other age here is measured against it (R-36).
 */
export function frameOf(
  payload: Payload,
  now: number,
  route: Array<Array<[number, number]>> = [],
): Frame {
  return {
    route,
    // R-71: the live boundary, never the fixed one. `payload.perimeter` is the
    // whole recinto and is what the archive was cut to (§14.2); it frames the
    // map and does not say where the game stops.
    perimeter: payload.playArea,
    ingestArea: payload.ingestArea,
    zones: payload.zones,
    pois: payload.pois,
    // Read off whatever records carry an elimination, which is exactly the set
    // §4 allowed through. No second decision is taken here and none should be.
    dropPoints: [payload.self, ...payload.players].flatMap((player) =>
      player?.eliminated?.dropPoint
        ? [
            {
              id: player.id,
              label: player.callsign,
              lat: player.eliminated.dropPoint.lat,
              lon: player.eliminated.dropPoint.lon,
            },
          ]
        : [],
    ),
    // R-21c, derived here as well as on the server, for the same reason NO_LINK is
    // (R-15): the absence of a message is not something to wait for. The server
    // withholds expired markers from every projection and broadcasts when the
    // alarm clears them — but a client that is simply sitting there, with nothing
    // arriving, would go on drawing what it was last sent. Measured on a local
    // Worker: with no request touching the object, the expiry alarm did not run at
    // all, and the marker only disappeared on the next snapshot. In production a
    // ping every five seconds hides that; a client that decides for itself does
    // not need it hidden. An indefinite marker survives this untouched.
    markers: activeMarkers(payload.markers, now),
  };
}

/**
 * Only positions that survived projection get drawn. An out-of-zone player has
 * no position in the payload, so there is nothing to accidentally render as a
 * ghost marker (R-40).
 *
 * @param now on the server's clock (R-36), which is `game.serverNow`, never
 *            `Date.now()` — the states below are decided by a 90 s threshold and
 *            a device clock is not accurate enough to decide it.
 */
export function dotsOf(payload: Payload, now: number, tray: TrayEntry[] = []): Dot[] {
  const dots: Dot[] = [];
  const config = payload.config;
  const push = (dot: Omit<Dot, 'unlocatable'>): void => {
    dots.push({ ...dot, unlocatable: dot.uncertaintyMetres > UNCERTAINTY_CAP_METRES });
  };

  if (payload.self?.position) {
    push({
      key: payload.self.id,
      label: payload.self.callsign,
      lat: payload.self.position.lat,
      lon: payload.self.position.lon,
      kind: 'SELF',
      state: derivePositionState(payload.self.position, config.linkThresholdMs, now),
      uncertaintyMetres: uncertaintyRadiusMetres(payload.self.position, config, now),
      eliminated: payload.self.eliminated !== undefined,
    });
  }

  for (const player of payload.players) {
    if (!player.position) continue;
    push({
      key: player.id,
      label: player.callsign,
      lat: player.position.lat,
      lon: player.position.lon,
      kind: 'PLAYER',
      state: derivePositionState(player.position, config.linkThresholdMs, now),
      uncertaintyMetres: uncertaintyRadiusMetres(player.position, config, now),
      eliminated: player.eliminated !== undefined,
    });
  }

  for (const entry of tray) {
    push({
      key: entry.deviceId,
      label: entry.deviceId,
      lat: entry.lat,
      lon: entry.lon,
      kind: 'DEVICE',
      // An unpaired device is not a player and has no link state to speak of; it
      // is drawn so a master can see a stray tracker, and R-12 is about players.
      state: derivePositionState(
        { ts: entry.lastSeen, state: 'MOVING' },
        config.linkThresholdMs,
        now,
      ),
      uncertaintyMetres: entry.accuracy ?? 0,
      // A tracker is not a person and cannot be out of the game.
      eliminated: false,
    });
  }

  return dots;
}

export function ringOf(polygon: Polygon): Array<[number, number]> {
  return (polygon.coordinates[0] ?? []).map(([lon, lat]) => [lon ?? 0, lat ?? 0]);
}

/**
 * Which zones a master's map leaves out because their whole **district** is
 * closed (R-71).
 *
 * A closed *sector* stays on the map, dim, because the panel row naming it has
 * to have ground to point at — §14.3 leaves the map without labels, so a name
 * with nothing to light is a name and nothing else. A closed **town** is
 * different in kind: thirteen dim outlines around somewhere nobody is playing
 * is the map describing what is not happening, and it costs most at exactly the
 * scale it appears. The two towns are 2,85 km apart, so with one district shut
 * the half still in play is the smaller half of the frame and the empty one
 * crowds it.
 *
 * Nothing is lost by those rows having nothing to light: a whole district is one
 * press to reopen. **Except while the master is pointing at one**, which is what
 * `pointedAt` is for — the list stays an index rather than becoming a column of
 * names that do nothing.
 *
 * A district with no sectors at all is not "entirely closed"; `every()` on an
 * empty list is true, and a geometry that produced one would otherwise vanish.
 * `sectorsOf()` cannot build one, which is precisely why the guard is here
 * rather than trusted.
 */
export function zonesOutOfPlay(
  districts: readonly District[],
  sectors: readonly Sector[],
  disabledZones: readonly string[],
  pointedAt: readonly string[] = [],
): Set<string> {
  const closed = new Set(disabledZones);
  const lit = new Set(pointedAt);
  const zonesOf = new Map(sectors.map((sector) => [sector.id, sector.zoneIds] as const));

  const dropped = new Set<string>();
  for (const district of districts) {
    if (district.sectorIds.length === 0) continue;
    const zoneIds = district.sectorIds.flatMap((id) => zonesOf.get(id) ?? []);
    // A district with no ground under it is not "entirely closed" either, for
    // the reason the empty sector list is not: `every()` on nothing is true.
    if (zoneIds.length === 0) continue;
    if (!zoneIds.every((id) => closed.has(id))) continue;
    for (const zoneId of zoneIds) {
      if (!lit.has(zoneId)) dropped.add(zoneId);
    }
  }
  return dropped;
}
