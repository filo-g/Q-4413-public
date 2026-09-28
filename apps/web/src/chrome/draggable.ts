/**
 * Drag a floating window by its title bar.
 *
 * A Svelte action rather than a component, because what is being made draggable
 * is somebody else's markup: the card already exists, already has a head, and
 * wrapping it in a container would put a box between it and the `position:
 * absolute` it depends on.
 *
 * ## Why it takes over `left`/`top` on the first drag
 *
 * The windows are placed with whichever pair of edges makes sense for them —
 * the card sits `right`/`bottom` so it grows upward out of its corner. That is the right resting
 * position and the wrong thing to animate: dragging against `bottom` inverts
 * the pointer. So the first drag reads the element's measured position, pins it
 * as `left`/`top`, and clears the other two. After that the window is where it
 * was put.
 *
 * ## Pointer events, not mouse events
 *
 * The master may well be on a phone mid-game, and `setPointerCapture` is what
 * makes a drag survive the pointer leaving the handle — without it, moving
 * faster than the browser repaints drops the window. `touch-action: none` on
 * the handle is the other half: without it the browser claims the gesture as a
 * scroll before the first `pointermove` arrives.
 */

export interface DraggableOptions {
  /** Kept inside this element. Defaults to the offset parent. */
  within?: HTMLElement | null;
}

export function draggable(handle: HTMLElement, options: DraggableOptions = {}) {
  let panel = handle.parentElement;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;
  let dragging = false;

  function boundsOf(): { width: number; height: number } {
    const within = options.within ?? (panel?.offsetParent as HTMLElement | null);
    if (within) return { width: within.clientWidth, height: within.clientHeight };
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function onPointerDown(event: PointerEvent): void {
    panel = handle.parentElement;
    if (!panel) return;
    // A button in the title bar is a control, not a grip. Without this the close
    // button becomes undismissable on touch: the press starts a drag and the
    // click never lands.
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;

    const box = panel.getBoundingClientRect();
    const parent = (panel.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    originLeft = box.left - (parent?.left ?? 0);
    originTop = box.top - (parent?.top ?? 0);
    startX = event.clientX;
    startY = event.clientY;
    dragging = true;

    panel.style.left = `${originLeft}px`;
    panel.style.top = `${originTop}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';

    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging || !panel) return;
    const limits = boundsOf();
    // Clamped so a window cannot be thrown off the screen. The title bar is the
    // only way back, so losing it loses the window.
    const maxLeft = Math.max(0, limits.width - panel.offsetWidth);
    const maxTop = Math.max(0, limits.height - panel.offsetHeight);
    const left = Math.min(Math.max(originLeft + event.clientX - startX, 0), maxLeft);
    const top = Math.min(Math.max(originTop + event.clientY - startY, 0), maxTop);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }

  handle.style.touchAction = 'none';
  // The token with a keyword behind it, like every other cursor in the app:
  // an SVG cursor that a browser declines to load is no cursor at all.
  handle.style.cursor = 'var(--cursor-move), move';
  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);

  return {
    destroy(): void {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
