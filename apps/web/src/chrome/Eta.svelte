<script lang="ts">
  import { etaParts } from '../format.ts';

  /**
   * R-45's rough time as the screen prints it: the approximation mark, a space,
   * then the reading.
   *
   * It exists because the mark has to be styled apart from the number and a
   * string has no seam to hold a rule. `formatEta()` is still the single place
   * that decides what the reading says — this only decides how the two halves
   * sit — so the two cannot drift.
   */
  let { seconds }: { seconds: number } = $props();

  const parts = $derived(etaParts(seconds));
</script>

{#if parts.mark}<span class="approx">{parts.mark}</span>{' '}{/if}{parts.value}

<style>
  /**
   * `~` says the number is a guess (R-45), which makes it a qualifier and not a
   * digit — but at the size of the digits beside it, it reads as one more
   * character of the value. Set down, it goes back to being punctuation.
   *
   * `em` and not `rem`: this lands in a HUD line, a list row and a card
   * paragraph, and each sets its own size. The mark has to be smaller than
   * whatever it is sitting in, not smaller than the root.
   *
   * **`.approx`, and it may not go back to being `.mark`.** That word is taken:
   * `styles/terminal.css` gives `.mark` to §9.7's four state shapes, globally,
   * as a 1,4 rem box with the shape painted by a pseudo-element. Scoping does
   * not shield an element from a global rule of the same name — it only narrows
   * this component's own — so the `~` was being laid out as an empty 1,4 rem
   * square with an invisible circle inside it, which is what put a hole between
   * the mark and the number it qualifies.
   */
  .approx {
    font-size: 0.8em;
  }
</style>
