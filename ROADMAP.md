# Roadmap

**Finished.** The system was built in the order below and then played: one full session,
six players, six hours, no intervention — which is M10's exit criterion word for word and
the only instrument several of these milestones were ever going to get. Every milestone is
closed and [§13's open items](HANDOFF-v3.md) are closed with them.

This is the **public record of what the work did**: for each milestone, what it delivered,
why it existed, and the exit criterion it closed against. The original document also carried
the reasoning as it was written and every measurement taken at a real venue with real
handsets; those numbers describe a place and the people who walked it, so they are not
here. Where a measurement decided a constant, the conclusion has been brought into the
comment beside that constant instead — which is where it is useful anyway.

Build order from [§8 of the handoff](HANDOFF-v3.md). An exit criterion is an *observable*:
something you can run, see or demonstrate. "Feels done" does not close a milestone, and
[CONTRIBUTING.md](CONTRIBUTING.md) requires the criterion to be copied into the pull request
that closes one.

The order is not arbitrary. Data first (M1), then the security boundary (M2), then game
behaviour (M3–M6), then the map (M7), then the aesthetic (M9). **The CRT layer goes last on
purpose** — it styles a working interface rather than becoming one.

---

## M0 — Repo skeleton — **done**

Everything feature work needs somewhere to live: a pnpm workspace of `apps/web`, `workers`,
`packages/core` and `packages/shared`; TypeScript with project references and strict mode;
Vitest as one root suite; CI on every push.

It exists as a milestone rather than as an afternoon because [§6.5](HANDOFF-v3.md) makes
`packages/core` runtime-agnostic — no Cloudflare and no DOM — and that is a property which
is cheap to establish on day one and expensive to recover on day thirty. It is what makes
the game logic testable without a Worker, runnable under `node --experimental-strip-types`,
and portable off Cloudflare in a day rather than a rewrite.

Two TypeScript compilers, both real: `svelte-check` needs the 6.x API for itself and the 7.x
native binary behind `--tsgo`. `pnpm typecheck` runs both; a bare `npx tsc` is neither.

**Exit:** `pnpm install && pnpm test && pnpm build` green on a fresh clone. **Met.**

---

## M1 — Data arrives — **done**

The ingest half of the system: the OsmAnd-protocol endpoint (R-01, R-02), parsing (R-03), the
unpaired-device tray (R-06) and the geofence that R-04 turns on when a game starts.

It is first because everything after it is a function of a position arriving. The protocol is
Traccar Client's, which is what makes any device that can post a compatible request a valid
tracker — see the README. Two findings shaped the rest of the system: a ping with no
`lat`/`lon` is a **status report** and not a malformed ping, and every unrecognised parameter
is parked in an `attributes` map, kept whole, which is where the allowlist in M8 later became
load-bearing.

**Exit:** a real phone running a tracker app shows up on screen. **Met** — one handset, plus
the synthetic fleet (`tools/fake-phones.mjs`) alongside it.

---

## M2 — Projection and roles — **done**

`project()` — the [§4](HANDOFF-v3.md) visibility matrix — and the sessions that decide who
calls it with what.

**This is the only security boundary in the system.** One pure function decides what every
socket is allowed to hold, there is no second layer behind it, and no message may be emitted
without passing through it. Two independent axes: position scope is the **zone** (R-39..R-42),
and marker and POI audience scope is **team or player** (R-16..R-21). They are never merged;
the single crossing between them is a master setting (R-21d) rather than a rule.

Every row of §4 is a test case across all six recipient columns, and the suite was
mutation-checked rather than trusted for passing. `tests/projection.test.ts` is the
highest-value suite in the repository: with game logic this thin, `project()` is most of the
backend.

**Exit:** every §4 row has a passing test, **and** a devtools inspection of a live player
socket confirms it receives nothing forbidden. **Met.**

---

## M2b — Live on Cloudflare — **done**

Off the LAN and onto the internet: one Worker on a custom domain serving both the built
bundle and the API, one Durable Object holding the game, and the authentication that goes
with a public origin.

The shape it settled on matters more than the deploy. Players authenticate by **redeeming an
invite link** rather than with a password, so there is nothing for them to be told and
nothing to forget; the master has a password, throttled per caller — five guesses a minute,
then locked out for five — because a master who cannot log in at the venue is a worse failure
than a distributed guess against a long random secret. One origin rather than two: serving
the bundle from the Worker itself removes every cross-origin argument about whether the
session cookie or the socket upgrade arrives.

**Exit:** a player's phone posts to the deployed ingest endpoint over HTTPS and draws a dot
on another player's device, with nobody on the same wifi. **Met** — two real phones posting
simultaneously over mobile data.

---

## M3 — Position states — **done**

What a dot means when nothing has arrived for a while: R-11's `MOVING` / `STATIONARY` /
`NO_LINK`, R-12's growing uncertainty circle, and R-13's radio-contact record.

The whole of it is **derived on the client from timestamps in the snapshot** — the server
never ticks to keep ages fresh (§6.3). That needs one thing to be true, and R-36 supplies it:
every snapshot carries `serverNow`, so a phone whose own clock is an hour out still renders
the same link states as everyone else's.

The milestone's real work was deciding what a *stationary* phone looks like, which is not the
same question as a silent one. A tracker at rest sends heartbeats and reports its own
accuracy; a phone in a basement sends nothing. The circle stays at the fix's accuracy while
the feed is alive and opens up only in `NO_LINK`, so the two are never confused.

**Exit:** a phone put in a pocket and left still keeps a **valid, non-growing circle** and
does not cross to `NO_LINK`; a phone in airplane mode crosses to `NO_LINK` at 90 s. **Met.**

---

## M4 — POIs, zones and markers — **done**

The geometry the game is played on, and the two things a master puts on it.

Zones arrive here rather than later because §4 scopes positions by zone: without them every
player is permanently out of everyone's zone and the matrix cannot be verified against a live
socket. Zone assignment happens on ping arrival, inside a request already paid for.

**The zone hold is this milestone's one non-obvious decision.** A zone border is a visibility
boundary, so GPS noise near one is a visibility flap — a player standing still changes zone,
repeatedly, and each flicker is also an over-disclosure. The answer is to hold the previous
zone while the new fix is still within its own reported accuracy of the border it crossed.
The argument for it, and against the two alternatives, is in
[packages/core/src/zones.ts](packages/core/src/zones.ts), which is where it is needed.

Markers are up to five (R-20b), each with an optional TTL (R-21c), scoped by audience, and
their expiry is the **only alarm in the system**.

**Exit:** placing a marker removes nothing from its audience's map; a marker vanishes on TTL
with exactly one alarm scheduled. **Met.**

---

## M5 — Master views — **done**

`OPERATIONAL` and `AUTHORITATIVE` (R-22..R-25): the master's two ways of reading the same
game, and the clock that closes the second one.

`OPERATIONAL` is the default and differs from `AUTHORITATIVE` on exactly one axis — which
position source a stopped feed uses. That is enough to remove the spoiler: an eliminated
player and a dead battery render identically, frozen with a growing circle and no cause
shown, so a master who is also playing does not learn who is out by looking at the panel.

`AUTHORITATIVE` costs a confirmation to enter (R-24) and **reverts after ten idle minutes**
(R-25), which is derived from a timestamp rather than counted down — there is no tick. Only
master *actions* stop that clock; a read never does, because counting reads would let the
panel hold the mode open forever by polling. The revert is applied on the way into every
request, and it is logged.

**Exit:** with one player eliminated and one player's phone off, `OPERATIONAL` renders both
identically — frozen, growing circle, no cause shown. **Met.**

---

## M6 — Elimination — **done**

A player declares themselves out (R-30), the drop point is recorded (R-30.5), and a master
can reverse it (R-32).

The requirement that shaped it is R-30.2: **an elimination reaches no log a player can
watch.** The entry is `MASTER_AUTHORITATIVE`, so it is absent from `OPERATIONAL` too. A
player who is out simply goes quiet, and their map keeps its furniture rather than going
blank — which is a requirement, not a nicety.

Two smaller decisions with the same shape. Declaring twice answers `200` and changes nothing:
a second press must not move the drop point or add a second line. And `dropPoint` is
optional, because a phone that lost GPS indoors is a real case and refusing the declaration
over it would be worse than a missing coordinate pair.

**Exit:** a player self-declares; a second player's socket shows no new event and the first
simply goes quiet. **Met.**

---

## M7 — Basemap and map — **done**

The map under the game: OpenStreetMap vector tiles as a single immutable `.pmtiles` archive,
MapLibre, and R-52's precache so the map survives a dead spot.

OSM rather than a commercial basemap for a reason that is not price: the terms of the obvious
alternatives forbid caching tiles for offline use and forbid restyling, and this project
requires both. The archive is cut per location by [tools/basemap.sh](tools/basemap.sh) and
**ships inside the bundle**, so the deploy is the upload — no bucket, no CORS policy, no
bypass rule.

Two things here are permanently load-bearing and both are written up in
[CLAUDE.md](CLAUDE.md): the three ways the map goes black, every one of them MapLibre's tile
worker resolving somewhere the file is not; and R-50's camera, which cannot use an animation
API because a per-frame bearing filter cancels one on its first frame.

**Exit:** the map loads and pans on a real phone with the network disabled, and the camera
does not spin while the player stands still. **Met.**

---

## M8 — Replay — **done**

Post-game replay (R-53..R-57): a window of the track, scrubbed locally, with the events
folded back in.

**Replay is a clock, not a mode**, and that is the milestone's whole design. `replayAt()`
returns a real `Payload` with `serverNow` moved, so R-11's states, R-12's circles and every
age on screen replay because they were already written against that field. The recorded risk
was a second code path in the view; what prevents one is two lines in the panel and a rule
that nothing below them may branch on the cursor.

The track is two ordinary SQL tables rather than a stored value, because a game is tens of
thousands of points. It deliberately survives `FINISHED` (R-26) — which is what makes one
mistake here permanent rather than session-shaped, and is why `TRACK_ATTRIBUTES` in
[packages/core/src/track.ts](packages/core/src/track.ts) is an **allowlist**: a tracker's
status body can carry a live push credential, R-03 keeps every parameter it does not
recognise, and a replay writer that persisted them wholesale would write credentials into
history that outlives the game.

Interpolation runs only across short gaps. Past that the earlier sample is held **with its
timestamp**, so it ages into `NO_LINK` against the cursor exactly as it did live — a smooth
line there would be a player walking through a blackout they spent standing still in.

**Exit:** scrubbing back 20 minutes reproduces positions and events, then snaps cleanly to
live. **Met.**

---

## M9 — CRT layer — **done**

[§9](HANDOFF-v3.md)'s art direction: the app is a monochrome terminal, and every screen is
inside the tube — login included, because a machine whose case appears once you have logged
in is a web page with a skin on it.

Last on purpose. It styles a working interface rather than becoming one, and the constraints
it added are legibility constraints rather than decoration. Three that turned out to be
rules: the bloom is a `text-shadow` and cannot be a `filter`, because a filter on any ancestor
forces a full-screen composite of the WebGL canvas on every frame; `--alarm` red belongs to
R-43's boundary warning and to nothing else, which is what lets it sit on the map without
being mistaken for game content; and the two typefaces are split **by domain, not by size** —
one is what the tube draws, the other is lettering printed on the box around it.

**Exit:** a distance reading is legible at night, one-handed, at arm's length, with
high-contrast mode both on and off. **Deferred to M10 by decision** — it is a measurement
taken outside, in the dark, on a real handset, and M10 is the session that exists for exactly
that. **Met there.**

---

## M10 — Field rehearsal — **done**

The session the system was built for, run end to end with nothing standing by to fix it.

There is no substitute for it and there never was. Several milestones above have exit
criteria that only a night outside can close, and the ones this found were not the ones
anybody was watching for — a threshold tuned against the wrong case, a control that read as
broken because a cached file never changed, a label distinguished by a typeface that turned
out not to be rare.

**Exit:** a full-length session runs at the venue with no intervention, and the open items
are closed with recorded numbers. **Met** — six players, six hours, no intervention.

---

## M11 — The debrief — **done**

The other end of M10: sitting down afterwards and replaying the whole game.

It is a milestone because it is the only thing that exercises the replay at the length it was
built for, and because it is where R-26's promise — that the track outlives the session that
produced it — is either true or is not. It also produced the two files a debrief needs: the
track as JSON, and a screen recording with legible callsigns in it.

**Exit:** a finished six-hour game replays end to end in one sitting — the window opens on the
whole game, 8x reaches the end with the mode still `AUTHORITATIVE`, the map is readable
throughout, and a selected player's route is drawn broken at a blackout rather than across it.
Both files come out, and the recording has legible callsigns in it. **Met.**

---

## The screensaver — the other half of VIGILIA — **done**

Not a milestone. R-67, one branch, and it is here rather than inside one because it closes
nothing: it makes an existing switch mean something.

`navigator.wakeLock` works, and holds the display awake. What it has never had is a
**visible** effect for a master: a phone dims in a pocket thirty seconds after you stop
touching it, and a laptop on a table does not — so the switch read as dead on the one screen
it is easiest to watch, and it was the **off** position that had nothing to show for itself.
The screensaver is therefore on the off side. Off means the screen is allowed to rest; on a
phone the operating system does the resting, and on a master's screen nothing did.

It is also the one overlay in the app that is not `pointer-events: none`, and that is the
same rule read the other way: it is the only overlay that is not permanent, and the click
that dismisses it must not also drop a marker where the mark happened to be.

**Exit:** the switch has a visible effect on a desktop screen, and dismissing the screensaver
does not act on the map underneath it. **Met.**

---

## M12 — Sectors: a second town, switchable — **done**

The play area gains a level and becomes **switchable**: ground can be closed and opened, and
it may happen during a game.

**Three levels: distrito ⊃ sector ⊃ zona** (R-70), and only the bottom one is geometry. A
sector's boundary is the union of its zones and is never drawn — not out of economy, but
because ground inside a drawn sector and inside none of its zones is ground where §4 can see
nobody and nobody can be seen. Derived, it cannot be written. The grouping is resolved onto
every ZONE feature in the `.geojson`, because the artefact is the only copy anybody reads.

**The zone is the unit** (R-71). A sector is closed when every zone of it is, and a district
when every zone under it is, so the server never learns what either word means: closing a
sector is one call with a longer list. That is also what makes "close the sector, then reopen
one zone of it" an obvious answer rather than a rule somebody has to remember.

Closing is **allowed while a game is in progress** — the area shrinking around the players is
the mechanic, not a configuration change. Swapping the geometry itself is still refused,
because that moves the zones rather than switching them off. The ingest area and the
downloaded basemap do not move with either: they are cut once, to everything, so a phone
outside the active area is still accepted (R-04) and still has a map under it.

R-21d became a ladder here (R-72): comms reach on QSA's 1-to-5 scale, where 3 is §4 alone, 4
adds your own team anywhere in your sector, and 5 adds them anywhere at all.

**Exit:** a game runs over the whole area; the master closes half of it mid-game and every
player's map loses those zones and their points in one broadcast while the boundary closes
around what is left; a player standing on the closed ground keeps their dot, goes red on R-43
and disappears from every player's map but not from the master's; the debrief afterwards
replays the closure at the instant it happened rather than showing the geometry as it is now.
**Met.**

---

## Cross-cutting

Checks that apply at every milestone, not one of them. Settled by a game rather than by a
review: six phones logged into nothing but their own invite, six hours, no intervention.

- [x] the master route is the only thing behind an access layer; ingest, the player app,
      `/api/*` and `/ws` all answer from a phone logged into nothing ([§6.2](HANDOFF-v3.md)).
      Proven by the game running at all
- [x] invite tokens are per game and invalidated at `FINISHED`, like device bindings (R-08) —
      visible from the other side afterwards, as every player's socket being refused the
      moment the game ended (R-74)
- [x] no periodic tick has been introduced; **marker TTL is the only alarm there is**
      (R-21, [§6.3](HANDOFF-v3.md))
- [x] no user-facing string outside `apps/web/locales/es.json`
- [x] no message emitted without passing through `project()`
- [x] game logic still runtime-agnostic in `packages/core` — no Cloudflare or DOM imports
      ([§6.5](HANDOFF-v3.md))
- [x] onboarding still exactly three steps
- [x] device bindings still expire at `FINISHED` (R-08)
- ~~object-storage CORS allows range requests and exposes `ETag` (§14.4)~~ — **void since
      R-52b.** There is no bucket: the archive ships as a static asset on our own origin,
      which is what removed the CORS policy and the bypass rule this line was guarding
- ~~`.pmtiles` archives never committed to git~~ — **inverted by R-52b, deliberately.** The
      deploy *is* the upload, so the archives are tracked and `.gitignore` carries the
      exception that lets them be. What the original line protected against — a repository
      growing a basemap nobody can account for — is held instead by the 25 MiB ceiling
      `tools/basemap.sh` refuses to exceed
