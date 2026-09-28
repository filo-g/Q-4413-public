<script lang="ts">
  import { onMount } from 'svelte';

  import { FAST_CHECK_MS } from './chrome/banner.ts';
  import Boot from './chrome/Boot.svelte';
  import Terminal from './chrome/Terminal.svelte';
  import { game } from './game.svelte.ts';
  import { t } from './i18n.ts';
  import Login from './views/Login.svelte';
  import MasterView from './views/master/MasterView.svelte';
  import PlayerView from './views/player/PlayerView.svelte';

  /**
   * Which view you get is decided by the projection, not by a route: a payload
   * with a `viewMode` came from a master recipient, one with a `self` from a
   * player. There is nothing to guess and nothing to spoof — the server already
   * decided when it signed the cookie.
   */
  onMount(() => {
    game.start();
    return () => game.stop();
  });

  const payload = $derived(game.payload);

  /**
   * §9.6 is **on load**, not on login.
   *
   * A player redeems an invite link and never sees a password; a master who
   * reloads has a cookie and does not either. A machine that boots only when
   * challenged is not a machine, so the checks run here for both — at about
   * half the login's cadence, because this one is in front of a map somebody
   * opened to look at rather than being the event itself.
   *
   * It costs what it costs, but not all of it is new: `#hydrate()` sets `auth`
   * the moment the state fetch resolves and opens the socket immediately after,
   * so the boot runs across the socket handshake. The map that appears when it
   * finishes is one whose live feed is already connected, rather than one that
   * renders and then waits.
   */
  let booting = $state(true);

  /**
   * The login runs its own, and this must not run a second one on top of it.
   *
   * `auth` goes `unknown` → `anonymous` → `session` for somebody who typed a
   * password, and `unknown` → `session` for everybody else. Having *been*
   * anonymous is therefore exactly the signal, and it is the only one available
   * here: by the time the view swaps, the two paths are indistinguishable from
   * the payload.
   */
  let cameFromLogin = $state(false);
  $effect(() => {
    if (game.auth === 'anonymous') cameFromLogin = true;
  });

  const bootFirst = $derived(booting && !cameFromLogin && game.auth === 'session');

  /**
   * A payload with a `viewMode` came from a master recipient — the same test the
   * view swap below makes, named once because the case wants it twice: §9's
   * refresh sweep and R-67's screensaver are both master-only, for two different
   * reasons that are argued where each of them is declared.
   */
  const isMaster = $derived(payload?.viewMode !== undefined);
</script>

<!-- Every screen is inside the tube, login included: §9 asks for a physical
     terminal, and a machine whose case appears once you have logged in is a web
     page with a skin on it. -->
<Terminal sweep={isMaster} master={isMaster}>
  {#if game.auth === 'anonymous'}
    <Login />
  {:else if bootFirst}
    <main class="console">
      <Boot ms={FAST_CHECK_MS} onDone={() => (booting = false)} />
    </main>
  {:else if payload?.viewMode}
    <MasterView />
  {:else if payload?.self}
    <PlayerView />
  {:else}
    <main><p>{t.boot.status}</p></main>
  {/if}
</Terminal>

<style>
  /* The boot/no-link screen. The tube does not scroll, so a one-line message
     centres in it rather than sitting in the top corner of a black rectangle. */
  main {
    height: 100%;
    display: grid;
    place-content: center;
    padding: 1ch;
  }

  /**
   * The boot is not a message, it is a machine printing — so it sits on the
   * floor of the screen and fills upward, the same as the login's console and
   * for the same reason: that is where a terminal's newest line is.
   *
   * `margin-top: auto` on the block rather than `place-content: end` on the
   * box, because a container that packs to the end clips its overflow at the
   * *start*, where there is no scrollbar to reach it.
   */
  main.console {
    display: flex;
    flex-direction: column;
    place-content: stretch;
    overflow: auto;
  }

  main.console :global(.checks) {
    margin-top: auto;
  }
</style>
