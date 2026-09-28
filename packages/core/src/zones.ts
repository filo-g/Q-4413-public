import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Zone } from '@q4413/shared';

import { distanceToBoundaryMetres } from './geometry.ts';

/**
 * Zone assignment on ping arrival (R-15, §6.3). Pulled forward from M3 because
 * §4 scopes positions by zone: without it, every player is permanently out of
 * everyone's zone and the matrix cannot be verified against a live socket.
 *
 * Zones are expected not to overlap. If they do, the first match wins — a
 * deterministic answer beats a clever one, and the overlap is a config error to
 * fix in game.geojson rather than a case to model.
 *
 * ## Why the previous zone is held through the fix's own error (M4)
 *
 * A zone border is a visibility boundary, so GPS error near one is a visibility
 * flap. Measured against a committed venue geometry — 10 zones, 179 border
 * segments over 38 ha, sampled on a 10 m grid — **18,2 %** of the
 * playable area is within 8 m of a border, which is the accuracy the phones show
 * at rest, and **47,0 %** is within 24 m, which is what one showed indoors and
 * moving. On the raw point alone, a player standing still in a third of the venue
 * changes zone on noise.
 *
 * The two candidate behaviours both fail somewhere, which is why this is written
 * down rather than chosen in a diff:
 *
 * - **switch on the first crossing** — the flicker. A master watching a
 *   stationary player sees them appear and vanish, and each flicker is *also* an
 *   over-disclosure: for as long as the noise says zone B, everyone in B may see
 *   them and they may see everyone in B.
 * - **hold the previous zone until the point is clear of it** — a bounded
 *   over-disclosure in one direction: the player stays visible to the zone they
 *   have just left, for as long as their own fix cannot prove they left it.
 *
 * Holding is taken. Neither reveals less in both directions, so §4's fail-closed
 * instinct does not decide it — but flicker is not fail-closed either; it
 * over-discloses intermittently, to whichever zone the noise picked, while also
 * making the map lie about a player who has not moved. Holding gives up the same
 * class of information, to one predictable audience, and keeps the map still.
 *
 * The band is the fix's **own reported accuracy**, capped at
 * `ZONE_HOLD_MAX_METRES` — see that constant for why the cap came down after the
 * field rehearsal. Three consequences worth knowing:
 *
 * - a fix with no accuracy (`applyPing` stores 0) holds nothing and behaves
 *   exactly as before — no accuracy, no claim.
 * - a cell-tower fix reporting hundreds of metres cannot pin a player in a zone
 *   they left ten minutes ago; the cap is what stops one bad fix becoming
 *   permanent state.
 * - the third option — reporting no zone at all within the error band — reveals
 *   less in both directions and is rejected on playability: it blanks 18 to 47 %
 *   of the venue, and a player who can see nobody is not playing a game about
 *   finding people.
 *
 * A gap in the feed also ends the hold, and that decision lives in `applyPing()`
 * with the timestamps: a player who was dark for ten minutes and came back across
 * a border walked there.
 */

/**
 * The widest error band that may hold a zone, in metres.
 *
 * **12 m, down from 25 after the field rehearsal**, where the complaint was that
 * a player's QTH took too long to catch up with them. It was not time, it was
 * distance: the hold runs until the fix is its own accuracy past the border, so
 * a phone reporting 24 m indoors and moving had to be walked 24 m into the new
 * zone — about eighteen seconds at 1,4 m/s, plus up to one ping interval.
 *
 * 25 m was chosen as "just above the 24 m measured from a phone indoors and
 * moving", which is the worst honest fix this game has seen. That number is the
 * right ceiling for *trusting* a fix and the wrong one for *holding* against it,
 * and the difference is what the hold was measured on: a **stationary** player
 * jittering across a border. A fix reporting 24 m of error while its owner walks
 * is the case the hold serves least and delays most.
 *
 * Lowering it changes nothing where most play happens. The band is
 * `min(accuracy, cap)`, and the phones show 8 m at rest — so every stationary
 * fix keeps exactly the band it had. Only fixes reporting worse than 12 m move,
 * and they move in §4's fail-closed direction: the hold is an over-disclosure to
 * the zone just left, and this shortens it.
 *
 * What it costs is flicker on those same bad fixes, and the geometry says how
 * much. Sampled on a 10 m grid over the committed artefacts, the ground within
 * a given distance of a zone border is:
 *
 * ```
 *                        4 m    8 m   12 m   16 m   25 m
 * venue,    10 zones   9,2 % 18,1 % 26,2 % 34,4 % 48,6 %
 * district, 23 zones   4,6 %  9,1 % 13,5 % 17,8 % 26,5 %
 * ```
 *
 * The district's zones are far larger than the venue's, so the flap-prone
 * fraction is about half at every band — the geometry this setting spends most
 * of its time on needs the hold less than the one it was tuned against. The
 * profiles bundled here are larger again: four zones over a square kilometre,
 * so under 5 % of the ground is within 12 m of a border.
 *
 * The cap's other job is unchanged and is why it exists at all: a cell-tower fix
 * reporting hundreds of metres cannot pin a player in a zone they left ten
 * minutes ago.
 */
export const ZONE_HOLD_MAX_METRES = 12;

/** What holding a zone through noise needs to know. Both fields optional: absent means no hold. */
export interface ZoneHold {
  /** The zone the player's last fix was assigned to, if it is still recent. */
  previousZoneId?: string | undefined;
  /** The new fix's own reported accuracy, in metres. */
  accuracy?: number | undefined;
}

export function zoneAt(
  lon: number,
  lat: number,
  zones: readonly Zone[],
  hold?: ZoneHold,
): string | undefined {
  let containing: string | undefined;
  for (const zone of zones) {
    if (booleanPointInPolygon([lon, lat], zone.geometry)) {
      containing = zone.id;
      break;
    }
  }

  const previousZoneId = hold?.previousZoneId;
  if (previousZoneId === undefined || previousZoneId === containing) return containing;

  const previous = zones.find((zone) => zone.id === previousZoneId);
  // A zone that no longer exists cannot be held: the geometry changed underneath
  // the stored id, and #setGeoProfile recomputes from the raw point for that
  // reason. Answering with the id anyway would keep a player in a zone that is
  // not on anybody's map.
  if (!previous) return containing;

  // Overlapping zones, where another zone won the scan above. Deterministic and
  // sticky, rather than deterministic and jumpy; the overlap is still a config
  // error to fix in game.geojson.
  if (booleanPointInPolygon([lon, lat], previous.geometry)) return previousZoneId;

  const band = Math.min(hold?.accuracy ?? 0, ZONE_HOLD_MAX_METRES);
  if (band <= 0) return containing;

  // Held while the point is inside its own error of the border it just crossed.
  // Past that the fix does prove the player left, whatever the noise had been
  // doing a second earlier.
  return distanceToBoundaryMetres(lon, lat, previous.geometry) <= band
    ? previousZoneId
    : containing;
}
