import {
  advanceCursor,
  earliestSampleTs,
  indexTrack,
  replayAt,
  routeAt,
  replayStartCursor,
  replayWindowFor,
  REPLAY_SPEEDS,
} from '@q4413/core';
import type { ReplayIndex, TrackWindow } from '@q4413/core';
import type { Payload } from '@q4413/shared';

import { fetchTrack, ReplayForbidden, Unauthorised } from './api.ts';

/**
 * The replay clock (R-53..R-57).
 *
 * **Not a mode.** Nothing in here draws anything: it holds a cursor and a
 * window, and `payloadFor()` hands back the same `Payload` shape a socket
 * message carries, with `serverNow` moved. The master panel then renders it with
 * the map, the roster and the log it already has. That is R-53 taken literally,
 * and it is the answer to the risk ROADMAP records against this milestone —
 * a replay that needed its own renderer would mean the clock abstraction was not
 * respected, so there is deliberately nowhere for a second renderer to live.
 *
 * ## The window is fetched whole
 *
 * One request per replay, scrubbed locally. `GET /api/track` is a read and so
 * does not stop R-25's clock (see `#trackWindow` in the Worker), which cuts both
 * ways: polling it per frame would not hold `AUTHORITATIVE` open, and it would
 * spend requests the free tier counts. It also means scrubbing works with the
 * link down, which is the state a master at a venue is in more often than not.
 */

/**
 * How far back the cursor starts **in a game still running**. M8's exit
 * criterion is twenty minutes. A finished game ignores this and opens at its own
 * beginning — `replayStartCursor()` is where that is decided, in core, because
 * it is a rule and not a preference.
 */
export const REPLAY_START_OFFSET_MS = 20 * 60 * 1000;

/**
 * 100 ms, not a frame.
 *
 * At the top speed one tick is 1,6 s of game time, and positions are
 * interpolated between samples that arrive every 5 s (R-55), so even there this
 * is more often than the data underneath it — which is the property that decides
 * where the speed list stops, and is written down where the list is. Driving it
 * from `requestAnimationFrame` would rebuild the whole payload and re-diff the
 * panel sixty times a second to show the same thing.
 */
const TICK_MS = 100;

/**
 * What the clock needs off the game: its span, and whether it has ended.
 *
 * `state` rather than the presence of `finishedAt`, because nothing clears that
 * field when a game is opened again — see `replayWindowFor()`.
 */
export type ReplayGame = Pick<Payload['game'], 'state' | 'startedAt' | 'finishedAt'>;

/** Named rather than free text, so the locale has one entry per outcome. */
export type ReplayError = 'AUTHORITATIVE' | 'SESSION' | 'UNKNOWN';

export class Replay {
  active = $state(false);
  playing = $state(false);
  speed = $state(1);
  /** On the server's clock (R-36), like every other timestamp in the app. */
  cursor = $state(0);
  loading = $state(false);
  /** Rendered, not logged: every one of these is something the master can act on. */
  error = $state<ReplayError | null>(null);

  #window = $state<TrackWindow | null>(null);
  /**
   * Whether the end of the window is live, which is only true of a game still
   * running. A finished game's window ends where the game did, and that is a
   * different thing to reach — see `#tick()`.
   */
  #endsLive = true;
  #index = $derived<ReplayIndex | null>(this.#window ? indexTrack(this.#window) : null);
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastTick = 0;

  get from(): number {
    return this.#window?.from ?? 0;
  }

  get to(): number {
    return this.#window?.to ?? 0;
  }

  get samples(): number {
    return this.#window?.samples.length ?? 0;
  }

  /**
   * The window itself, for R-65's first file. Read-only by convention rather
   * than by copy: the caller serialises it and hands it to the browser, and a
   * defensive clone of 26.000 samples to protect against a mutation nobody
   * makes is a megabyte of nothing.
   */
  get window(): TrackWindow | null {
    return this.#window;
  }

  /** R-54b and R-54c's five, cycled by one control rather than five buttons. */
  get speeds(): readonly number[] {
    return REPLAY_SPEEDS;
  }

  /**
   * The payload as of the cursor, or `null` when replay is off — the caller
   * falls back to the live one, and the fallback is the only branch in the panel.
   */
  payloadFor(live: Payload | null): Payload | null {
    if (!this.active || !live || !this.#index) return null;
    return replayAt(live, this.#index, this.cursor);
  }

  /**
   * Where one player has been, up to the cursor (R-64).
   *
   * Empty unless a replay is running, which is what lets the caller pass the
   * result straight into the frame with no condition of its own: live, this is
   * `[]` and the map draws nothing, exactly as it does for a replay with nobody
   * selected.
   */
  routeFor(playerId: string | null, linkThresholdMs: number): Array<Array<[number, number]>> {
    if (!this.active || !playerId || !this.#index) return [];
    const samples = this.#index.byPlayer.get(playerId);
    if (!samples) return [];
    return routeAt(samples, this.cursor, linkThresholdMs);
  }

  /**
   * Opens a replay over the whole game (R-62).
   *
   * The window is fetched before `active` goes true, so the panel never renders
   * a replay with no track in it — an empty map would read as "everybody
   * vanished" rather than "still loading".
   */
  async open(game: ReplayGame, liveNow: number): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      // The whole game (R-62), and the cursor where the game's own state puts it:
      // a finished game opens at its start, a running one twenty minutes back.
      // Both decided in core, so this method fetches and stores and decides
      // nothing.
      const asked = replayWindowFor(game, liveNow);
      const window = await fetchTrack(asked.from, asked.to);
      this.#window = window;
      this.#endsLive = game.state !== 'FINISHED';
      this.cursor = replayStartCursor(
        window,
        game,
        REPLAY_START_OFFSET_MS,
        earliestSampleTs(window.samples),
      );
      this.active = true;
      this.play();
    } catch (error) {
      this.#window = null;
      this.error =
        error instanceof ReplayForbidden
          ? 'AUTHORITATIVE'
          : error instanceof Unauthorised
            ? 'SESSION'
            : 'UNKNOWN';
      if (!(error instanceof ReplayForbidden) && !(error instanceof Unauthorised)) {
        console.error(error);
      }
    } finally {
      this.loading = false;
    }
  }

  play(): void {
    if (!this.active) return;
    this.playing = true;
    this.#lastTick = Date.now();
    this.#timer ??= setInterval(() => this.#tick(), TICK_MS);
  }

  pause(): void {
    this.playing = false;
    this.#stopTimer();
  }

  /** R-54b and R-54c, as one control: 1 → 2 → 4 → 8 → 16 → 1. */
  cycleSpeed(): void {
    const at = REPLAY_SPEEDS.indexOf(this.speed);
    this.speed = REPLAY_SPEEDS[(at + 1) % REPLAY_SPEEDS.length] ?? 1;
  }

  /** Dragging the scrub bar. Pauses, because a cursor that runs away under the thumb is unusable. */
  seek(to: number): void {
    if (!this.#window) return;
    this.pause();
    this.cursor = Math.min(Math.max(to, this.#window.from), this.#window.to);
  }

  /**
   * Back to live, and the only way out (R-54).
   *
   * Called both by the master and by the tick that reaches the end of the
   * window, so "the replay caught up" and "the master pressed live" leave the
   * panel in exactly the same state — reading the socket, with no window held.
   */
  close(): void {
    this.pause();
    this.active = false;
    this.#window = null;
    this.error = null;
  }

  /**
   * Reaching the end of the window **is** reaching live, in a game that is still
   * being played: the window was fetched up to `liveNow` and R-54 says the
   * cursor snaps to real time there. It closes rather than sitting at the end,
   * because a paused cursor a few seconds behind a live socket is the one state
   * that looks identical to both and is neither.
   *
   * **A finished game has no live to reach**, so the same arrival means the
   * opposite: the replay has run out of game, and it stops there with the last
   * frame on screen. Closing instead would drop the debrief back to a panel
   * showing the same instant with none of the controls that got there, which
   * reads as the replay having crashed at exactly the moment it succeeded.
   */
  #tick(): void {
    const now = Date.now();
    const elapsed = now - this.#lastTick;
    this.#lastTick = now;
    const end = this.#window?.to;
    if (end === undefined) return this.close();
    this.cursor = advanceCursor(this.cursor, elapsed, this.speed, end);
    if (this.cursor < end) return;
    if (this.#endsLive) this.close();
    else this.pause();
  }

  #stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

export const replay = new Replay();
