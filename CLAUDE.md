# Notes for agents working in this repository

Deliberately short. Everything here is either **expensive to rediscover** or **dangerous to
get wrong**, and none of it is written anywhere else in the repo.

If something belongs to a milestone, it goes in [ROADMAP.md](ROADMAP.md) instead — this file
must not need editing when a milestone closes, or it will rot and start lying.

## Where the truth lives

| Document | Authority |
|---|---|
| [HANDOFF-v3.md](HANDOFF-v3.md) | **normative.** Numbered requirements `R-xx` and sections `§n`. Cite them; do not restate them here |
| [ROADMAP.md](ROADMAP.md) | the milestones the work went through, what each delivered and its exit criterion |
| [CONTRIBUTING.md](CONTRIBUTING.md) | branches, commits, and the rule that the **draft PR opens before the work**, not after |
| [README.md](README.md) | what this is, setup, and the Traccar Client settings every player's phone needs |

`R-xx` numbers are **stable and never renumbered**. A requirement that changes gets a new
number appended; editing an existing one silently invalidates every commit message and doc
comment that cites it.

## Secrets — read this before running anything

- **`INGEST_SECRET` travels in a URL path segment** (R-02). Cloudflare logs request URLs, and
  so does `wrangler dev` on every line. It is therefore **plaintext in Workers Logs** and in
  any captured terminal output. Treat any secret you have seen as burned, and rotate before a
  real game. There is a **Run workflow** button on the Deploy workflow for rotating without a
  code change.
- **The values in `workers/.dev.vars` are burned.** They are local-dev only. Do not reuse them
  anywhere that matters, and do not print them.
- **Traccar Client posts a live FCM push token.** Its status body — sent on every service start —
  is `id=<device>&notificationToken=<FCM registration token>`, about 178 bytes. That is a real
  credential. It must never reach a commit, a PR body, or a test fixture; tests use an obvious
  placeholder. If you capture one, it is burned.

### The hazard M8 walked into, and the guard that is now load-bearing

R-03 parks every unrecognised parameter in an `attributes` map, kept whole and on purpose. The
status body above means **that map can contain a push credential**. `TrackSample` was planned
as the place that map would be kept, so a replay writer that persisted attributes wholesale
would write push tokens into game history that outlives the game.

**`TRACK_ATTRIBUTES` in [packages/core/src/track.ts](packages/core/src/track.ts) is the
allowlist that closed it:** `altitude`, `hdop`, `charge`, each truncated. Nothing else reaches
the `track` table, and `tests/track.test.ts` feeds a placeholder push token in and requires it
back out.

Two ways to reopen the hole without noticing. **Widening the list** to something that looks
like telemetry and is not — `driverUniqueId` is identity, not a reading. And **writing the map
directly**: `#recordSample()` hands `ping.attributes` to `sampleOf()`, which is what applies
the filter, so an INSERT that builds its own row bypasses the only guard there is. The track
is the one table that deliberately survives `FINISHED` (R-26), which is what makes a mistake
here permanent rather than session-shaped.

## The geometry is the artefact, and the artefact is checked

The `.geojson` files in `packages/shared/geo/` are **hand-maintained and travel on their
own**. There is no generator in this repository and there deliberately is not one: a
location is configuration, never code (§11), and a tool that could regenerate a file would
be a second copy of the geometry that has to be kept in step with the one everybody reads.

The invariant that matters is that the zones **tile the perimeter exactly** — no gap and no
overlap. It is not cosmetic and it is the least visible defect a file can carry: a strip of
ground in no zone at all is, under §4, a player nobody can see who can see nobody. That
happened, to a real venue, and was found by a sampler rather than by eye.

So [tests/geo.test.ts](tests/geo.test.ts) samples **every committed profile** on a 10 m grid
and refuses a gap or an overlap, along with the rest of what makes a file playable: the
grouping (R-70), the entrances on their borders, every POI inside the ingest area. **Adding a
profile means adding its name to `PROFILES` there.** That suite is the definition of a
geometry this app can run, and it is the first thing to point at a file somebody has drawn.

## Toolchain

**Two TypeScript compilers, both real.** `pnpm typecheck` runs `@typescript/native` (tsgo,
currently 7.0.2) over the build graph, then `svelte-check` on classic `typescript` (6.0.3). A
bare `npx tsc` is neither of them and will give you a different answer. Run `pnpm typecheck`.

**`node --experimental-strip-types` imports `packages/core/src/*.ts` directly, with no build
step:**

```bash
node --experimental-strip-types -e '
import { parseOsmAndPing } from "./packages/core/src/ingest.ts";
console.log(parseOsmAndPing(new URLSearchParams("id=X&batt=50"), Date.now()));
'
```

This is the fastest way to run real captured data through real game logic, and it is completely
undiscoverable from the source. `packages/core` is runtime-agnostic by rule (§6.5), which is
what makes it work.

Tests are one root Vitest suite over `tests/**/*.test.ts` — see [vitest.config.ts](vitest.config.ts).
`tests/projection.test.ts` is the highest-value suite in the repo; with game logic this thin,
`project()` is most of the backend.

## Local development

**Two `wrangler dev` on one port split the Durable Object state**, so you get confusing
half-populated reads. Before starting one, check nobody else is already running one against
the same port. Wrangler's default is 8787, which is often occupied — pass an explicit
`--port`, and `--ip 0.0.0.0` if a phone on the LAN needs to reach it.

**There is exactly one game.** The Durable Object is addressed by a fixed name
(`env.GAME.idFromName('default')` in [workers/src/index.ts](workers/src/index.ts)). Two
consequences: local state survives restarts and accumulates across sessions, and **there is no
isolated test game** — anything that needs the game `IN_PROGRESS` changes the state of the only
game there is. That is why the geofence was never scripted: it was exercised by the game of
2026-09-26 instead, which is also the only condition it is true under.

**A `git checkout` swaps the running Worker.** `wrangler dev` watches `workers/src`, so
switching branches hot-reloads it — and by the paragraph above there is only one game, which
keeps its state and starts running the other branch's rules underneath whoever is looking at
it. The symptom is a feature that works, then does not, with nothing in the diff to explain
it: on 2026-09-23 checking out `main` to open a fix branch took R-25b out of the Worker for
ninety seconds, and `AUTHORITATIVE_REVERTED` landed in a `FINISHED` game one second after the
checkout. That was reported as a bug in R-25b, which was never wrong. **Before switching
branches while a local game is being looked at, say so or stop `wrangler dev`** — and when
something behaves oddly, check `track_log` against the reflog before the source.

`run_worker_first = ["/i/*", "/j/*", "/api/*", "/ws"]` in `workers/wrangler.toml` is
load-bearing. Without it the asset router answers everything with `index.html` and the Worker
never runs — ingest, sessions and the socket all silently become the login screen.

### Reading local Durable Object state

There is no API for this and it is the only way to check what actually got written:

```bash
DB=$(ls workers/.wrangler/state/v3/do/q4413-GameDurableObject/*.sqlite | grep -v metadata)
sqlite3 "$DB" "select key, length(value) from _cf_KV;"
sqlite3 "$DB" "select hex(value) from _cf_KV where key='events';" > events.hex
```

Values are **V8-serialized**, not JSON:

```js
const v8 = require('v8');
v8.deserialize(Buffer.from(require('fs').readFileSync('events.hex', 'utf8').trim(), 'hex'));
```

Keys in use: `game`, `players`, `devices`, `tray`, `teams`, `events`, `viewModes`, `epoch`,
`markers`, `loginFailures`, `geoProfile`, `geoVersion`, `hiddenPois`, `disabledZones`,
`masterEpoch`.

**The track is not in `_cf_KV` and is not V8-serialized.** M8 put it in two ordinary SQL
tables in the same file, because a KV value is capped at 128 KiB and a game is ~17.000
points. They read like any other table, which makes them by far the easiest state in this
object to inspect — and the easiest to seed, which is how M8's twenty-minute scrub was
measured without waiting twenty minutes:

```bash
sqlite3 "$DB" "select count(*), min(ts), max(ts) from track;"
sqlite3 "$DB" "select ts, kind, target from track_log order by ts desc limit 10;"
```

Stop `wrangler dev` before writing to them. Both are dropped by
`POST /api/master/game/reset` and deliberately **not** by `FINISHED`: R-26 calls the feature
post-game replay, so the track has to outlive the session that produced it.

**The daily Protomaps planet build stops at z15**, so `pmtiles extract --maxzoom=17`
is accepted and quietly produces z15. That is not a fault to chase: MapLibre overzooms
vector tiles, and `Game.basemap.maxZoom` (19) is how far a player may zoom, which is a
different number from what the archive stores. `tools/basemap.sh` prints both.

What overzoom does not do is invent detail, and past z18 you can see where it stops. The
tiles are 4096 units across, so a z15 tile drawn at z18 puts a vertex on a 1 px grid and at
z19 on a 2 px one — the staircase on a diagonal building wall is the archive's resolution,
and no style change will smooth it. It is why the buildings are a fill with a `line` layer
over it rather than a `fill-outline-color`: that property draws one unantialiased device
pixel, which under R-48's 50° pitch turned the far edges into a dotted shimmer and made the
quantisation read as a broken line rather than as a block of a shopping centre.
`outlinesAreLineLayers()` in `map/style.ts` holds it.

**Editing a `.geojson` and deploying changes nothing until you bump `GEO_VERSION`.** The
geometry is seeded into the `game` key on first load, not read from the bundle per
request, so an existing game keeps the old rings — this is why a profile shrinking from
27 x 23 km to a 1,73 km square in M7 was invisible, and why `entranceTo` was absent from
the only copy anybody reads the day after it was added to the file.

`#load()` re-derives the geometry when that constant moves **and the game is not
`IN_PROGRESS`**, which is the condition `POST /api/master/game/geo` already enforces:
zones moving under players mid-game would take R-04's geofence and §4's projection with
them. A game that *is* `IN_PROGRESS` still needs the endpoint, after it ends.

`Game.basemap.pmtilesUrl` and `bbox` have their own constant (`BASEMAP_VERSION`) and
`maxZoom` has another; all three exist because a game is seeded once and a deploy does
not reseed it.

**`marker` (singular) is the old key** and is migrated away on first load: R-20b raised the
one slot to five, and a game is seeded once, so `#load()` lifts a legacy `marker` into
`markers` and deletes it. A game created before 2026-09-03 therefore still has the old key
until something touches it.

**`viewModes` values are objects, not mode strings.** R-25's revert needs a clock, so an
entry is `{ mode, lastActionAt? }` and `#load()` lifts a bare `'AUTHORITATIVE'` from before
that — deliberately without a `lastActionAt`, which reverts it. Same reasoning as `marker`
above: a game is seeded once and a deploy does not reseed it.

**The alarm is in a different file, and it is the only way to see one.** There is no API for
reading a pending alarm, and marker expiry is the only alarm the system has (R-21):

```bash
sqlite3 workers/.wrangler/state/v3/do/q4413-GameDurableObject/metadata.sqlite \
  "select actor_name, scheduled_time/1000000 from _cf_ALARM;"
```

`scheduled_time` is **nanoseconds**, and `actor_id` is the primary key — so the table can hold
at most one row per Durable Object, which is what "exactly one alarm" means in practice.
`setAlarm()` replaces rather than adds.

## The static demo is a second server, and it may not become a second app

`apps/web/src/demo/` answers the API in the page, for the build at
`q4413-demo.filoga.me`. `VITE_DEMO=1` is the only switch; without it the branch in
`main.ts` is removed and no demo chunk is emitted at all.

**It patches `globalThis.fetch` and `globalThis.WebSocket`, underneath `api.ts`, and that
is the rule.** There must be no `if (demo)` in `views/` or in `map/` — a second code path
in the view is a parallel renderer that drifts from the real one and demonstrates nothing.
Same rule R-53 imposed on replay, for the same reason.

It does not reimplement the game. `project()` is pure and lives in `packages/core`, so the
demo hands it the same `World` the Durable Object does; what is reimplemented is the
orchestration around it — the seed, storage, the master actions, the broadcast. **If you
change a rule, change it in `packages/core` and both get it.** If you find yourself copying
logic into `demo/`, that logic is in the wrong package.

Three things about its shape that are not obvious:

- **`demo/profiles.ts` is the only file that needs a bundler.** It imports the `.geojson`
  with Vite's `?raw`, and `tsconfig.tests.json` compiles plain TypeScript and cannot read a
  query specifier — the same trap that keeps `map-worker.ts` outside `map/`. Everything
  underneath takes the geometry as an argument, which is what lets `tests/demo.test.ts`
  drive the whole fake server under Node.
- **It walks the players with `tools/walk.mjs`**, which is `fake-phones.mjs`'s pure half,
  split out for exactly this. Two walk implementations would be two answers to "where is
  everybody", one of them tested.
- **What it cannot do answers `501` and says why.** Ingest, the basemap override and device
  pairing. The controls for those are absent because the payload makes them absent, never
  because the view knows about the demo — `replayAvailable`, an empty tray. A demo that
  shows a button doing nothing is worse than one that does not show it, and
  `tests/demo.test.ts` pins that.

## Three ways the map goes black, none of them the map

**Every one of them is MapLibre's tile-parsing Web Worker, and it is the single most
fragile thing in the web app.** MapLibre 6 ships it as a separate file and resolves it at
runtime from `import.meta.url`, which no bundler can follow. Two of the three below are
that resolution landing somewhere the file is not, and each one breaks in exactly one
environment — so **a map verified on the dev server tells you nothing about the built
bundle, and the reverse is also true.**

**Vite's dependency pre-bundler breaks MapLibre**, which parses tiles in a Web Worker: the
optimizer rewrites the entry and loses `maplibre-gl-worker.mjs`, so every tile fails to
parse while the style still loads. Background paints, nothing else does. `optimizeDeps.exclude`
in [apps/web/vite.config.ts](apps/web/vite.config.ts) holds it off; if it comes back, the
trigger is a **lockfile change**, because that is what makes the optimizer re-run. Dev only —
`vite build` does no pre-bundling — and it looks identical to a wrong `source-layer` or a
broken CORS policy, which are the failures §14 warns about and this is not.

**A built bundle emits no worker at all unless something asks for one.** `vite build` does no
pre-bundling, so the trap above cannot fire — and it resolves `./maplibre-gl-worker.mjs`
against the entry chunk instead, `/assets/main-<hash>.js`, where nothing ever put a worker.
That URL is a 404, and `not_found_handling` is `single-page-application`, so the 404 comes
back as `index.html` with a **200**: the worker is handed a page of HTML to execute.
Identical symptom, opposite environment — **production and `vite preview` only, never in
dev.** [apps/web/src/map-worker.ts](apps/web/src/map-worker.ts) imports the worker with
Vite's `?worker&url` and hands the emitted asset's URL to MapLibre's own `setWorkerUrl()`;
it sits beside `src/map/` rather than in it because `tsconfig.tests.json` compiles that
directory into the root suite, which cannot read a Vite query specifier.

**So a map change is not verified until it has been looked at through `pnpm build` and
`wrangler dev`** — which serves `[assets]` out of `apps/web/dist` behind the same SPA
fallback production uses, and still answers `/api` and `/ws`. `vite dev` cannot see the
second failure and `vite build` cannot see the first, and the suite sees neither: there is
no browser in CI, and a worker that fails to boot is a runtime event, not a type error.

**`GameMap` renders MapLibre's `error` event on screen**, in a red box, in production. That
is deliberate and it is the only reason the above was findable: every silent-blank failure
raises one, and before that box they had nowhere to go. Do not remove it because the design
looks tidier without it.

## The navigation camera may not use an animation API

**MapLibre cancels an in-flight `easeTo` on any other camera change, and `setBearing()` is
one.** R-50 mandates a per-frame bearing filter, so a per-frame filter and an eased centre
cannot coexist: the first frame kills the transition. That is why one loop in
[GameMap.svelte](apps/web/src/map/GameMap.svelte) low-passes centre, zoom, pitch and bearing
together and writes them with `jumpTo`, which starts no animation and has nothing to cancel.

It fails quietly: the axes the loop writes keep working and the ones the ease was carrying
silently stop, so the symptom is "the zoom was never applied" rather than an error.

**The player may keep an axis, and `held` is how.** Zoom, bearing and pitch are the
camera's until the player touches them and theirs afterwards — the loop leaves a held axis
out of its `jumpTo` entirely. A hold is taken when a camera event arrives with an
`originalEvent`, which is the only thing that separates a gesture from the loop's own
writes; a new fix does **not** clear one, and the mode toggle is the only thing that does.
Two consequences worth knowing before chasing either as a bug: `bearingSnap` is `0` because
MapLibre's snap-to-north is an `easeTo` the next `jumpTo` cancels halfway, and the settled
test treats a held axis as arrived — without that the loop chases a target it is not
writing, for the rest of a four-hour game.

## The tube's bloom is a `text-shadow`, and it reaches things it should not

`styles/terminal.css` puts `text-shadow` on `.screen`, so every glyph in the app glows. That
is correct for every glyph that sits on `--screen`, which is all of them **except the map's
callsign labels** — those are DOM markers over amber roads, zone dashes and an uncertainty
circle, and a glow spreads them into all three. `GameMap` cancels it and gives them an
opaque plate; anything that removes the cancel makes the map unreadable without touching the
map.

**Do not reach for `filter` to make the glow better.** The map is a WebGL canvas and R-48's
camera writes it once per frame, so a `filter` on any ancestor forces a full-screen composite
of that canvas on every one of those frames. That is why bloom is a shadow, scanlines and the
vignette are static gradients, and only the flicker animates — on an empty overlay, never on
content. Every overlay is also `pointer-events: none`, or the topmost one eats the map's
click handler and picking a drop point silently stops working. **R-67's screensaver is the
one exception**, and it is that rule read the other way: it is the only overlay that is not
permanent, and the click that dismisses it must not also drop a marker where the mark
happened to be.

## `--alarm` belongs to R-43 and to nothing else

`#ff4422` is the only non-monochrome colour in §9's palette, and the boundary warning is the
only thing on any screen that is not game content. Those two facts are the same decision:
the warning is told from the game by **colour and typeface** — alarm red, case lettering, no
bloom — which is what lets it sit directly on the map without being mistaken for something in
the game.

It shipped wrong once. The approach edge was `#ffb000`, which is `--phosphor`, which is the
colour of every dot, ring and callsign on the screen. Emphasis everywhere else is **inverse
video** (§9.4) for exactly this reason: a monochrome terminal alarmed that way, it reads
louder than red, and it leaves the one real colour free for the one real warning.

### The typeface half of that only works because the case face is rare

§9's two faces are a split **by domain, not by size**: `VT323` is what the tube draws,
`--case-font` is lettering printed on the box around it. The app had been reading the second
one as *any label*, so Barlow Condensed carried every `QTH`, `BAT` and `ESTADO` on both
views — most of the small text on screen. A warning told apart by "case lettering" cannot be,
if case lettering is also how the roster is captioned.

So a label naming a reading now takes the screen face, through `--label-font` /
`--label-size` / `--label-tracking` in `styles/terminal.css` — three properties rather than
nine identical copies across three files. **Six things keep `--case-font`, and each is a
different reason it is not tube content:** `.plate` and `.switch` are literally the case,
`kbd` is a key's own legend, and `.scale`, `.fault` and R-43's `.alert` are the machine
speaking from outside the fiction. Widening that list is how the warning quietly loses half
of what distinguishes it.

`--label-font` carries no `font-weight` on purpose: `VT323` ships one weight, so `600` asks
the browser to smear a bitmap into a fake bold. Tracking is a hair rather than `0,1em`
because §9's grid is a character cell and `letter-spacing` is what pushes glyphs off it.

## Replay may not have its own renderer, and it does not have one by construction

R-53 says replay is a clock, not a mode, and the milestone's recorded risk was a second code
path. What prevents one is a single line in [MasterView.svelte](apps/web/src/views/master/MasterView.svelte):

```ts
const payload = $derived(replay.payloadFor(live) ?? live);
const now     = $derived(replay.active ? replay.cursor : game.serverNow);
```

`replayAt()` returns a real `Payload` with `serverNow` moved, so R-11's state, R-12's circle,
R-21c's TTL and every age on screen replay because they were already written against that
field. **Anything that adds a `if (replay.active)` branch below those two lines is the fork
the milestone was warned about.** The derivations in `game.svelte.ts` take an optional clock
for this reason and no other.

**`viewMode` deliberately does not take one.** R-25 runs on real time whatever the cursor is
doing; a replay that could hold `AUTHORITATIVE` open would be a way around the requirement.
The reverse edge is an effect in the panel that closes the replay when the mode lapses — the
window in hand was projected for a master the server would no longer project it for.

### The event table may not be keyed

`{#each payload.events ...}` in the master panel is the one `{#each}` in the app with no
key, and it has to stay that way. A key is an identity claim, and the log has none to make:
`#revertLapsedViewModes()` writes one `AUTHORITATIVE_REVERTED` per lapsed session at a
single `now`, with the session in `actor` and **nothing in `target`**, so two masters idling
out together produce two events identical in every field a key could be built from. Svelte
answers a duplicate key with a thrown `each_key_duplicate`, which takes the panel down —
not a warning, and not one row missing.

Keying buys nothing here regardless: the list is a fresh reversed slice, so one new event
shifts every row and no identity survives the render.

## `#log()` writes two places, and only one of them is the one you have to remember

`GameDurableObject#log()` pushes onto an in-memory array **and inserts a `track_log` row**.
The row is durable; the array is not. Every handler that logs also writes the `events` key
itself, and one that forgets produces an event that is on every open socket, in replay
for ever, and gone from the live panel the moment the object is evicted.
`AUTHORITATIVE_OPENED` shipped that way in M2 and went unnoticed until M5, because a test
session always does something else within seconds.

**If you add a `#log()` call, add the `await this.#put('events', this.#events)` with it.**
M8 did not change that; it added a second destination underneath it.

The two are not redundant. `events` is a **live tail capped at 500** that every projection
reads; `track_log` is the archive R-56 replays from, uncapped inside the retention window.
A four-hour game overruns the tail, so a replay reading the KV key would silently lose the
beginning of its own window.

## Two traps in the observability

**Cloudflare logs the request URL and never the body.** Traccar Client posts form-encoded
bodies, so coordinates, battery and every other field are **invisible** in Workers Logs and in
`wrangler tail`. You cannot debug ingest *content* from production logs, ever. You need
`wrangler dev` with the phone pointed at it, or a tunnel to a local capture. Budget for that
instead of discovering it an hour in.

**`wrangler tail` emits one record for the Worker invocation and another for the Durable Object
invocation of the same request.** Counting raw records doubles every rate you compute. Dedupe
before drawing conclusions.

TLS fields on `request.cf` — `tlsClientHelloLength`, `tlsClientCiphersSha1`,
`tlsClientExtensionsSha1`, `tlsCipher` — identify a client across IP and VPN changes, and
distinguish two applications on one handset when the user-agent alone is ambiguous. `content-length`
is a much weaker signal than it looks: coordinate precision differs between builds by more than a
field does.

## Things that look like bugs and are not

- **A ping with no `lat`/`lon` is a status report, not a malformed ping.** Traccar Client sends
  one on every service start. See `ParseResult` in
  [packages/core/src/ingest.ts](packages/core/src/ingest.ts).
- **`TrayEntry.lastSeen` does not advance on a status report,** and `pings` does not increment.
  Both are consumed as *the position's* timestamp, not as time-of-last-contact. The doc comment
  in [packages/core/src/devices.ts](packages/core/src/devices.ts) explains what breaks otherwise.
- **Ingest answers `200` to everything,** including rejections, so Traccar does not retry. The
  outcome is in the `INGEST_REJECTED` event, not the status code. Never judge an ingest change by
  its HTTP response.
- **The geofence does not apply during `PREPARATION`** (R-04), on purpose — pairing needs a real
  ping to arrive from wherever setup is happening. It is not a noise filter and cannot be one.
- **A teammate visible from another zone is not a projection bug.** It is the comms reach
  (R-21d, R-72), a master setting that is the *only* thing in the system that lets team
  membership reach the position axis (§4). `payload.game.commsReach` says how far it goes —
  **3** is §4 alone, **4** adds your own team anywhere in your sector, **5** adds them
  anywhere at all — and the event log records every move. It is 3 on a fresh game, and a
  game seeded before M12 reads its old `extendedComms` boolean as 3 or 5 on first load.
  **A player on ground R-71 has closed has no zone, so they have no sector**, and 4 does not
  reach them; 5 still does.
- **A marker with no `expiresAt` never expires** (R-21c), and that is not a missing field to
  default. `markerExpired()` is the one place that knows; a sentinel date would be worse.
- **`AUTHORITATIVE` dropping back after ten minutes of reading the map is R-25 working.**
  Only master *actions* stop the clock — every `POST`/`DELETE` under `/api/master/`, plus
  `/api/radio-contact` — and a read never does, on purpose: counting `/api/state` would let
  the panel's own socket hold the mode open forever. The decision and its cost are in
  ROADMAP under M5. An action arriving *after* the ten minutes does not resurrect the mode
  either; the master confirms R-24 again.
- **An eliminated player whose position, zone and battery stop moving is R-22's freeze,**
  not a write that failed. `applyPing()` stops advancing `knownPosition` and `knownBattery`
  once `player.eliminated` is set, while `position` and `battery` keep going for
  `AUTHORITATIVE`. Every field that kept advancing was a way for `OPERATIONAL` to say who
  was out — the growing circle, the zone, the battery percentage — which is the one thing
  the mode exists to prevent.
- **The master's drop-point column emptying on its own is the same revert.** The panel says
  so, because the event that records it (`AUTHORITATIVE_REVERTED`) is itself
  `AUTHORITATIVE`-only and cannot be the thing that explains it.
- **The REVIVIR button is missing in `OPERATIONAL` on purpose** (R-32, §4). The control's
  *presence* is the leak: a revive button beside one callsign announces which player is out,
  which is the state that mode withholds. Same gate as the drop-point column, on
  `game.viewMode` rather than the snapshot's.
- **An `eliminated` record with no `dropPoint` is a player who had no fix when they
  declared** (M6), not a write that half-failed. R-30.5 says what is recorded and is silent
  about a phone that lost GPS indoors; refusing the declaration would be worse than a
  missing coordinate pair, so `dropPoint` is optional and the panel says so in words.
- **`POST /api/me/eliminated` twice answers `200` and changes nothing.** Declaring is not a
  toggle: a second press must not move the drop point, and must not add a second line to the
  log. `declareEliminated()` returns the same object, which is how the caller knows to skip
  the write and the broadcast.
- **A map with no streets under the game geometry is not a broken style.** An empty
  `Game.basemap.pmtilesUrl` is a supported state, and `buildStyle()` **removes** the
  basemap source and every layer drawn from it. Left in, MapLibre logs a network error
  per tile and draws nothing at all. The path is derived from the live geo profile,
  so the fix is normally a deploy plus `POST /api/master/game/geo`, not a URL.
- **The archive is read whole, never by range** (R-52b). It ships as a static asset, and
  Cloudflare's asset server answers a range request with `200`, which `pmtiles` treats as
  fatal — *"Check that your storage backend supports HTTP Byte Serving"*. `WholeArchiveSource`
  in [apps/web/src/map/archive.ts](apps/web/src/map/archive.ts) is what makes that
  irrelevant. Anything that reintroduces a dependency on `206` breaks the map in dev, on
  a first load, and anywhere the service worker is not in front.
- **The map not turning while a player walks is R-50 with no input.** The measured
  Traccar Client sends neither `bearing` nor `speed`, and absent speed **freezes** rather
  than trusts — the gate exists for readings that look like movement and are not. Do not
  reach for derived speed: the corridor walk measured 10,73 m/s against a 0,5 m/s
  threshold.
- **An uncertainty circle vanishing while the dot stays** is the render-layer cap in
  `frame.ts`, not a draw that failed. Past half the perimeter's short axis the circle
  covers the venue and everyone on it, so it stops being drawn; `uncertaintyRadiusMetres()`
  still returns the true number and the roster still prints it.
- **An elimination reaches no log you can watch.** R-30.2 sends no event to players, and the
  `ELIMINATION` entry is `MASTER_AUTHORITATIVE`, so it is absent from `OPERATIONAL` too.
  Cloudflare's logs have never had it: they carry the request URL and never the body.
- **A replayed dot that stops moving and grows a circle is R-55 refusing to invent.**
  Interpolation runs only across gaps shorter than `linkThresholdMs`; past that the earlier
  sample is held **with its timestamp**, so R-12's arithmetic ages it into `NO_LINK` against
  the cursor exactly as it did live. A smooth line there would be a player walking through a
  blackout they spent standing still in a basement.
- **A replay that closes on its own after ten minutes is R-25, not a crash.**
  `GET /api/track` is a read and reads never stop that clock — the same decision as
  `/api/state`, for the same reason: counting it would let the panel hold `AUTHORITATIVE`
  open by polling. The window is fetched whole, so the cost is confirming R-24 again, not
  re-downloading anything.
- **A replay with no markers in it is a game whose markers predate M8.** `MARKER_PLACED`
  only started carrying `lat`/`lon` in M8, and R-56 cannot stand a marker back up without
  them. Absent rather than in the wrong place, on purpose.
- **The tray is empty in every replay.** An unpaired device has only a current position and
  no history, so carrying it back would draw a stray phone where it is *now* on a map of
  twenty minutes ago.
- **The replay control being absent in `OPERATIONAL` is the same gate as REVIVIR** (R-32,
  R-57). Offering a replay beside a roster the mode is withholding from announces that there
  is something to withhold.
- **A player receiving nothing at all, with the app still up, is the cut switch** (R-60).
  It halts the **player** feed as well as ingest: no broadcast, nothing in the snapshot a
  fresh socket is handed, and `503` from `/api/state` and `/api/geo`. The socket still
  opens — they are still authenticated — and is handed nothing, so their last payload ages
  itself into `NO_LINK` client-side. **Masters are unaffected on purpose** (R-35): a master
  staring at a frozen panel while deciding what to do about the thing they cut for is the
  opposite of what the switch is for.
- **A point on the master's list that is on no player's map is R-61,** not an audience rule.
  The two are filtered in that order and never instead of each other: R-16 to R-18 answer
  *who a point is for* and are per-recipient; `hiddenPois` removes it from everyone at once.
  The master keeps seeing it in **both** view modes, because the panel's list is the only
  place a hidden point can be found again and turned back on. The list is cleared by a geo
  profile change and by the end of a session — the ids belong to the geometry they came
  from, and a hidden point reappearing missing in a later game leaves an absence rather than
  a mark.
- **The version on the boot screen and on the master's bar is fiction, and never changes.**
  `boot.version` in `locales/es.json` is the terminal's firmware, not this repository's —
  the same register as the manufacturer and the bank above it. It is deliberately not
  maintained and must not be wired to anything: a version in the UI that tracks the project
  rots by construction, which the master's header already proved by saying `M3` for six
  milestones.
