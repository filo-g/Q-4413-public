import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Game, GameState, PingRejection, Polygon } from '@q4413/shared';

/**
 * Ingest gates (R-04, R-05). Pure predicates, kept apart from the HTTP layer so
 * every branch is testable without a Worker.
 */

/**
 * R-05: pings are accepted in PREPARATION, IN_PROGRESS and PAUSED, and rejected
 * when FINISHED or when the manual cut switch is on. There is no separate ingest
 * schedule (R-34) — if setup starts six hours early, pings are accepted six
 * hours early.
 */
export function ingestOpen(
  state: GameState,
  cutSwitch: boolean,
): { open: true } | { open: false; rejection: PingRejection } {
  if (cutSwitch) return { open: false, rejection: { reason: 'CUT_SWITCH' } };
  if (state === 'FINISHED') return { open: false, rejection: { reason: 'GAME_FINISHED' } };
  return { open: true };
}

/**
 * R-60 — the other half of R-34's cut switch.
 *
 * R-34 says the cut halts **ingest and broadcast**. Only the ingest half was
 * built: `#broadcast()` never consulted the switch, so with the cut on a master
 * action still reached every player, and a player who reloaded or reconnected
 * was handed a complete, current projection. The emergency stop stopped half of
 * what it says it stops — and the half it missed is the one that matters when
 * the reason for cutting is that something is being **seen** that should not be.
 *
 * Players only, which is R-35 read forward: masters access in any state,
 * including with the cut on, and a master staring at a frozen panel while
 * working out what to do next is the opposite of what that requirement is for.
 * R-34 says "broadcast" flatly and R-35 says masters keep access; the
 * interaction is written down here rather than inferred at the call site.
 *
 * A player mid-game simply stops receiving. Their last payload stays on screen
 * and R-15's client-side ageing carries every reading into `NO_LINK` on its own,
 * which is the honest picture: the machine has stopped, nothing is being hidden
 * from them that anyone else can see.
 */
export function playerFeedOpen(cutSwitch: boolean): boolean {
  return !cutSwitch;
}

/**
 * The cut switch, moved by the game ending rather than by a master (R-34b).
 *
 * R-05 already refuses every ping once the state is `FINISHED`, and
 * `#endSession()` already closes every socket and revokes every player session,
 * so a finished game is silent through two mechanisms before this one. This is
 * the third, and it is not redundant with them in the way it first looks: the
 * other two are consequences of the state, and **the switch is the thing a
 * master reads to know whether the machine is listening**. A panel that says
 * ingest is open, on a game that is refusing every ping, is the machine lying
 * about itself in the one place somebody checks.
 *
 * The release is the half that needs the flag. A cut left on from a finished
 * game would make the *next* session start deaf — pings refused for a reason
 * that belongs to a game that is over, with nothing on screen tying the two
 * together — and that is a worse failure than the one this fixes, because it
 * happens during setup and looks like broken ingest. So leaving `FINISHED`
 * clears a cut this threw, and never one a master threw by hand.
 *
 * Returns `null` when nothing should change, which is also how the caller knows
 * whether there is anything to log.
 */
export function cutSwitchOnStateChange(
  next: GameState,
  game: Pick<Game, 'state' | 'cutSwitch' | 'cutByFinish'>,
): { cutSwitch: boolean; cutByFinish: boolean } | null {
  if (next === 'FINISHED') {
    // Already cut — by a master, in the middle of something — stays theirs.
    if (game.cutSwitch) return null;
    return { cutSwitch: true, cutByFinish: true };
  }
  if (game.state === 'FINISHED' && game.cutSwitch && game.cutByFinish === true) {
    return { cutSwitch: false, cutByFinish: false };
  }
  return null;
}

/**
 * R-04: geographic rejection applies **only while IN_PROGRESS**.
 *
 * During PREPARATION pings are accepted from anywhere. Setup happens at home and
 * in the car, hours before anyone reaches the venue, and pairing requires a real
 * ping to arrive (R-06) — a geofence during preparation makes pairing impossible.
 */
export function geofenceApplies(state: GameState): boolean {
  return state === 'IN_PROGRESS';
}

export function insideIngestArea(lon: number, lat: number, ingestArea: Polygon): boolean {
  return booleanPointInPolygon([lon, lat], ingestArea);
}

/** Both gates in the order R-05 then R-04, which is the order they are specified. */
export function checkPingAccepted(args: {
  state: GameState;
  cutSwitch: boolean;
  lat: number;
  lon: number;
  ingestArea: Polygon;
}): { accepted: true } | { accepted: false; rejection: PingRejection } {
  const open = ingestOpen(args.state, args.cutSwitch);
  if (!open.open) return { accepted: false, rejection: open.rejection };

  if (geofenceApplies(args.state) && !insideIngestArea(args.lon, args.lat, args.ingestArea)) {
    return {
      accepted: false,
      rejection: { reason: 'OUTSIDE_INGEST_AREA', lat: args.lat, lon: args.lon },
    };
  }

  return { accepted: true };
}
