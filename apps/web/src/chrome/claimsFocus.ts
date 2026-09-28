/**
 * A surface that has just appeared takes focus, and gives it back when it goes.
 *
 * The panels already did this by hand and it is the difference between a
 * keyboard interface and a keyboard-shaped one: open a card without moving
 * focus and `Tab` carries on from the button behind it, so the first control
 * inside the thing you just opened is a dozen presses away. Close it without
 * putting focus back and the next `Tab` starts from the top of the document.
 *
 * An action rather than a component, for the same reason `draggable` is one:
 * what needs the behaviour is somebody else's markup — a card that already
 * exists, already has a head, and is already positioned. Wrapping it would put
 * a box between it and the `position: absolute` it depends on.
 *
 * ## Why the restore is conditional
 *
 * Focus goes back **only if it was still inside when the surface closed**.
 * Restoring unconditionally is the bug this shape exists to avoid: a master
 * opens a card with the keyboard, clicks a button on the bar, the card closes
 * as a result — and focus jumps backwards to where it was two actions ago,
 * away from the control they are using. `focusout` carries where focus is
 * going, which is the only reliable moment to ask: by the time the action is
 * destroyed the node may already be detached, and `contains()` then answers no
 * for a card that did have focus.
 */

export function claimsFocus(node: HTMLElement): { destroy(): void } {
  const active = document.activeElement;
  const returnTo = active instanceof HTMLElement ? active : null;

  // Not reachable by `Tab`, reachable by script, which is exactly what a
  // container that has just appeared needs — the controls inside it keep their
  // own place in the order.
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  node.focus();

  let held = true;
  const onIn = (): void => {
    held = true;
  };
  const onOut = (event: FocusEvent): void => {
    const to = event.relatedTarget;
    held = to instanceof Node && node.contains(to);
  };
  node.addEventListener('focusin', onIn);
  node.addEventListener('focusout', onOut);

  return {
    destroy() {
      node.removeEventListener('focusin', onIn);
      node.removeEventListener('focusout', onOut);
      // `isConnected`, because what focus came from may itself have gone: a
      // roster row that opened a card is removed when §4 stops projecting that
      // player, and focusing a detached element silently moves focus to the
      // body instead.
      if (held && returnTo?.isConnected) returnTo.focus();
    },
  };
}
