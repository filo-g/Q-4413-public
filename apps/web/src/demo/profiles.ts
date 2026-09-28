import barcelonaGeoJsonText from '@q4413/shared/geo/barcelona.geojson?raw';
import madridGeoJsonText from '@q4413/shared/geo/madrid.geojson?raw';
import sevillaGeoJsonText from '@q4413/shared/geo/sevilla.geojson?raw';

import type { GeoProfiles } from './world.ts';

/**
 * The bundled geometry, as text, and **the only module in the demo that a
 * bundler is required to understand.**
 *
 * `?raw` is a Vite query specifier, so plain `tsc` cannot read this file — which
 * is why it is a leaf with nothing but these three lines. Everything underneath
 * takes the map as an argument, and that is what lets `tests/demo.test.ts`
 * exercise the whole fake server with `readFileSync`.
 *
 * The same trap, in the same shape, as `map-worker.ts` sitting beside `map/`
 * rather than in it.
 */
export const GEO_PROFILES: GeoProfiles = {
  madrid: madridGeoJsonText,
  barcelona: barcelonaGeoJsonText,
  sevilla: sevillaGeoJsonText,
};
