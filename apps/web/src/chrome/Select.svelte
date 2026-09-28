<script lang="ts">
  import { t } from '../i18n.ts';

  /**
   * A dropdown that stays inside the tube.
   *
   * ## Why this is not a `<select>`
   *
   * It was one, and the list was the last thing in the app still drawn by the
   * operating system. `appearance: base-select` fixed the colours — the popup
   * becomes a real element with real children — but not the geometry, and the
   * geometry is the part §9 cares about: **a popover lives in the top layer, so
   * no ancestor can clip it.** Not the panel, not the screen, not the case. When
   * the list did not fit below its control it flipped up and painted over the
   * bezel, which is the one surface in this interface that is not a screen.
   * There is no CSS for that. `overflow`, `contain`, a stacking context — none
   * of them reach the top layer, by design.
   *
   * So the list is an ordinary absolutely-positioned element inside the panel
   * that owns the control. It is clipped by that panel and it scrolls with it,
   * which is what a list inside a machine does.
   *
   * ## What it gives up, and what it must not
   *
   * A native select brings keyboard handling, an accessible role, and a mobile
   * picker, and all three have to be paid for here. The roles are `combobox`
   * plus `listbox`, focus stays on the control with `aria-activedescendant`
   * pointing at the active row — which is the pattern that does not have to
   * move focus into the list and back out again — and the keys a select answers
   * are answered here: arrows, Home, End, Enter, Space, Escape, Tab.
   *
   * The mobile picker is the real loss. A full-screen wheel is easier to hit
   * one-handed than a list in a rail. Every one of these is a master control
   * used during setup, and the rows are `--touch` tall like everything else, so
   * it is a trade rather than a regression — but it is a trade.
   */
  let {
    value = $bindable(''),
    options,
    disabled = false,
    onchange,
  }: {
    value?: string;
    options: Array<{ value: string; label: string }>;
    disabled?: boolean;
    onchange?: (value: string) => void;
  } = $props();

  const uid = $props.id();

  let open = $state(false);
  /** Which row the keyboard is on. Not the selection — nothing is chosen until it is. */
  let active = $state(0);
  let root = $state<HTMLDivElement>();
  let control = $state<HTMLButtonElement>();
  let list = $state<HTMLUListElement>();

  const current = $derived(options.find((option) => option.value === value));
  const selectedIndex = $derived(options.findIndex((option) => option.value === value));

  function show(): void {
    if (disabled || options.length === 0) return;
    // Opening starts on the current row rather than the first: a list of twenty
    // players opened with the keyboard should not walk from the top every time.
    active = selectedIndex >= 0 ? selectedIndex : 0;
    open = true;
  }

  /**
   * @param restore whether focus goes back to the control. False when the browser
   *                is already moving it — a Tab, or a press somewhere else —
   *                where taking it back would fight the user for the caret.
   */
  function hide(restore = true): void {
    if (!open) return;
    open = false;
    if (restore) control?.focus();
  }

  function commit(next: string): void {
    value = next;
    onchange?.(next);
    hide();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        show();
      }
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        hide();
        break;
      case 'ArrowDown':
        event.preventDefault();
        active = Math.min(active + 1, options.length - 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        active = Math.max(active - 1, 0);
        break;
      case 'Home':
        event.preventDefault();
        active = 0;
        break;
      case 'End':
        event.preventDefault();
        active = options.length - 1;
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const option = options[active];
        if (option) commit(option.value);
        break;
      }
      case 'Tab':
        // Not prevented: Tab is meant to leave, and the list must not survive it.
        hide(false);
        break;
    }
  }

  /**
   * A press anywhere else closes it. On the capture phase, or a press on a
   * control inside another panel would open that one on the way down and be
   * closed again by this on the way back up.
   */
  $effect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      if (!root?.contains(event.target as Node)) hide(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });

  /** The active row has to be on screen to be the active row. */
  $effect(() => {
    if (!open) return;
    const row = list?.children[active];
    row?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div class="select" bind:this={root}>
  <button
    type="button"
    class="control"
    {disabled}
    role="combobox"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={`${uid}-list`}
    aria-activedescendant={open ? `${uid}-${active}` : undefined}
    onclick={() => (open ? hide() : show())}
    onkeydown={onKeydown}
    bind:this={control}
  >
    <span class="value">{current?.label ?? ''}</span>
    <!-- Drawn from borders rather than set as `▼`: the screen face is a bitmap
         revival and a missing glyph is a tofu box, which is a worse caret than
         no caret. Borders follow `currentColor`, so it dims with the control. -->
    <span class="caret" aria-hidden="true"></span>
  </button>

  {#if open}
    <ul class="list" id={`${uid}-list`} role="listbox" bind:this={list}>
      {#each options as option, index (option.value)}
        <!-- The keyboard is on the control, not on the row. That is the
             `aria-activedescendant` pattern: focus never enters the list, so a
             row cannot carry a key handler and does not need one. A `<button>`
             per row would be the alternative and would break the pattern — it
             would put twenty tab stops inside one field. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={`${uid}-${index}`}
          role="option"
          aria-selected={option.value === value}
          class:active={index === active}
          onclick={() => commit(option.value)}
          onpointerenter={() => (active = index)}
        >
          <!-- Which row is current, said by the mark and not by colour: the
               active row is already inverse video, and a second reading in
               brightness disappears under high contrast, where `--phosphor` is
               defined as `--phosphor-bright`. -->
          <span class="tick" aria-hidden="true">{option.value === value ? t.select.mark : ''}</span>
          <span>{option.label}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .select {
    position: relative;
    display: block;
    width: 100%;
  }

  /* The closed control wears the same box as an `<input>`, because that is what
     it is until it is pressed. */
  .control {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8ch;
    width: 100%;
    text-transform: none;
    letter-spacing: normal;
    text-align: left;
  }

  /* The button inverts on hover like every other button in the app, and that is
     wrong here: this one holds a value rather than performing an action, and a
     field that flashes when the pointer crosses it reads as a control that did
     something. */
  .control:hover:not(:disabled) {
    background: transparent;
    color: var(--phosphor);
  }

  .control[aria-expanded='true'],
  .control:focus-visible {
    border-color: var(--phosphor);
  }

  .value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caret {
    flex: none;
    width: 0;
    height: 0;
    border-left: 0.35ch solid transparent;
    border-right: 0.35ch solid transparent;
    border-top: 0.5ch solid currentColor;
  }

  /**
   * The list. Absolute inside `.select`, which is the whole point — it is part
   * of the panel, so the panel clips it and the panel scrolls it.
   *
   * Opaque rather than `--overlay`: this sits over the form it belongs to, not
   * over the map, and a field showing through the list it opened is the one
   * place transparency costs a reading rather than buying context.
   */
  .list {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 4;
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 11lh;
    overflow-y: auto;
    background: var(--screen);
    border: 1px solid var(--phosphor-dim);
  }

  .list li {
    display: flex;
    align-items: center;
    gap: 0.8ch;
    padding: 0 0.6ch;
    min-height: var(--touch);
    cursor: var(--cursor-hand), pointer;
  }

  /* Inverse video, not a colour change (§9.4). */
  .list li.active {
    background: var(--phosphor);
    color: var(--screen);
    text-shadow: none;
  }

  /* Reserved whether or not there is a mark in it, so the labels line up. */
  /* `.tick` and not `.mark`: `styles/terminal.css` owns that class globally for
     §9.7's state shapes, and a global rule reaches an element whatever a scoped
     one says — the check was getting a 1,4 rem box and a pseudo-element circle
     it has no use for. */
  .tick {
    flex: none;
    width: 1.2ch;
  }
</style>
