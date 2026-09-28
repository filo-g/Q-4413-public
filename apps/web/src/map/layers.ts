import type { Feature, FeatureCollection, Polygon } from '@q4413/shared';

import type { Dot, Frame } from './frame.ts';

/**
 * Frame and dots as the two GeoJSON sources the style draws (R-51).
 *
 * Pure functions, and separate from the component for the reason the rest of
 * this directory is: what can go wrong here is which features exist — a circle
 * drawn for a dot that must not have one, a POI that came from the file rather
 * than from the projection — and that is testable without a canvas.
 *
 * **`featureType` is upper case**, matching `geoJsonFromPayload()` and the
 * committed `.geojson` files. The style filters on these strings, so a case
 * mismatch renders nothing at all with no error anywhere — which is §14's
 * documented failure mode and was already latent in the starter style.
 */

export const GAME_SOURCE = 'game';
export const POSITIONS_SOURCE = 'positions';

/** The layer the map hit-tests a tap against, to know which dot was meant. */
export const DOT_LAYER = 'position-dots';

/** Metres per degree, the same local plane as `packages/core` geometry.ts. */
const METRES_PER_DEGREE_LAT = 111_132;
const METRES_PER_DEGREE_LON_EQUATOR = 111_320;

/**
 * R-12's circle as a polygon, because MapLibre's `circle` layer is sized in
 * **pixels** and this one is a claim in **metres**: a pixel radius would shrink
 * as the player zooms in, which says the uncertainty got smaller.
 *
 * 64 segments — the error against a true circle is under 0,2% of the radius,
 * which at the 403 m cap is well under a metre.
 */
export function circlePolygon(
  lon: number,
  lat: number,
  metres: number,
  steps = 64,
): Polygon {
  const latDegrees = metres / METRES_PER_DEGREE_LAT;
  const lonDegrees =
    metres / (METRES_PER_DEGREE_LON_EQUATOR * Math.cos((lat * Math.PI) / 180) || 1);
  const ring: Array<[number, number]> = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * 2 * Math.PI;
    ring.push([lon + Math.cos(angle) * lonDegrees, lat + Math.sin(angle) * latDegrees]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

/**
 * The frame's furniture as geometry: the two boundaries and the zones.
 *
 * Built from the `Frame` and never from `game.geojson`. The file holds every
 * POI, including the ones scoped to a team or one player; the frame came out of
 * `project()` and holds only what this recipient may see (§4).
 *
 * **The POIs and the master's markers are not here.** They were two `circle`
 * layers, and a circle is the one shape MapLibre draws — which left a fixed POI
 * looking like a dimmer, smaller player. They are diamonds now, and a diamond
 * that holds its size on screen has nowhere to live in this style: §14.3 leaves
 * it with no symbol layer, and geometry drawn in metres would swell as the
 * master zooms out. So they are DOM markers in `GameMap`, on the same mechanism
 * as the callsigns and R-22's cross, and nothing is emitted for them here —
 * a feature in a source no layer reads is a thing that looks drawn and is not.
 */
/**
 * A course line, from where the player is to where they said they are going.
 *
 * Two points and a straight line between them, which is exactly the claim being
 * made: **this is the direction, not the route.** The venue has walls and the
 * app has never known where they are — §14.3 strips the basemap's labels and
 * nothing here does routing — so a line that curved around a building would be
 * inventing a path nobody surveyed. R-45 already settles the same question for
 * time, where a rough walk is honest and `4:12` is not.
 *
 * Derived entirely on this side: the player's own fix and a point that was in
 * the payload from the start (R-16). Nothing is asked of the server and nothing
 * new is learned — this is the two ends of a line the player could already see.
 */
export interface Course {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
}

/**
 * Which zones to light, and why it is a parameter rather than part of the frame.
 *
 * The master's map carries no names (§14.3 leaves it one symbol layer and that
 * one is the basemap's streets), so a panel that lists a dozen sectors is an
 * index for a map that cannot label any of them — and a master who has never
 * walked the ground cannot tell one dashed outline from another. This is the
 * lookup: point at a row and the ground it names lights up, before pressing
 * anything.
 *
 * Transient, per browser, and gone on the next mouse move, which is exactly what
 * the frame is not: the frame is what `project()` decided this recipient may
 * see. Same distinction as `highlightPoi` against `Frame.pois`.
 *
 * `closed` is the other half and is not transient at all — a master's frame
 * carries the zones of closed sectors (R-71) so that the list above has ground
 * to point at, and they are drawn as ground that is out of play rather than as
 * ground. A player's frame never contains one, so the set is empty there and
 * nothing in the style fires.
 */
export function gameGeoJson(
  frame: Frame,
  course?: Course,
  marks: { highlight?: ReadonlySet<string>; closed?: ReadonlySet<string> } = {},
): FeatureCollection {
  const features: Feature[] = [
    // One feature per piece (R-71). The play area is the union of the open
    // zones, and closing the road between the two towns leaves two islands —
    // a single feature would need a MultiPolygon, and every consumer of this
    // collection already works a polygon at a time.
    ...frame.perimeter.map(
      (piece, index): Feature => ({
        type: 'Feature',
        properties: { featureType: 'PERIMETER', piece: index },
        geometry: piece,
      }),
    ),
    {
      type: 'Feature',
      properties: { featureType: 'INGEST_AREA' },
      geometry: frame.ingestArea,
    },
    ...frame.zones.map(
      (zone): Feature => ({
        type: 'Feature',
        // `highlight` is always written, never left off. MapLibre's `case` wants
        // a boolean and `["get", ...]` on a missing property answers null, which
        // is not one — the layer would fall through to its default for every
        // zone and the highlight would silently never appear.
        properties: {
          featureType: 'ZONE',
          id: zone.id,
          name: zone.name,
          highlight: marks.highlight?.has(zone.id) ?? false,
          closed: marks.closed?.has(zone.id) ?? false,
        },
        geometry: zone.geometry,
      }),
    ),
  ];
  // R-64. One feature per segment rather than one MultiLineString, so a gap is
  // structurally a gap: a MultiLineString would draw the same thing today and
  // put the decision back in reach of anything that flattens coordinates.
  for (const [index, segment] of frame.route.entries()) {
    features.push({
      type: 'Feature',
      properties: { featureType: 'ROUTE', segment: index },
      geometry: { type: 'LineString', coordinates: segment },
    });
  }
  if (course) {
    features.push({
      type: 'Feature',
      properties: { featureType: 'COURSE' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [course.from.lon, course.from.lat],
          [course.to.lon, course.to.lat],
        ],
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * The dots, and the uncertainty circles belonging to the ones that still have
 * something to say.
 *
 * Two rules, both of them R-12's:
 *
 * - a circle exists **only in `NO_LINK`**. A device that declared itself
 *   stationary has a true position, and a ring around it would invent doubt;
 * - a circle is omitted entirely once the dot is `unlocatable` — past the cap
 *   in `frame.ts` it would cover the venue and everyone else on it. The dot
 *   stays, and says on its own that it is a memory.
 *
 * And a third, which is R-22's: an eliminated player gets **a cross and nothing
 * else** — no dot and no circle. Two marks on one position read as two people,
 * and a radius around somebody who is out is clutter that grows.
 */
export function positionsGeoJson(dots: Dot[], selected?: string): FeatureCollection {
  const features: Feature[] = [];
  for (const dot of dots) {
    // No circle around somebody who is out. R-12's circle answers "where might
    // they be", and for an eliminated player that question has stopped being
    // the master's problem — while the circle itself keeps growing at walking
    // pace and, at the cap, covers the venue and everyone still playing. The
    // cross says where their feed last put them; the drop point says where they
    // declared. Neither needs a radius.
    if (dot.eliminated) continue;
    if (dot.state === 'NO_LINK' && !dot.unlocatable && dot.uncertaintyMetres > 0) {
      features.push({
        type: 'Feature',
        properties: { featureType: 'UNCERTAINTY', key: dot.key },
        geometry: circlePolygon(dot.lon, dot.lat, dot.uncertaintyMetres),
      });
    }
  }
  // After every circle, so no dot is drawn under another dot's uncertainty.
  for (const dot of dots) {
    // R-22 and R-31. An eliminated player gets **no feature in this source at
    // all** — their mark is `✕`, and a glyph has to keep its size on screen the
    // way the dots do, which geometry in metres cannot do. §14.3 leaves the
    // style with no symbol layer to put a character in, so the mark is a DOM
    // marker in GameMap, next to the callsign labels that exist for exactly the
    // same reason.
    if (dot.eliminated) continue;
    features.push({
      type: 'Feature',
      properties: {
        featureType: 'DOT',
        key: dot.key,
        label: dot.label,
        kind: dot.kind,
        state: dot.state,
        // MapLibre expressions compare against literals, and a boolean survives
        // the round trip through GeoJSON where undefined would not.
        unlocatable: dot.unlocatable,
        // Carried on the feature rather than drawn as a second source: one dot
        // is selected at a time, and a parallel source would be one more thing
        // to keep in step with the dots it is describing.
        selected: dot.key === selected,
      },
      geometry: { type: 'Point', coordinates: [dot.lon, dot.lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}
