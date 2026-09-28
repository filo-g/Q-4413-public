<script lang="ts">
  import { display } from '../display.svelte.ts';
  import { recorder } from '../recorder.svelte.ts';
  import { replay } from '../replay.svelte.ts';
  import { MARK, MARK_FONT } from './banner.ts';
  import { pathFor, positionAt } from './screensaver.ts';

  /**
   * What an idle master's tube does instead of holding a still picture (R-67).
   *
   * ## It is the visible half of VIGILIA, and that is the whole point
   *
   * The wake lock is not inert on a desktop — `navigator.wakeLock` has been in
   * Chrome and Edge since 84, Safari 16.4 and Firefox 126, and it does hold the
   * display awake. What it has no visible effect on is a **master's** screen: a
   * phone dims in a pocket thirty seconds after you stop touching it, and a
   * laptop on a table does not. So the one switch on the case a master is most
   * likely to press is the one that appears to do nothing at all.
   *
   * This is what the off position does. With VIGILIA on, the machine is being
   * held awake and stays exactly as it was; with it off, the screen is allowed
   * to rest, and on a master's screen resting is this rather than the operating
   * system's own blank — which is coming anyway, later, on a timer we do not
   * own. Ours is the prelude, and it is drawn rather than black because a
   * screensaver exists to stop a still image burning into a phosphor tube,
   * which is the thing this app spends its entire art direction pretending to
   * be.
   *
   * ## Master only
   *
   * R-43's boundary warning is the one thing on a player's screen that is not
   * game content, and it may never be behind anything — a player reads their
   * map at a run, in the dark, and a screen they have to wake first is a screen
   * that told them nothing. A master reads a fixed picture from a table, which
   * is also the only condition under which a still image sits there long enough
   * to matter. Same argument as `sweep` in `Terminal.svelte`, and the caller
   * passes the same fact.
   *
   * ## What counts as idle
   *
   * The hands, plus anything on the screen that is moving on its own. A replay
   * running is the second case and the reason `showing` is not simply
   * `display.idle`: the master's hands are off the keyboard for minutes at a
   * time while they watch twenty minutes of a game go past at 8x, and a
   * screensaver over that is the app interrupting the one thing it was asked to
   * show.
   *
   * **R-65's recording is the third case** (R-67b), and it is the one with
   * something to lose. R-65b starts a replay whenever a recording starts, so
   * `replay.playing` already covers a debrief being captured — but a recording
   * of a *live* panel is the one an operator sets going and walks away from, and
   * there the hands are off the keyboard because that is the point. A minute in,
   * the screensaver would be written into the file, and the file is the
   * artefact: nobody is watching the tube to dismiss it, and what comes back is
   * a minute of the game followed by a bouncing mark.
   *
   * ## The overlay swallows the input that dismissed it, on purpose
   *
   * Every other overlay in this app is `pointer-events: none`, because the
   * topmost one otherwise eats the map's click handler and picking a drop point
   * silently stops working. This one is the exception and it is the same
   * argument read the other way: a click that wakes the screen **and** drops a
   * marker where the mark happened to be is exactly the silent, wrong write
   * that rule is there to prevent. The overlay only exists while it is up, so
   * there is nothing to eat the rest of the time.
   */

  interface Props {
    /**
     * Whether this is a master's screen. The caller already knows — a payload
     * with a `viewMode` came from a master recipient — and passing the fact is
     * cheaper than this file learning how to ask.
     */
    master?: boolean;
  }

  const { master = false }: Props = $props();

  /** The drawing, as one string. `<pre>` keeps the grid; nothing else has to. */
  const ART = MARK.join('\n');

  const showing = $derived(
    master && display.idle && !display.awake && !replay.playing && !recorder.recording,
  );

  /**
   * §9's motion obligation, and the one place it cannot be honoured by simply
   * switching the animation off: a screensaver that does not move is a still
   * image, which is the thing it was put there to avoid. The trade taken is the
   * lesser one — the mark sits in the middle of an otherwise cleared screen, so
   * the panel underneath still stops burning and nothing on the glass moves.
   *
   * Read once rather than watched. Somebody who changes this system setting
   * mid-game has a browser reload in them.
   */
  const still = (() => {
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  })();

  let tubeWidth = $state(0);
  let tubeHeight = $state(0);
  let markWidth = $state(0);
  let markHeight = $state(0);
  let markEl = $state<HTMLPreElement | undefined>(undefined);

  const path = $derived(
    pathFor(
      { width: tubeWidth, height: tubeHeight },
      { width: markWidth, height: markHeight },
    ),
  );

  /**
   * The loop, and it writes the element rather than a rune.
   *
   * Same reasoning as R-48's camera: this runs once per frame for as long as
   * the panel is left alone, and routing a number through `$state` to get a
   * `transform` onto one element means Svelte re-reads and re-diffs that
   * subtree sixty times a second to arrive at the string we already had.
   * `style.transform` is a composited property written directly — no layout, no
   * paint, and above all no `filter`, which on any ancestor would force a
   * full-screen composite of the map's WebGL canvas underneath.
   *
   * The position is a function of elapsed time and not an integration, so a
   * dropped frame costs a frame rather than bending the trajectory away from
   * the corner it is aiming at. See `screensaver.ts`.
   */
  $effect(() => {
    const element = markEl;
    const track = path;
    if (!showing || still || !element || !track) return;

    // Where on the path it starts, chosen per appearance. Zero would start it
    // sitting in a corner, which opens with the payoff; a random offset makes
    // the first one a real wait, and because it shifts the clock rather than the
    // axes the corner still arrives on schedule. See `positionAt`.
    const phase = Math.random() * track.cornerMs;
    const startedAt = performance.now();

    let frame = requestAnimationFrame(function tick(now: number): void {
      const at = positionAt(track, now - startedAt, phase);
      element.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
      frame = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(frame);
  });
</script>

{#if showing}
  <!-- aria-hidden because there is nothing here to read: the panel underneath is
       untouched and a screen reader was never looking at the phosphor. -->
  <div
    class="saver"
    class:still
    aria-hidden="true"
    bind:clientWidth={tubeWidth}
    bind:clientHeight={tubeHeight}
  >
    <pre
      bind:this={markEl}
      bind:clientWidth={markWidth}
      bind:clientHeight={markHeight}
      style:font-family={MARK_FONT}>{ART}</pre>
  </div>
{/if}

<style>
  /**
   * The resting screen: the whole of the tube and nothing outside it.
   *
   * Opaque `--screen`, because a screensaver that let the panel show through
   * would be leaving the pattern it was put there to clear.
   */
  .saver {
    /**
     * Absolute, inside the tube, and **never** over the case.
     *
     * The strip below the glass is the machine's bezel: the model plate, the
     * OSM credit and two physical switches. Those are not on the screen, they
     * are on the box around it, and nothing the tube draws may ever cover them
     * — a screensaver that swallowed the case would be a screensaver painted
     * over the plastic. It was `fixed` for one commit and that is exactly what
     * it did.
     *
     * What does have to go under it is the master's status bar, which *is* on
     * the screen. That is what `z-index` below is for.
     */
    position: absolute;
    inset: 0;
    /**
     * Above everything the panel draws, and the number is read off the panel:
     * `.bar` is 3 and `.briefing-dim` is 4 in `MasterView.svelte`, both in this
     * same stacking context, because nothing between here and the root makes
     * one — `.tube` and `.deck` are `position: relative` with an automatic
     * `z-index`, which is not enough.
     *
     * So DOM order alone does not put this on top: without a `z-index` the bar
     * stays lit across the bottom of a screen that is supposed to be resting,
     * which is the one thing anybody notices immediately.
     *
     * It goes over §9.3's glass too, which the bar already did. The scanlines
     * come back below as this element's own, so the tube keeps its texture
     * rather than borrowing the layer it is now above.
     */
    z-index: 5;
    overflow: hidden;
    background: var(--screen);
    /* The exception to the app's overlay rule, and the script block says why:
       the input that dismisses this must not also reach the map. */
    cursor: none;
    user-select: none;
  }

  /**
   * The mark, positioned from the top-left corner of the travel box and moved
   * by `transform` alone — never `top`/`left`, which is a layout on every frame
   * over a full-screen WebGL canvas.
   *
   * `--phosphor-dim` rather than the top of the palette: the machine is resting,
   * and a screensaver at full brightness is burn-in with a moving pattern.
   *
   * Small, and it came down twice. A screensaver's mark is a thing that crosses
   * a screen, not a thing that fills it: at about a seventh of the short axis
   * the travel box is nearly the whole of the glass, so the path has room to be
   * a path rather than a logo shuffling inside a narrow frame. The bounce also
   * reads faster at the same pixels per second, because there is more of the
   * screen to cross.
   *
   * The face and the leading are not a preference. The drawing is 29 columns
   * for 15 rows at an aspect of 1,92, which is a system monospace's cell and not
   * VT323's 2,875 — the same block set in the screen face is a circle squashed
   * into an egg. `banner.ts` carries the full argument and `MARK_FONT` the
   * stack; `--cell-y` is the row height both halves of that ratio assume.
   */
  pre {
    position: absolute;
    top: 0;
    left: 0;
    margin: 0;
    color: var(--phosphor-dim);
    font-size: clamp(4px, 0.8vmin, 9px);
    line-height: var(--cell-y);
    white-space: pre;
    /* A drawing is not type: §9's bloom is for strokes of a font, and on a block
       of `#` it spreads the ink into the gaps and fills the circle in. */
    text-shadow: none;
    will-change: transform;
  }

  /**
   * §9.3's scanlines, redrawn here because this element is above the tube's.
   *
   * The same gradient at the same 3 px pitch and — the part that matters — the
   * same token, so `high` and `daylight` take it to zero along with every other
   * copy without this file knowing either mode exists. A screensaver without
   * them is an HTML panel over a CRT rather than the CRT resting.
   *
   * The vignette, the flicker and the sweep are deliberately not copied. One is
   * curvature and the other two move; a resting tube showing one still figure
   * has nothing to flicker and nowhere to sweep.
   */
  .saver::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: var(--scanline-opacity);
    background: repeating-linear-gradient(
      to bottom,
      rgb(0 0 0 / 0.55) 0px,
      rgb(0 0 0 / 0.55) 1px,
      transparent 1px,
      transparent 3px
    );
  }

  /**
   * Reduced motion: centred and still. `transform` is the same property the
   * loop writes, so the loop not running is the whole of the difference.
   */
  .still pre {
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    will-change: auto;
  }
</style>
