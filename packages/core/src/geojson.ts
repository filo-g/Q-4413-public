import type { GameGeoJson, Payload } from '@q4413/shared';

/**
 * The GeoJSON a client gets from `GET /api/geo` (§5), built from a projected
 * payload rather than from the file on disk.
 *
 * This matters: game.geojson holds **every** POI, including the ones scoped to a
 * team or a single player. Serving the file directly would hand a player POIs
 * that §4 says are not theirs — a bypass of the one security boundary, through
 * the door marked "it is only configuration". Everything here has already been
 * through project().
 */
export function geoJsonFromPayload(payload: Payload): GameGeoJson {
  return {
    type: 'FeatureCollection',
    features: [
      /**
       * The live boundary (R-71), one feature per piece, and **not**
       * `payload.perimeter` — that is the whole recinto, which the archive was
       * cut to and which does not move with the switch. Closing the road between
       * the two towns leaves two islands, so a single feature would need a
       * MultiPolygon and every reader of this collection works one polygon at a
       * time.
       */
      ...payload.playArea.map((piece, index) => ({
        type: 'Feature' as const,
        properties: {
          featureType: 'PERIMETER' as const,
          name: payload.playArea.length > 1 ? `Perimetro ${index + 1}` : 'Perimetro',
        },
        geometry: piece,
      })),
      {
        type: 'Feature',
        properties: { featureType: 'INGEST_AREA', name: 'Area de ingesta' },
        geometry: payload.ingestArea,
      },
      ...payload.zones.map((zone) => ({
        type: 'Feature' as const,
        properties: { featureType: 'ZONE' as const, id: zone.id, name: zone.name },
        geometry: zone.geometry,
      })),
      ...payload.pois.map((poi) => ({
        type: 'Feature' as const,
        properties: {
          featureType: 'POI' as const,
          id: poi.id,
          name: poi.name,
          category: poi.category,
          ...(poi.audience === undefined ? {} : { audience: poi.audience }),
          ...(poi.description === undefined ? {} : { description: poi.description }),
        },
        geometry: { type: 'Point' as const, coordinates: [poi.lon, poi.lat] },
      })),
    ],
  };
}
