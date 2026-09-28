import { describe, expect, it } from 'vitest';

import {
  isTypingTarget,
  keyLabel,
  matchBinding,
  type Binding,
  type KeyStroke,
} from '../apps/web/src/keys.ts';

/**
 * Single-key bindings, htop-style (M9). Everything here is about the two ways
 * they go wrong: swallowing a keystroke that was not for them, and offering one
 * that §4 says must not exist.
 */

/** A keystroke without a DOM, which is all `matchBinding` asks for. */
function press(key: string, over: Partial<KeyStroke> = {}): KeyStroke {
  return { key, ctrlKey: false, altKey: false, metaKey: false, target: null, ...over };
}

function ran(bindings: Binding[], event: KeyStroke): string | undefined {
  let hit: string | undefined;
  const wired = bindings.map((binding) => ({ ...binding, run: () => (hit = binding.key) }));
  matchBinding(event, wired)?.run();
  return hit;
}

const BAR: Binding[] = [
  { key: '1', run: () => {} },
  { key: 'm', run: () => {} },
  { key: 'Escape', run: () => {} },
];

describe('matchBinding', () => {
  it('runs the binding whose key was pressed', () => {
    expect(ran(BAR, press('1'))).toBe('1');
    expect(ran(BAR, press('m'))).toBe('m');
  });

  /** Caps lock is on at three in the morning, and the binding still has to fire. */
  it('matches a letter whatever the case', () => {
    expect(ran(BAR, press('M'))).toBe('m');
  });

  it('ignores a key nothing is bound to', () => {
    expect(ran(BAR, press('z'))).toBeUndefined();
  });

  /**
   * The failure mode of every single-key binding ever shipped: `1` opens a
   * panel while somebody is typing a marker's latitude into a field.
   */
  it('keeps out of a field somebody is typing in', () => {
    const input = { tagName: 'INPUT', isContentEditable: false };
    expect(ran(BAR, press('1', { target: input }))).toBeUndefined();
  });

  /**
   * Except Escape. Leaving a field and leaving the thing the field is in are
   * one gesture to anybody who has used a terminal, and trapping somebody
   * inside a form is the opposite of usable.
   */
  it('lets Escape through from inside a field', () => {
    const input = { tagName: 'INPUT', isContentEditable: false };
    expect(ran(BAR, press('Escape', { target: input }))).toBe('Escape');
  });

  /**
   * Ctrl, Alt and Meta belong to the browser and the operating system — copy,
   * switch tab, open devtools. A page that swallows them has taken the machine
   * hostage. Shift is not one of them: a shifted letter is still that letter.
   */
  it('leaves the browser its own combinations alone', () => {
    expect(ran(BAR, press('1', { ctrlKey: true }))).toBeUndefined();
    expect(ran(BAR, press('1', { metaKey: true }))).toBeUndefined();
    expect(ran(BAR, press('1', { altKey: true }))).toBeUndefined();
    // Shift is not one of them: a shifted letter is still that letter, and a
              // `KeyStroke` has no field for it precisely because nothing reads one.
    expect(ran(BAR, press('1'))).toBe('1');
  });

  /**
   * §4's rule reaching the keyboard. R-57's replay is `AUTHORITATIVE`-only and
   * its *presence* is the leak, exactly like R-32's revive button: a key that
   * did something in `OPERATIONAL` would announce that there is something being
   * withheld.
   */
  it('does not run a binding that is switched off', () => {
    const gated: Binding[] = [{ key: '5', when: false, run: () => {} }];
    expect(ran(gated, press('5'))).toBeUndefined();
    expect(ran([{ key: '5', when: true, run: () => {} }], press('5'))).toBe('5');
  });
});

describe('isTypingTarget', () => {
  it('is false for nothing at all', () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  /**
   * The case no tag name covers — and the reason the check is structural rather
   * than `instanceof HTMLElement`, which is per realm and fails for an element
   * that came from an iframe.
   */
  it('catches a contenteditable element', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });
});

describe('keyLabel', () => {
  it('prints Escape by its name and everything else upper case', () => {
    expect(keyLabel('Escape')).toBe('ESC');
    expect(keyLabel('m')).toBe('M');
    expect(keyLabel('1')).toBe('1');
  });
});
