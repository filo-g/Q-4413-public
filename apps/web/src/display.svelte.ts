import { IDLE_MS, REARM_MS } from './chrome/screensaver.ts';

/**
 * High-contrast mode (§9, **mandatory**) and the one place the root element's
 * display state is written.
 *
 * §9 gives the CRT layer three obligations that pull against it — the effect
 * must never cost legibility, `prefers-reduced-motion` must be honoured, and a
 * high-contrast mode must exist. The first two are CSS; this is the third, and
 * it is a setting rather than a media query because the condition it answers is
 * not a system preference. A player standing under a streetlight with a phone at
 * arm's length has a legibility problem their OS knows nothing about.
 *
 * It does not recolour anything. The palette is already monochrome, so there is
 * no colour to raise — what it does is take the scanlines, the bloom and the
 * vignette to zero and move the phosphor to its brightest value. The tokens live
 * in `styles/terminal.css`; this only sets the attribute they key off.
 */

/**
 * Three, not two.
 *
 * `high` is §9's mandatory mode and it answers one question: the effect layer
 * costing legibility at night. It takes the scanlines, the bloom and the
 * vignette to zero and moves the phosphor to its top value, and the palette
 * stays what it is — amber on warm black.
 *
 * `daylight` answers a different one, and raising the contrast does not touch
 * it. A screen that is mostly black cannot compete with the sun: what a phone
 * can put out is light, and in an amber-on-black palette almost none of the
 * pixels are producing any. The fix is to invert — dark ink on a light ground —
 * so the backlight is doing the work rather than fighting it.
 *
 * §9 asks for an amber CRT and this is not one. The same section is why it
 * exists anyway: *the effect must never compromise legibility*, and a player
 * standing in a street at two in the afternoon has a legibility problem the
 * fiction cannot argue with. The game is at night; setup, pairing and the walk
 * to the venue are not.
 */
type Contrast = 'normal' | 'high' | 'daylight';

/** The order the switch cycles in, and the order they are listed above. */
const ORDER: readonly Contrast[] = ['normal', 'high', 'daylight'];

const STORAGE_KEY = 'q4413:contrast';
const AWAKE_KEY = 'q4413:awake';

/**
 * Storage is read and written through these, because it is not always there:
 * a private window, a locked-down browser or a WebView with storage disabled
 * throws on access rather than returning null. A setting that cannot persist is
 * a setting that lasts one session, which is a much better outcome than a panel
 * that will not boot.
 */
function readStored(): Contrast | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return ORDER.find((mode) => mode === value);
  } catch {
    return undefined;
  }
}

function writeStored(value: Contrast): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Nothing to do and nothing worth logging: the mode still applies to this
    // session, which is what the player asked for.
  }
}

/**
 * The OS's answer, used only when the player has not given their own.
 *
 * `prefers-contrast: more` is somebody who has already said, at system level,
 * that they need contrast — asking them again with an effect-laden default
 * would be ignoring an answer we were handed.
 */
function systemPreference(): Contrast {
  try {
    return matchMedia('(prefers-contrast: more)').matches ? 'high' : 'normal';
  } catch {
    return 'normal';
  }
}

class Display {
  contrast = $state<Contrast>('normal');

  /**
   * Whether a reading surface is open over the tube.
   *
   * §9's effect layer sits above **everything**, panels included — it is glass,
   * and glass does not choose what it covers. That is right over a map, which is
   * a picture, and wrong over a roster, which is text: the vignette is a radial
   * and therefore darkest at the screen's edge, which is exactly where the
   * personnel rail lives, so a list at the left margin was being read through
   * the strongest part of the effect.
   *
   * §9 already decides this — "the effect must never compromise legibility" —
   * so the glass goes quiet while something is being read, and comes back when
   * it closes. Not off: a panel that erased the machine would read as a second
   * application rather than a sheet over this one.
   *
   * **A plain field, deliberately not `$state`.** Nothing renders from it: it
   * exists to put an attribute on the root element, and the CSS keys off the
   * attribute. It was a rune for one commit and that was an infinite effect
   * loop — the panel's effect called a method that wrote this *and* read it
   * back through `#apply()`, so the effect took a dependency on the very thing
   * it had just written and re-ran itself until Svelte gave up with
   * `effect_update_depth_exceeded`. It fired on every panel and on nothing
   * else, because a panel is the only thing that opens a reader.
   */
  #reading = false;

  get reading(): boolean {
    return this.#reading;
  }

  /**
   * Called once from `main.ts`, before the app mounts, so the first frame is
   * already in the right mode. Applying it after mount would flash the full
   * effect at exactly the person who asked not to see it.
   */
  start(): void {
    this.contrast = readStored() ?? systemPreference();
    this.#apply();
    this.#restoreAwake();
    // The lock dies whenever the page is hidden — a tab switch, a lock button,
    // a call — and the browser does not give it back. Coming into view is the
    // only moment it can be taken again, and a player who answered a call and
    // came back is exactly who needs it.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      void this.#acquireWakeLock();
      // Coming back to a tab is looking at it. Without this the screensaver is
      // already up on the first frame the master sees, which reads as the panel
      // having crashed while they were away rather than as it having rested.
      this.#poke();
    });
    this.#watchIdle();
    // Every way out is the browser's, not ours (R-68c): the back gesture,
    // Escape, and swiping the system bars down all leave without telling this
    // class. One listener is what keeps the lamp and the corner allowance
    // honest about which of the two states the app is really in.
    //
    // It does not poke the idle timer, and does not need to: every way into or
    // out of fullscreen on the master's view is a keystroke — `F` or Escape —
    // and `#watchIdle()` is already listening for those in capture.
    document.addEventListener('fullscreenchange', () => this.#noteFullscreen());
    this.#noteFullscreen();
  }

  /** One control, cycling. Two buttons for three states is a mode picker. */
  toggleContrast(): void {
    const at = ORDER.indexOf(this.contrast);
    this.contrast = ORDER[(at + 1) % ORDER.length] ?? 'normal';
    writeStored(this.contrast);
    this.#apply();
  }

  get high(): boolean {
    return this.contrast === 'high';
  }

  /**
   * Read by the map, which cannot use a CSS variable: MapLibre's paint values
   * are numbers and colour literals inside a style object, so the palette swap
   * has to reach it as data. See `buildStyle()`.
   */
  get daylight(): boolean {
    return this.contrast === 'daylight';
  }

  /**
   * Whether the screen is being held awake.
   *
   * A phone turns its screen off after thirty seconds and the map is a thing
   * you glance at while walking, so a player spends the game waking their
   * phone up — and R-43's boundary warning is drawn on a screen nobody is
   * looking at. The Screen Wake Lock API is the whole of the fix, and it costs
   * exactly what it sounds like it costs, which is why it is a switch on the
   * case rather than something the app does quietly.
   *
   * **On by default.** The complaint it answers is real and immediate; the
   * battery it spends is a four-hour game on a phone that is already running
   * GPS and a socket. Somebody who wants it off can reach the switch, and the
   * lamp says which way it is set.
   *
   * `$state` because the lamp on the bezel renders from it, unlike `reading`
   * below which only ever sets an attribute.
   */
  awake = $state(true);

  #lock: { released: boolean; release(): Promise<void> } | null = null;

  /** Unsupported is a real answer: Safari had none of this until 16.4. */
  get canStayAwake(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  toggleAwake(): void {
    this.awake = !this.awake;
    try {
      localStorage.setItem(AWAKE_KEY, this.awake ? 'on' : 'off');
    } catch {
      // Same as the contrast setting: a mode that cannot persist lasts one
      // session, which beats refusing to boot in a locked-down browser.
    }
    if (this.awake) void this.#acquireWakeLock();
    else void this.#releaseWakeLock();
  }

  #restoreAwake(): void {
    try {
      this.awake = localStorage.getItem(AWAKE_KEY) !== 'off';
    } catch {
      this.awake = true;
    }
    if (this.awake) void this.#acquireWakeLock();
  }

  /**
   * Whether nothing has touched this machine for a while (R-67).
   *
   * **A timestamp and a timeout, deliberately not a tick.** Idle is the absence
   * of events, so it is measured by the events themselves: every input pushes
   * the timeout out, and when one is finally allowed to fire, it fires once.
   * Nothing here polls, nothing counts frames, and — this is the part R-25
   * cares about — nothing reaches the server. A screensaver that pinged
   * anything at all would be a way to hold `AUTHORITATIVE` open by doing
   * nothing, which is the exact failure that requirement exists to prevent.
   *
   * It lives here rather than in the component that draws the screensaver
   * because it is the other half of `awake` above: one of them is what the
   * machine does to the display, and the other is what the display does when
   * the machine is left alone. `Screensaver.svelte` decides what to put on the
   * glass; this decides whether the glass is being watched.
   *
   * `$state`, because something renders from it — unlike `reading`, which only
   * ever sets an attribute.
   */
  idle = $state(false);

  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** When the timer was last re-armed, which is what keeps `#poke()` cheap. */
  #lastInput = 0;

  /**
   * One handler for every kind of input, and the list is deliberately broad:
   * anything that moves a pointer, presses a key, scrolls or touches the glass
   * is somebody using this. Capture, so it runs whatever the target does with
   * the event afterwards — including the screensaver's own overlay, which
   * swallows the input that dismissed it.
   *
   * `pointermove` is the reason for `REARM_MS`. It arrives at the refresh rate,
   * and clearing a timeout sixty times a second is a tick with extra steps.
   */
  #watchIdle(): void {
    const poke = (): void => this.#poke();
    for (const kind of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(kind, poke, { capture: true, passive: true });
    }
    this.#poke();
  }

  #poke(): void {
    const now = Date.now();
    const wasIdle = this.idle;
    if (wasIdle) this.idle = false;
    // A machine that was already awake and was poked a moment ago does not need
    // its timer touched: the one it has is already measuring the same silence.
    else if (now - this.#lastInput < REARM_MS) return;
    this.#lastInput = now;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.idle = true;
    }, IDLE_MS);
  }

  async #acquireWakeLock(): Promise<void> {
    if (!this.awake || !this.canStayAwake) return;
    if (this.#lock && !this.#lock.released) return;
    try {
      const api = (navigator as unknown as {
        wakeLock: { request(type: 'screen'): Promise<{ released: boolean; release(): Promise<void> }> };
      }).wakeLock;
      this.#lock = await api.request('screen');
    } catch {
      // Refused rather than absent: some browsers decline while the battery is
      // low or the document is not visible. Not worth surfacing — the screen
      // behaves the way it did before, and the next visibility change tries
      // again.
      this.#lock = null;
    }
  }

  async #releaseWakeLock(): Promise<void> {
    const lock = this.#lock;
    this.#lock = null;
    if (lock && !lock.released) await lock.release().catch(() => {});
  }

  /**
   * Whether the app is filling the screen (R-68c).
   *
   * **A control and not a setting**, and the API is what decides that. The
   * manifest's `display` is read once, when the app is installed, and cannot
   * differ between one orientation and the other — which is the thing actually
   * wanted here: a phone held upright has room for the system bars and a phone
   * turned sideways does not. `requestFullscreen()` can tell them apart and
   * refuses to run without a user gesture, so no rotation handler can call it.
   * That leaves a button, which is the honest shape of the feature rather than a
   * compromise: the player presses it once and it survives every rotation until
   * they leave.
   *
   * Mirrored from the `fullscreenchange` event rather than set on the way out.
   * The browser's own exits — the back gesture, Escape, swiping the bars down —
   * do not go through this class, and a flag that only tracked the button would
   * be wrong the first time somebody used one of them.
   */
  fullscreen = $state(false);

  /**
   * Whether the app is already filling the screen **because the manifest says
   * so**, rather than because anybody pressed anything.
   *
   * `display: fullscreen` is read once, when the app is installed, and
   * `document.exitFullscreen()` cannot reach it — there is no element in
   * fullscreen to exit. What a press produced was the system bars appearing for
   * a moment and Android's sticky immersive mode putting them straight back,
   * which reads as a toggle that half-works and is a manifest the phone was
   * handed months ago.
   *
   * R-68c settled the manifest at `standalone` for exactly this reason, so the
   * only way to be here is an installed copy from before that — or a phone
   * still holding the cached manifest the service worker used to serve
   * cache-first. Detected rather than assumed impossible, because both of those
   * are real phones in a real bag.
   */
  get lockedFullscreen(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(display-mode: fullscreen)').matches && !this.fullscreen;
  }

  /**
   * Unsupported is a real answer here — iOS Safari has never allowed it — and so
   * is *already there and not by this button's doing*, which is what
   * `lockedFullscreen` catches. A control that cannot change what it describes
   * is worse than a missing one: the player presses it, the bars flicker, and
   * the app has told them it is broken.
   */
  get canFullscreen(): boolean {
    if (typeof document === 'undefined' || document.fullscreenEnabled !== true) return false;
    return !this.lockedFullscreen;
  }

  async toggleFullscreen(): Promise<void> {
    if (!this.canFullscreen) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      // Refused rather than absent — a gesture the browser did not count as one,
      // or a permissions policy. The screen stays as it was, which is the state
      // the button already described.
    }
  }

  /**
   * The attribute the stylesheet reads, beside `@media (display-mode: fullscreen)`.
   *
   * Both, because the two are not reliably the same thing: the media feature is
   * specified against the *web app's* display mode, and whether an element
   * fullscreened through the API also flips it has varied. R-68b's corner
   * allowance has to be on exactly when the app is against the glass, and an
   * attribute this class writes is the half of that it can be sure of.
   */
  #noteFullscreen(): void {
    this.fullscreen = document.fullscreenElement !== null;
    // The attribute follows the API *or* the manifest: R-68b's corner allowance
    // is about the app being against the glass, and it is against the glass
    // either way. The media query beside this rule covers the manifest case on
    // its own, but only where the browser flips it — which is the variance this
    // attribute exists to cover.
    const againstGlass =
      this.fullscreen ||
      (typeof window !== 'undefined' &&
        window.matchMedia?.('(display-mode: fullscreen)').matches === true);
    if (againstGlass) document.documentElement.dataset['fullscreen'] = '';
    else delete document.documentElement.dataset['fullscreen'];
  }

  /**
   * Counted rather than set, because two surfaces can be open at once — a panel
   * and a card — and the one that closes first must not put the glass back over
   * the one still up.
   */
  #readers = 0;

  openedReader(): () => void {
    this.#readers += 1;
    this.#applyReading();
    return () => {
      this.#readers = Math.max(0, this.#readers - 1);
      this.#applyReading();
    };
  }

  /**
   * Its own writer, and not a call to `#apply()`.
   *
   * This runs from inside an `$effect`, and `#apply()` reads `this.contrast` —
   * which would make every panel that opens depend on the contrast setting for
   * no reason. Touching only the attribute it owns keeps the effect's
   * dependencies to the one thing it actually watches.
   */
  #applyReading(): void {
    const root = document.documentElement;
    if (this.#readers > 0) root.dataset['reading'] = '';
    else delete root.dataset['reading'];
  }

  /**
   * On the root element rather than on a component, so the effect layer, the
   * case and every panel below see the same state without threading a prop —
   * and so a token override in `:root[data-contrast='high']` is all the CSS
   * needs to say.
   */
  #apply(): void {
    document.documentElement.dataset['contrast'] = this.contrast;
    this.#applyReading();
  }
}

export const display = new Display();
