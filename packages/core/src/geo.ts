import type { District, Game, GameGeoJson, Poi, Polygon, Sector, Zone } from '@q4413/shared';

import { zoneAt } from './zones.ts';

/**
 * Reading game.geojson into the geometry the game layer uses (R-51, §11).
 *
 * One file feeds both the renderer and server-side geometry, so this is the
 * single place that decides what each featureType means. Everything geographic
 * is configuration, never code: a new location changes the file, not this.
 */

export class GameGeoError extends Error {}

function polygonOf(geo: GameGeoJson, featureType: 'PERIMETER' | 'INGEST_AREA'): Polygon {
  const matches = geo.features.filter(
    (f) => f.properties.featureType === featureType && f.geometry.type === 'Polygon',
  );
  if (matches.length !== 1) {
    throw new GameGeoError(
      `game.geojson must hold exactly one ${featureType} polygon, found ${matches.length}`,
    );
  }
  return matches[0]!.geometry as Polygon;
}

export function zonesOf(geo: GameGeoJson): Zone[] {
  return geo.features
    .filter((f) => f.properties.featureType === 'ZONE' && f.geometry.type === 'Polygon')
    .map((f) => {
      const id = f.properties.id;
      if (!id) throw new GameGeoError('every ZONE feature needs a stable id');
      /**
       * Refused rather than defaulted (R-70). A zone that fell back to a sector
       * of its own would be a zone nobody can switch off, silently, in the one
       * artefact a venue is described by — and the symptom at the venue is a
       * closure that leaves a piece of ground open with players standing on it.
       */
      const sector = f.properties.sector;
      if (!sector) throw new GameGeoError(`ZONE ${id} is in no sector`);
      return { id, name: f.properties.name ?? id, geometry: f.geometry as Polygon, sector };
    });
}

/**
 * R-70's two groupings, read off the zones that declare them.
 *
 * **Derived rather than declared separately**, so the two cannot disagree: a
 * sector is exactly the zones that name it, in file order, and a district is
 * exactly the sectors whose zones name it. There is no way to write a sector
 * listing a zone that is not in the file, and no way to write a zone in two
 * sectors, because neither sentence can be expressed.
 *
 * The one thing that *can* be written wrong is a sector whose zones disagree
 * about which district it is in, and that is refused below — it is the shape a
 * copy-paste in the generator takes, and left alone it would put one sector
 * under two group controls.
 */
export function sectorsOf(
  geo: GameGeoJson,
  zones: Zone[],
): { sectors: Sector[]; districts: District[] } {
  const properties = new Map(
    geo.features
      .filter((f) => f.properties.featureType === 'ZONE' && f.properties.id)
      .map((f) => [f.properties.id!, f.properties] as const),
  );

  const sectors: Sector[] = [];
  const bySectorId = new Map<string, Sector>();
  const districtNames = new Map<string, string>();

  for (const zone of zones) {
    const props = properties.get(zone.id);
    const district = props?.district;
    if (!district) throw new GameGeoError(`ZONE ${zone.id} is in no district`);

    const existing = bySectorId.get(zone.sector);
    if (existing) {
      if (existing.district !== district) {
        throw new GameGeoError(
          `sector ${zone.sector} is in two districts: ${existing.district} and ${district}`,
        );
      }
      existing.zoneIds.push(zone.id);
    } else {
      const sector: Sector = {
        id: zone.sector,
        name: props?.sectorName ?? zone.sector,
        district,
        zoneIds: [zone.id],
      };
      sectors.push(sector);
      bySectorId.set(sector.id, sector);
    }
    // First one wins, which is file order — the same rule the sector's own name
    // follows, and the same one `zoneAt()` uses for overlapping zones.
    if (!districtNames.has(district)) districtNames.set(district, props?.districtName ?? district);
  }

  const districts: District[] = [];
  const byDistrictId = new Map<string, District>();
  for (const sector of sectors) {
    const existing = byDistrictId.get(sector.district);
    if (existing) {
      existing.sectorIds.push(sector.id);
      continue;
    }
    const district: District = {
      id: sector.district,
      name: districtNames.get(sector.district) ?? sector.district,
      sectorIds: [sector.id],
    };
    districts.push(district);
    byDistrictId.set(district.id, district);
  }

  return { sectors, districts };
}

export function poisOf(geo: GameGeoJson): Poi[] {
  return geo.features
    .filter((f) => f.properties.featureType === 'POI' && f.geometry.type === 'Point')
    .map((f) => {
      const id = f.properties.id;
      if (!id) throw new GameGeoError('every POI feature needs a stable id');
      const [lon, lat] = (f.geometry as { coordinates: number[] }).coordinates;
      if (lon === undefined || lat === undefined) {
        throw new GameGeoError(`POI ${id} has no coordinates`);
      }
      return {
        id,
        name: f.properties.name ?? id,
        lon,
        lat,
        category: f.properties.category ?? 'OTHER',
        // Which zone an entrance opens into — see Poi.entranceTo for why this
        // is written down rather than worked out. Absent on everything else.
        ...(f.properties.entranceTo === undefined
          ? {}
          : { entranceTo: f.properties.entranceTo }),
        // Absent audience means { kind: 'all' } (§3); it is left absent rather
        // than materialised, so the default lives in exactly one place.
        ...(f.properties.audience === undefined ? {} : { audience: f.properties.audience }),
        ...(f.properties.description === undefined
          ? {}
          : { description: f.properties.description }),
      };
    });
}

/**
 * Which zone a point closes with (R-71), derived here and nowhere else.
 *
 * **An entrance is closed with the place it leads to, not the ground it stands
 * on.** Every entrance is placed exactly on the ring of the zone it serves, so
 * `booleanPointInPolygon` counts it as inside that zone *and* inside whichever
 * neighbour shares the ring — and `zoneAt()` answers with whichever comes first
 * in the file. `Poi.entranceTo` already documents that arbitrariness as the
 * reason it exists; this is the same fact used a second time, and here it
 * decides whether closing a car park takes the door into the shopping centre
 * with it.
 *
 * Derived at load rather than written into the `.geojson`, unlike the zone's own
 * sector: it is a fact about two features at once, and the file would then hold
 * an answer that has to be kept in step with the geometry that produced it.
 */
function withZone(poi: Poi, zones: Zone[]): Poi {
  const zoneId = poi.entranceTo ?? zoneAt(poi.lon, poi.lat, zones);
  return zoneId === undefined ? poi : { ...poi, zone: zoneId };
}

export function gameGeoFromGeoJson(geo: GameGeoJson): Game['geo'] {
  const zones = zonesOf(geo);
  const pois = poisOf(geo);
  /**
   * An `entranceTo` naming a zone that is not in the file is the one error here
   * that would otherwise be silent: the card falls back to printing nothing, so
   * a renamed zone id turns a working label into a missing one, in the artefact
   * a venue is described by rather than in code anybody is reading. Loud, and at
   * the only moment the two lists are in the same hand.
   */
  const known = new Set(zones.map((zone) => zone.id));
  for (const poi of pois) {
    if (poi.entranceTo !== undefined && !known.has(poi.entranceTo)) {
      throw new GameGeoError(`POI ${poi.id} is an entrance to unknown zone ${poi.entranceTo}`);
    }
  }
  const { sectors, districts } = sectorsOf(geo, zones);
  return {
    perimeter: polygonOf(geo, 'PERIMETER'),
    ingestArea: polygonOf(geo, 'INGEST_AREA'),
    zones,
    pois: pois.map((poi) => withZone(poi, zones)),
    sectors,
    districts,
  };
}

/* ------------------------------------------------------------------ */
/* The basemap's bounding box (§14.2, R-47)                           */
/* ------------------------------------------------------------------ */

/**
 * How much wider than the play area the map has to reach.
 *
 * **16:9 and 9:16 are the two shapes this is ever looked at in**, and a square
 * extract fits neither. MapLibre's `maxBounds` is set to this box, so it refuses
 * to zoom out past the point where the view would show ground outside it — which
 * means an archive only slightly larger than the perimeter cannot frame the
 * perimeter at all on a phone. The play area ends up cropped at minimum zoom,
 * which is exactly the wrong moment to crop it.
 *
 * The arithmetic: to fit a box `W × H` on a viewport of aspect `a`, the view has
 * to cover `max(W, H·a)` across and `max(H, W/a)` down. Across 16:9 and 9:16
 * that is `1,778 × max(W, H)` in **both** directions, so a square box of
 * `1,778 × max(W, H)` is the minimum that works for either orientation. 2,0
 * leaves 12% of comfort on top, which is the difference between "the perimeter
 * touches the edges" and "the perimeter sits on a map".
 */
export const BASEMAP_FRAME_FACTOR = 2;

const METRES_PER_DEGREE_LAT = 111_132;
const METRES_PER_DEGREE_LON_EQUATOR = 111_320;

function ringBounds(polygon: Polygon): [number, number, number, number] {
  const ring = polygon.coordinates[0] ?? [];
  const lons = ring.map(([lon]) => lon ?? 0);
  const lats = ring.map(([, lat]) => lat ?? 0);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/**
 * The box the basemap archive covers and `maxBounds` is set to.
 *
 * **Derived, never written down.** It used to be the ingest area's bounds, and
 * before that a literal beside the geometry — the literal meant switching
 * profiles left the map framing the other venue, and the ingest area meant the
 * play area would not fit on a phone. Both failures were the same failure: two
 * places holding one number.
 *
 * Square, centred on the perimeter, and **never smaller than the ingest area** —
 * a ping is accepted from anywhere inside that area (R-04), so a master has to
 * be able to pan to wherever one came from, and `maxBounds` is what decides
 * whether they can.
 *
 * `tools/basemap.sh` calls this to choose the extract's bbox, so the archive and
 * the camera cannot disagree about where the map ends.
 */
export function basemapBbox(
  geo: Pick<Game['geo'], 'perimeter' | 'ingestArea'>,
): [number, number, number, number] {
  const perimeter = ringBounds(geo.perimeter);
  const ingest = ringBounds(geo.ingestArea);

  const centreLat = (perimeter[1] + perimeter[3]) / 2;
  const centreLon = (perimeter[0] + perimeter[2]) / 2;
  const metresPerDegreeLon =
    METRES_PER_DEGREE_LON_EQUATOR * Math.cos((centreLat * Math.PI) / 180) || 1;

  const widthOf = (box: [number, number, number, number]): number =>
    (box[2] - box[0]) * metresPerDegreeLon;
  const heightOf = (box: [number, number, number, number]): number =>
    (box[3] - box[1]) * METRES_PER_DEGREE_LAT;

  const side = Math.max(
    BASEMAP_FRAME_FACTOR * Math.max(widthOf(perimeter), heightOf(perimeter)),
    widthOf(ingest),
    heightOf(ingest),
  );

  const halfLon = side / 2 / metresPerDegreeLon;
  const halfLat = side / 2 / METRES_PER_DEGREE_LAT;
  return [
    centreLon - halfLon,
    centreLat - halfLat,
    centreLon + halfLon,
    centreLat + halfLat,
  ];
}
