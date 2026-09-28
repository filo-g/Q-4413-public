```
              #############
            ####         ####
          ###               ###
         ##                   ##
        ##                     ##
       ###         ###         ###
       ##        #######        ##
       ##        ######         ##
       ###         ########    ###
        ##             ####### ##
         ##              ##########
          ###             ##########
            ####          ########
              #############  ####
                             #

       ___        _  _   _  _   _ _____
      / _ \      | || | | || | / |___ /
     | | | |_____| || |_| || |_| | |_ \
     | |_| |_____|__   _|__   _| |___) |
      \__\_\        |_|    |_| |_|____/
```

**Live-action zombie LARP tracking system.** Players carry phones that post their position,
one server decides what each person is allowed to see, and everybody's screen is a 1970s
amber CRT terminal.

A game master runs it from a panel over the same map: close ground mid-game and the play
boundary follows, drop markers, cut the feed, and afterwards replay the whole night.

**Visibility is a server decision.** One pure function projects a separate payload per
socket, so a player with devtools open cannot see what the interface is not showing them —
it was never sent. Everything else here is downstream of that.

Ingest speaks the **OsmAnd protocol**, so **anything that can make an HTTP request can be a
tracker** — a phone running [Traccar Client](https://www.traccar.org/client/), a GPS logger,
a script:

```
GET /i/<INGEST_SECRET>/?id=phone-1&lat=40.4168&lon=-3.7038&accuracy=8&batt=73
```

Form fields, not a JSON body. Unknown ids land in a tray for a master to pair.

---

## Try it

**[q4413-demo.filoga.me](https://q4413-demo.filoga.me)** — the whole app with a fake server
in the browser. Any password, including none. Nothing leaves your tab and there is nothing
to sign up for.

Locally:

```bash
VITE_DEMO=1 pnpm --filter @q4413/web build && pnpm --filter @q4413/web preview
```

---

## Run your own

Needs **Node ≥ 22**, **pnpm 11** and **`wrangler`** on your PATH.

```bash
git clone https://github.com/filo-g/Q-4413-public.git
cd Q-4413-public
pnpm install

cp workers/.dev.vars.example workers/.dev.vars
pnpm dev                                    # Vite + wrangler dev
```

Three values in `workers/.dev.vars`:

| | |
|---|---|
| `INGEST_SECRET` | the path segment in `/i/<secret>/`. **Hex, never base64** — a `/` is truncated by the router and every ping 404s. `openssl rand -hex 32` |
| `SESSION_SECRET` | HMAC key for the session cookie. `openssl rand -base64 32` |
| `MASTER_PASSWORD` | what the master types on the login screen |

Log in as master and point something at ingest — `pnpm fake-phones -- --help` if you have no
phone to hand. Other scripts: `pnpm test`, `pnpm typecheck`, `pnpm build`.

Deploying is `wrangler deploy` against your own account; put your hostname in
`workers/wrangler.toml` first, where there is a placeholder.

> **Two things that will cost you an afternoon otherwise.** A map verified on the dev server
> tells you nothing about the built bundle, and the reverse is also true — check map changes
> through `pnpm build`. And a tracker with *stop detection on* goes silent the moment its
> owner stands still, which reads on the master's screen as a player who vanished. Both are
> in [CLAUDE.md](CLAUDE.md), with the rest of what is expensive to rediscover.

---

## Your own ground

**Everything geographic is configuration, never code.** A location is a file.

Three profiles ship — a 1 km square over the centre of Madrid, Barcelona and Seville, each
tiled by four rectangular zones. They are deliberately uninteresting and exist to be
replaced.

### 1. Draw the file

One GeoJSON `FeatureCollection` in `packages/shared/geo/`. It feeds **both** the renderer and
the server-side geometry, so every feature carries a `featureType`:

| `featureType` | How many | What it is |
|---|---|---|
| `PERIMETER` | exactly one | The whole playable area. What the basemap is cut to frame, and it does **not** move when a master closes ground |
| `INGEST_AREA` | exactly one | Where a ping is accepted from during a game. Strictly larger than the perimeter — players drift, and a rejected ping is a dot that silently stops |
| `ZONE` | two or more | The unit of visibility **and** the unit a master can close |
| `POI` | any | Points on the map |

A zone:

```json
{
  "type": "Feature",
  "properties": {
    "featureType": "ZONE",
    "id": "zone-norte-este",
    "name": "NORTE ESTE",
    "sector": "s-norte",
    "sectorName": "NORTE",
    "district": "d-madrid",
    "districtName": "MADRID"
  },
  "geometry": { "type": "Polygon", "coordinates": [[[lon, lat], "…"]] }
}
```

`sector` and `district` are **required** — a zone that fell back to a sector of its own would
be a zone nobody can switch off, and the symptom is a closure that leaves ground open with
players standing on it.

**Sectors and districts are never declared, only derived.** A sector is exactly the zones
that name it, in file order; a district is exactly the sectors whose zones name it. You
cannot write a sector listing a zone that does not exist, or a zone in two sectors — neither
sentence is expressible.

A POI takes `category` — `OBJECTIVE`, `MEETING_POINT`, `ENTRANCE`, `HAZARD` or `OTHER` — and
optionally an `audience` scoping it to one team or one player. An `ENTRANCE` also needs
`entranceTo`, naming the zone it opens into: a door is drawn *on* the ring of that zone, a
point on a boundary counts as inside both zones sharing it, and the answer would otherwise
depend on the order of features in a file.

### 2. The one invariant that is not cosmetic

**The zones must cover the perimeter with no gaps and no overlaps.**

Get this wrong and it is invisible. A strip of ground in no zone at all is a player nobody
can see who can see nobody — they stand there, apparently fine, and disappear from everyone.
An overlap is the same mistake mirrored: first match wins, so who can see them depends on
the order of features in a file.

It has happened, to a real venue, and it was found by a sampler rather than by eye. So:

```bash
pnpm test -- geo
```

[tests/geo.test.ts](tests/geo.test.ts) samples every committed profile on a **10 m grid** and
requires each point inside the perimeter to be in exactly one zone. **Add your profile's name
to `PROFILES` at the top of that file.** It also checks the grouping, the entrances, the ids
and the ingest area. That suite is the definition of a geometry this app can run, and it is
worth more than looking at the file on a map.

From having done it: **make the zones rectangular and share exact vertices between
neighbours** — the same numbers, not numbers that are nearly the same. Half a metre of
disagreement is a strip nobody can stand in safely.

### 3. Wire it up

```
packages/shared/package.json        add "./geo/<name>.geojson" to the exports map
workers/src/game-do.ts              import it, add to GEO_PROFILES, and BUMP GEO_VERSION
apps/web/src/views/master/…         GEO_PROFILES in MasterView.svelte, the panel's list
apps/web/locales/es.json            geo.profiles.<name> — the name a master reads
```

**`GEO_VERSION` is the silent one.** The geometry is seeded into storage the first time a
game runs, not read from the bundle on every request — so editing a `.geojson` and deploying
**changes nothing** until that constant moves. An existing game keeps the old rings.

### 4. Cut the map under it

```bash
brew install pmtiles                            # homebrew-core, no tap
tools/basemap.sh <name> --version v4 --install  # extract, verify, install
```

Then bump `BASEMAP_VERSION` to match. The archive is cached by path and never revalidated,
so a new extract **must** get a new version or every phone that already downloaded the old
one stays on it with no way to notice. Ceiling is 25 MiB per file; the script refuses to
exceed it.

### 5. Switch to it

From the master panel, or `POST /api/master/game/geo {"profile":"<name>"}`. Refused while a
game is in progress — zones decide who sees whom, and moving them mid-game rewrites that
silently. Closing and reopening ground *during* a game is a different thing, and is allowed:
that is the mechanic.

---

## Licence

Two licences, because there are two different things here — details in [NOTICE](NOTICE).

- **The code is MIT.** See [LICENSE](LICENSE).
- **The basemap archives are not.** `apps/web/public/basemap/v3/*.pmtiles` are extracts of a
  Protomaps planet build derived from OpenStreetMap: **© OpenStreetMap contributors**, under
  the [Open Database License (ODbL) 1.0](https://www.openstreetmap.org/copyright).
  Attribution is required of anyone who redistributes them, or a map made from them.

In the app that credit is silkscreened on the case bezel beside the `Mod. Q-4413` plate,
outside the phosphor area. **Removing it is a licence violation, not a design decision.**

The game geometry in `packages/shared/geo/` is invented, describes no real place, and is not
derived from OpenStreetMap. Never put fictional game geometry into OSM.

---

## The rest of the documentation

- **[HANDOFF-v3.md](HANDOFF-v3.md)** — the specification, and **normative**. Numbered
  requirements `R-xx` and sections `§n`. Nearly every comment in this repository cites one;
  this is what they point at.
- **[ROADMAP.md](ROADMAP.md)** — what each milestone delivered and the exit criterion it
  closed against.
- **[CLAUDE.md](CLAUDE.md)** — what is expensive to rediscover or dangerous to get wrong:
  which secrets are burned, the three ways the map goes black, and the behaviours that look
  like bugs and are not.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branches, commits, and when not to merge.

Where this README disagrees with the handoff, the handoff wins.
