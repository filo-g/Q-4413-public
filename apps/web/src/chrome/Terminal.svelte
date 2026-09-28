<script lang="ts">
  import type { Snippet } from 'svelte';

  import { display } from '../display.svelte.ts';
  import { t } from '../i18n.ts';
  import Screensaver from './Screensaver.svelte';

  /**
   * The machine: a case around a recessed tube (§9, required element 1), and the
   * three effects that make the tube a tube.
   *
   * ## The case is a margin, not furniture
   *
   * §9 asks for a physical terminal and on a desk that is right. But the map is
   * the interface — a player reads a distance off it while walking, and the
   * master may well open the panel on a phone mid-game — so every pixel of bezel
   * is taken from the one thing the screen is for. It is a thin frame on a
   * laptop and close to a hairline on a phone, which is the same trade §9
   * already makes when it says the effect must never compromise legibility.
   *
   * What it never becomes is nothing at all: the OSM credit is silkscreened on
   * it (§14.5), and ODbL wants that visible on every screen rather than on the
   * wide ones.
   *
   * ## Nothing here scrolls
   *
   * The tube is exactly the viewport minus the strip, and what is inside it owns
   * its own overflow. A case that scrolls away is a background image, and a map
   * that has to be scrolled to is a section rather than an interface.
   *
   * ## Why there is no `filter`
   *
   * The obvious way to draw phosphor bloom is `filter: blur()` on a container.
   * It is also the one thing that cannot be done here: the map is a **WebGL
   * canvas**, R-48's navigation camera writes it once per frame, and a filter
   * over an ancestor forces a full-screen composite of that canvas on every one
   * of those frames. On a phone, at night, that is the milestone trading a
   * requirement for a decoration.
   *
   * So bloom is `text-shadow`, which touches glyphs and nothing else. Scanlines
   * and the vignette are static gradients — painted once, never repainted. Only
   * the flicker animates, and it animates `opacity` on an empty overlay.
   *
   * Every overlay is `pointer-events: none`. Without it the topmost one eats the
   * map's click handler, and picking a drop point by clicking real ground —
   * which is why the map is pickable at all — silently stops working.
   *
   * R-67's screensaver is the one exception, and it is that rule read the other
   * way: it is the only overlay that is not permanent, and the click that
   * dismisses it must not also drop a marker wherever the mark happened to be —
   * which is precisely the silent wrong write the rule is guarding against.
   */
  interface Props {
    children: Snippet;
    /**
     * The refresh sweep, on for the master's screen and off for the player's.
     *
     * Not because the tube is different — it is the same machine — but because
     * of what each screen is for. The player reads theirs at a run, in the
     * dark, looking for one dot; a band travelling across it is one more thing
     * moving on a screen where movement means somebody is walking. A master
     * watches a fixed picture from a table, which is exactly the condition a
     * CRT's refresh beat is visible under.
     */
    sweep?: boolean;
    /**
     * Whether this is a master's screen, which is the only one R-67's
     * screensaver is allowed on: a player needs their map the instant they look
     * at it, and R-43's boundary warning may never be behind anything.
     *
     * The same fact `sweep` is handed, and deliberately not the same prop. They
     * are two decisions that happen to agree today — one is about a refresh
     * beat being visible from a table, the other about which screen is safe to
     * cover — and folding them together means a change to either one silently
     * moves the other.
     */
    master?: boolean;
  }

  const { children, sweep = false, master = false }: Props = $props();
</script>

<div class="case">
  <div class="tube">
    <div class="screen">
      {@render children()}
    </div>

    <!-- R-67, above the panel and below the glass: it is the tube drawing
         something, so the scanlines and the vignette belong on top of it the
         same way they belong on top of the map. It renders nothing at all
         unless the screen has been left alone with VIGILIA off. -->
    <Screensaver {master} />

    <!-- §9.3, in the order they stack. aria-hidden and pointer-events:none on
         all three: they are glass, not content. -->
    <div class="scanlines" aria-hidden="true"></div>
    <div class="vignette" aria-hidden="true"></div>
    <div class="flicker" aria-hidden="true"></div>
    {#if sweep}
      <div class="sweep" aria-hidden="true"></div>
    {/if}
  </div>

  <!-- One strip, and it carries everything the case has to say. Silkscreened
       plastic, not phosphor (§9, typography): the model plate because a
       manufacturer's marking belongs on the case, the OSM credit because §14.5
       puts it there beside it — which is what makes it read as a marking rather
       than as a modern UI overlay — and the contrast switch because §9 makes
       high-contrast mandatory, and a mandatory control behind a menu is one a
       player under a streetlight does not find. -->
  <div class="strip">
    <span class="plate model">{t.boot.model}</span>
    <span class="plate credit">{t.map.attribution}</span>
    <!--
      A lamp and a switch, which is what the label being fixed buys.

      It used to print its own state — `CONTRASTE: NORMAL` / `CONTRASTE: ALTO`
      — and a physical control does not do that. Reading a switch that relabels
      itself means reading the word *and* deciding whether it names what you
      have or what you would get, which is the ambiguity every real panel avoids
      by keeping the legend still and lighting a lamp beside it.

      The lamp sits **outside** the button, as an indicator on the case rather
      than a detail of the control — which is how a panel is actually built: the
      lamp reports, the switch acts, and they are two parts.

      **Two parts of one control, so they are wrapped together.** Laid out as
      four flex children at one gap they were read as `lamp lamp switch switch`,
      and each switch appeared to light the other's lamp — which is worse than
      no lamp, because it is a wrong reading rather than a missing one. The
      pairing is structural here and the gap inside a pair is tighter than the
      gap between them, which is the only thing that says which lamp belongs to
      which legend.
    -->
    <!-- Two lamps for three states, which is how a panel with one switch says
         where it is: dark is the machine as built, green is §9's high contrast,
         amber is daylight. `aria-pressed` is a boolean and cannot carry three,
         so the mode travels in the button's **accessible name** instead — which
         is not its legend, and is the only reason the legend can stay still.

         The legend is the control's name and never its position. It printed its
         position for one commit (`TUBO` / `CONTRASTE` / `DIURNO`) and that is
         the relabelling above, only with three states to make it less obvious. -->
    <span class="control">
      <span class="led" class:on={display.high} class:day={display.daylight} aria-hidden="true"
      ></span>
      <button
        type="button"
        class="switch"
        class:pressed={display.contrast !== 'normal'}
        aria-label="{t.terminal.contrast}: {t.terminal.modes[display.contrast]}"
        onclick={() => display.toggleContrast()}
      >
        {t.terminal.contrast}
      </button>
    </span>
    <!-- The screen lock, beside the display mode because both are what the case
         does to the tube rather than anything the game knows about. Absent
         where the browser has no wake lock at all — a switch that cannot act is
         worse than no switch, and Safari had none of this until 16.4.

         Two states, so this one's lamp *is* `aria-pressed` said twice. -->
    {#if display.canStayAwake}
      <span class="control">
        <span class="led" class:on={display.awake} aria-hidden="true"></span>
        <button
          type="button"
          class="switch"
          class:pressed={display.awake}
          aria-pressed={display.awake}
          onclick={() => display.toggleAwake()}
        >
          {t.terminal.awake}
        </button>
      </span>
    {/if}
  </div>
</div>

<style>
  /**
   * Three pixels of plastic, and **the cutout is not its problem** (R-68b).
   *
   * This padded itself by `env(safe-area-inset-*)` for one release, on the
   * reasoning that a monitor's surround is the part allowed to be an awkward
   * shape. It reads well and it was wrong: this box paints a gradient, so room
   * reserved here *is* bezel. In portrait that is a hairline nobody notices; in
   * landscape the camera moves to a side and the case grew a band across the
   * width — spending the screen that `fullscreen` had just gone to fetch.
   *
   * The room belongs to what is **read**, and those are the overlays inside the
   * tube and the switches on the chin. The glass itself goes to the physical
   * edge and stays there: a road under a camera hole loses nothing.
   */
  .case {
    height: 100dvh;
    overflow: hidden;
    display: grid;
    /* The tube first, the bezel under it: the thick part of a monitor's surround
       is the chin, where the badge and the controls go, and putting it at the
       top made the case read as a title bar. */
    grid-template-rows: 1fr auto;
    background: linear-gradient(180deg, var(--case) 0%, var(--case-shadow) 100%);
    padding: 3px;
    gap: 3px;
  }

  /**
   * The chin, compressed into one row. The inset highlight is on its **top**
   * edge, which is the one that catches the light when the bulk is below the
   * glass — and it is what sells plastic at this size. A border would read as a
   * frame around a web page, and there is no room for one anyway.
   */
  /**
   * The chin takes its own inset, and it is the one place where doing so is free
   * (R-68b): this row is already plastic, so growing it costs no glass. VIGILIA
   * sits in its bottom corner and was being clipped by the screen's radius —
   * half a switch, on the control that decides whether the phone sleeps.
   */
  .strip {
    position: relative;
    display: flex;
    align-items: center;
    gap: 1ch;
    padding: 0 calc(22px + var(--safe-right)) var(--safe-bottom) calc(22px + var(--safe-left));
    min-height: 26px;
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.3);
  }

  /* Two screws, drawn rather than imaged: an SVG here is an asset to cache and
     a request to make, for something a gradient does.

     **They are centred on the legend, not on the row.** An absolutely positioned
     box resolves `top: 50%` against the *padding* box, and this row's inset is
     `padding-bottom` alone — so with the allowance on, the flex children centre
     themselves in a content box that is shorter than the plastic and the screws
     did not follow. Half the bottom inset is exactly that difference. */
  .strip::before,
  .strip::after {
    content: '';
    position: absolute;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #d8cbb4 0%, var(--case-shadow) 70%, #6f6149 100%);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.25);
    top: 50%;
    margin-top: calc(-4px - var(--safe-bottom) / 2);
  }
  .strip::before {
    left: 6px;
  }
  .strip::after {
    right: 6px;
  }

  /* Case labelling is a condensed grotesque, never the screen face (§9). That
     contrast is what makes this read as hardware rather than as a colour theme. */
  .plate {
    font-family: var(--case-font);
    font-weight: 600;
    font-size: 0.68rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #4a4132;
    text-shadow: 0 1px 0 rgb(255 255 255 / 0.4);
    white-space: nowrap;
  }

  .model {
    color: #322c22;
  }

  /* The credit yields width before the model plate does, and never disappears:
     ODbL asks for visible credit, and a narrow screen is still a screen. */
  .credit {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /**
   * One control: its lamp and its legend, bound by being closer to each other
   * than to anything else on the strip. The strip's own `gap` is `1ch` and this
   * is half of it, which is what stops `lamp lamp switch switch` from being a
   * plausible reading of four evenly spaced children.
   */
  .control {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.5ch;
  }

  .switch {
    flex: 0 0 auto;
    font-family: var(--case-font);
    font-weight: 600;
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    /* Below --touch on purpose, and it is the one control that may be: it is on
       the case rather than on the screen, it is pressed at a desk far more often
       than in the field, and giving it 44 px costs the tube 44 px on the device
       where §9 says legibility wins. */
    min-height: 20px;
    min-width: 0;
    padding: 0 0.6ch;
    color: #322c22;
    background: linear-gradient(180deg, #cfc0a4 0%, var(--case-shadow) 100%);
    border: 1px solid #6f6149;
    border-radius: 2px;
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.45);
  }

  .switch:hover,
  .switch:focus-visible {
    /* Not inverse video: this is plastic, and plastic does not glow. */
    background: linear-gradient(180deg, #ded1b7 0%, #9d8d71 100%);
    color: #322c22;
  }

  /* Pressed in whenever the machine is not in the state it was built in, so the
     legend stays put and the *switch* moves. It cannot key off `aria-pressed`
     for the contrast: that attribute is a boolean and there are three modes, so
     the button is pressed for both of the two that are not `normal` and the
     lamps say which. */
  .switch.pressed {
    background: linear-gradient(180deg, #9d8d71 0%, #b6a68a 100%);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.35);
  }

  /**
   * The lamp, green, on the case and not on the screen.
   *
   * §9's "one non-monochrome colour" is a rule about the **phosphor**: the tube
   * is amber and `--alarm` is R-43's alone, because a second colour on the
   * screen is a second thing that looks like it means something. The case is
   * already outside that palette — it is beige plastic — and a green indicator
   * beside a switch is what the hardware being imitated actually had.
   *
   * It is still a colour in the room while the boundary warning is red, which
   * is the one argument against: they are far apart, differently shaped and
   * never lit for the same reason, but a red alarm is worth a second look at
   * anything else that glows.
   *
   * Dark resin when off, lit from inside when on. The glow is a `box-shadow` on
   * a 7 px dot — the only place in this app where a halo is literally a lamp
   * rather than a font effect.
   */
  .led {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #2b3a2d;
    border: 1px solid #6f6149;
    box-shadow: inset 0 1px 1px rgb(0 0 0 / 0.5);
  }

  .led.on {
    background: #46e06a;
    border-color: #2f7a41;
    box-shadow:
      inset 0 0 2px rgb(200 255 214 / 0.95),
      0 0 6px rgb(70 224 106 / 0.8);
  }

  /* Amber, because that is the lamp a machine of this vintage lights when it is
     running in a mode it was not built for. It is not `--alarm`: R-43 owns the
     one red on any screen, and a case lamp is not a boundary warning. */
  .led.day {
    background: #ffb62e;
    border-color: #9a6a10;
    box-shadow:
      inset 0 0 2px rgb(255 235 190 / 0.95),
      0 0 6px rgb(255 182 46 / 0.8);
  }

  /**
   * The tube. `overflow: hidden` clips the overlays to the glass; `min-height: 0`
   * is what stops a grid row from being sized by its content, which is how a
   * full-height map inside it ends up pushing the case off the bottom.
   */
  .tube {
    position: relative;
    min-height: 0;
    overflow: hidden;
    border-radius: 10px / 8px;
    background: var(--screen);
    box-shadow:
      inset 0 0 0 1px #0a0705,
      inset 0 0 18px rgb(0 0 0 / 0.85);
  }

  .screen {
    height: 100%;
    /* Not `auto`. What is inside decides what scrolls, and in both views that is
       nothing: the map fills the tube and everything else is drawn on top of it. */
    overflow: hidden;
    /* Phosphor bloom, on glyphs only. See the note in the script block: a filter
       here would composite the map's WebGL canvas every frame. */
    text-shadow: 0 0 var(--bloom-radius) rgb(255 176 0 / 0.45);
  }

  /**
   * Scanlines at 3 px pitch, in CSS pixels rather than device ones, so the
   * texture survives a 3x phone instead of disappearing into it.
   */
  .scanlines {
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

  /* Curvature, implied rather than modelled: darkening the corners is what a
     curved tube does to an image, and it costs one gradient. */
  .vignette {
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: var(--vignette-opacity);
    background: radial-gradient(
      ellipse at center,
      transparent 58%,
      rgb(0 0 0 / 0.4) 86%,
      rgb(0 0 0 / 0.75) 100%
    );
  }

  /**
   * The flicker, deliberately almost nothing: `--flicker-depth` is 0.03. A
   * mains-hum wobble is a thing you notice only when it stops, and anything
   * stronger is a strobe on a screen somebody reads a distance off at night.
   */
  .flicker {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: var(--phosphor);
    opacity: 0;
    animation: hum 5.7s steps(2, end) infinite;
  }

  @keyframes hum {
    0%,
    97% {
      opacity: 0;
    }
    98% {
      opacity: var(--flicker-depth);
    }
    100% {
      opacity: 0;
    }
  }

  /**
   * The refresh sweep: the slow band a CRT leaves when the eye, or a camera, is
   * out of step with its refresh. One soft gradient translated down the glass,
   * once every seven seconds.
   *
   * `transform`, never `top` — a transform is composited and a `top` is a
   * layout on every frame, over a full-screen WebGL canvas. And never `filter`,
   * for the reason the whole effect layer avoids it: a filter on any ancestor
   * forces the canvas region to be composited again on each of R-48's per-frame
   * camera writes.
   *
   * It runs past the bottom rather than stopping there, so the band leaves the
   * glass instead of dissolving in the middle of it.
   */
  .sweep {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 18%;
    background: linear-gradient(
      180deg,
      transparent 0%,
      rgb(255 176 0 / 0.05) 45%,
      rgb(255 216 153 / 0.12) 60%,
      rgb(255 176 0 / 0.04) 72%,
      transparent 100%
    );
    opacity: var(--sweep-opacity);
    animation: sweep var(--sweep-period) linear infinite;
    will-change: transform;
    pointer-events: none;
  }

  @keyframes sweep {
    from {
      transform: translateY(-100%);
    }
    to {
      transform: translateY(calc(100vh + 100%));
    }
  }

  /**
   * Both halves of §9's motion obligation. The token alone would leave the
   * animation running at zero amplitude, which still wakes the compositor every
   * frame on a device whose owner asked for less of exactly that.
   */
  @media (prefers-reduced-motion: reduce) {
    .flicker,
    .sweep {
      animation: none;
    }
  }

  /* Both modes that switch the effects off switch the animations off with them:
     the token alone leaves them running at zero amplitude, which still wakes the
     compositor every frame on a device whose owner asked for the opposite. */
  :global(:root[data-contrast='high']) .flicker,
  :global(:root[data-contrast='high']) .sweep,
  :global(:root[data-contrast='daylight']) .flicker,
  :global(:root[data-contrast='daylight']) .sweep {
    animation: none;
  }

  /**
   * On a phone the case is a hairline. The master may open this in the field and
   * the player is in it the whole game; at 390 px a period bezel drawn at desk
   * scale costs a fifth of the area the map needs, and §9 says which side wins.
   * The strip stays — that is where the credit is.
   */
  @media (max-width: 600px) {
    .case {
      padding: 1px;
      gap: 1px;
    }
    .strip {
      padding: 0 14px;
      min-height: 20px;
      gap: 0.6ch;
    }
    .strip::before,
    .strip::after {
      width: 5px;
      height: 5px;
      margin-top: -2.5px;
    }
    .strip::before {
      left: 4px;
    }
    .strip::after {
      right: 4px;
    }
    .plate {
      font-size: 0.58rem;
      letter-spacing: 0.06em;
    }
    .control {
      gap: 0.3ch;
    }
    .switch {
      font-size: 0.55rem;
      min-height: 18px;
    }
    .tube {
      border-radius: 4px;
    }
  }
</style>
