import type { OsmAndPing, OsmAndStatus, Player, Zone } from '@q4413/shared';

import { stateFromPing, stationarySinceFor } from './position-state.ts';
import { zoneAt } from './zones.ts';

/**
 * Applying a ping to a player.
 *
 * The MOVING / STATIONARY decision and the stationary run behind
 * `stationarySince` are R-10, and both live in position-state.ts — this function
 * is the adapter that writes their answers onto the player. `NO_LINK` is
 * deliberately absent: it is derived from age wherever it is needed, never
 * stored, which is what §6.3 and R-15 mean by no server tick.
 *
 * knownPosition tracks the live position while the feed is active, and **stops
 * once the player is eliminated** — R-22's "the position the game knows", frozen
 * at the moment the game stopped knowing (M5).
 *
 * That is the only case where a ping arrives for a feed R-22 calls stopped: a flat
 * battery or a lost fix sends nothing at all, so its freeze is simply the absence
 * of writes. An eliminated player's phone keeps reporting, and every field that
 * kept advancing was a way for OPERATIONAL to tell the two apart — which is the
 * one thing the mode exists to prevent.
 *
 * ping.attributes is deliberately not copied. R-03's unrecognised parameters are
 * historical data with no slot in the §3 model, so they land in TrackSample when
 * SQLite arrives in M8 rather than being parked on the player's current position.
 *
 * ## Every timestamp stored here is the server's (R-36)
 *
 * `receivedAt`, never `ping.ts`. R-36 says all clocks are server-side and client
 * clocks are never trusted; a phone running Traccar Client is a client, and
 * `OsmAndPing.receivedAt` says as much on the field itself. The fix time the
 * device reports is parsed (R-03 requires recognising its three encodings) and
 * then not stored, because §3 has no slot for a timestamp nobody may trust.
 *
 * This is not pedantry, it is the airplane-mode case from M3's own exit
 * criterion. Traccar Client buffers positions while offline and flushes them on
 * reconnect **with their original fix times**. Stored by fix time, the last write
 * of a flush leaves `position.ts` minutes in the past, and every consumer reads
 * that as silence: `feedStopped()` says the feed stopped, the client's R-15 age
 * derivation says NO_LINK, and the growing circle appears around a player who is
 * transmitting perfectly. Stored by receive time, a flush is what it actually is
 * — a burst of traffic that arrived now, in the order it arrived.
 *
 * What is given up is that the dot replays the player's recent path during a
 * flush instead of jumping straight to where they are. That is a second or two
 * of cosmetics, and it self-corrects on the last write of the burst.
 *
 * In normal operation the two clocks agree to within the network latency of a
 * single request, so this costs nothing for the 5 s interval the game runs on.
 */
export function applyPing(
  player: Player,
  ping: OsmAndPing,
  options: {
    zones?: readonly Zone[];
    /**
     * R-11's single value. Required rather than defaulted: it decides whether a
     * stationary run survives a gap in the feed, and a rule that quiet is not one
     * a caller should be able to acquire by forgetting an argument.
     */
    linkThresholdMs: number;
  },
): Player {
  // Zone assignment happens here, on ping arrival, inside a request already paid
  // for (§6.3). §4 scopes positions by zone, so this is what decides who sees whom.
  //
  // The previous zone is offered as a hold only while the feed was still live
  // (see zoneAt(), and the same threshold the stationary run uses for the same
  // reason). A player who was dark for ten minutes and came back on the far side
  // of a border walked there; holding the old zone across that gap would turn an
  // absence of evidence into a claim about where they are, and keep them visible
  // to a zone they left while they were unobservable.
  const previousZoneId =
    player.position !== undefined &&
    ping.receivedAt - player.position.ts <= options.linkThresholdMs
      ? player.position.zoneId
      : undefined;
  const zoneId = zoneAt(ping.lon, ping.lat, options.zones ?? [], {
    previousZoneId,
    accuracy: ping.accuracy,
  });
  const state = stateFromPing(ping);
  const stationarySince = stationarySinceFor(player.position, ping, options.linkThresholdMs);

  return {
    ...player,
    position: {
      lat: ping.lat,
      lon: ping.lon,
      accuracy: ping.accuracy ?? 0,
      ...(ping.bearing === undefined ? {} : { bearing: ping.bearing }),
      ...(ping.speed === undefined ? {} : { speed: ping.speed }),
      ts: ping.receivedAt,
      state,
      ...(stationarySince === undefined ? {} : { stationarySince }),
      ...(zoneId === undefined ? {} : { zoneId }),
    },
    // `position` is what the system knows and keeps advancing; the frozen pair
    // below is what the game knows. AUTHORITATIVE reads the first, OPERATIONAL the
    // second (R-22), and an eliminated player is exactly where they diverge.
    ...(player.eliminated === undefined
      ? {
          knownPosition: {
            lat: ping.lat,
            lon: ping.lon,
            ts: ping.receivedAt,
            accuracy: ping.accuracy ?? 0,
            ...(zoneId === undefined ? {} : { zoneId }),
          },
          ...(ping.battery === undefined ? {} : { knownBattery: ping.battery }),
        }
      : {}),
    ...(ping.battery === undefined ? {} : { battery: ping.battery }),
  };
}

/**
 * Applying a status report: the battery, and deliberately nothing else.
 *
 * A status report says the phone is **on**, not where it is (see OsmAndStatus).
 * Touching `position` here would be the R-12 failure written by hand: the stored
 * position would carry a fresh timestamp over coordinates minutes old, so
 * `derivePositionState()` would call it live and `uncertaintyRadiusMetres()`
 * would draw the confident non-growing circle R-12 reserves for a position
 * somebody may act on. A phone that only manages status reports is a phone with
 * no fix, and R-11 has exactly the right answer for that already — it crosses to
 * `NO_LINK` at the threshold, while the battery on the roster stays current.
 *
 * Returns the same object when the report carries no battery, so a caller can
 * skip a storage write and a broadcast rather than persisting an identical row.
 */
export function applyStatus(player: Player, status: OsmAndStatus): Player {
  if (status.battery === undefined) return player;
  // Frozen for an eliminated player, like knownPosition: a status report is the
  // one thing a phone still manages when it can no longer get a fix, and a battery
  // ticking down next to a frozen position says which of the two causes applies.
  return {
    ...player,
    battery: status.battery,
    ...(player.eliminated === undefined ? { knownBattery: status.battery } : {}),
  };
}
