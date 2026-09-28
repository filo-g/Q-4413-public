<script lang="ts">
  import { CHECK_MS } from './banner.ts';
  import { t } from '../i18n.ts';

  /**
   * §9.6's self-test, as the one thing that prints it.
   *
   * Two callers with the same lines and different reasons to show them: the
   * login runs it after a correct password, where the boot *is* the event; the
   * app runs it on any other load, in front of a map somebody opened to look
   * at. Same list, same look, one cadence knob — a second copy of this would
   * be two machines with the same nameplate.
   *
   * Twenty-one lines going past faster than they can be read, which is the
   * point: a boot is recognisable by its **cadence** rather than by any one
   * line, and nobody reads one — they watch it happen. Four lines at a readable
   * pace is a self-test, not a boot.
   */
  let {
    ms = CHECK_MS,
    tail,
    onDone,
  }: {
    /** Milliseconds per line. */
    ms?: number;
    /** One more line after the list, in the same shape. */
    tail?: string | undefined;
    onDone?: (() => void) | undefined;
  } = $props();

  const CHECKS: readonly string[] = t.boot.checks;

  let checked = $state(0);
  const finished = $derived(checked >= CHECKS.length);

  /**
   * §9's motion obligation, and it is not decoration: somebody who asked for
   * less motion gets the whole list at once and whatever is behind it
   * immediately, rather than a shorter animation.
   */
  function reducedMotion(): boolean {
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /**
   * Keep the newest line on screen.
   *
   * Twenty-one lines overrun any console they are printed into, and both
   * callers bottom-align their block with `margin-top: auto` — which collapses
   * to nothing the moment the content is taller than the box, so the list then
   * grows *downwards* off the bottom edge. Scrolling the last line into view
   * scrolls whichever ancestor actually scrolls, which is the caller's console
   * in both cases and nothing this component has to know about.
   */
  let list = $state<HTMLElement | null>(null);
  $effect(() => {
    void checked;
    list?.lastElementChild?.scrollIntoView({ block: 'end' });
  });

  $effect(() => {
    if (reducedMotion()) {
      checked = CHECKS.length;
      onDone?.();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = (): void => {
      if (checked >= CHECKS.length) {
        // A beat on the last line, or the handover reads as the boot being cut
        // off rather than as it finishing.
        timer = setTimeout(() => onDone?.(), Math.max(120, ms * 5));
        return;
      }
      checked += 1;
      timer = setTimeout(step, ms);
    };
    step();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  });
</script>

<!-- `[ OK ]` in the brightest phosphor rather than inverse video. §9.4 makes
     inverse this interface's emphasis, and twenty-one inverted badges in a
     column would be a screen of blocks — brightness is §9.7's second channel
     and carries this fine. -->
<div class="checks" bind:this={list}>
  {#each CHECKS.slice(0, checked) as check}
    <p class="check"><span class="ok">[ {t.boot.ok} ]</span> {check}</p>
  {/each}
  {#if finished && tail}
    <p class="check tail"><span class="ok">[ {t.boot.ok} ]</span> {tail}</p>
  {/if}
</div>

<style>
  /* Its own grid rather than `display: contents`: the caller places this block,
     and a block that dissolves into its parent's grid cannot be given a margin
     or be scrolled to as one thing. */
  .checks {
    display: grid;
    justify-items: start;
  }

  /**
   * `pre-wrap`, not `pre`: the spacing inside `[ OK ]` is the alignment and has
   * to survive, but a 34-column line on a 320 px phone is wider than the screen
   * — and a boot that scrolls sideways is a boot nobody can read the end of.
   * It wraps at the space before the long word, which is the one place a break
   * costs nothing.
   */
  .check {
    margin: 0;
    max-width: 100%;
    white-space: pre-wrap;
  }

  .ok {
    color: var(--phosphor-bright);
  }

  .tail {
    margin-top: 0.5lh;
  }
</style>
