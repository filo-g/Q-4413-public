#!/usr/bin/env bash
set -euo pipefail

# The §14 basemap pipeline: extract → verify → upload.
#
# The basemap is OpenStreetMap, and not only because it is cheapest: Google's
# terms forbid caching tiles for offline use and forbid restyling, which are the
# two things this project requires (§14.1).
#
# Protomaps publishes daily whole-planet builds, and `pmtiles extract` downloads
# **only the bytes for our area** — no planet download, no tile server, no
# database, no API key. What comes out is a single immutable file.
#
# It is written into `apps/web/public/basemap/` and ships with the bundle
# (R-52b), not uploaded to R2. Same origin means there is no CORS policy to get
# wrong and no Access bypass rule to forget — the two silent blank-map failures
# §14 warns about — and Cloudflare charges nothing to serve a static asset. The
# ceiling is what the trade costs: **25 MiB per file**, checked below.
#
# One archive per location (§11, §14.6): two profiles are two places, and the
# area is what the file costs — each zoom level roughly doubles it.
#
# Usage:
#   tools/basemap.sh <profile> [options]
#
#   <profile>            madrid | barcelona | sevilla — any file in packages/shared/geo
#   --build YYYYMMDD     Protomaps build id. Discovered from the index if omitted
#   --maxzoom N          default 15, which is as deep as the daily planet build goes
#   --version vN         path prefix. A new extract MUST get a new one (R-52)
#   --install            copy the verified archive into apps/web/public/basemap/
#
# Nothing here runs in CI. Cutting an archive is a deliberate act before a
# session, and --install is what makes the next deploy carry it.

profile=""
build=""
schema_version="?"
planet_gb="?"
# 15, not §14.2's 17: the Protomaps **daily planet build stops at z15**, so a
# higher number is accepted and silently produces z15 anyway. MapLibre overzooms
# vector tiles past a source's maximum, and Game.basemap.maxZoom — how far a
# player may zoom — is a different number, now 19. Past z15 the map generalises
# rather than blurs: z15's simplification drawn larger.
maxzoom=15
version="v1"
install=0

while [ $# -gt 0 ]; do
  case "$1" in
    --build) build="$2"; shift 2 ;;
    --maxzoom) maxzoom="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --install) install=1; shift ;;
    -h|--help) sed -n '3,30p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) profile="$1"; shift ;;
  esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
geojson="$root/packages/shared/geo/$profile.geojson"

if [ -z "$profile" ] || [ ! -f "$geojson" ]; then
  echo "usage: tools/basemap.sh <profile> [--build YYYYMMDD] [--maxzoom N] [--version vN] [--install]" >&2
  echo "profiles:" >&2
  ls "$root/packages/shared/geo" | sed 's/\.geojson$//' | sed 's/^/  /' >&2
  exit 2
fi

# `pmtiles` is a Go binary and is not a project dependency: it is used a handful
# of times per location, and vendoring a platform binary into a pnpm workspace
# to run it twice a year is worse than this message.
if ! command -v pmtiles >/dev/null 2>&1; then
  cat >&2 <<'EOF'
pmtiles CLI not found. Install it:

  brew install pmtiles                    # homebrew-core, no tap
  go install github.com/protomaps/go-pmtiles/cmd/pmtiles@latest

There is no protomaps/tap — that was wrong when this script was written and
fails with "Repository not found".

Releases: https://github.com/protomaps/go-pmtiles/releases
EOF
  exit 1
fi

# The bbox comes from `basemapBbox()` in packages/core, which is the same
# function the Worker derives Game.basemap.bbox from — called here rather than
# reimplemented, because the archive and `maxBounds` disagreeing is a grey
# rectangle with the play area in the corner, and it is a silent one.
#
# It is **not** the ingest area's bounds any more. That box is square, and this
# map is only ever looked at in 16:9 or 9:16: MapLibre refuses to zoom out past
# the point where the view would leave `maxBounds`, so a square archive cannot
# frame a square play area on a phone. See the docblock on BASEMAP_FRAME_FACTOR.
#
# `node --experimental-strip-types` imports the TypeScript directly, with no
# build step — packages/core is runtime-agnostic by rule (§6.5), which is what
# makes a shell script able to call into the game's own geometry.
read -r west south east north <<EOF
$(GEOJSON="$geojson" ROOT="$root" node --experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module -e '
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
// Imported by absolute URL: this script is run from wherever the caller happens
// to be, and a relative specifier would resolve against that instead of the repo.
const core = await import(pathToFileURL(process.env.ROOT + "/packages/core/src/index.ts").href);
const geo = core.gameGeoFromGeoJson(JSON.parse(readFileSync(process.env.GEOJSON, "utf8")));
console.log(core.basemapBbox(geo).join(" "));
')
EOF

# Rough area, only to catch the case the roadmap flagged: a profile drawn
# around two towns is a rectangle of tens of km², and copying a venue's maxzoom
# onto it would produce an archive nobody wants over mobile data.
# Through the environment, not argv: a negative longitude on the command line
# is parsed by node as a flag — "node: bad option: -4.4863027".
area_km2="$(W="$west" S="$south" E="$east" N="$north" node -e '
const [w, s, e, n] = [process.env.W, process.env.S, process.env.E, process.env.N].map(Number);
const midLat = (s + n) / 2;
const width = (e - w) * 111.32 * Math.cos((midLat * Math.PI) / 180);
const height = (n - s) * 111.132;
console.log((width * height).toFixed(1));
')"

echo "profile:  $profile"
echo "bbox:     $west,$south,$east,$north   (~${area_km2} km²)"
echo "maxzoom:  $maxzoom"

if [ "$(awk -v a="$area_km2" 'BEGIN { print (a > 100) ? 1 : 0 }')" = "1" ] && [ "$maxzoom" -ge 17 ]; then
  cat >&2 <<EOF

WARNING: ${area_km2} km² at z$maxzoom. Each zoom level roughly doubles the archive
(§14.2), and this area is not a commercial estate. Consider --maxzoom 15 for a
test area, where the map exists to prove a dot lands on a real street rather
than to navigate by.

EOF
fi

# maps.protomaps.com/builds is a single-page app and lists nothing to a script.
# The index it fetches is this, which also carries the **basemap schema version**
# — the thing §14.3 warns changes `source-layer` names between builds, and worth
# having in the terminal beside the layer check below.
if [ -z "$build" ]; then
  echo "resolving the latest Protomaps build..."
  build_line="$(curl -fsSL https://build-metadata.protomaps.dev/builds.json | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const builds = JSON.parse(raw);
  const latest = builds.at(-1);
  if (!latest) process.exit(1);
  const gb = (latest.size / 1e9).toFixed(0);
  console.log(`${latest.key.replace(/\.pmtiles$/, "")} ${latest.version} ${gb}`);
});
' || true)"
  build="${build_line%% *}"
  schema_version="$(echo "$build_line" | awk '{ print $2 }')"
  planet_gb="$(echo "$build_line" | awk '{ print $3 }')"
fi
if [ -z "$build" ]; then
  echo "could not resolve a build id. Pick one from https://maps.protomaps.com/builds and pass --build YYYYMMDD" >&2
  exit 1
fi

out="$root/tools/out/$profile-$build-z$maxzoom.pmtiles"
mkdir -p "$(dirname "$out")"

echo "build:    $build   (basemap schema $schema_version, ${planet_gb} GB planet)"
echo "output:   $out"
echo

pmtiles extract "https://build.protomaps.com/$build.pmtiles" "$out" \
  --bbox="$west,$south,$east,$north" \
  --maxzoom="$maxzoom"

echo
echo "── pmtiles show ──────────────────────────────────────────────"
pmtiles show "$out"
echo

# The zoom the archive actually holds, which is not necessarily the one asked
# for: the Protomaps **daily planet build stops at z15**, so --maxzoom=17 is
# accepted and silently produces z15. That is not a problem to fix — MapLibre
# overzooms vector tiles, and Game.basemap.maxZoom is how far a player may zoom
# rather than what the archive stores — but it is worth seeing rather than
# assuming, because "why is it blurry past z15" has one answer and it is this.
archive_maxzoom="$(pmtiles show "$out" | awk '/^max zoom:/ { print $3 }')"
if [ -n "$archive_maxzoom" ] && [ "$archive_maxzoom" -lt "$maxzoom" ]; then
  echo "note:     archive holds z$archive_maxzoom, not the z$maxzoom asked for — the daily planet build stops there. MapLibre overzooms."
  echo
fi

# §14.3's documented silent failure, checked rather than trusted: `source-layer`
# names and the `kind` attribute have changed between Protomaps basemap
# versions, and a style pointing at a layer the archive does not have renders
# blank with no useful console error.
#
# Against `--metadata`, not the plain output: `pmtiles show` prints
# "vector_layers <object, use --metadata to view full JSON metadata>" and a grep
# for a layer name over that finds nothing, which would fail every archive.
echo "── style source-layers vs archive ────────────────────────────"
report="$(pmtiles show --metadata "$out" | STYLE="$root/apps/web/src/map/style.json" node -e '
const fs = require("node:fs");
const style = JSON.parse(fs.readFileSync(process.env.STYLE, "utf8"));
const wanted = [
  ...new Set(
    style.layers
      .filter((l) => l.source === "basemap" && l["source-layer"])
      .map((l) => l["source-layer"]),
  ),
];
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const present = new Set((JSON.parse(raw).vector_layers ?? []).map((l) => l.id));
  let missing = 0;
  for (const layer of wanted) {
    if (present.has(layer)) console.log(`  ok       ${layer}`);
    else { console.log(`  MISSING  ${layer}`); missing += 1; }
  }
  // The other half of the same question, and the one nobody thinks to ask: what
  // the archive carries that the style ignores. `places` and `pois` are label
  // layers, and §14.3 wants them unreferenced rather than filtered.
  const unused = [...present].filter((l) => !wanted.includes(l));
  if (unused.length) console.log(`  unused   ${unused.join(", ")}`);
  console.log(`missing=${missing}`);
});
')"
echo "$report" | grep -v '^missing='

if [ "$(echo "$report" | sed -n 's/^missing=//p')" != "0" ]; then
  cat >&2 <<'EOF'

A layer the style draws is not in this archive. The map would render blank with
nothing in the console. Check the Protomaps basemap schema for this build and
update apps/web/src/map/style.json before installing.
EOF
  exit 1
fi

# 25 MiB is the hard ceiling on a Cloudflare static asset, and exceeding it
# fails at deploy rather than here — after the extract, after the commit, in
# front of whoever is deploying. Better to say so now, with the lever named.
bytes="$(wc -c < "$out" | tr -d ' ')"
mib="$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1048576 }')"
echo "size:     ${mib} MiB"
if [ "$bytes" -gt 26214400 ]; then
  cat >&2 <<EOF

${mib} MiB exceeds the 25 MiB limit on a Cloudflare static asset (R-52b), so
this archive cannot ship with the bundle. Drop a zoom level — each one roughly
halves it — or put this profile on object storage and configure an absolute URL.
EOF
  exit 1
fi

if [ "$install" != "1" ]; then
  cat <<EOF

Verified, not installed. Re-run with --install when you mean it.

  tools/basemap.sh $profile --build $build --maxzoom $maxzoom --version $version --install
EOF
  exit 0
fi

# R-52 caches by version path and never revalidates, so overwriting an existing
# path leaves every phone that has already cached it on the old archive with no
# way to notice. A new extract gets a new --version, always.
key="basemap/$version/$profile.pmtiles"
dest="$root/apps/web/public/$key"
mkdir -p "$(dirname "$dest")"
cp "$out" "$dest"

echo
echo "installed at apps/web/public/$key"

cat <<EOF

One step left: commit it and deploy. The archive ships with the bundle, so the
deploy is the upload — no bucket, no CORS policy, no Access bypass rule.

Nothing to configure. The Durable Object derives this path from the live geo
profile, so switching geometry switches the map under it:

   POST /api/master/game/geo  {"profile":"$profile"}

Only a location too big for the 25 MiB ceiling needs the override, which points
at object storage instead:

   curl -X POST https://q4413.example.com/api/master/game/basemap \\
     -H 'content-type: application/json' \\
     -d '{"pmtilesUrl":"https://<host>/$key"}'

EOF
