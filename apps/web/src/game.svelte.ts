import {
  accountabilityOf,
  activeMarkers,
  derivePositionState,
  radioContactFresh,
  uncertaintyRadiusMetres,
  viewModeInForce,
} from '@q4413/core';
import type { Accountability } from '@q4413/core';
import type {
  CommsReach,
  MasterMarker,
  Payload,
  PositionState,
  ProjectedPlayer,
  ViewMode,
  WsServerMessage,
} from '@q4413/shared';

import { fetchState, Unauthorised } from './api.ts';
import { afterSocketClose, nextRetryMs, RETRY_FIRST_MS } from './link.ts';
import { precacheBasemap } from './sw-register.ts';

/**
 * Live game state, held in runes (§15.1). No stores: `$state` in a `.svelte.ts`
 * module is the runes-era equivalent and the only form allowed here.
 *
 * Staleness is derived on the client from the timestamps in the snapshot (R-15,
 * §6.3) — the server never ticks to keep ages fresh.
 *
 * ## Which clock the ages are measured against
 *
 * R-15 and R-36 pull in opposite directions on their own: derive the age locally,
 * but never trust the client clock. They meet if the client derives locally
 * *against a clock the server set*. Every snapshot carries `serverNow`, so the
 * offset between this device and the authority is re-measured on each one, and
 * `serverNow()` below is what every age in the UI is subtracted from.
 *
 * A phone whose clock is an hour out — or set by hand, or freshly booted with no
 * network time — therefore still renders the same link states as everyone else's.
 * That is not a hypothetical: a 90 s threshold is inside the error of a clock
 * nobody checked, and it is worth remembering that under R-09 the position source
 * is Traccar Client, so a phone can be a display device and a tracker at once and
 * be wrong about the time in both roles.
 *
 * No round-trip correction. The offset is short by one leg of network latency,
 * which is tens to a few hundred milliseconds against a 90 s threshold — three
 * orders of magnitude below anything it decides. Measuring it would cost a
 * request and buy nothing.
 */

/**
 * ## Why the derivations take a clock
 *
 * Every helper below defaults `now` to `serverNow` and accepts an override. That
 * is R-53's whole ask on this file: replay moves the clock and nothing else, so
 * a panel scrubbed back twenty minutes calls the same functions with a different
 * number rather than a second set of them. `viewMode` and the revert
 * deliberately do **not** take one — R-25 runs on real time whatever the cursor
 * is doing, and a replay must not be able to hold `AUTHORITATIVE` open.
 */
export type LinkStatus = 'connecting' | 'connected' | 'offline';
/** No session is a screen, not an error: the master logs in, the player redeems a link. */
export type AuthStatus = 'unknown' | 'anonymous' | 'session';

class GameConnection {
  payload = $state<Payload | null>(null);
  auth = $state<AuthStatus>('unknown');
  link = $state<LinkStatus>('connecting');
  /** Ticks once a second so ages re-render without any server involvement. */
  now = $state(Date.now());
  /**
   * serverNow minus this device's clock, from the last snapshot. Reactive: every
   * derived age depends on it, and the first snapshot is what makes it real.
   */
  #offset = $state(0);

  /**
   * Now, on the server's clock (R-36). The one time value anything in the UI may
   * compare a timestamp against.
   */
  get serverNow(): number {
    return this.now + this.#offset;
  }

  /**
   * R-11 as the recipient sees it: the snapshot's `state` was derived when the
   * snapshot was built, and this re-derives it as the seconds pass with no new
   * message. A player who walks out of coverage crosses into NO_LINK on every
   * screen watching them without the server sending anything (§6.3).
   *
   * `undefined` for a player §4 withheld a position from, which is the distinction
   * the rest of this file turns on: **a redacted position is not a silent one.**
   * An out-of-zone player (R-40) may be walking about perfectly well with a live
   * feed; the viewer simply is not allowed to know. Returning NO_LINK there would
   * be inventing a fact out of a permission.
   */
  linkState(player: ProjectedPlayer | undefined, now = this.serverNow): PositionState | undefined {
    const config = this.payload?.config;
    if (!player || !config || player.outOfZone) return undefined;
    return derivePositionState(player.position, config.linkThresholdMs, now);
  }

  /**
   * R-12's circle, in metres. Stays at the fix's accuracy while the feed is live
   * and opens up only in NO_LINK.
   */
  uncertaintyMetres(player: ProjectedPlayer | undefined, now = this.serverNow): number {
    const config = this.payload?.config;
    if (!player?.position || !config) return 0;
    return uncertaintyRadiusMetres(player.position, config, now);
  }

  /**
   * R-13. `undefined` while the feed is alive, because radio contact is neither
   * displayed nor tracked until a player is in NO_LINK. Both values are labels:
   * neither is an alarm, and nothing here may ever start flashing.
   *
   * Also `undefined` for an out-of-zone player, for the reason in `linkState()`.
   * Without that guard this would read their withheld position as silence and
   * label a healthy player UNACCOUNTED — R-13's one forbidden outcome, arrived at
   * by mistaking a §4 redaction for a dead phone.
   */
  accountability(player: ProjectedPlayer | undefined, now = this.serverNow): Accountability | undefined {
    const config = this.payload?.config;
    if (!player || !config || player.outOfZone) return undefined;
    return accountabilityOf(player.position, player.radioContact, config, now);
  }

  /**
   * Whether a radio contact is still inside its five-minute window (R-13). Split
   * out from `accountability()` for the out-of-zone list, which may say that
   * someone was heard from — R-29 sends contact across the boundary on purpose —
   * but may not say anything about their link.
   */
  contactFresh(player: ProjectedPlayer | undefined, now = this.serverNow): boolean {
    const config = this.payload?.config;
    if (!player || !config) return false;
    return radioContactFresh(player.radioContact, config, now);
  }

  /**
   * The live markers as of now, soonest expiry first (R-20b, R-21c). Expiry is
   * derived here as well as on the server: the server withholds expired markers
   * and broadcasts when the alarm clears them, but a client with nothing arriving
   * would keep drawing what it was last sent — and on a local Worker with no
   * traffic the alarm was measured not running at all. A TTL is a timestamp; a
   * client can read it.
   */
  get markers(): MasterMarker[] {
    return this.markersAt(this.payload, this.serverNow);
  }

  /**
   * The same rule applied to a payload and a clock the caller names, which is
   * what lets replay (R-53) reuse it: the cursor is the clock there, and R-21c
   * has to be decided against the cursor or a marker that was standing twenty
   * minutes ago renders as expired.
   */
  markersAt(payload: Payload | null, now: number): MasterMarker[] {
    return activeMarkers(payload?.markers ?? [], now);
  }

  /**
   * Seconds until a marker expires, or `undefined` when it has no TTL at all
   * (R-21c) — which is not the same as zero, and must not render as a countdown
   * that has run out.
   */
  markerRemainingSeconds(marker: MasterMarker, now = this.serverNow): number | undefined {
    if (marker.expiresAt === undefined) return undefined;
    return Math.max(0, (marker.expiresAt - now) / 1000);
  }

  /** R-21d / R-72, as the recipient was told it. Absent reads as the narrowest. */
  get commsReach(): CommsReach {
    const reach = this.payload?.game.commsReach;
    return reach === 4 || reach === 5 ? reach : 3;
  }

  /**
   * Whether the team reaches past the zone at all (R-72).
   *
   * One question with one answer, for the places that only need to know
   * *whether* rather than *how far* — the out-of-zone note, which would
   * contradict a meter at 4 as readily as at 5. Anything that cares about the
   * difference reads `commsReach`.
   */
  get teamReachesOut(): boolean {
    return this.commsReach > 3;
  }

  /**
   * How much of the game this screen is being told, on QSA's 1-to-5 scale.
   *
   * Not radio signal — there is no radio in this system, R-29 runs the voice out
   * of band — but the same question a signal report answers, which is why the
   * fiction already has a gauge for it and why the number is 5 rather than 3 or
   * 100. Four readings, because there are exactly four things to say:
   *
   * - **0** — the socket is down or still opening. Nothing is arriving, and no
   *   comms setting means anything while that is true, so the link outranks it.
   * - **3** — §4 as built: your own zone.
   * - **4** — and your own team anywhere in your sector (R-72).
   * - **5** — and your own team anywhere at all, which is R-21d as it behaved
   *   when the setting was a switch.
   *
   * Here rather than in either view because both draw it and a second copy of
   * this ladder is a second answer. The master's is deliberately the same
   * reading and not a connection indicator: `link` alone said 5 when a socket
   * was open and 1 when it was not, which is a fact about a WebSocket rather
   * than about the game, and nobody was going to act on it.
   */
  get signal(): 0 | CommsReach {
    if (this.link !== 'connected') return 0;
    return this.commsReach;
  }

  /**
   * The master's mode as of **now**, not as of the snapshot (R-25).
   *
   * Derived here for the same reason marker expiry is: the revert is a timestamp
   * and the server has no tick, so a panel sitting on a quiet game would keep
   * rendering AUTHORITATIVE until something else caused a broadcast. Deriving it
   * fails closed immediately; #syncLapsedViewMode() then makes the server agree.
   *
   * `undefined` for a player, who has no mode at all.
   */
  get viewMode(): ViewMode | undefined {
    return viewModeInForce(this.payload, this.serverNow);
  }

  /**
   * Seconds until the revert (R-25), `undefined` outside AUTHORITATIVE. Shown so
   * the master is not surprised by it: the mode ending mid-read is the requirement
   * working, and it costs nothing to say when.
   */
  get authoritativeRemainingSeconds(): number | undefined {
    const expiresAt = this.payload?.authoritativeExpiresAt;
    if (expiresAt === undefined) return undefined;
    return Math.max(0, (expiresAt - this.serverNow) / 1000);
  }

  /** Seconds since the last ping, for the roster. `undefined` with no position. */
  positionAgeSeconds(player: ProjectedPlayer | undefined, now = this.serverNow): number | undefined {
    if (!player?.position) return undefined;
    return Math.max(0, Math.round((now - player.position.ts) / 1000));
  }

  #socket: WebSocket | undefined;
  #refreshing = false;
  /**
   * Whether a socket is wanted at all, which is what tells a deliberate close
   * from a link that dropped (R-74). `close` fires either way and carries
   * nothing that distinguishes them.
   */
  #wanted = false;
  #retryMs = RETRY_FIRST_MS;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #clock: ReturnType<typeof setInterval> | undefined;

  start(): void {
    this.#clock ??= setInterval(() => {
      this.now = Date.now();
      this.#syncLapsedViewMode();
    }, 1_000);
    void this.#hydrate();
  }

  /**
   * The other half of the derived revert. `viewMode` stops *showing* authoritative
   * data the moment the deadline passes, but the payload in hand still contains it
   * — drop points cannot be un-received — so this asks the server for a clean one.
   *
   * The request is what makes the revert real rather than cosmetic: /api/state
   * reverts the stored session on the way in and logs it (R-25). One fetch per
   * lapse, guarded, and a no-op for every player socket, which has no mode.
   */
  #syncLapsedViewMode(): void {
    if (this.payload?.viewMode !== 'AUTHORITATIVE') return;
    if (this.viewMode === 'AUTHORITATIVE') return;
    if (this.#refreshing) return;
    this.#refreshing = true;
    void this.refresh().finally(() => {
      this.#refreshing = false;
    });
  }

  /**
   * A fresh projection over the existing session and socket. Unlike reload() this
   * keeps both: nothing about the identity changed, only what the server is willing
   * to project for it.
   */
  async refresh(): Promise<void> {
    try {
      const payload = await fetchState();
      this.#syncClock(payload);
      this.payload = payload;
    } catch {
      // The socket is the primary path and is still open; a failed refresh means
      // the derived mode keeps withholding until the next snapshot arrives.
    }
  }

  /**
   * One state fetch decides everything: whether there is a session at all, and
   * therefore whether to open a socket or render a login screen.
   */
  async #hydrate(): Promise<void> {
    try {
      const payload = await fetchState();
      this.#syncClock(payload);
      // Not `=`: a socket snapshot may already have overtaken this fetch, and it
      // is the fresher of the two.
      this.payload ??= payload;
      this.auth = 'session';
    } catch (error) {
      if (error instanceof Unauthorised) {
        this.auth = 'anonymous';
        return;
      }
      // A transient failure is not a missing session; the socket will retry.
      this.auth = 'session';
    }

    // Geometry arrives inside the payload, already audience-filtered, so there is
    // no second fetch to keep in step with it.
    this.#connect();
  }

  /** After logging in or redeeming an invite, start over with the new cookie. */
  async reload(): Promise<void> {
    // Same order and the same reason as `stop()`: this is where the login
    // screen's endless reconnect came from. `#hydrate()` below decides there is
    // no session and returns without connecting, while the timer armed by the
    // close it has just done goes on to connect anyway (R-74).
    this.#wanted = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#socket?.close();
    this.#socket = undefined;
    this.payload = null;
    this.auth = 'unknown';
    await this.#hydrate();
  }

  stop(): void {
    // Before the close, not after: closing fires the listener that would arm the
    // next attempt, and a timer cleared first is a timer this re-arms.
    this.#wanted = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#clock) clearInterval(this.#clock);
    this.#clock = undefined;
    this.#socket?.close();
    this.#socket = undefined;
  }

  /**
   * Re-measured on every snapshot rather than once at startup, so a device whose
   * clock is corrected mid-game — by NTP, or by the user — follows along instead
   * of carrying the old error until a reload.
   *
   * R-52's precache is triggered from here for the same reason it is called on
   * every snapshot rather than once: this runs on every path a payload arrives
   * by, so there is no way to receive the archive's URL and not act on it. Both
   * sides are idempotent — the same URL every five seconds, and a worker that
   * returns early on a cache hit.
   */
  #syncClock(payload: Payload): void {
    precacheBasemap(payload.basemap.pmtilesUrl);
    this.#offset = payload.serverNow - Date.now();
  }

  #connect(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    this.#socket = socket;
    this.#wanted = true;
    this.link = 'connecting';
    /**
     * Whether this socket ever came up, which is the whole of R-74's evidence.
     * A refused handshake and a dropped link are the same `close` event with the
     * same empty reason — the browser does not pass the status through — so the
     * only thing that separates a `401` from a lift is whether `open` ever fired.
     */
    let opened = false;

    socket.addEventListener('open', () => {
      opened = true;
      this.link = 'connected';
      this.#retryMs = RETRY_FIRST_MS;
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as WsServerMessage;
      if (message.t === 'snapshot') {
        this.#syncClock(message.payload);
        this.payload = message.payload;
      }
    });

    socket.addEventListener('close', () => {
      const outcome = afterSocketClose({ wanted: this.#wanted, opened });
      if (outcome === 'STOP') return;
      this.link = 'offline';
      if (outcome === 'PROBE') {
        void this.#probe();
        return;
      }
      this.#retryLater();
    });
    socket.addEventListener('error', () => socket.close());
  }

  /**
   * Backoff, and the only place a reconnect is armed (R-74). A chain that can be
   * started from two places is a chain nothing can reliably stop.
   */
  #retryLater(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#connect(), this.#retryMs);
    this.#retryMs = nextRetryMs(this.#retryMs);
  }

  /**
   * One `/api/state` after a socket that never opened, to find out whether there
   * is still a session to reconnect to (R-74).
   *
   * **A `401` is an answer and not a failure.** `FINISHED` revokes every player
   * session (R-33b), so at the end of every game each phone's socket starts
   * being refused — and until this existed the app went on retrying, showing
   * ENLACE offline, which is also what a basement looks like. The login screen
   * is the true reading, and it is the only screen from which a new invite can
   * be redeemed.
   *
   * Anything else is the network saying nothing useful, and the retry carries on
   * exactly as before. One fetch per refused connect, and only for a socket that
   * never came up, so a walk with bad signal pays nothing for this.
   */
  async #probe(): Promise<void> {
    try {
      const payload = await fetchState();
      this.#syncClock(payload);
      this.payload = payload;
      this.auth = 'session';
      this.#retryLater();
    } catch (error) {
      if (error instanceof Unauthorised) {
        this.#wanted = false;
        this.payload = null;
        this.auth = 'anonymous';
        return;
      }
      this.#retryLater();
    }
  }
}

export const game = new GameConnection();
