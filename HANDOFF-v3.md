# HANDOFF v3 — Live-action zombie LARP tracking system

> Complete technical handoff. Written in English on purpose: this document drives
> code generation, and a Spanish spec produces Spanish identifiers by mimicry.
> **All code, identifiers, comments and commit messages are English.** UI copy is
> Spanish and lives in `apps/web/locales/es.json`, never inlined.
>
> Requirements are numbered `R-xx`. Numbers are stable across revisions —
> withdrawn requirements are marked *removed* rather than renumbered, so existing
> references keep working. §12 lists changes; §14 is the basemap pipeline.

---

## 0. Overview

Web app (PWA) for running a zombie LARP over a real commercial area of roughly
71,000 m², expandable to surrounding streets and part of the city.
6 players in teams, one or more game masters. Voice comms happen over
walkie-talkie, out of band.

**All GPS work is delegated to Traccar Client**, the published Android/iOS app,
which posts positions over HTTP to our endpoint. Our app never requests
background geolocation.

Player onboarding is exactly three steps, forever: install Traccar Client, paste
the URL, paste the device id. Any design that adds a fourth step is wrong.

**This is not a safety system.** The venue has physical security staff and all
participants are safe at all times. The map is part of the game's immersion.
Optimise for immersion and cost, not emergency response.

**Deliberately thin game logic.** The server routes positions, assigns zones and
projects per role. That is nearly all of it. There is no horde system, no event
engine, no discovery mechanic. Extra value comes from static POIs, drawn areas
and the aesthetic — not from simulation.

**The one structural rule:** filtering happens on the server. Every socket
receives only what its role, team and zone permit. A player with devtools open
must not be able to see anything the UI doesn't show them.

---

## 1. Glossary

| Term | Meaning |
|---|---|
| **Game** | A session. Has state, geometry, config. One Durable Object per game. |
| **Master** | Organiser. Two view modes. Not in the data path: the game runs with zero masters connected. |
| **Player** | Participant. Public `callsign`, private `fullName`. |
| **Team** | Grouping of players. Audience scope for master markers. |
| **Perimeter** | Playable area polygon. Drives boundary warnings. |
| **Ingest area** | Larger region where pings are accepted once the game is running. |
| **Zone** | Static drawn area. Scopes mutual player visibility. No timers, no activation. |
| **POI** | Static point of interest. Configured up front, always visible. |
| **Master marker** | Temporary point placed by the master for a chosen audience. Exactly one at a time. |
| **Device** | A Traccar Client instance. Paired to a player. |
| **Feed stopped** | A player whose position is no longer being relayed — flat battery, lost fix, or eliminated. One predicate, three causes, indistinguishable by design. |
| **Drop point** | Exact coordinates where a player self-declared elimination. |
| **Radio contact** | Manual record that someone spoke to a player. Liveness signal. |

---

## 2. Requirements

### 2.1 Ingest

**R-01** Expose an endpoint compatible with Traccar's OsmAnd protocol (parameters
accepted in the query string and in the POST body).

**R-02** The ingest path carries a long random secret: `POST /i/<secret>/`.
Rotated per game. It is the only credential the OsmAnd protocol has.

**R-03** Parameters consumed:

| Field | Required | Use |
|---|---|---|
| `id` | yes | Device identifier. Pairing key. |
| `lat`, `lon` | yes | Position |
| `timestamp` | no | Fix time (Unix s). Falls back to receive time. |
| `accuracy` | no | Uncertainty radius, metres |
| `bearing` | no | Course over ground. **Sole heading source (R-50).** |
| `speed` | no | Gates `bearing` validity only. Never used for ETAs. |
| `batt` | no | Battery 0–100 |
| `is_moving` | no | Movement state |
| `activity` | no | `still` / `walking` / `in_vehicle` |
| `event` | no | `motionchange`, `heartbeat` |

Unrecognised parameters are kept in a free-form attribute map.

**R-04** Geographic rejection applies **only while the game state is
`IN_PROGRESS`**. Pings outside the ingest area are dropped and logged.

> During `PREPARATION` pings are accepted from anywhere. Setup happens at home and
> in the car, hours before anyone reaches the venue, and pairing requires a real
> ping to arrive (R-06). A geofence during preparation makes pairing impossible.

**R-04b** A repeated rejection from the same caller is **counted, not logged
again**: the first is written at once and the rest of a five-minute window
arrive as one line carrying how many there were.

R-04 says a ping outside the ingest area is dropped and logged, and that was
built as every one. One device in the wrong place therefore writes a line every
reporting interval, and the live event tail is capped — so it pushes every other
event out of the master's panel. Measured on a local Worker forty minutes into a
test game with a single device outside the area: **212 of 238 events in the tail
were `INGEST_REJECTED`**, all from the same device, all saying the same thing.
The archive replay reads from (R-56) had the same 212.

The first rejection from a device is the useful one — that phone is outside the
area, or the secret is wrong, and somebody should go and look. The four
hundredth says nothing new, and the log is where a master finds out what
happened in a game.

Keyed per caller, so a second device going wrong while the first is still being
suppressed is still news. A ping too malformed to carry a device id is keyed by
its reason instead: what a master needs to know there is that something is
sending rubbish, not how much of it.

**R-05** Pings are accepted whenever the game state is `PREPARATION`,
`IN_PROGRESS` or `PAUSED`, and rejected when `FINISHED` or when the manual cut
switch is on. There is no separate ingest schedule (R-34).

**R-06** A ping with an unknown `id` is not discarded: it creates or updates an
entry in the **unpaired device tray** with id, first seen, last seen, coordinates
and ping count.

**R-07** The master pairs a device to a player from the tray. The whole game —
players, teams, geometry, POIs, pairings — must be fully configurable before
anyone leaves for the venue.

**R-08** All device↔player bindings **expire when the game is finished**. No code
path may leave a binding alive past the session.

**R-09** Traccar Client is the only supported source. No PWA-sent position, no
custom SDK app. A single link threshold applies to everyone (R-11). GSM trackers
speak the same protocol and would drop in unchanged if ever needed, but are out
of scope.

### 2.2 Position state

**R-10** Three states:

| State | Detection | Position validity |
|---|---|---|
| `MOVING` | recent ping, `is_moving: true` or absent | reliable |
| `STATIONARY` | `motionchange` with `is_moving: false`, `heartbeat`, or `activity: still` | **valid** |
| `NO_LINK` | silence beyond threshold with no stationary evidence | unreliable |

**R-11** Link threshold: **90 s**, single value, config key `linkThresholdMs`.

**R-12** The growing uncertainty circle around a last known position appears
**only in `NO_LINK`**. If the device declared stationary, the position is still
true and the circle does not grow.

**R-13** Radio contact is a manual record that someone spoke to a player by
walkie. It **only starts mattering once the player is in `NO_LINK`**. While pings
are flowing it is neither displayed nor tracked.

Contact stays valid for **5 minutes** (`radioContactValidityMs`). A `NO_LINK`
player with fresh radio contact renders as accounted for; without it, as
unaccounted. **Neither raises an alarm** — display state, not an alert.

**R-14** Both players and masters can record radio contact for any player.

**R-15** State computation needs no server tick. The client knows `lastPingTs`
and derives age locally. The server recomputes and broadcasts **on ping arrival**
(§6.3).

### 2.3 POIs, zones and master markers

**R-16** POIs are **static configuration**, visible to everyone from the start.
No discovery, no proximity unlocking, no redacted slots.

> This lets POIs carry non-game meaning too — meeting points, entrances, the car
> park — which is impossible if they have to be found.

**R-17** A POI has: id, name, position, category (`OBJECTIVE`, `MEETING_POINT`,
`ENTRANCE`, `HAZARD`, `OTHER`) and an optional `audience` scope. Default audience
is everyone; a POI may optionally be scoped to a single team.

**R-18** Proximity to a POI shows name, distance and rough time (R-45). Purely
informational; nothing unlocks.

**R-61** A master may take a point off **every** player's map, and it stays off
until put back: the setting is the server's, survives a reload and a second
master, and every toggle is logged. It is not an audience rule — R-16 to R-18
answer *who a point is for* and are per-recipient; this removes it from
everyone at once, so it is filtered after them and never instead of them.

The master keeps seeing it, in both view modes, because the list in the panel is
the only place a hidden point can be found again. A player is never told which
points are hidden: that list is the places they are not being shown, which is
more than the unfiltered list ever was.

It does not outlive its game. The ids belong to the geometry they came from, so
a profile change clears them, and so does the end of a session — a point hidden
in one game arriving missing in the next, with nobody remembering doing it, is
the elimination-that-outlived-its-game in a shape that leaves an absence instead
of a mark.

**R-19** The master can place a **master marker**: a temporary point with a
label, an audience (`player:<id>`, `team:<id>` or `all`) and a TTL.

**R-20** ~~**Exactly one master marker exists at a time, globally.** Placing a
new one replaces the previous one, whatever its audience was. No queue, no
per-audience slot.~~ **Superseded by R-20b on 2026-09-03.** Kept verbatim: every
commit and doc comment citing R-20 stays true about what it said.

**R-20b** **Up to five master markers exist at a time, globally.** Placing a
sixth is **refused**, not queued and not silently replacing anything — the master
clears one first. Still no per-audience slot: the five are one global set,
whatever each one is addressed to.

> The single slot of R-20 was a deliberate constraint, and loosening it was
> named as M4's own risk. It was loosened on purpose, by the author, with the
> cap and the refusal as the things that keep it from becoming a queue: five is
> few enough to hold in your head, and a refused sixth is a decision the master
> makes rather than a marker that vanishes from somebody's phone unasked.

**R-21** ~~Markers expire on their TTL and vanish from the audience's map. Marker
expiry is the only recurring alarm in the system (§6.3).~~ **Superseded by R-21c
on 2026-09-03.**

**R-21c** A marker carries **a TTL or none**. With a TTL it expires and vanishes
from its audience's map; without one it stays until the master clears it, or
until the session ends (R-08). Expiry remains the only recurring alarm: one alarm
is scheduled for the **earliest** expiry among the live markers, and markers with
no TTL schedule nothing.

> An indefinite marker is one nobody has to remember to renew, and one nobody
> remembers to remove. Expiry is therefore still the default in the panel, and a
> marker without a TTL is a choice made per marker rather than a mode.

**R-21d** The master can enable **extended comms**, a single global setting. While
it is on, a player sees **every member of their own team, in every zone**, exactly
as if they were in the same zone — position, distance, battery and link state.
Off by default. Toggling it is logged (§3), because it silently rewrites who can
see whom.

> It is a comms setting, not a view mode: it changes what **players** see, it is
> not the master's `AUTHORITATIVE` (R-22), and it never affects what the master
> sees, who already sees everyone. It does not reach an eliminated player either
> — R-30.4 still takes everything but their own position from them.

**R-72** **Extended comms is a ladder, not a switch**, on QSA's own scale — and
**only the team's reach widens**. §4's zone scoping is identical at every rung.

| level | reach |
|---|---|
| **3** | §4 as built: everyone in your zone. Nobody sees a teammate outside it |
| **4** | *and* your own team anywhere in your **sector** |
| **5** | *and* your own team anywhere at all — R-21d exactly as it behaved as a boolean |

> **5 keeps its meaning rather than becoming "see everybody".** This adds a
> point to the setting; it does not rewrite the one that was there. `Qsa.svelte`
> already took any level — its own comment said a meter that can show three
> things has to be edited the first time there is a fourth, and this was that
> time.
>
> **4 is not "everyone in your sector".** That would put the position axis on
> *ground* rather than on team membership, which is the one thing §4 lets
> nothing else do. It is the same predicate as 5 with a narrower question.
>
> A teammate on ground R-71 has closed has no zone, so they have no sector, so 4
> does not reach them — the closure takes them out of their team's reach by the
> same rule that takes them out of everyone's sight, and nothing in the ladder
> knows about it. 5 still reaches them, because 5 asks nothing about where
> anybody is.
>
> `Game.commsReach` replaces `Game.extendedComms`, and `#load()` lifts the old
> key: `true` is 5, anything else is 3. Absent reads as 3 through
> `commsReachOf()`, the same shape `extendedCommsOn()` had. The panel confirms a
> step **up** and lets a step down through: narrowing takes visibility away, and
> the cost of this setting is entirely in granting it.

**R-21b** **Zones are static drawn areas.** They have geometry and a name, they
scope mutual player visibility, and that is all. There is no activation, no
timer, no horde kind, and no zone-based events.

**R-70** **The geometry has three levels: distrito ⊃ sector ⊃ zona.** Every zone
belongs to exactly one sector and every sector to exactly one district. A
**sector is the unit the master switches**; a **district is a group control** and
nothing else reads it.

> **Only the bottom level is geometry.** A sector's boundary is the union of its
> zones and is never drawn, which is not economy — ground inside a drawn sector
> but inside none of its zones is ground where §4 can see nobody and nobody can
> be seen, and that was a real defect at a real venue, found on a 10 m sample and
> corrected by hand on 2026-09-02. Derived, it cannot be written.
>
> **A sector with nothing drawn inside it still has one zone.** An area with no
> subdivisions has nothing drawn in it, and §4 decides visibility by zone, so a
> player standing there would otherwise be in none — invisible to everyone and
> seeing nobody. Each gets a single leaf zone covering the sector.
> The alternative, falling back to the sector when `zoneAt()` finds nothing, puts
> a branch on the one axis of the system where a branch is a visibility leak.
>
> **`Zone['sector']` is required, and a zone without one is refused at read
> time.** A default would be a zone nobody can switch off, silently, in the one
> artefact a venue is described by; the symptom at the venue is a closure that
> leaves a piece of ground open with players standing on it.
>
> **This inverted a word the product already used.** The Spanish UI called a
> `Zone` a *sector* — `geo.zones: "SECTORES"`, the QTH line, the roster's own
> caption, R-42's heading, the QSA legend — because until M12 there was only one
> level and *sector* was the word for it. The ladder in R-21d needs
> zona ⊂ sector, so a `Zone` is **ZONA** on screen and SECTOR moved up a level.
>
> The flip is done and it was not only the strings: the doc comments said
> *sector* too, in `PlayerView`, `PoiCard`, `format.ts` and `geo.ts`, which is
> how the confusion would have come back. Code and UI agree now, and a control
> reading SECTOR and a card reading SECTOR meaning two different levels is the
> failure this requirement exists to have prevented.
>
> The grouping is **resolved onto every ZONE feature** in the `.geojson` rather
> than declared once somewhere else. The artefact is the only copy anybody reads
> — it is hand-maintained and it travels on its own — so a grouping kept in a
> generator would be a fact about the venue held where the venue's file does not
> go. `tests/geo.test.ts` checks it on the committed files, which is where the
> grouping is.

**R-71** **Ground can be closed and opened, and it may happen during a game.**
**The zone is the unit**: a sector is closed when every zone of it is, and a
district when every zone under it is. The master writes the **whole closed set
of zones** (`POST /api/master/game/zones`); sector and district are group
controls on the panel and the server never learns what either word means. One
set rather than three is what makes "close the sector, then reopen one zone of
it" an obvious answer instead of a rule. A closed sector's zones and points leave every **player's** map — this is
ground going out of play, not information being withheld, so it is not a §4 rule
and a player is not told what was taken out.

> **The master keeps the ground and loses the points**, which is one decision
> rather than two halves of an inconsistency. §14.3 leaves the map without
> labels, so the panel's list of fourteen sectors is fourteen names with no
> ground attached — and a master directing somebody through a district they have
> never walked is the normal case with two towns in play, not the edge one.
> Pointing at a row has to light something, and after a closure there would be
> nothing left to light. So the closed sector's zones stay on the master's map,
> drawn as out of play: no fill, no glow, a quiet outline. **A name is not a
> place.** The points do not come back with them — a point is somewhere to send
> somebody and there is nobody to send.
>
> That is R-61's shape at the next level up: the list is what makes a thing
> findable again, and here the map is part of the list.

> **Three point filters now, in this order: R-71 → R-61 → R-16..R-18.** They are
> three different kinds of thing — out of play, taken off every map by one
> person, and addressed to somebody. The order is load-bearing at one join: a
> point in a closed sector must never enter `hiddenPois`, or opening the sector
> would not bring it back and R-61's list would fill with ids nobody chose.
>
> **The play boundary is derived, never drawn.** `Payload.playArea` is the
> union of the open zones, and it is what the map draws and what R-43 warns
> about. `Game.geo.perimeter` stays put: it is the whole recinto, it is what
> `pmtiles extract` was given (§14.2), and an archive that shrank with a
> master's decision would be a download the phones cannot redo at the venue. Two
> boundaries because they answer two questions — how far the map reaches and how
> far the game does — and before ground could close they happened to be the same
> polygon.
>
> Deriving it closes a class of defect rather than adding one: the zones tile
> the perimeter exactly, so ground inside the boundary and inside no zone cannot
> exist. That was a real fault at a real venue, corrected by hand on 2026-09-02.
>
> **It is a list.** A geometry may hold two areas that do not touch, joined by a
> road drawn as a sector of its own precisely so a master may shut it, which
> leaves two islands. Every consumer takes the
> pieces: one map feature each, "inside" means inside any, and the boundary is
> the nearest edge of any. Empty when every zone is closed, which R-43 reads as
> UNKNOWN rather than as a breach — there is a difference between "you are
> outside" and "there is no inside".
>
> **Closing ground mid-game is the mechanic, not a configuration change.**
> `POST /api/master/game/geo` stays refused while `IN_PROGRESS` because it moves
> the zones themselves and would take R-04's geofence and §4's projection with
> them; this moves neither. What happens to a player standing in one is a
> requirement, not something to find out in the field:
>
> - **they keep emitting.** The ingest area does not move with the switch, so
>   R-04 goes on accepting their pings and the master keeps seeing them normally
>   in both view modes — a panel that blinded a master to the players their own
>   decision caught is the opposite of what the control is for (R-35's reasoning)
> - **they lose their `zoneId`**, and §4 does the rest with no new rule: no
>   player sees them and they see no player. Their own card reads as out of play
>   too, which is the point — players have no event feed, so the closure is told
>   by the map, the card and R-43
> - **R-21d still reaches their own team** at 4 or 5. The ladder is about the
>   team's reach and says nothing about which ground is in play
>
> The closed set is its own storage key, cleared by a geo profile change and by
> the end of a session, for the reason `hiddenPois` is: zone ids belong to the
> geometry they came from, and a town quietly out of play at the start of a
> session nobody set it for is an absence rather than a mark.
>
> `GEOMETRY_TOGGLED` carries **the whole open set**, not the zones pressed. See
> the event kind: `replayAt()` is only safe today because the geometry cannot
> change mid-game, and this is what stops that being true.

### 2.4 Master views

**R-22** Two view modes over the same interface.

**`OPERATIONAL` (default).** The master sees the position **the game knows**, not
the position the system knows:

- Players with a live or stationary feed render normally, **in every zone**.
- Players whose feed has stopped — flat battery, lost fix, or self-declared
  elimination — render **frozen at their last known position** with the growing
  uncertainty circle, and with **no indication of which cause applies**.
- All POIs, all drawn zones, the active master marker.
- Roster with callsigns, full names, link state, battery, radio contact.
- All master controls.
- Hidden: the real current position of any player whose feed has stopped,
  elimination state, drop points, replay.

**`AUTHORITATIVE`.** Everything, always: real live positions including eliminated
players, elimination state, drop points, full replay.

> **Implementation note.** A single predicate `feedStopped(player)` selects the
> position source. A flat battery and a dead player take the same branch by
> design — that is the whole mechanism, and it must not be special-cased.

The master frequently plays alongside players and coordinates them by radio, so
knowing exactly who is out is counterproductive. `OPERATIONAL` preserves full
coordination ability while removing the spoiler.

**R-23** *Removed.* (Was a 30-second spot reveal. Unnecessary now that
`OPERATIONAL` shows live positions.)

**R-24** Switching to `AUTHORITATIVE` shows a blocking confirmation warning: the
master is about to see real information about eliminated players, which must not
be shared with players in that state nor influence radio instructions.

**R-25** Every `AUTHORITATIVE` activation is logged with a timestamp. The mode
auto-reverts to `OPERATIONAL` after **10 minutes** of no interaction.

**R-25b** R-25's auto-revert **does not apply while the game is `FINISHED`.**

The timeout exists so the mode cannot be left open *during play*: the hazard R-24
briefs against is a master who sees who is out and lets it change what they say
over the radio. A finished game has no radio and nobody left to tell — and R-26
makes `AUTHORITATIVE` the only way to read a replay at all, so the timeout in
that state stops protecting anything and starts charging the debrief a
confirmation every ten minutes. In `FINISHED` the mode therefore holds until the
master leaves it or logs out.

Unchanged in all four states: R-24's blocking confirmation, and the logged
activation. Unchanged in the other three: the ten minutes, and the rule that
reads never stop the clock.

**R-26** Post-game replay with full detail requires `AUTHORITATIVE`.

**R-27** A player record holds exactly two identity fields: `callsign` (public)
and `fullName` (master only, in **both** view modes). Nothing else — phone
numbers, emergency contacts and medical data live elsewhere and are out of scope.

> `fullName` exists purely so a master who has forgotten who "NOGAL" is can check.
> It is never sent to player sockets, in any view mode.

**R-67** A master's screen left untouched for **one minute with the screen lock
off** clears itself and bounces the device mark across the tube until something
is touched again. Master only. Never while anything on the glass is
moving on its own — a running replay is not an idle screen, whatever the hands
are doing. Nothing about it reaches the server, and the input that dismisses it
is consumed rather than passed to the map underneath.

> **It is the visible half of the screen lock, which is why it is the *off*
> position that draws it.** `navigator.wakeLock` is real on a desktop and does
> hold the display awake — it has simply never had an observable effect for a
> master, because a phone dims by itself thirty seconds after you stop touching
> it and a laptop on a table does not. So the one switch on the case a master is
> most likely to press appears to be a dead one. Off now means the screen is
> allowed to rest, and on a tube resting is drawn rather than blank: a
> screensaver exists to stop a still image burning into phosphor, which is what
> §9 spends the whole interface pretending this is.
>
> It is master-only for R-43's sake. A player's boundary warning may never be
> behind anything, and a screen that has to be woken before it can be read is a
> screen that told them nothing. Not counting as an interaction is R-25's
> sake: a screensaver that polled anything would be a way to hold
> `AUTHORITATIVE` open by doing nothing at all.
>
> **A minute is short and it is deliberate.** A master reading the map with
> their hands still will be interrupted, and that costs one movement of the
> pointer, because any input dismisses it and none of them reaches the game.
> The alternative costs a still bright map for as long as the wait, which is
> the burn the requirement exists to prevent. A master who would rather not be
> interrupted turns the lock on, and then none of this happens.

**R-67b** **Nor while the tube is being recorded** (R-65).

R-67 says never while anything on the glass is moving on its own, and a capture
is not that: nothing moves, and the hands being off the keyboard is the point
rather than the symptom. R-65b starts a replay whenever a recording starts, so a
debrief being captured was already covered by the replay clause — the case that
was not is a recording of a **live** panel, which is the one an operator sets
going and walks away from.

What makes it worth its own line is where the damage lands. Every other reason
the screensaver is wrong costs one movement of the pointer; this one is written
into the file, and the file is the artefact. Nobody is watching the tube to
dismiss it, and what comes back is a minute of the game followed by a bouncing
mark.

### 2.5 Masterless operation and player signals

**R-28** The game runs with zero masters connected. All logic — zone assignment,
link states, marker expiry, elimination — lives on the server. The master is an
observer and an operator, never a link in the data path. Masters are frequently
busy doing something else; nothing may depend on one watching the map.

**R-29** A player can record radio contact with another player (R-13). This
crosses zone boundaries on purpose: it is liveness, not location, and it is what
makes the walkie-driven game work when GPS goes quiet.

**R-30** A player can **self-declare elimination**. Effects:

1. The server stops relaying their position to other players.
2. **No elimination event is emitted to players.** Nobody is notified.
3. To everyone else they simply become `NO_LINK`, indistinguishable from a flat
   battery. The ambiguity is intentional and good.
4. The eliminated player's own client keeps: **their own position, all POIs
   visible to them, any master marker addressed to them, and the drawn zone
   geometry.** It loses all other players' positions.
5. The drop point is recorded with exact coordinates and time.

**R-31** Drop points are visible only to the master in `AUTHORITATIVE` during the
game, and to everyone in the post-game debrief.

**R-32** Self-declaration requires a deliberate confirmation (~3 s
press-and-hold). Only a master can reverse it.

### 2.6 Game state

**R-33** States: `PREPARATION` → `IN_PROGRESS` → `FINISHED`, with optional
`PAUSED`.

**R-34** **There is no access schedule.** Sessions and ingest are open for as long
as the game exists and is not finished. If setup starts six hours early, pings are
accepted six hours early.

The only manual control is a **cut switch** that halts ingest and broadcast
immediately, independent of state.

**R-34b** **Finishing a game throws the cut switch**, and opening the game again
releases it — but only if the finish is what threw it.

R-05 already refuses every ping once the state is `FINISHED`, and finishing
already closes every socket and revokes every player session, so a finished game
is silent through two mechanisms before this one. The third is not redundant
with them in the way it first looks: those two are consequences of the state,
and **the switch is the thing a master reads to know whether the machine is
listening**. A panel saying ingest is open, on a game refusing every ping, is
the machine lying about itself in the one place somebody checks.

R-34 says the cut is the only manual control and that is still true of the
throw; what this adds is one automatic one, in a state where there is nothing
left to cut off. A cut already thrown by a master is left alone, because the
throw was theirs and the release has to be theirs too.

**The release is the half that needs saying.** A cut left on from a finished
game would make the *next* session start deaf — pings refused for a reason that
belongs to a game that is over, with nothing on screen tying the two together —
and that is a worse failure than the one this fixes, because it happens during
setup and looks like broken ingest. So leaving `FINISHED` clears a cut that the
finish threw, and never one a master threw by hand. `Game.cutByFinish` is which
of the two it was, and any manual use of the switch makes it the master's again
in both directions.

**R-35** Masters access in any state, including with the cut switch on.

**R-60** The cut switch halts the **player** feed, not the master's. With it on,
no player receives a snapshot — not over the socket, not on connecting, and not
from `/api/state` or `/api/geo`, which are the same projection in other wrappers
and would otherwise be the way round it. Masters keep theirs: R-35 gives them
access in any state, and a frozen panel is the opposite of that at the moment it
is needed. Throwing or releasing the switch is logged.

R-34 says "ingest and broadcast" and R-35 says masters keep access; this is the
interaction between them, written down rather than inferred. It is a new number
rather than an edit because R-34's own wording is unchanged and still correct.

**R-36** All clocks are server-side, UTC. Client clocks are never trusted.

**R-37** When a game finishes, player clients stop receiving updates. The client
keeps its own position and the perimeter geometry, which are computed locally and
work offline — this costs nothing and avoids an abrupt blank screen mid-immersion.

**R-33b** **A master session survives the end of a game; a player session does
not.**

Finishing revokes every player cookie, device binding and invite in one bump of
the session epoch (§6.4) — one number rather than a register of who is logged in,
which is the whole reason that mechanism was chosen. It took the master's own
cookie with it, so the debrief began by logging in again and re-confirming R-24,
on the one screen R-26 says is the point of keeping the track at all.

The epoch therefore splits in two: **a player epoch**, bumped when a game
finishes and by `POST /api/master/game/reset`, and **a master epoch**, bumped by
the reset and by nothing else. Nothing else about §6.4 changes, and a session is
still refused outright when its epoch does not match.

**SALIR clears the cookie in that browser and does not move the epoch**, which is
the right grain for logging out: an epoch is a mass revocation, and one master
leaving must not sign out a second one who is still working.

Finishing still clears every stored view mode, and that is not in tension with
the session surviving: what outlives the game is the master's **access**, not
their mode. R-24's confirmation is a briefing about a specific situation, and a
game ending with the panel left in `AUTHORITATIVE` would carry that open window
into a different one without anybody deciding to. The master confirms once more
for the debrief, and R-25b is what makes that one confirmation enough.

The cost is stated rather than hidden: a master cookie now outlives the game it
was issued in, so it is a live credential sitting on somebody's laptop until they
press SALIR. That is the same trade the 48-hour track retention already makes —
the debrief is worth a window in which the archive can still be read — and SALIR
is what closes it.

### 2.7 Player view

**R-38** Own position, always, with heading.

**R-39** Positions of players in the same zone.

**R-40** Players outside the zone: **callsign only**. No position, no distance, no
last known position, no ghost marker. Separate group at the end of the list.

**R-41** ~~Teammates outside the zone are **not** visible either. Team membership
does not override zone scoping; it only scopes master-marker and POI audiences.~~
**Conditioned by R-41b on 2026-09-03.**

**R-41b** R-41 holds **while extended comms is off**, which is the default: team
membership scopes master-marker and POI audiences and nothing else. With extended
comms on (R-21d), team membership **does** override zone scoping, for teammates
only — everybody else outside the zone is still callsign only (R-40), and the
distance to them is still withheld (R-42).

**R-42** The list is sorted by proximity **only among same-zone players**. The
out-of-zone group has no ordering derived from position.

> Distance to an out-of-zone player is itself information. Do not leak it through
> sort order.

**R-43** Boundary warnings, computed **client-side** (`pointToLineDistance`
against the perimeter), so they work without network:

| Condition | Warning |
|---|---|
| < 50 m from the boundary, approaching | amber screen edge, short vibration |
| outside the perimeter | persistent red edge, long vibration, return arrow |

Non-modal. The player may be running.

**R-44** POI proximity shows name, distance, rough time.

**R-45** ETA is `(euclideanDistance × detourFactor) / walkingSpeed`, with
`detourFactor = 1.35` and `walkingSpeed = 1.4 m/s`.

> Buildings and fences mean a point 200 m away can be 600 m of walking. **Render
> "≈4 min", never "4:12".** Never use instantaneous GPS speed, which is noise.

**R-46** There is no panic button. Physical security staff handle real incidents;
an in-app emergency channel would be a false promise.

**R-68** **The installed app takes the whole screen, and the case absorbs the
cutout.**

`display: "fullscreen"` in the manifest, not `standalone`. Standalone hides the
browser's chrome and keeps the system's, which is what the specification says it
does and is not what a phone held sideways can afford: a 360 dp viewport loses
about 72 dp to the status bar and the navigation bar together — **a fifth of the
screen**. The same two bars are 9% of the same phone held upright, which is why
this reads as a problem only when rotated.

No `display_override` beside it: the fallback chain fullscreen → standalone →
minimal-ui → browser is already in the specification, so a browser that cannot do
the first lands on exactly what this was.

**And the bezel takes the safe area.** `viewport-fit=cover` is what lets the app
reach the physical edges, and it is also what puts it under a camera hole and
under the rounded corners unless something reserves the room. The inset is padded
on the **case**, never the tube: a monitor's surround is the part that is allowed
to be an awkward shape, so the glass stays rectangular and the plastic grows by
whatever the device keeps. On a phone with no cutout every inset is zero and the
box is unchanged.

**R-68b** **The room belongs to what is read, not to the bezel.**

The paragraph above is wrong and a Pixel 9a showed why. The case paints a
gradient, so room reserved on it *is* bezel: in portrait a hairline nobody
notices, and in landscape — where the cutout moves to a side — a band across the
width, spending the screen `fullscreen` had just gone to fetch.

So the case keeps its 3 px and **the map goes to the physical edge and stays
there**. A road under a camera hole loses nothing; it is texture. What may not
sit under one is a **reading**: the scale bar, the callsign, the status block,
R-43's alert, the master's clock, and the switches on the chin. Each of those
takes the inset instead.

**And the inset is `max(env(…), a constant)`, because `env()` is not enough.**
It reports the display cutout and nothing reports the corner radius, which
rounds off about ten pixels on each axis of a modern phone. The same Pixel 9a
clipped the scale, the callsign and half of the VIGILIA switch — all four in
corners — while `env(safe-area-inset-top)` read zero. The constant is a guess
about hardware and is held in one custom property so it can be corrected in one
place.

The constant applies **only in `fullscreen`**. Anywhere else the browser's own
furniture or the system bars already hold the app off the corners, and an inset
there pads against a hazard that is not present.

**R-68c** **The manifest goes back to `standalone`, and the whole screen becomes
a button.**

R-68 took the system bars from the installed app, and it took them everywhere. A
phone held upright has room for them and no complaint to answer; a phone turned
sideways has neither. **A manifest cannot tell those apart** — `display` is read
once, when the app is installed, and does not vary by orientation.

Nothing else can tell them apart automatically either. `requestFullscreen()`
needs a user gesture, so no rotation handler may call it. That is not a
limitation to work around: it leaves a control, which is the honest shape of the
feature. The player presses it when they turn the phone, and it survives every
rotation after that until they leave.

**The player gets a button and the master gets a key.** On a phone it sits in the
map's chrome column beside R-48's camera controls, because to a player it is one
— the two above it change what the camera looks at and this changes how big the
window is. On the master's view it is `F` on the bar, with the marker window and
the panels: a control floating over the map is furniture for a phone held in one
hand, and the bar already has a legend and room on it. A keystroke is a user
gesture, so the key can do what the button does.

The state is mirrored from `fullscreenchange`, never set on the way out. Every
exit belongs to the browser — the back gesture, Escape, swiping the bars down —
and a flag that only tracked the button would be wrong the first time somebody
used one of them. R-68b's corner allowance reads that mirror as well as
`@media (display-mode: fullscreen)`, because the media feature is specified
against the *web app's* display mode and whether the API flips it has varied.

A browser tab is not covered by any of this — a manifest only applies to an
installed app. Reclaiming the bars there needs the Fullscreen API, which needs a
gesture and cannot be restored after a reload, so it would be a control on
screen rather than a setting in a file. Deliberately not built.

**R-68d** **The corner allowance is for touch screens only.**

R-68b's constant is a guess about a **phone's corner radius**, and nothing on
the platform reports one. That was already known; what was missed is that
nothing reports its *absence* either. A laptop with square corners answers
`env(safe-area-inset-*)` with zero on all four sides, which is the same answer a
phone gives when its cutout misses the app — so `max(0px, 14px)` reserved the
allowance on a rectangle, against a radius that is not there.

It showed on the chin, which is where the inset is least free to be wrong: the
row takes it as `padding-bottom` against a hard `padding-top: 0`, so the legend
and the switches centred themselves in a content box shorter than the plastic
and sat about 7 px above the middle of the strip — with the screws, absolutely
positioned and therefore resolved against the padding box, staying where the
middle used to be.

So the allowance is gated on `pointer: coarse`. It is a proxy for "this screen
belongs to a phone" and it is wrong about a touchscreen laptop, which reserves
room it does not need. That is the direction to be wrong in: the cost there is a
few pixels of plastic, and the cost of the rule it replaces was half a VIGILIA
switch on the device that does have the radius.

The screws take half the bottom inset as a negative margin, so they stay on the
legend's line wherever the allowance does apply.

### 2.8 Map

**R-47** MapLibre GL JS with a custom style (§14). `maxBounds` set to the ingest
area, `minZoom`/`maxZoom` bounded. All geometry comes from configuration so the
play area can grow into surrounding streets, and so test sessions can run
somewhere else entirely.

**R-69** **Street names are drawn where the place is read by street name, and
they are the only label that is drawn anywhere.** The map carries one `symbol`
layer, over the basemap's `roads` source-layer, filtered to features that have a
name. §14.3's argument is kept and narrowed rather than dropped: every other
label the basemap holds — `places`, `pois`, `boundaries` — remains
*unrenderable* because nothing references those layers, which is a different
thing from being filtered or hidden.

> It arrives with the town (M12). At one venue the vocabulary was the zone —
> a player says "estoy en Outlet" and everybody knows where that is — and a
> street name would have been clutter. Across a town nobody has a zone name for
> where they are, and a player who cannot read the street they are standing on
> cannot say where they are over the radio, which is the only channel R-29
> gives them.
>
> **So the layer is per location, and the reasoning above is what makes that the
> rule rather than a preference.** `Game.basemap.streetNames` is derived from the
> geo profile beside `pmtilesUrl` and `bbox`, so switching geometry switches the
> lettering with it and there is nothing to remember on the way into a session.
> A town profile has it; a venue-scale one does not. At a venue the roads under
> the geometry are a car park's internal lanes, the names mean nothing to anybody
> standing on them, and they land directly on the zone outlines that are the
> actual vocabulary — §14.3's ground shouting over the figure. Every profile
> bundled in this repository is a city centre, so every one of them has it.
>
> **Off means the layer is removed, not hidden**, and absent means off. A
> `visibility: none` layer still requests glyph ranges and still counts as a
> symbol layer, so hiding it would leave §14.3's invariant answering "one symbol
> layer" for a map that draws no text — and that rule is worth having only
> because it is countable. A location with the names off therefore gets exactly
> the style §14.3 described before this requirement existed, which is also what
> a payload seeded before the field gets.
>
> The glyphs are **VT323 and self-hosted**. §9 gives the tube one face and the
> case another, and a street name is drawn on the tube; a third face would be
> the machine speaking in a voice it does not have. Self-hosted because R-52
> puts the map offline — a glyph range fetched from a CDN is a label layer that
> works at the desk and not at the venue. `tools/glyphs.mjs` generates the
> ranges and `tests/glyphs.test.ts` holds their format, because a malformed
> range fails inside MapLibre's worker and the failure is a blank map.
>
> The label is basemap, not game: it takes the major road's colour and the
> ground's halo, both of which already have a value in all three palettes, and
> the two brightest values in §9 stay with the geometry (§14.3's figure and
> ground).

**R-48** Player map has two modes, toggled:

- **Navigation (default).** Camera follows the player, `pitch ≈ 50`, `bearing`
  follows heading, tight zoom.
- **Overview.** North up, `pitch: 0`, `fitBounds` to the whole play area.

**R-49** Master map is north up, no rotation, no pitch, in both view modes.

**R-50** Heading comes from the `bearing` field of the incoming ping (R-03), not
from device sensors. This avoids a second permission prompt. **Browser
geolocation is not used at all** for now.

Mandatory handling:

1. **Freeze the last bearing below `bearingFreezeSpeed` (0.5 m/s)** or the map
   spins while the player stands still.
2. **Low-pass filter the rotation** (`bearingSmoothing ≈ 0.12` per frame). Never
   snap. Player-facing smoothness is a requirement, not a nicety.
3. One ping interval of latency (~5 s) is **accepted**. If navigation mode feels
   sluggish in the rehearsal, the lever is reducing Traccar Client's reporting
   interval to ~3 s, at a battery cost. Measure before changing it.

**R-51** Perimeter, ingest area, zones and POIs live in a **single GeoJSON**
feeding both the renderer and server-side geometry. One source of truth. Every
feature carries a `featureType` property (`perimeter`, `ingestArea`, `zone`,
`poi`) so the style can filter on it.

**R-52** Basemap tiles are a self-hosted `.pmtiles` extract served from ~~R2~~ and
cached by the service worker. Full pipeline in §14. **Conditioned by R-52b on
2026-09-03.**

**R-52b** The extract ships **as a static asset next to the bundle**, not from
R2. Same origin, so there is no CORS policy to misconfigure and no Access bypass
rule to forget — the two failures §14.4 warns render a blank map with nothing in
the console — and Cloudflare charges nothing to serve or store it.

Two consequences, both load-bearing:

1. **The asset server answers a range request with `200`, not `206`,** and
   `pmtiles` treats that as fatal ("Check that your storage backend supports
   HTTP Byte Serving"). The archive is therefore read **whole, once**, and
   sliced in memory — `WholeArchiveSource` in
   [`apps/web/src/map/archive.ts`](apps/web/src/map/archive.ts). Byte serving is
   no longer required of anything.
2. **A static asset is capped at 25 MiB.** `tools/basemap.sh` refuses to install
   a larger archive and names the lever, which is a zoom level. A location whose
   extract will not fit goes back to object storage and an absolute URL, which
   both the config and the client still accept.

The rest of §14 — extraction, the label-free style, the service worker, the
attribution — is unchanged.

### 2.9 Replay

**R-53** Replay is **not a separate mode: it is a clock.** Same map, same
renderer, a cursor offset from now.

**R-54** Speeds 1x, 2x, 4x. On reaching live, the cursor snaps to real time.

**R-54b** Speeds are 1x, 2x, 4x and **8x**. R-54's snap to real time on reaching
live is unchanged, and so is the rule that one control cycles them rather than
one button each. 8x exists because R-62 made the window the whole game: six hours
at 4x is ninety minutes of real time, which is not a debrief anybody sits
through.

**R-54c** **And 16x**, which is where the list stops.

Measured rather than guessed: a seeded six-hour game is ninety minutes at 4x,
forty-five at 8x and **twenty-two at 16x**, and twenty-two is the first of those
that is a sitting rather than an afternoon.

The end of the list, not a step towards 32x. The tick is 100 ms, so 16x advances
the cursor 1,6 s of game time per tick against samples that arrive every 5 s —
still more often than the data underneath, which is the property that makes
R-55's interpolation worth running. At 32x a tick would be 3,2 s and the cursor
would step over most of a sample interval at a time, putting back exactly the
jumps R-55 exists to smooth.

**R-55** Linear interpolation between samples.

**R-56** Zone geometry and events replay too, not just positions.

**R-57** Master only. Full detail requires `AUTHORITATIVE` (R-26).

**R-57b** **A finished game offers the replay in either view mode.**

R-57 gates the replay on `AUTHORITATIVE`, and R-32's argument gates the
*control's presence* on it too: offering a replay beside a roster the mode is
withholding from announces that there is something to withhold. That argument is
about a game being played. A finished game has no roster left to protect, no
radio and nobody to tell — the same point R-25b makes about the idle timeout, one
state later.

The window is served **whole** in both modes. R-26 and R-57 say full detail is
the only replay there is, and a debrief with the eliminations filtered out of it
is the reduced replay those two refuse to invent.

**The cost, stated rather than discovered.** A master in `OPERATIONAL` now reads
eliminations and drop points with no `AUTHORITATIVE_OPENED` line recording when
they did, so the log no longer marks every access to that information. It still
marks every one during play, which is where R-25's record was ever going to
matter. And the live panel beside the replay goes on withholding what the replay
shows, which is not an inconsistency to fix by relaxing the panel: R-32's gate on
the REVIVIR button is about an action, and there is no action left in a game that
has ended.

The rule is one function in core (`replayAllowed()`), called by the Worker before
it answers `GET /api/track` and by the panel before it draws the control. Two
copies would be two things to keep in step, and the one that drifted open would
be the one on the wire.

**R-62** **A replay covers the whole game, and its controls are a dock, not a
panel.**

The window runs from the game's start to its end — or to now, in progress —
instead of a fixed hour, so scrubbing past an hour costs no second request and
the debrief is one fetch. Six players over six hours at one fix per 5 s is about
26,000 samples, roughly 5,5 MB of JSON before the edge compresses it: larger than
M8's hour and still one request, held once and indexed once.

The controls sit in their own full-width row under the map, the way the event log
already docks, so **the map stays visible while the cursor moves.** A replay
whose controls cover the map is one the master scrubs blind, which is the
opposite of what a cursor is for. The scrub resolution follows the window rather
than a fixed number of steps: over six hours, M8's 1.000 steps are 21,6 s apart,
which is coarser than the samples underneath.

**R-62b** **The dock is marks and one line each, not prose.**

R-62 put the controls under the map so the map stays visible; a dock that takes
two thirds of the screen honours the letter of that and none of it. Three rules
keep it a fixed amount of interface:

Play, pause and the speed are **drawn marks**, not words — and drawn rather than
lettered, because VT323 carries no `▶`, `⏸` or `⏩` and §9.7's four state marks
were already lost to exactly that. The speed keeps its number beside the mark,
since it is the one of the three whose value is not visible in the mark itself.

**Each file's warning sits on its button's own row.** §10 is why the text exists
— a file of real positions and named drop points says so where it is pressed —
and a line beside the button says it for a third of the height.

**The cursor is not printed as an age.** It read `1h` against live, which in a
debrief opened days later is both useless and nearly constant across the whole
bar. R-66 prints the instant on the stage instead.

**R-63** **Point visibility replays** (R-61, and R-56's "events replay too").
`POI_VISIBILITY` is reconstructed from the log at the cursor, exactly as
eliminations, radio contacts and markers already are, so a point hidden at 21:14
is hidden from 21:14 in the replay and visible before it. Until this, the live
`hiddenPois` list was applied to every instant of every replay — the one part of
the world a replay still read from the present.

**R-64** **A player selected during a replay draws their route to the cursor.**

Built from the samples the dot is already built from, and **split wherever the
gap between two samples exceeds `linkThresholdMs`.** That is R-55's rule applied
to a line that stays on screen: an unbroken stroke across a blackout is the same
invention the interpolation refuses, except left standing in a place the dot's
growing circle is not. A route is drawn for the selected player only — a route
each for six players is a map of string — and, like everything else in a replay,
it is master-only (R-57).

**R-65** **Two files come out of a finished game: the track as JSON, and the
replay as video.**

The JSON is the window already in memory, written to a file. It carries real
positions, eliminations and drop points for named people, so the control says so
where it is pressed rather than in a document nobody has open (§10).

The recording is a capture of **this tab**, never of the screen and never of the
canvas.

Not the screen, because what that records is the browser — address bar, tabs,
whatever else is on the desktop — and none of that is the game.

Not the canvas, because §14.3 leaves the map style with no `symbol` layers, so
callsigns, marker labels and R-22's elimination mark are DOM markers *over* the
WebGL canvas: `captureStream()` on the map exports the dots and not one word,
and compositing the labels back in is exactly the second renderer R-53 exists to
prevent.

**The controls are hidden for the duration and the tube is not.** The bar, the
dock and any open panel are furniture for running the game; the bezel, the
scanlines, the callsigns, R-12's circles and the zone dashes are the game. So
the first go and the second stay, and the frame is the whole terminal rather
than a crop of the map — cropping removes the bezel along with the controls, and
the bezel is most of what makes a recording of this look like the machine it is
pretending to be.

The master loses their controls while a recording runs, so **Escape stops one**,
ahead of everything else on the panel's Escape ladder.

**A red `REC` pilot sits top left, and it is in the recording on purpose**: it is
what tells somebody watching the file that they are watching a recording. It is
the one thing outside R-43 that uses the alarm colour on a map, and the argument
is narrow rather than a widening — R-43's warning is rendered by the player's
view and reaches no master screen ever, so the two can never appear together and
the colour still tells exactly one thing apart on any screen it is on. The
corner it sits in is already the one the machine talks about itself from, beside
the scale and the faults, and the pilot does not exist except while recording.

**R-65b** **Starting a recording starts the replay.**

A recording that begins on a paused cursor is a still photograph taken with a
video camera, and the master cannot fix it once it has begun: R-65 hides the dock
for the duration, so PAUSA is not on screen to press.

Only if a recording actually started — a cancelled picker leaves the cursor where
it was — and **after** the picker rather than before, so the opening of the
recording is not spent on a permission dialog.

Stopping a recording does **not** pause. The cursor is the master's, and a
recording ending is not a reason to take it back off them.

**R-66** **The master's stage prints the instant it is showing, to the second.**

`[2026/09/23 11:07:58]`, top left, beside R-65's pilot and **in the recording**.

Every other time in the app is an age — `45s`, `2h` — because live, what matters
is how stale a reading is. A debrief asks the other question: the master says
*"at 10:51 they were already in the car park"*, and an age counted from a cursor
answers nothing anybody can repeat on a radio or match to a video.

It reads the panel's `now` and nothing else, so it is **the cursor in a replay
and the server's clock live**, with no state and no branch of its own. A clock
that knew about replay would be R-53's second code path in four digits.

Phosphor, not the alarm colour: it is a fact about the game. The pilot beside it
keeps red meaning exactly one thing, which is the condition R-65 put on using
that colour here at all.

The device's own timezone, and that is not a breach of R-36. R-36 governs what
timestamps are *compared* against, because a handset's clock drifts and every age
in the app is arithmetic. This is not arithmetic — it is a number read off the
screen and matched against a watch, a radio log or a video's timecode, by
somebody standing at the venue the game is being played in.

**R-73** **The master can say where the recorded game begins, and everything
before it is dropped.**

`POST /api/master/game/track { from }`. It sets `startedAt` to that instant and
deletes every sample older than it, in one action. Refused while `IN_PROGRESS`,
and refused for a `from` that is not before the end of the game. Logged as
`TRACK_TRIMMED` with how many samples went.

**The problem is that `startedAt` is written once and never again.** It is
stamped on the first transition into `IN_PROGRESS` there has ever been, because
when a game started is a fact rather than a field to keep current — and R-62
opens the scrub bar there. An object that was put in progress for a pairing test
days earlier therefore replays from the pairing test: the bar spans an afternoon
of nobody playing, and the night it was kept for is a fraction of it. Retention
does not help, because 48 hours from now takes the game before it takes the
rehearsal.

**Both halves, or neither.** Moving the start without deleting leaves real
movement one scrub outside the window; deleting without moving the start leaves
the bar exactly as long, opening onto an empty map — R-62's cursor sits at the
first sample, and everything left of it is people who have not vanished being
drawn as though they had.

`from` is not clamped to the recorded start. A master saying where the recording
begins is answering a different question from the one the transition answered,
and an instant *before* the press is a legitimate answer: the twenty minutes of
people arriving are part of the night even though the game was not running yet.

**`track_log` is not trimmed.** It is events rather than positions, it is small,
and one of its rows is read from outside the window by design — R-71's last
`GEOMETRY_TOGGLED` before `from`, which is what tells a replay which ground was
open when it opens. Deleting the log by timestamp would take that row in exactly
the case it exists for.

Irreversible, and that is why it is an event and not a silent edit: R-26 keeps
the track past the end of the session, so this changes the only copy of what
happened. R-65's JSON is the way to keep a game before cutting it.

**R-74** **A refused socket is told from a lost link, and a revoked session ends
at the login screen rather than in a reconnect loop.**

The client reconnects with backoff (M1), and every close looked the same to it:
the browser hands `close` and `error` with no status, so a `401` handshake is
indistinguishable from a phone in a lift. Three things follow, and the app owes a
different answer to each.

**A close the app asked for must not arm anything.** `reload()` closes the socket
to start over with a new cookie, and closing it fired the listener that schedules
the next attempt — which then ran after `#hydrate()` had already decided there was
no session, connected, was refused, and armed the one after it. The login screen
therefore retried for ever, at whatever rate a backgrounded tab throttles a 15 s
timer to. Reported as an error repeating on the login screen about once a minute.

**A socket that never opened is a question, not a failure.** One `/api/state`
answers it: `401` means the session is gone, and the app shows the login screen —
the only screen a new invite can be redeemed from. Anything else is the network,
and the retry continues exactly as before. Bounded by construction: one fetch per
refused connect, and only for a socket that never came up.

**A link that was working and dropped keeps M1's behaviour**, unchanged.

This is what every player's phone does at the end of every game, not an edge
case: R-33b revokes their sessions on `FINISHED`, so from that moment the socket
is refused, and until this the app showed ENLACE offline — which is also what a
basement looks like.

> Volume: 6 players × 4 h at one ping per 5 s ≈ 17,000 points. Ring buffer in
> memory plus SQLite. Negligible.

> **Two decisions M8 took inside these five requirements**, recorded here because
> both are places a later change would look harmless and would not be.
>
> 1. **`TrackSample` carries an allowlist, never R-03's `attributes` map.**
>    Traccar Client's status body is `id=<device>&notificationToken=<FCM
>    registration token>`, R-03 keeps every parameter it does not recognise, and
>    this is the one table R-26 requires to outlive the session. `TRACK_ATTRIBUTES`
>    in `packages/core/src/track.ts` is `altitude`, `hdop`, `charge`; adding a
>    fourth is a deliberate act.
> 2. **R-55's interpolation stops at `linkThresholdMs`.** Past it the two samples
>    are the last fix before a blackout and the first one after it; a straight
>    line between them replaces R-12's growing circle with a player walking
>    through a dead zone. A long gap holds the earlier sample, timestamp and all,
>    so every age downstream reproduces the blackout on its own.
>
> R-56's zone geometry costs nothing today because `POST /api/master/game/geo`
> is refused with a 409 while the game is `IN_PROGRESS`. Removing that 409 is what
> would make a geometry history necessary.

### 2.10 Master controls

**R-58** Alerts are deliberately minimal — not a safety system, and every
recurring check costs money:

| Alert | Kept? |
|---|---|
| Link lost past threshold | yes, passive display, no sound |
| Battery critical | yes, passive display |
| Perimeter crossing | yes, passive display |
| Proximity between players | **removed** |
| Panic button | **removed** |
| Zone / horde events | **removed** |

**R-59** Controls: game state, cut switch, place/clear master marker, directed
message, radio contact, reverse elimination, device pairing tray, full-name
lookup, view mode.

---

## 3. Data model

```ts
type PositionState = 'MOVING' | 'STATIONARY' | 'NO_LINK';
type GameState     = 'PREPARATION' | 'IN_PROGRESS' | 'PAUSED' | 'FINISHED';
type ViewMode      = 'OPERATIONAL' | 'AUTHORITATIVE';
type PoiCategory   = 'OBJECTIVE' | 'MEETING_POINT' | 'ENTRANCE' | 'HAZARD' | 'OTHER';
type Audience =
  | { kind: 'all' }
  | { kind: 'team';   teamId: string }
  | { kind: 'player'; playerId: string };

interface Game {
  id: string;
  name: string;
  state: GameState;
  startedAt?: number;
  finishedAt?: number;

  ingestSecret: string;
  cutSwitch: boolean;
  /** R-21d. Optional because a game is seeded once: absent has to read as off. */
  extendedComms?: boolean;

  geo: {
    perimeter: GeoJSON.Polygon;    // playable area
    ingestArea: GeoJSON.Polygon;   // larger; enforced only when IN_PROGRESS
    zones: Zone[];                 // static drawn areas
    pois: Poi[];                   // static, always visible
  };

  basemap: {
    pmtilesUrl: string;
    styleUrl: string;
    bbox: [number, number, number, number];  // minLon, minLat, maxLon, maxLat
    maxZoom: number;
  };

  config: {
    linkThresholdMs: number;           // 90_000
    radioContactValidityMs: number;    // 300_000
    authoritativeIdleRevertMs: number; // 600_000
    markerDefaultTtlMs: number;        // 300_000
    detourFactor: number;              // 1.35
    walkingSpeed: number;              // 1.4 m/s
    bearingFreezeSpeed: number;        // 0.5 m/s
    bearingSmoothing: number;          // 0.12
    poiProximityRadius: number;        // m, display only
  };
}

interface Player {
  id: string;
  callsign: string;        // public
  fullName: string;        // master only, both view modes (R-27)
  teamId: string;

  sessionToken: string;
  deviceId?: string;

  /** Real position as last received from the device. */
  position?: {
    lat: number; lon: number;
    accuracy: number;
    bearing?: number;
    speed?: number;
    ts: number;
    state: PositionState;
    stationarySince?: number;
    zoneId?: string;
  };

  /**
   * Position the game layer knows. Frozen once the feed stops (R-22).
   *
   * The whole snapshot, so OPERATIONAL cannot borrow a fresher field from
   * `position` — accuracy and zone included (M5). Those two are optional for the
   * games seeded before they existed.
   */
  knownPosition?: {
    lat: number; lon: number; ts: number;
    accuracy?: number; zoneId?: string;
  };

  /** Battery the game layer knows, frozen with knownPosition (R-22, M5). */
  knownBattery?: number;

  battery?: number;
  radioContact?: { ts: number; reportedBy: string };  // playerId | 'MASTER'

  eliminated?: {
    ts: number;
    /** Absent when the player had no fix when they declared (M6). R-30.5 does not cover that case. */
    dropPoint?: { lat: number; lon: number };
    selfDeclared: boolean;
  };
}

interface Team { id: string; name: string; playerIds: string[] }

/** Static. No activation, no timer, no kind. */
interface Zone {
  id: string;
  name: string;
  geometry: GeoJSON.Polygon;
}

interface Poi {
  id: string; name: string;
  lat: number; lon: number;
  category: PoiCategory;
  audience?: Audience;     // defaults to { kind: 'all' }
  description?: string;
}

/** Exactly one exists at a time, globally (R-20). */
interface MasterMarker {
  id: string;
  label: string;
  lat: number; lon: number;
  audience: Audience;
  placedAt: number;
  expiresAt: number;
}

interface Device {
  id: string;              // Traccar Client device id
  playerId?: string;       // absent while unpaired
  firstSeen: number;
  lastSeen: number;
  pings: number;
  gameId: string;          // expires with the game (R-08)
}

interface TrackSample {
  ts: number; playerId: string;
  lat: number; lon: number; accuracy: number;
  bearing?: number; state: PositionState; battery?: number;
}

interface GameEvent {
  ts: number;
  kind: 'PING' | 'ELIMINATION' | 'ELIMINATION_REVERSED' | 'RADIO_CONTACT'
      | 'MARKER_PLACED' | 'MARKER_EXPIRED' | 'PERIMETER' | 'MESSAGE'
      | 'DEVICE_SEEN' | 'DEVICE_PAIRED' | 'AUTHORITATIVE_OPENED'
      | 'GAME_STATE' | 'INGEST_REJECTED';
  actor?: string; target?: string;
  data?: Record<string, unknown>;
  visibility: 'MASTER' | 'MASTER_AUTHORITATIVE' | 'TEAM' | 'ALL';
}
```

> **`kind` has grown past this list, and `packages/shared/types.ts` is the
> authority for it.** Later requirements added things worth auditing that §3 had
> no name for — `EXTENDED_COMMS` (R-21d), `GEO_PROFILE`, `ROSTER` (R-07),
> `AUTHORITATIVE_REVERTED` (R-25). Each carries a doc comment saying why it was
> added rather than folded into an existing kind, which is the argument this list
> would lose if it were only widened here.

> **Amended by R-70, R-71 and R-72 at M12, and `packages/shared/types.ts` is the
> authority.** The block above describes one venue with one level of geometry,
> which is what there was. What changed, and why each is not a widening of this
> list:
>
> - `Zone` gains **`sector: string`, required**. A zone that could fall back to a
>   sector of its own would be a zone nobody can close, silently, in the one
>   artefact a venue is described by — `zonesOf()` refuses it instead.
> - **`Sector` and `District` are new, and derived rather than declared.** A
>   sector is exactly the zones that name it and a district exactly the sectors
>   whose zones name it (`sectorsOf()`), so a grouping cannot disagree with the
>   geometry it groups. The one thing that *can* be written wrong — a sector
>   whose zones name two districts — is refused at load.
> - `Poi` gains **`zone?: string`**, derived at load by `withZone()`. An entrance
>   closes with the zone it leads to rather than the ground it stands on, which
>   is the same arbitrariness `entranceTo` already exists for.
> - `Game.geo` gains `sectors` and `districts`. `perimeter` is unchanged and
>   still feeds `basemapBbox()`: it is the whole recinto, not what is in play.
> - **`Game.extendedComms?: boolean` is gone.** `Game.commsReach?: CommsReach`
>   (`3 | 4 | 5`) replaces it, absent reads as 3 through `commsReachOf()`, and
>   `#load()` lifts a stored boolean once (R-72).
> - `Payload` gains **`playArea: Polygon[]`** — the union of the open zones, as
>   the disjoint pieces rather than a MultiPolygon, because closing the road
>   leaves two towns and a boundary warning has to know they are two — plus
>   `sectors`, and `districts` and `disabledZones` for the master alone: they are
>   what reopens ground, and a player has no control to reopen it with.

---

## 4. Visibility matrix

**The normative table.** One pure function `project(game, recipient): Payload`,
fully covered by tests. This is the piece to harden — with game logic this thin,
`project()` is most of the backend's value.

| Datum | Player, same zone | Player, other zone | Self | Eliminated self | Master OPERATIONAL | Master AUTHORITATIVE |
|---|---|---|---|---|---|---|
| Callsign | yes | yes | yes | yes | yes | yes |
| Full name | no | no | yes | yes | **yes** | yes |
| Live position, feed active | yes | **no** | yes | own only | **yes** | yes |
| Live position, feed stopped | no | no | — | own only | **no** | yes |
| Last known position, feed stopped | yes | **no** | yes | own only | **yes** | yes |
| Distance / proximity sort | yes | **no** | — | no | no | yes |
| Battery, accuracy, link state | yes | no | yes | own only | yes | yes |
| Radio contact | yes | **yes** | yes | yes | yes | yes |
| Elimination state | **no** | no | yes | yes | **no** | yes |
| Drop point | **no** | no | yes | yes | **no** | yes |
| POIs (audience `all`) | yes | yes | yes | **yes** | yes | yes |
| POIs scoped to a team | team only | team only | — | team only | yes | yes |
| Master markers (up to 5, R-20b) | those in audience | those in audience | those in audience | **those in audience** | all | all |
| Drawn zone geometry | yes | yes | yes | **yes** | yes | yes |
| Replay | no | no | no | no | **no** | yes |

Implementation notes:

- Position scope is **zone**; marker and POI audience scope is **team or
  player**. Two independent axes; never merge them.
- **The one exception, and it is a setting rather than a rule:** at a comms reach
  of 4 or 5 (R-21d, amended by R-72), a teammate is treated as same-zone for
  position, distance, battery and link state — 4 within your own sector, 5
  anywhere. It is the only thing that lets team membership touch the position
  axis, it is **3** on a fresh game, and everyone who is not a teammate stays
  exactly as R-40 and R-42 describe.
- Radio contact deliberately crosses zones (R-29).
- `OPERATIONAL` differs from `AUTHORITATIVE` on exactly one axis: which position
  source is used for players whose feed has stopped.
- An eliminated player keeps map furniture (POIs, markers, zones) and loses only
  other players (R-30.4).

> **Amended by R-71 at M12: the zone geometry row is no longer one answer.** A
> player is sent the zones that are **open**, because the drawn boundary is what
> tells them ground has closed and a zone they may not enter drawn like one they
> may is worse than no line at all. The master is sent **every** zone plus
> `disabledZones`, and draws the closed ones out of play: the panel's list is the
> only place closed ground can be found again and reopened, and §14.3 leaves the
> map without labels, so a name there is not a place.
>
> Points follow the same set through **three filters, in this order**: R-71's
> closed ground → R-61's `hiddenPois` → this table's audience. Order matters
> because a point in a closed zone must not enter `hiddenPois` — reopening the
> ground would not bring it back.

---

## 5. API surface

### HTTP

```
POST /i/<secret>/                     OsmAnd ingest. No session auth.
                                      Requires a Cloudflare Access bypass policy.
GET  /j/<token>                       redeem token → session cookie
POST /api/session/master              master login
POST /api/session/logout              clears the cookie; 204 either way

GET  /api/state                       snapshot, projected for the session
GET  /api/geo                         GeoJSON: perimeter, ingest area, zones, POIs
GET  /api/track?from&to               replay data (R-53..R-57). Master and
                                      AUTHORITATIVE only; 403 otherwise. Both
                                      bounds optional — `to` defaults to now and
                                      `from` to an hour before it. Answers
                                      { from, to, serverNow, samples, events }

POST /api/me/eliminated               self-declaration (R-30). No body: the
                                      session names the player
POST /api/radio-contact               { playerId } liveness (R-29)

GET  /api/master/invites              one /j/<token> per player (R-07)
POST /api/master/game/state           { state }
POST /api/master/game/cut             { on }
POST /api/master/game/geo             { profile } swap the live geometry (§11).
                                      Refused 409 while IN_PROGRESS
POST /api/master/game/zones           { disabled } the whole closed set of
                                      zone ids (R-71). Sector and district are
                                      group controls that send a longer list.
                                      Idempotent; 404 on an unknown zone id.
                                      **Allowed while IN_PROGRESS** — the only
                                      geometry control that is
POST /api/master/game/basemap         { pmtilesUrl } which .pmtiles archive the
                                      map draws. A same-origin path under
                                      R-52b, or an absolute https URL. Refused
                                      409 while IN_PROGRESS; the bbox is derived
                                      from the geometry and is not settable here
POST /api/master/game/track           { from } the recorded game begins here
                                      (R-73): moves startedAt and drops every
                                      sample before it. Refused 409 while
                                      IN_PROGRESS, or for a `from` that is not
                                      before the end. Logs TRACK_TRIMMED
POST /api/master/game/reset           { confirm } wipe and reseed. Refused 409
                                      while IN_PROGRESS
POST /api/master/devices/pair         { deviceId, playerId }
POST /api/master/marker               place one, up to five (R-20b); a sixth is
                                      refused 409 MARKER_LIMIT
DELETE /api/master/marker/:id         clear one; 404 for an unknown id
DELETE /api/master/marker             clear all five
POST /api/master/comms                { reach } 3, 4 or 5 — how far a player's own
                                      team reaches (R-21d, R-72), logged
POST /api/master/message              { target, text } R-59              [n/y]
POST /api/master/players/:id/revive   reverse an elimination (R-32)
POST /api/master/players/add          { callsign, fullName, teamId } (R-07)
POST /api/master/players/remove       { playerId }
POST /api/master/players/team         { playerId, teamId }
POST /api/master/teams/add            { name }
POST /api/master/teams/rename         { teamId, name }
POST /api/master/teams/remove         { teamId }
POST /api/master/view                 { mode } logs R-25
```

`[n/y]` is the directed message of R-59,
which no milestone has claimed — it is a master control with nothing depending on
it, so it has stayed unbuilt rather than been deferred. Everything else is served
by [`workers/src/game-do.ts`](workers/src/game-do.ts) today.

**Every `POST`/`DELETE` under `/api/master/`, plus `/api/radio-contact`, counts as
master interaction for R-25's idle revert.** The rule is the method and the
surface rather than a list, so a route added here counts from the moment it exists
and a read never does.

### WebSocket

Server → client:

```ts
{ t: 'snapshot',  payload: Payload }
{ t: 'positions', payload: ProjectedPosition[] }   // on ping arrival, not on a tick
{ t: 'event',     payload: ProjectedEvent }
{ t: 'marker',    payload: MasterMarker | null }
{ t: 'game',      payload: { state, cutSwitch } }
```

Client → server: presence pings only. Everything that mutates state goes over
HTTP so it is idempotent and auditable.

**No message is ever emitted without passing through `project()`** — masters
included, since view mode is applied in the projection.

---

## 6. Infrastructure

### 6.1 Chosen: Cloudflare

| Concern | Service |
|---|---|
| Static PWA | Pages |
| Ingest + API | Workers |
| Game state | one Durable Object per game |
| Live connections | WebSocket Hibernation |
| Marker expiry, state transitions | Alarms API |
| Track history | DO SQLite |
| Basemap `.pmtiles` | R2 |
| Access gate | Cloudflare Access (email allowlist, free to 50 users) |

Fits the free tier comfortably: ~17,000 ingest requests and under 2,000 GB-s for
a 4-hour game, against 100,000 requests and 13,000 GB-s per day.

### 6.2 Access bypass — the failure that ruins game night

> Traccar Client cannot log in. If Access protects every route, ingest dies and
> the map is empty, and nobody finds out until everyone is already at the venue.
>
> Create a **bypass policy for `/i/<secret>/*`**, which is protected by its own
> path secret. **Test it with a real player's phone the week before.**
>
> The R2 basemap route also needs public read access (§14.4), so plan two bypass
> rules, not one.

### 6.3 Cost shape: event-driven, not ticked

Do **not** run a periodic tick. Each DO alarm bills as a full request, whereas
incoming WebSocket messages bill at 20:1.

- **Recompute and broadcast on ping arrival.** The ingest request is already paid
  for; do zone assignment and fan-out there.
- **Staleness needs no server work.** The client has `lastPingTs` and renders age
  locally.
- **Alarms only for marker TTL and auto-finish.**

This takes a 4-hour game from ~2,880 alarms to fewer than ten.

### 6.4 Auth

- **Players**: invite link `https://host/j/<long-token>`, redeemed for a signed
  cookie (`httpOnly; Secure; SameSite=Lax`). No passwords. Revoke by invalidating
  the token. The same link is what gets installed to the home screen, so the
  session survives PWA installation.
- **Master**: strong password, optional TOTP.
- `.htaccess` / Basic Auth is not viable: it authenticates but does not
  authorise, cannot distinguish players, and does not survive the WebSocket
  handshake cleanly.

### 6.5 Escape hatches, ranked

Keep all game logic in `packages/core`, runtime-agnostic, so the platform can
change in a day rather than a rewrite.

1. **Hetzner CX22, ~€4/mo.** Node + Socket.IO + SQLite + Caddy. Boring, no
   platform limits, no cold starts. The recommended fallback.
2. **Oracle Always Free.** Genuinely free forever, but the Ampere A1 allocation
   was halved to 2 OCPU / 12 GB in June 2026 with no notice, and regional ARM
   capacity is frequently unavailable.
3. **Mini-PC or Pi at home + Cloudflare Tunnel.** Zero cost, no open ports.
   Depends on the house having power and internet while you are at the venue.
4. **Avoid Render's free tier** (idles out and recycles) and **Vercel** (no
   durable WebSocket model; native support is beta, single-instance and capped at
   5 minutes by default).

---

## 7. Repository layout

**The tree below is the original sketch, and it is wrong about one thing that
matters.** It puts `projection.ts`, `zones.ts`, `position-state.ts` and friends
under `workers/src/`; §6.5 requires all game logic to be runtime-agnostic, and
they live in `packages/core/src/` — where nothing may import a Cloudflare or DOM
API, which is what lets `node --experimental-strip-types` run real game logic over
captured data with no build step. `workers/src/` holds the HTTP, storage and
socket adapters that call it. [README.md](README.md#repo-layout) carries the tree
as built; this one is kept for the file-by-file intent, which still holds.

```
/
├─ apps/web/                     # PWA (Vite)
│  ├─ src/
│  │  ├─ views/player/
│  │  ├─ views/master/           # OPERATIONAL and AUTHORITATIVE
│  │  ├─ map/
│  │  │  ├─ style.json           # amber basemap style, NO symbol layers (§14.3)
│  │  │  ├─ camera.ts            # navigation / overview modes (R-48)
│  │  │  └─ layers.ts
│  │  ├─ crt/                    # visual layer (§9)
│  │  ├─ perimeter.ts            # client-side, offline (R-43)
│  │  ├─ heading.ts              # bearing freeze + low-pass filter (R-50)
│  │  └─ sw.ts                   # service worker, pmtiles precache
│  └─ locales/es.json            # ALL user-facing copy
├─ workers/
│  ├─ src/
│  │  ├─ index.ts                # router
│  │  ├─ game-do.ts              # Durable Object
│  │  ├─ ingest.ts               # OsmAnd protocol (R-01..R-09)
│  │  ├─ projection.ts           # project() — §4. THE critical piece
│  │  ├─ zones.ts                # turf point-in-polygon
│  │  ├─ markers.ts              # single-slot marker + TTL
│  │  ├─ position-state.ts       # R-10..R-15, feedStopped()
│  │  └─ track.ts                # SQLite, replay
│  └─ wrangler.toml
├─ packages/core/                # runtime-agnostic game logic (§6.5)
├─ packages/shared/
│  ├─ types.ts
│  └─ geo/game.geojson           # perimeter, ingest area, zones, POIs
├─ tools/
│  └─ basemap.sh                 # extract → verify → upload (§14)
└─ tests/
   ├─ projection.test.ts         # highest priority
   ├─ position-state.test.ts
   └─ markers.test.ts
```

---

## 8. Build order

**M1 — Data arrives.** Worker + DO + OsmAnd ingest with path secret. Unpaired
device tray. An ugly panel that draws dots. Goal: **a real phone running Traccar
Client shows up on screen.**

**M2 — Projection and roles.** `project()` with the §4 table and its test suite.
Player tokens, master session, rooms. Verify with devtools that a player socket
receives nothing forbidden. **With game logic this thin, this milestone is most
of the backend.**

**M3 — States.** R-10..R-15, `feedStopped()`, zone assignment on ping arrival,
radio contact between players.

**M4 — POIs, zones and markers.** Static config, audience scoping, master markers
with TTL — one slot as written, **five as amended** (R-20b), with an optional TTL
(R-21c) and extended comms alongside them (R-21d).

**M5 — Master views.** OPERATIONAL/AUTHORITATIVE, blocking warning, idle revert,
full-name lookup.

**M6 — Elimination.** Silent self-declaration, drop point, master reversal,
reduced eliminated-player payload.

> **Every milestone below is built and deployed.** [ROADMAP.md](ROADMAP.md) is the
> authority for what each one delivered and the exit criterion it closed against;
> this section is the order they were planned in, kept as written.

**M7 — Basemap and map.** §14 pipeline, MapLibre, custom style, single GeoJSON,
service worker, client-side perimeter, navigation/overview toggle, bearing
smoothing.

**M8 — Replay.** Time cursor, 1x/2x/4x, live snap.

**M9 — CRT layer.** Full styling (§9) over a working interface.

**M10 — Field rehearsal.** At the real venue with the real phones, a week ahead.
Measure observed accuracy, calibrate `linkThresholdMs` and
`poiProximityRadius`, and judge whether navigation-mode latency needs the 3 s
reporting interval (R-50.3).

---

## 9. Art direction: 1970s apocalypse, CRT computing

The interface must read as **a physical terminal of the era**, not a modern app
with a filter applied.

**Correct references:** IBM 3270, DEC VT52/VT100, Tektronix storage-tube displays,
NASA mission control, green-bar printouts, beige and mustard plastic housings,
silkscreened labelling, nixie tubes.

**Wrong references:** synthwave, 1980s neon, purple gradients, glassmorphism,
cyberpunk.

### Palette

```css
--phosphor:        #ffb000;   /* P3 amber, the real phosphor colour */
--phosphor-dim:    #b3760a;
--phosphor-deep:   #6b4606;
--phosphor-bright: #ffd899;
--screen:          #140f0a;   /* warm black, never #000 */
--alarm:           #ff4422;   /* the only non-monochrome colour */
--case:            #b9a88c;   /* institutional beige plastic */
--case-shadow:     #8a7a60;
--rust:            #9c4a25;
```

Amber, not green: green-on-black reads as Matrix, not 1977.

### Typography

Two families with a conceptual distinction that must be preserved:

- **Screen content** → `VT323`. Anything drawn by the tube.
- **Case labelling** → condensed grotesque (`Barlow Condensed`). Labels on the
  machine are silkscreened plastic, not phosphor.

That contrast is what makes it read as hardware rather than a colour theme.

### Required elements

1. **Physical case** around the screen: screws, silkscreened labels, recessed tube.
2. **Character-cell grid.** Everything aligned to a monospace grid; box-drawing
   characters (`─ │ ┌ └ ├ ═`) for panel frames.
3. **Scanlines, phosphor bloom, curvature vignette, subtle flicker.**
4. **Inverse video for alerts** (phosphor block, dark text) instead of colour.
   Monochrome terminals alarmed this way and it reads louder than red.
5. **Vector phosphor map**, Tektronix storage-tube style: thin amber strokes, no
   fills, no textures, markers as points with crosshairs. §14.3 delivers exactly
   this from real OSM geometry.
6. **Boot sequence** on load: three or four self-test lines, ~1.5 s, skippable.
7. **State by glyph and brightness**, not colour alone:
   `●` moving · `◎` stationary · `◌` no link · `✕` eliminated.
8. **OSM attribution silkscreened on the case bezel**, not in the phosphor area
   (§14.5). It reads as a manufacturer's plate and satisfies ODbL.

### Quality obligations

- Honour `prefers-reduced-motion`: no flicker, no animated scanlines.
- The CRT effect must never compromise legibility. Players use this at night,
  moving, one-handed. If bloom obscures a distance reading, reduce the bloom.
- **High-contrast mode** that disables scanlines, vignette and flicker and raises
  text contrast. Mandatory, not optional.
- 44 px minimum touch targets.
- Boundary warnings (R-43) sit **outside the game aesthetic** so they cannot be
  mistaken for game content.

---

## 10. Privacy

The system tracks the real-world location of six known people.

- Device bindings expire when the game finishes (R-08).
- Ingest closes when the game finishes (R-05).
- Geographic rejection while in progress (R-04).
- Track history has a defined retention with automatic deletion.
- `fullName` never reaches a player socket, in any view mode.
- Players know they are being tracked: Android's persistent foreground-service
  notification makes it explicit. That is a feature.

---

## 11. Configuration policy

Everything geographic and numeric is configuration, never code:

- The play area **may expand to surrounding streets and part of the city**.
- **Test sessions will run in completely different locations** from the real
  venue. Each location needs its own `.pmtiles` extract, bbox and GeoJSON — the
  basemap is per-location config too (§14).
- Perimeter, ingest area, zones, POIs, `Game.basemap` and every value in
  `Game.config` must be swappable without a deploy.

---

## 12. Changes from v2

| Area | Change | Reason |
|---|---|---|
| R-22 `OPERATIONAL` | Now shows live positions for everyone with an active feed; only players whose feed stopped are frozen at last known position | master coordinates by radio and needs positions; the spoiler is *who is out*, not *where people are* |
| R-23 spot reveal | **removed** | unnecessary once OPERATIONAL shows positions |
| R-21b zones | Static drawn areas; activation, timers and `HORDE` kind removed | no horde system, no event engine |
| R-30.4 | Eliminated player keeps POIs, addressed markers and zone geometry | own-position-only left an almost blank map |
| R-50 | `bearing` from ping confirmed as sole source; no browser geolocation; smoothing and freeze made mandatory; 5 s latency accepted | decided |
| R-58 | Zone/horde events removed from the alert list | cost and scope |
| Events enum | `ZONE_ACTIVATED`, `ZONE_EXPIRED` removed | zones are static |
| §14 | **new** basemap pipeline appendix | real streets needed from a real source |
| `Game.basemap` | new config block | basemap is per-location |
| R-51 | GeoJSON features must carry `featureType` | the style filters on it |
| §15 | **new** frontend stack fixed: Svelte 5 runes-only, plain Vite, pnpm workspaces | the spec was silent, so each codegen session invented a different framework |

---

## 13. Open items — closed

**All four are settled, and the thing that settled three of them is that the game
was played**: six hours over both towns on the night of 2026-09-26, 23:00 to
05:00, with no intervention in the system at any point. A session is a worse
instrument than a measurement and a better one than a plan, and where it is all
there is, this says so.

1. **`linkThresholdMs` and `poiProximityRadius` stay as they are.** Nothing
   misbehaved across the session: nobody standing still was reported as having
   vanished, and the nearest point was the useful one. Closed by a game rather
   than by a figure — no reading was taken against observed accuracy, and none
   will be now.
2. **Navigation mode does not get a 3 s reporting interval.** The game ran at the
   30 s of §14's phone table and nobody asked for more. The cost was always
   battery, and a four-hour game that finished with phones still alive is the
   argument for leaving it alone.
3. ~~Basemap `maxZoom`: 17 is the recommended start (§14.2). Bump to 18 only if
   individual doorways need to be legible.~~ **Decided at M9: 19.** The two things a
   master does at the far end of the zoom are place a marker on a doorway and tell
   apart two players standing a few metres apart, and at 19 the span across a phone
   is about fifty metres, which is the scale those are decided at. It costs no bytes:
   the archive stops at z15 whatever this says, because that is where the daily
   Protomaps planet build stops, and MapLibre overzooms vector tiles. Past z15 the map
   gets coarser, never fuzzier — z15's generalisation drawn larger — and everything
   this app draws on top of it is at full precision regardless. `Game.basemap.maxZoom`
   is how far a player may zoom and is a different number from what the archive stores.
4. **`authoritativeIdleRevertMs` stays at ten minutes.** The question M5 raised
   was not whether the mechanism worked but whether a master mid-coordination
   would hit it often enough to start clicking through R-24's briefing without
   reading it. They did not notice it. That is the answer the requirement wanted,
   and it is the only kind of answer it could have had.

**And one that was never on this list and belongs here now: iOS.** Traccar Client
stopped sending the moment the screen locked, deterministically, which made an
iPhone player `NO_LINK` for a whole session — and the cause was reasoned from the
permission model rather than confirmed. **It was the permission.** With location
access set to *Always*, iPhones tracked through the night like everything else.
The README carries the checklist; what changed is that it is now a fix rather
than a hypothesis.

---

## 14. Appendix: basemap pipeline

### 14.1 Source and licensing

The basemap is **OpenStreetMap**. This is not only the cheapest option, it is the
only legal one: Google's terms forbid both caching tiles for offline use and
restyling the map, which are the two things this project requires.

Two Spanish sources are better than OSM for specific layers and are free:

- **Catastro (INSPIRE download service)** — building footprints and cadastral
  parcels in GML, metre-accurate. Spain imported cadastre into OSM so coverage is
  already good, but the source data is better. In a commercial estate, parcel
  boundaries are effectively the fence lines, which is real game-relevant
  geometry.
- **PNOA orthophotos (IGN)** — free official aerial imagery over WMS. Load it as
  a backdrop in QGIS or JOSM and trace gates, fences, internal service roads and
  gaps between units into our own overlay GeoJSON. Private estates often lack
  internal roads in OSM.

> **Never put fictional game geometry into OSM.** If the rehearsal reveals a real
> missing road, contributing it upstream is welcome and helps everyone. Zones,
> POIs and the perimeter live in `packages/shared/geo/game.geojson` only.

### 14.2 Extracting tiles

Protomaps publishes daily whole-planet `.pmtiles` builds. The CLI downloads
**only the bytes for our area** without fetching the planet:

```bash
# 1. find the latest build id at maps.protomaps.com/builds
# 2. get the bbox from bboxfinder.com, or reuse the game perimeter GeoJSON

pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles zone.pmtiles \
  --bbox=-4.4600,36.7150,-4.4380,36.7280 \
  --maxzoom=17

# a GeoJSON region works too, and is tidier once the perimeter exists:
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles zone.pmtiles \
  --region=packages/shared/geo/game.geojson --maxzoom=17

# verify what actually came out — layer names and attributes vary by build
pmtiles show zone.pmtiles
```

Sizing: **each additional zoom level roughly doubles the archive**. z0–17 over a
commercial estate is a few MB. Do not reach for z18 without a reason.

Bbox order is `minLon,minLat,maxLon,maxLat`. Make the extract bbox match
`Game.basemap.bbox` and cover the **ingest area**, not just the perimeter, since
`maxBounds` is set to the ingest area (R-47).

### 14.3 Style: labels are absent, not hidden

This is what makes the requirement clean. **We author the style**, so we decide
layer by layer what is drawn. The Protomaps basemap keeps names and POIs in
separate layers (`pois`, `places`, and the label layers).

If the style contains **no layer of type `symbol`**, street names and POI labels
cannot render. There is nothing to filter and nothing that can leak through a
misconfiguration. We include only `earth`, `landuse`, `water`, `buildings` and
`roads`, drawn as thin amber strokes — which produces exactly the vector-phosphor
look of §9.5 from real geometry.

> **Amended by R-69 at M12, in one place and on purpose.** There is now at most
> one `symbol` layer and it draws street names off `roads`. The mechanism above
> is what makes that safe to do: the *other* label layers are still not
> referenced by anything, so they remain unrenderable rather than filtered, and
> the rule a test can hold changed from "no symbol layer" to "no symbol layer,
> or one and it is this one". Adding a second is how the distinction is lost.
>
> **At most**, because the layer is per location: R-69 derives it from the geo
> profile, and a location that is read by zone name rather than by street gets
> this section unamended. Both halves are held — `theOnlySymbolLayerIsStreetNames()`
> for the town and `hasNoSymbolLayers()` for everywhere else.

A starting style ships at `apps/web/src/map/style.json`. Buildings use a
transparent fill with `fill-outline-color` to get a 1 px outline; roads are split
by `kind` into three widths with a dashed centreline on the majors.

> **Verify before trusting.** `source-layer` names and the `kind` attribute have
> changed between Protomaps basemap versions. Run `pmtiles show` against the
> actual extract and check the schema docs; do not assume the layer names in the
> starter style are correct for the build in use.

### 14.4 Serving

*Superseded in part by R-52b (2026-09-03): the archive ships as a static asset
next to the bundle. Everything below still describes the object-storage route,
which remains the answer for a location whose extract exceeds the 25 MiB asset
ceiling.*

```bash
tools/basemap.sh madrid --install        # what is actually done now
```

Upload to R2 and read directly from the browser over HTTP range requests — no
tile server, no database, no API key.

```bash
rclone copyto zone.pmtiles r2:larp-basemap/v1/zone.pmtiles
```

**CORS is the step that silently breaks everything.** The bucket must allow range
requests and expose `ETag`:

```json
[{
  "AllowedOrigins": ["https://<our-domain>"],
  "AllowedMethods": ["GET", "HEAD"],
  "AllowedHeaders": ["range", "if-match"],
  "ExposeHeaders": ["etag", "content-range", "content-length"],
  "MaxAgeSeconds": 3600
}]
```

Without it the map renders blank with no useful console error.

Client wiring:

```ts
import maplibregl from 'maplibre-gl';
import * as pmtiles from 'pmtiles';

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
// style.json points at "pmtiles://https://<r2-domain>/v1/zone.pmtiles"
```

> Under R-52b the archive is added to the protocol explicitly, with a source
> that reads it whole, rather than left to `Protocol`'s own range fetching. The
> `pmtiles://` reference is matched against `Source.getKey()` by string, so the
> style's URL and the source's must be resolved identically and exactly once.

The service worker precaches the archive so the map survives dead spots and
basements (R-52). It is a single immutable file, so cache it by version path and
never revalidate.

### 14.5 Attribution

ODbL requires visible credit: **“© OpenStreetMap contributors”**. Put it
**silkscreened on the case bezel**, beside the `Mod. Q-4413` plate and outside the
phosphor area. It satisfies the licence and reads as a manufacturer's marking
rather than a modern UI overlay.

### 14.6 Checklist per location

Because test sessions run elsewhere (§11), each location needs:

- [ ] bbox covering the ingest area
- [ ] `zone.pmtiles` extract at the agreed `maxZoom`
- [ ] `pmtiles show` output checked against the style's `source-layer` names
- [ ] installed at a versioned path under `apps/web/public/basemap/` (R-52b), or
      uploaded to a versioned R2 path if it exceeds 25 MiB
- [ ] `game.geojson` with `featureType` on every feature
- [ ] `Game.basemap` config block updated
- [ ] loaded once on a real phone, offline, with the network disabled

---

## 15. Frontend stack

*Decided 2026-08-27. This section fixes choices §0–§14 left open; it adds no
requirement and renumbers nothing.*

### 15.1 Framework

**Svelte 5 with runes only.** The following are forbidden anywhere in `apps/web`:

| Forbidden | Use instead |
|---|---|
| `$:` reactive statements | `$derived` / `$effect` |
| `writable()` / `readable()` stores | `$state` in a `.svelte.ts` module |
| `<script context="module">` | a plain `.ts` module import |

The **major version is pinned** in `package.json`. Runes and the legacy reactivity model
solve the same problems in incompatible ways, and a codebase that mixes them is one
where nobody can tell which half a given component belongs to.

### 15.2 Bundler

**Plain Vite, not SvelteKit.** The PWA is a static bundle on Pages with the API on
Workers (§6.1) — there is nothing to server-render. SvelteKit would insert a routing and
adapter layer between us and the service worker, which owns `.pmtiles` precaching (R-52)
and is not negotiable.

### 15.3 Language and workspace

TypeScript in strict mode throughout. **pnpm workspaces**, chosen for strict dependency
resolution: `packages/core` must not be able to import a Cloudflare or DOM API even by
accident, or the §6.5 escape hatch is gone without anyone noticing.

### 15.4 What this does not change

UI copy still lives only in `apps/web/locales/es.json` (§0). Identifiers, comments and
commit messages are still English. The map is still MapLibre GL JS driven imperatively —
it is not wrapped in a component abstraction, because the camera work in R-48 and R-50
is frame-level and reactive wrappers fight it.
