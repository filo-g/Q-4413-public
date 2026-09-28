/**
 * Key bindings, on htop's terms.
 *
 * The bar already reads like a function-key strip — a row of named actions,
 * always visible, one press each — so it is given the keys to match and the
 * keys are printed on it. That is the whole design: **a binding nobody can see
 * is a binding nobody uses**, and htop and btop both solve it the same way, by
 * putting the key next to the name rather than in a help screen.
 *
 * Digits and letters rather than function keys. `F1` opens the browser's help,
 * `F5` reloads, `F11` goes fullscreen — a terminal emulator owns its keyboard
 * and a web page does not, so the app takes the ones the browser has no claim
 * on. `Escape` is the exception and the most important one: it is the key every
 * program in this idiom answers, and the only way out that does not require
 * finding a specific button first.
 */

/**
 * The part of a key event this needs, and nothing else.
 *
 * A real `KeyboardEvent` satisfies it structurally, so a component hands one
 * over unchanged. Written out rather than imported because the root suite has
 * no DOM library — the same reason `heading.ts` and `perimeter.ts` are plain
 * arithmetic — and because naming the four fields it reads is a smaller claim
 * than naming the whole event.
 */
export interface KeyStroke {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Whatever the browser says the keystroke landed on. */
  target: unknown;
}

export interface Binding {
  /**
   * `event.key` to match, compared case-insensitively — so a binding fires with
   * caps lock on, which is how somebody types at three in the morning.
   */
  key: string;
  /** What it does. */
  run: () => void;
  /**
   * Off while false, and the key is not printed either. A binding that is on
   * screen and does nothing is worse than one that is absent: R-57's replay
   * control is `AUTHORITATIVE`-only, and a key for it in `OPERATIONAL` would
   * announce that there is something being withheld.
   */
  when?: boolean;
}

/**
 * Whether a keystroke belongs to whoever is typing.
 *
 * Without this, `1` opens a panel while the master is entering a marker's
 * latitude — which is the failure mode of every single-key binding ever
 * shipped. `isContentEditable` covers the case no tag name does.
 */
export function isTypingTarget(target: unknown): boolean {
  // Structural, not `instanceof HTMLElement`, and that is a correctness point
  // before it is a testing one: `instanceof` is per realm, so an element from
  // an iframe fails it and the guard silently stops guarding. It also lets this
  // decision be tested without a DOM, which the root suite does not have.
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!element || typeof element !== 'object') return false;
  if (element.isContentEditable === true) return true;
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Whether a keystroke is the browser's or the operating system's.
 *
 * `Ctrl`, `Alt` and `Meta` combinations belong to them — copy, paste, switch
 * tab, open devtools — and a page that swallows them is a page that has taken
 * the machine hostage. `Shift` is deliberately not in the list, because a
 * shifted letter is still that letter.
 */
function isReserved(event: KeyStroke): boolean {
  return event.ctrlKey || event.altKey || event.metaKey;
}

/**
 * Run the first binding that matches, and say whether one did.
 *
 * Pure, so the decision can be tested without a DOM: the component's job is to
 * hand it an event and the bindings in force at that moment.
 */
export function matchBinding(
  event: KeyStroke,
  bindings: readonly Binding[],
): Binding | undefined {
  if (isReserved(event)) return undefined;
  if (isTypingTarget(event.target)) {
    // Escape still gets through while typing. Leaving a field, and leaving the
    // thing the field is in, are the same gesture to everybody who has used a
    // terminal, and trapping somebody inside a form is the opposite of usable.
    if (event.key !== 'Escape') return undefined;
  }
  const key = event.key.toLowerCase();
  return bindings.find((binding) => binding.when !== false && binding.key.toLowerCase() === key);
}

/**
 * How a key is printed beside its name.
 *
 * Short and upper case, because it sits in a strip of case lettering next to
 * the label — the same relationship the bezel's plates have to the tube.
 */
export function keyLabel(key: string): string {
  if (key === 'Escape') return 'ESC';
  return key.toUpperCase();
}
