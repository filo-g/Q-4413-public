<script lang="ts">
  import { loginMaster, Throttled, Unauthorised } from '../api.ts';
  import {
    LOGO_ROW_MS,
    LOGOTYPE,
    MARK,
    noticeBox,
    PRINT_LINE_GAP_MS,
    printDuration,
  } from '../chrome/banner.ts';
  import Boot from '../chrome/Boot.svelte';
  import { formatDuration } from '../format.ts';
  import { game } from '../game.svelte.ts';
  import { t } from '../i18n.ts';

  /**
   * Master login only (§6.4). Players have no password: they redeem an invite
   * link at /j/<token>, which is the whole of their authentication, and that link
   * is what gets installed to the home screen.
   *
   * ## Why this is a console and not a form on a screen
   *
   * §9.6 asks for a boot sequence and this is the only screen that can carry
   * one: every other surface in the app is a map, a roster or a panel, and a
   * terminal that announces itself over the top of those is a splash screen.
   *
   * The order is the order a machine does it in. **The logotype first**, because
   * a banner is the first thing on the screen and everything after it is the
   * program identifying itself underneath. Then who built it, then what it is,
   * then the password. Nothing is tested before that: a machine that checks its
   * cartography and *then* asks who you are has done the work for somebody who
   * has not proved they may ask for it — so the checks are on the far side of
   * the prompt, which is also where a server's are.
   *
   * The block prints **bottom-up**: it is anchored to the foot of the screen
   * and each line pushes the ones above it up, which is where a prompt lives on
   * anything with a scrollback and where a thumb already is on a phone.
   */
  let password = $state('');
  let failed = $state(false);
  let busy = $state(false);
  /**
   * When a M2b login lockout ends, as a deadline rather than a remaining count.
   * A phone that sleeps mid-lockout stops receiving ticks, and a decrementing
   * counter would resume where it left off and claim more time than is left.
   */
  let lockedUntil = $state(0);
  let now = $state(Date.now());
  const lockedFor = $derived(Math.max(0, Math.ceil((lockedUntil - now) / 1000)));

  // A countdown rather than a static number: locked out at the venue, the useful
  // question is "how much longer", and a frozen "5min" invites a page reload.
  $effect(() => {
    if (lockedUntil <= Date.now()) return;
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  interface Printed {
    text: string;
    /**
     * A logotype row is put on the screen; a line of prose is written a
     * character at a time. The flag is what the CSS keys the typing animation
     * off, and what decides how long the line holds before the next.
     */
    logo?: boolean;
    /**
     * A row of the device mark, which is the one block on this screen set in
     * something other than VT323. `banner.ts` says why at length: that face has
     * 224 glyphs and no `U+2588`, and a per-character fallback shears the grid
     * because the fallback's advance is half as wide again.
     */
    mark?: boolean;
    /** TRIAL: a row of the operator's notice, which prints like the banner. */
    notice?: boolean;
  }

  /**
   * What the machine prints before it asks for anything.
   *
   * The credit is §9.6's, and the joke in it is period-accurate: the bank and
   * the manufacturer are the same group, which is why the machine exists and
   * why it was never going to be repaired. Locale copy, all of it — the one
   * thing that is not is the logotype, and `banner.ts` says why.
   *
   * **The version under the program name is fiction and is not maintained.**
   * It is the terminal's firmware, not this repository's, which is the whole of
   * why it can be a constant: a number in the UI that tracks the project rots
   * by construction, and this one has nothing to track. The master's bar reads
   * the same string, so the machine cannot give two answers.
   */
  /**
   * The operator's notice. The box is `banner.ts`'s; the sentences are the
   * locale's, and only ever printed here — a player redeems `/j/<token>` and
   * never reaches a password prompt, so this is the master's screen.
   */
  const NOTICE: readonly string[] = noticeBox({
    title: t.boot.warningTitle,
    lines: t.boot.warning,
    centred: [t.boot.warningConsent, t.boot.warningPresence],
    accept: t.boot.warningAccept,
  });

  const BOOT: readonly Printed[] = [
    ...NOTICE.map((row) => ({ text: row, logo: true, notice: true })),
    { text: '' },
    ...MARK.map((row) => ({ text: row, logo: true, mark: true })),
    ...LOGOTYPE.map((row) => ({ text: row, logo: true })),
    { text: '' },
    { text: t.boot.model },
    { text: t.boot.maker },
    { text: t.boot.group },
    { text: '' },
    { text: t.boot.program },
    { text: t.boot.version },
    { text: '' },
    { text: t.boot.ready },
  ];

  /**
   * How many of `BOOT`'s rows are the banner.
   *
   * They are a contiguous prefix by construction, which is what lets the render
   * split into two loops with a constant rather than filtering the list twice
   * on every frame of the print.
   */
  const NOTICE_ROWS = NOTICE.length + 1;
  const BANNER_ROWS = MARK.length + LOGOTYPE.length;


  const dwell = (line: Printed): number =>
    line.logo ? LOGO_ROW_MS : printDuration(line.text) + PRINT_LINE_GAP_MS;

  /**
   * How much of the script has printed.
   *
   * One counter rather than a queue: the lines are a constant, so the only
   * state is how far down them the machine has got, and skipping is that
   * counter jumping to the end.
   */
  let printed = $state(0);
  const booted = $derived(printed >= BOOT.length);

  /** After the password is accepted: the checks, then the app. */
  let signingIn = $state(false);
  let bootDone: (() => void) | undefined;

  /**
   * §9's motion obligation, and it is not decoration here: somebody who asked
   * for less motion gets the whole block at once and the prompt immediately,
   * rather than a shorter animation.
   */
  function reducedMotion(): boolean {
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /**
   * Print the block, one line at a time.
   *
   * A chain of timeouts rather than one interval, because the dwell depends on
   * the line: a line types at a fixed rate per character, so a long one has to
   * hold the next one back or the two overlap. `printDuration` is the same
   * function the CSS duration is computed from, for exactly that reason.
   */
  $effect(() => {
    if (signingIn) return;
    if (reducedMotion()) {
      printed = BOOT.length;
      return;
    }
    let at = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = (): void => {
      if (at >= BOOT.length) return;
      printed = at + 1;
      const line = BOOT[at] ?? { text: '' };
      at += 1;
      timer = setTimeout(step, dwell(line));
    };
    step();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  });

  /** §9.6: skippable. A boot nobody can skip is a boot that is in the way. */
  function skip(): void {
    if (!booted) printed = BOOT.length;
  }

  /**
   * Focus lands in the field the moment there is a field, and not before: a
   * password box focused under a block that is still printing is a box you
   * start typing into and then watch the machine talk over.
   */
  let field = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if (booted && !signingIn) field?.focus();
  });

  /** The console follows its own tail while the block goes past. */
  let box = $state<HTMLElement | null>(null);
  $effect(() => {
    void printed;
    void signingIn;
    if (box) box.scrollTop = box.scrollHeight;
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    failed = false;
    try {
      await loginMaster(password);
      password = '';
      lockedUntil = 0;
      await runChecks();
      await game.reload();
    } catch (error) {
      // Back to the prompt rather than stranded mid-boot: `game.reload()` is a
      // fetch and can fail after the password was accepted, and a screen frozen
      // half way through is one a master can only get out of by reloading.
      signingIn = false;
      failed = error instanceof Unauthorised;
      if (error instanceof Throttled) {
        now = Date.now();
        lockedUntil = now + error.retryAfterSeconds * 1000;
      } else if (!failed) console.error(error);
    } finally {
      busy = false;
    }
  }

  /**
   * The boot proper, on the far side of the password.
   *
   * `Boot` is the same component the app runs on any other load — §9.6 is "on
   * load", and a machine that boots only when challenged is not a machine. What
   * differs here is the cadence and the reason: after a password the boot *is*
   * the event, so it runs at full speed rather than getting out of the way.
   *
   * Awaited rather than fired and forgotten: `game.reload()` is what swaps this
   * component for the master's view, so anything still running here would be
   * torn off screen mid-line. The session already exists — the cookie was set by
   * `loginMaster` — so the second it costs is spent before the socket rather
   * than instead of it.
   */
  function runChecks(): Promise<void> {
    signingIn = true;
    return new Promise((resolve) => {
      bootDone = resolve;
    });
  }
</script>

<!--
  Click or key anywhere skips the printing. Not a button: the gesture is "get on
  with it", and a button labelled that would be one more thing on a screen whose
  whole point is that it looks like a machine talking to itself. The hint below
  says it in words, and it goes away with the thing it describes.
-->
<svelte:window onkeydown={skip} />

<main onclick={skip} role="presentation" bind:this={box}>
  <div class="console">
    <!--
      The banner in a box of its own, and it is the only way to centre the
      wordmark under the mark.

      The two blocks are set in **different faces** — the mark cannot be VT323
      (see `banner.ts`) — so a column is 0,40 em in one and about 0,60 em in the
      other, and the platform decides which 0,60. Centring by padding the
      wordmark with spaces would therefore be right on the machine it was
      counted on and wrong everywhere else. Layout has no such problem: the box
      shrinks to its widest row and each row centres inside it, in whatever
      units each row happens to be measured in.
    -->
    <!-- TRIAL: the notice, printed in order like every other row. It is not
         mounted above the console: it arrives when the machine reaches it. -->
    {#each BOOT.slice(0, Math.min(printed, NOTICE_ROWS)) as line}
      <p class="line logo notice">{line.text}</p>
    {/each}

    <div class="banner">
      {#each BOOT.slice(NOTICE_ROWS, Math.min(printed, NOTICE_ROWS + BANNER_ROWS)) as line}
        <p class="line logo" class:device={line.mark}>{line.text}</p>
      {/each}
    </div>

    {#each BOOT.slice(NOTICE_ROWS + BANNER_ROWS, printed) as line}
      <!-- `--cols` is the line's length in characters, which is exactly its
           width because the screen font is monospace: that is what lets the
           typing be a width animation instead of a character at a time. -->
      <p
        class="line"
        style="--cols: {line.text.length}; --ms: {printDuration(line.text)}ms"
      >{line.text}</p>
    {/each}

    {#if signingIn}
      <Boot tail={t.login.granted} onDone={() => bootDone?.()} />
    {:else if booted}
      <!--
        A terminal's prompt, not a form on a screen.

        No border, no box, no visible button: what a machine asks for is a caret
        at the end of a line, and the `ENTRAR` button that used to sit under it
        is what made this read as a web page. The button is still in the DOM and
        still reachable — it is what a screen reader announces and what tells
        anybody the field can be submitted at all — it simply has no pixels
        until something focuses it.
      -->
      <form onsubmit={submit}>
        <label>
          <span class="prompt">{t.login.prompt}</span>
          <!--
            **No `required`.** The browser's own validation bubble is a modern UI
            overlay with a white box and an arrow, popped over a monochrome tube
            — the same objection as the button above it, and worse, because it is
            a control §9 cannot style.

            Nothing is lost by dropping it: the server is the authority on an
            empty password, it answers the same `401` it answers a wrong one, and
            the screen already says so. What it costs is that an empty submit
            spends one of M2b's five attempts, which is a fair price for a screen
            that never stops looking like a terminal.
          -->
          <input
            bind:this={field}
            type="password"
            bind:value={password}
            autocomplete="current-password"
          />
        </label>
        <button type="submit" class="offscreen" disabled={busy || lockedFor > 0}>
          {t.login.submit}
        </button>
      </form>
      {#if lockedFor > 0}
        <p class="failed">{t.login.throttled} {formatDuration(lockedFor)}</p>
      {:else if failed}
        <p class="failed">{t.login.failed}</p>
      {/if}
      <p class="hint">{t.login.playerHint}</p>
    {:else}
      <p class="hint">{t.boot.skip}</p>
    {/if}
  </div>
</main>

<style>
  /**
   * The tube stopped scrolling, so every view owns its own overflow.
   *
   * `margin-top: auto` on the block rather than `align-content: end` on the
   * box: both bottom-align, and only one of them can be scrolled back through.
   * A grid or flex container that packs to the end clips its overflow at the
   * *start*, where there is no scrollbar to reach it — fine for twelve lines,
   * and it loses the top of the screen the moment twenty-one checks print under
   * them.
   */
  main {
    height: 100%;
    overflow: auto;
    padding: 1ch;
    display: flex;
    flex-direction: column;
  }

  .console {
    margin-top: auto;
    display: grid;
    gap: 0;
    justify-items: start;
    /* Wider than a form's 44ch: the credit line is 81 columns and the logotype
       43, and a machine that wrapped its own name would be a machine with a
       narrower screen than the one it is drawn on. Never wider than the tube,
       though — see the narrow-screen block at the end. */
    max-width: min(82ch, 100%);
  }

  /**
   * One printed line. `white-space: pre` because a line aligned with dots stops
   * being a column the moment it wraps.
   *
   * The typing is a width animation over a fixed character count, which is
   * exact on a monospace face and costs one compositor property per line — the
   * same reasoning the map's sweep is built on. `steps()` is what makes it read
   * as typing rather than as a wipe.
   */
  .line {
    margin: 0;
    white-space: pre;
    overflow: hidden;
    width: calc(var(--cols) * 1ch);
    /* `--ms` comes from `printDuration()`, the same function that schedules the
       next line. Written as a literal here it was a second copy of a timing
       constant, and the two drifting apart is a line that starts printing
       before the one above it has finished. */
    animation: type var(--ms) steps(24, end) both;
  }

  @keyframes type {
    from {
      width: 0;
    }
  }

  /**
   * The logotype's rows do not type: a banner is put on the screen, not
   * written. `width: auto` because there is no animation left to need a
   * measured one, and the top of the palette because it is the machine's name.
   */
  /**
   * The banner's box: one grid column, as wide as its widest row, with every
   * row centred in it. The widest row is the mark, so the wordmark centres
   * under the mark — which is the whole requirement, and it holds without this
   * file knowing how wide either block came out, which it cannot: the two are
   * set in different faces and one of them is the platform's.
   *
   * **A grid rather than `margin-inline: auto` on a `fit-content` child.** That
   * is the shorter spelling and it put the wordmark out to the right instead of
   * in the middle. `width: max-content` here and `justify-items: center` has no
   * such reading: the column is sized by its contents and the items are placed
   * in it, which is the same mechanism `.console` above already uses to hold
   * every other line against the left margin.
   */
  .banner {
    display: grid;
    justify-items: center;
    width: max-content;
  }

  .line.logo {
    width: auto;
    animation: none;
    color: var(--phosphor-bright);
  }

  /* TRIAL: the notice prints at the banner's cadence and at the body's
     brightness — it is the machine's own small print, not its name. */
  .line.notice {
    color: var(--phosphor);
  }

  /**
   * The device mark, and the only element in the app that leaves VT323.
   *
   * Not a preference. The shipped subset of that face has 224 glyphs and
   * `U+2588` is not among them, so every block would fall back on its own to a
   * face whose column is about 0,60 em against VT323's 0,40 — and a row's width
   * would then depend on how many blocks were in it. The drawing comes apart
   * rather than merely looking off, which is the same failure §9.7's four state
   * marks hit before they became CSS.
   *
   * `line-height` is pinned so the cell keeps the 1,92 ratio the art is drawn
   * for: a fallback face with its own idea of leading would turn the circle
   * into an egg without changing a single character.
   */
  .line.device {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace;
    line-height: var(--cell-y);
    /* A block glyph is solid, so the bloom has nothing to spread from and
       everything to smear: §9's shadow is for strokes of type. */
    text-shadow: none;
  }

  /* An empty line still has to take a line's height, or the blank rows between
     the logotype, the credit and the program collapse and the block reads as
     one paragraph. */
  .line:empty::before {
    content: ' ';
  }


  form {
    display: grid;
    gap: 0.5lh;
    margin-top: 1lh;
    justify-items: start;
  }

  label {
    display: flex;
    align-items: baseline;
    gap: 1ch;
  }

  /* The prompt reads as part of the line the field sits on, which is what makes
     the field look like something being typed into a terminal rather than a
     form control that happens to be on one. */
  .prompt {
    color: var(--phosphor-dim);
  }

  .prompt::after {
    content: ' >';
  }

  /**
   * The field, with nothing around it.
   *
   * A terminal shows a caret and nothing else, so the border, the background
   * and the focus ring all go — **and the caret is what replaces them**. It is
   * the focus indicator here, which is why it is set to the brightest value in
   * the palette rather than left to the browser: an unbordered field with an
   * invisible caret is a field nobody can tell they are typing into.
   */
  .console input {
    border: none;
    background: transparent;
    padding: 0;
    width: 20ch;
    caret-color: var(--phosphor-bright);
    color: var(--phosphor-bright);
  }

  .console input:focus,
  .console input:focus-visible {
    outline: none;
  }

  /**
   * The submit button, present and unpainted.
   *
   * Not `display: none` and not `hidden`: both take it out of the accessibility
   * tree, and then nothing announces that this field can be submitted at all.
   * Clipped instead — and it comes back the moment it is focused, so a keyboard
   * user who tabs past the field finds a control rather than a dead stop.
   *
   * Enter submits without it either way: a form whose only field is a single
   * text input submits implicitly, which is what a terminal does and the reason
   * the button was never the way in.
   */
  .offscreen {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .offscreen:focus-visible {
    position: static;
    width: auto;
    height: auto;
    margin: 0;
    overflow: visible;
    clip-path: none;
  }

  .hint {
    margin: 0.5lh 0 0;
    color: var(--phosphor-dim);
  }

  /* Inverse video rather than a colour (§9.4). A monochrome terminal alarmed
     this way and it reads louder than red — which also keeps the alarm colour
     free for the one thing that is not game content, R-43's boundary. */
  .failed {
    margin: 0.5lh 0 0;
    background: var(--phosphor);
    color: var(--screen);
    padding: 0 0.6ch;
    text-shadow: none;
  }

  /* §9's motion obligation, both halves: the lines are all on screen at once
     and none of them animates. */
  @media (prefers-reduced-motion: reduce) {
    .line {
      animation: none;
      width: auto;
    }
  }

  /**
   * On a phone the block does not fit, and the typing is what makes that a
   * scroll rather than a wrap.
   *
   * `--screen-size` is 1,25rem, so a column is about 10 px and a 390 px phone
   * holds thirty-seven of them. The credit is 81 columns and the program 53 —
   * both more than twice the screen — and `width: calc(var(--cols) * 1ch)` is
   * what forces the box to that width whatever is around it. Wrapping cannot
   * happen inside a box that was given a width in the units of the thing it is
   * meant to wrap.
   *
   * So the prose stops being typed and starts wrapping. **Nothing is lost:**
   * the lines already arrive one at a time from the scheduler, which is the
   * cadence — the width animation was the flourish on top, and a flourish that
   * costs a phone its horizontal axis is not one.
   *
   * The logotype keeps `pre` because it is a grid, and shrinks instead. 43
   * columns at 0,75rem is about 260 px, which fits a 320 px phone with room to
   * spare — a smaller banner is still the banner, and a wrapped one is not a
   * banner at all.
   */
  @media (max-width: 600px) {
    .line {
      width: auto;
      max-width: 100%;
      animation: none;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .line.logo {
      font-size: 0.75rem;
      white-space: pre;
    }
  }
</style>
