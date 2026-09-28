/**
 * The clock every scrambled field reads, and there is one of it.
 *
 * A player's roster can hold a dozen unknown readings at once — a distance and
 * a zone for everybody §4 withheld — and a timer each is a dozen timers on a
 * phone that has to last a four-hour game. One tick, ref-counted, running only
 * while something is actually mounted and reading it.
 *
 * Deliberately not `Date.now()` in the component: a counter is all a scramble
 * needs, and a counter is the thing that can be depended on without every
 * reader re-deriving a clock.
 */

/** Fast enough to read as noise, slow enough not to be a strobe. */
const TICK_MS = 110;

class Scrambler {
  #tick = $state(0);
  #readers = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  get tick(): number {
    return this.#tick;
  }

  /**
   * Call from an `$effect` and return the result, so the tick stops with the
   * last field that was using it.
   */
  join(): () => void {
    this.#readers += 1;
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => {
        this.#tick += 1;
      }, TICK_MS);
    }
    return () => {
      this.#readers = Math.max(0, this.#readers - 1);
      if (this.#readers === 0 && this.#timer !== undefined) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
    };
  }
}

export const scrambler = new Scrambler();

/**
 * The characters a withheld reading is made of.
 *
 * Printable ASCII, for the reason `banner.ts` gives at length: the app ships
 * VT323 and a character it does not have is a tofu box on somebody's handset.
 *
 * **No digits, and no letters.** That is the whole of the honesty here: a
 * scramble that rolled `4` and `7` would be a number that changes every tenth
 * of a second, and somebody would eventually read one. These cannot be
 * mistaken for a distance, and they cannot be mistaken for a callsign either.
 */
const GLYPHS = '#$%&*+/<=>?@\\^_|~';

/**
 * `length` characters of noise, different on every tick.
 *
 * `seed` keeps two fields on one row from rolling the same string, which would
 * read as a pattern and therefore as data.
 */
export function scrambled(length: number, tick: number, seed: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // A cheap integer hash of the three inputs. Nothing here needs to be
    // unpredictable — it needs to look unpredictable and cost nothing.
    const h = Math.imul(tick + i * 2654435761 + seed * 40503, 2246822519) >>> 8;
    out += GLYPHS[h % GLYPHS.length];
  }
  return out;
}
