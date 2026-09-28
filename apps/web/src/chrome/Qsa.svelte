<script lang="ts">
  /**
   * Signal strength, on the scale a radio operator already reads.
   *
   * QSA is 1-to-5 on a real set, which is why this is five bars and not four or
   * seven. What the app puts on it is not radio signal — there is no radio in
   * this system, R-29 runs the voice out of band — but **how much of the game a
   * screen is currently being told**, which is the same question a signal report
   * answers and the one the fiction already has a gauge for.
   *
   * Three levels are used (0, 3, 5) and the component takes any of them, because
   * a meter that can only show three things is a meter that has to be edited the
   * first time there is a fourth.
   *
   * ## An SVG and not five spans
   *
   * The bars are a fixed geometry — even steps, even gaps — and a stack of boxes
   * sized in CSS is that geometry restated in a language that rounds. The step
   * is computed from one constant rather than written out five times, which is
   * where an uneven meter would otherwise come from.
   */
  const BARS = [0, 1, 2, 3, 4].map((i) => ({
    x: i * 4.7,
    height: 3 + i * 2.25,
    y: 14 - (3 + i * 2.25),
  }));

  let { level, label }: { level: number; label: string } = $props();
</script>

<svg class="qsa" viewBox="0 0 22 14" role="img" aria-label={label} focusable="false">
  {#each BARS as bar, step (step)}
    <rect x={bar.x} y={bar.y} width="3.2" height={bar.height} class:lit={step < level} />
  {/each}
</svg>

<style>
  /**
   * Sized in `em`, so the consumer decides how big this is by setting a font
   * size on whatever it sits in — the roster's heading wants a gauge, the
   * master's bar wants a reading, and they are the same drawing at two sizes.
   *
   * `currentColor` for the lit bars, so the whole thing inverts with §9.4 and
   * with daylight without a second rule. The unlit ones are `--phosphor-deep`
   * rather than nothing: the bars that are *not* lit are what makes a level
   * readable at a glance, and empty space is not a reading.
   */
  .qsa {
    display: block;
    height: 1.4em;
    width: auto;
    flex: none;
  }

  .qsa rect {
    fill: var(--phosphor-deep);
  }

  .qsa rect.lit {
    fill: currentColor;
  }
</style>
