<script lang="ts">
  import { scrambled, scrambler } from './scramble.svelte.ts';

  /**
   * A reading the viewer is not allowed to have, drawn as noise.
   *
   * §4 withholds a position rather than blanking it, and the two look the same
   * on screen: a dash reads as *the machine has nothing*, which is a claim
   * about the player — that they are off the air, out of battery, gone. They
   * are none of those. Somebody is out there with a perfectly live feed and the
   * zone rules say this viewer does not get it (R-40), and noise is the honest
   * picture of that: **there is a signal here and you cannot resolve it.**
   *
   * The glyphs carry the same promise. No digits and no letters, ever, because
   * a scramble that rolled `47` for a tenth of a second is a distance somebody
   * will eventually read — see `scramble.svelte.ts`.
   */
  let {
    length = 5,
    seed = 0,
    label,
  }: {
    /** How many characters of noise. Roughly the width of the reading it stands in for. */
    length?: number;
    /** So two fields on one row do not roll the same string and read as a pattern. */
    seed?: number;
    /** What a screen reader says instead. The noise is a picture, not a word. */
    label: string;
  } = $props();

  /**
   * §9's motion obligation. Somebody who asked for less motion still gets the
   * distinction — the field is still noise rather than a number — it just holds
   * still. That is the same trade the boot and the sweep make.
   */
  function reducedMotion(): boolean {
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  const still = reducedMotion();

  $effect(() => {
    if (still) return;
    return scrambler.join();
  });

  const text = $derived(scrambled(length, still ? 0 : scrambler.tick, seed));
</script>

<span class="scramble" aria-label={label} title={label}>{text}</span>

<style>
  /**
   * Dimmer than a reading and never brighter. §9.7 uses brightness as the
   * second channel for state, and this is the bottom of it: what is on screen
   * is the absence of a reading, and an absence that glowed would pull the eye
   * away from the six that are real.
   */
  .scramble {
    color: var(--phosphor-deep);
    user-select: none;
    -webkit-user-select: none;
  }
</style>
