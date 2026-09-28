/**
 * game.geojson is bundled as text (see the Text module rule in wrangler.toml)
 * and parsed at startup. Keeping the file as GeoJSON rather than a .ts literal
 * is what lets it stay editable per location without a code change (§11).
 */
declare module '*.geojson' {
  const content: string;
  export default content;
}
