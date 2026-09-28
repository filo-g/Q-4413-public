import type { Game, GameState, Payload, ViewMode } from '@q4413/shared';

/**
 * The master's view mode, and the ten-minute revert that ends it (R-22, R-25).
 *
 * R-25 gives the timeout and never says what stops the clock. **Actions only**
 * — the POSTs that change game state — and the reason is what the requirement is
 * for: `AUTHORITATIVE` is a look, not a workspace. Counting any request from the
 * session would mean the panel's own socket resets the clock by existing, and
 * R-25 would be code that never runs. The argument and the accepted cost are in
 * ROADMAP under M5.
 *
 * **Derived at read time, with no alarm and no tick (§6.3).** The same shape as
 * `NO_LINK` and marker expiry: a timestamp plus `now`. Marker expiry has an alarm
 * because a marker vanishing from a player's map is a game event nobody is
 * necessarily watching for; a master's mode reverting is only ever observed by
 * the master, whose next read applies it.
 */
export interface ViewModeSession {
  mode: ViewMode;
  /**
   * When this master last did something that counts (R-25). Absent means the
   * clock has no evidence of interaction at all, which **reverts** — a stored
   * session that predates this field, or one restored across a deploy, does not
   * get to keep `AUTHORITATIVE` on the strength of having once asked for it.
   */
  lastActionAt?: number;
}

/**
 * What the clock needs to know: how long it runs, and whether it runs at all.
 *
 * The state is here rather than at the call sites because R-25b is a property of
 * the clock and not of any one caller — passing the game means a caller cannot
 * apply the timeout to a finished game by forgetting to ask.
 */
export interface ViewModeClock {
  state: GameState;
  config: Pick<Game['config'], 'authoritativeIdleRevertMs'>;
}

/**
 * Whether R-25's timeout runs at all (R-25b).
 *
 * It does not once the game is `FINISHED`. R-25 exists so the mode cannot sit
 * open **during play**: the hazard R-24 briefs against is a master who sees who
 * is out and lets it change what they say over the radio. A finished game has no
 * radio and nobody left to tell, and R-26 makes `AUTHORITATIVE` the only way to
 * read a replay at all — so in that state the timeout defends nothing and
 * charges the debrief a confirmation every ten minutes.
 *
 * Deliberately a state test and not a `finishedAt` one: `PAUSED` is a game that
 * is still being played, and a master who pauses to talk is exactly who R-25 is
 * about.
 */
export function idleRevertApplies(state: GameState): boolean {
  return state !== 'FINISHED';
}

/**
 * Whether this master may read the track at all (R-57, R-57b).
 *
 * `AUTHORITATIVE` always — that is R-57, and R-26 behind it: full detail is the
 * only replay there is, and there is no reduced one to offer instead.
 *
 * **And `OPERATIONAL` once the game is `FINISHED`**, which is R-57b. R-57's gate
 * is the same argument R-32 makes about the REVIVIR button: offering a replay
 * beside a roster the mode is withholding from announces that there is something
 * to withhold. That argument is about a game being played. A finished game has
 * no roster left to protect, no radio and nobody to tell — the same reasoning
 * R-25b already applies to the idle timeout, one state later.
 *
 * What it costs is stated in R-57b and is not nothing: the replay carries
 * eliminations and drop points, so a master reads them with no
 * `AUTHORITATIVE_OPENED` line recording when. That is a deliberate trade for a
 * debrief, not an oversight, and it is why this is a named rule in core rather
 * than a condition at two call sites that could drift apart.
 *
 * Fails closed on an absent state, as `viewModeInForce()` does: a caller that
 * cannot say what state the game is in does not get the relaxation on the
 * strength of not having said.
 */
export function replayAllowed(
  viewMode: ViewMode | undefined,
  state: GameState | undefined,
): boolean {
  if (viewMode === 'AUTHORITATIVE') return true;
  return state === 'FINISHED';
}

/**
 * When `AUTHORITATIVE` lapses, or `undefined` if the question does not apply —
 * the session is `OPERATIONAL`, or it is `AUTHORITATIVE` with no action stamped
 * and has therefore already lapsed.
 *
 * Sent to the master's own payload so the panel can count down from a timestamp
 * rather than poll for the transition, which is how every other age in the system
 * reaches a screen (R-15).
 */
export function authoritativeExpiresAt(
  session: ViewModeSession | undefined,
  game: ViewModeClock,
): number | undefined {
  if (session?.mode !== 'AUTHORITATIVE') return undefined;
  if (session.lastActionAt === undefined) return undefined;
  // No clock, no deadline (R-25b). The mode still holds — `effectiveViewMode()`
  // is what says so, and it no longer reads this to find out.
  if (!idleRevertApplies(game.state)) return undefined;
  return session.lastActionAt + game.config.authoritativeIdleRevertMs;
}

/**
 * The mode that is actually in force. Every path that needs a master's mode goes
 * through here rather than reading `session.mode`, because the stored mode is a
 * record of what was asked for and this is the answer.
 */
export function effectiveViewMode(
  session: ViewModeSession | undefined,
  game: ViewModeClock,
  now: number,
): ViewMode {
  if (session?.mode !== 'AUTHORITATIVE') return 'OPERATIONAL';
  // Checked before R-25b, and the order is the requirement: a session with no
  // action stamped never evidenced being asked for, which is a different fact
  // from an idle one and reverts in every state.
  if (session.lastActionAt === undefined) return 'OPERATIONAL';
  if (!idleRevertApplies(game.state)) return 'AUTHORITATIVE';
  return now < session.lastActionAt + game.config.authoritativeIdleRevertMs
    ? 'AUTHORITATIVE'
    : 'OPERATIONAL';
}

/**
 * Whether a stored session has lapsed and the stored record is now a lie worth
 * correcting. Distinct from `effectiveViewMode()` returning `OPERATIONAL`, which
 * is also true of a session that never left it: this is only the transition, and
 * it is what makes the revert auditable (R-25) instead of merely silent.
 */
export function authoritativeLapsed(
  session: ViewModeSession | undefined,
  game: ViewModeClock,
  now: number,
): boolean {
  if (session?.mode !== 'AUTHORITATIVE') return false;
  return effectiveViewMode(session, game, now) === 'OPERATIONAL';
}

/**
 * The same question from the other side: the mode in force for a payload already
 * in hand, which is what a client can ask. It has the deadline but not the
 * session, and no way to learn that the revert happened except by reading the
 * clock — a quiet game sends nothing, and the payload it is holding would go on
 * claiming AUTHORITATIVE indefinitely.
 *
 * Lives here rather than in the client so both sides of the revert are one rule,
 * the way `activeMarkers()` is one rule for marker expiry. `undefined` for a
 * player payload, which has no mode at all.
 *
 * **R-25b arrives here too, and it has to.** A finished game sends no deadline,
 * and an absent deadline is the one thing this function treats as already
 * lapsed — so without the state test a debrief would revert on the client while
 * the server went on projecting `AUTHORITATIVE`, which is the worst of the three
 * possible disagreements: the panel hides what the payload in its hand contains.
 * The state is read off the payload rather than passed in, so there is nothing a
 * caller can forget.
 */
export function viewModeInForce(
  payload:
    | (Pick<Payload, 'viewMode' | 'authoritativeExpiresAt'> & {
        game?: Pick<Payload['game'], 'state'>;
      })
    | undefined
    | null,
  now: number,
): ViewMode | undefined {
  const asked = payload?.viewMode;
  if (asked !== 'AUTHORITATIVE') return asked;
  // Optional, and absent means the clock runs: a caller holding a payload too
  // partial to say what state the game is in does not get to keep the mode on
  // the strength of not having said. Failing closed is the only safe direction
  // here, as it is in `verifySession()`.
  const state = payload?.game?.state;
  if (state !== undefined && !idleRevertApplies(state)) return 'AUTHORITATIVE';
  const expiresAt = payload?.authoritativeExpiresAt;
  if (expiresAt === undefined || now >= expiresAt) return 'OPERATIONAL';
  return 'AUTHORITATIVE';
}

/**
 * Whether a request counts as interaction (R-25).
 *
 * The rule is the method and the surface, not a list of paths: every master
 * action is a `POST` or a `DELETE` under `/api/master/`, plus `/api/radio-contact`,
 * which R-14 gives masters and players alike. A list of paths would be a second
 * place to remember when a route is added — this way a new master route counts
 * from the moment it exists, and a new read never does.
 *
 * `GET /api/master/invites` is a read and does not count, which is the case that
 * makes the method test load-bearing rather than decorative.
 */
export function isMasterAction(method: string, pathname: string): boolean {
  if (method !== 'POST' && method !== 'DELETE') return false;
  return pathname.startsWith('/api/master/') || pathname === '/api/radio-contact';
}
