/**
 * The path the device mark takes across an idle master's tube (R-67), and the
 * timings that decide when it gets there.
 *
 * ## Why this is arithmetic in a file of its own
 *
 * Because of the corner. A DVD logo bouncing in a box is folklore for exactly
 * one reason — the wait for it to land square in a corner — and a velocity pair
 * picked by eye is overwhelmingly likely to never land on one at all. That is
 * not a thing you can see in review and not a thing you can see in a minute of
 * watching: it is an arithmetic property of the trajectory, so it is computed
 * here and asserted in `tests/screensaver.test.ts`.
 *
 * ## The trajectory is a function of the clock, not an integration
 *
 * The obvious spelling is a position and a velocity stepped once per frame,
 * flipping a sign at each wall. It drifts: a frame is not a fixed length, the
 * flip happens a fraction of a pixel past the wall, and after twenty minutes of
 * an idle panel the path is no longer the path that was designed — which is
 * precisely long enough for the corner to stop arriving.
 *
 * So there is no state. The mark's position is a pure function of elapsed time:
 * a triangle wave per axis, one whose period is chosen so that the two axes
 * come back into phase. Rewinding, dropped frames and a tab that was hidden for
 * an hour all land exactly where the arithmetic says they should.
 *
 * ## How the corner is guaranteed
 *
 * With `x` a triangle wave of period `2·xMs` and `y` one of period `2·yMs`, the
 * mark is at a corner whenever the clock is a whole number of half-periods on
 * **both** axes at once — that is, at every common multiple of `xMs` and `yMs`.
 * A pair of crossing times taken straight from the tube's aspect has no small
 * common multiple, so the ratio is snapped to a fraction `a/b`. The corner then
 * arrives every `a` vertical crossings, which is also every `b` horizontal ones.
 *
 * ## And why a *good* fraction is the large one, not the accurate one
 *
 * This is the part the first version had backwards, and a screen found it in
 * about four seconds. Snapping to the **nearest** fraction means the smallest
 * terms — `1/1` on a near-square tube, `2/1` on a laptop — and small terms are
 * a disaster twice over.
 *
 * `a/b = 1/1` is the pure diagonal: the mark leaves one corner, crosses to the
 * opposite one, comes back, and does that until somebody touches the keyboard.
 * It is not a bounce, it is a metronome. `2/1` is barely better — a closed
 * triangle that visits a corner every couple of crossings, which turns the one
 * event the whole thing exists for into the thing it does constantly.
 *
 * What makes it read right is `a` and `b` **coprime and both large**: the path
 * then fills the box, and the corner is rare because it takes `a` crossings for
 * the two axes to come back into phase. So the search below keeps every
 * fraction within a tolerance of the true aspect and picks the **densest** of
 * them rather than the closest — subject to the corner landing in a window
 * somebody will still be sitting there for.
 *
 * The horizontal speed pays for it, by up to `RATIO_TOLERANCE`. Nobody can see
 * ten per cent on a bounce nobody is timing; everybody can see a logo ricochet
 * corner to corner like a screen test.
 */

/**
 * How long the master's screen has to be untouched.
 *
 * **One minute, and it was three until somebody sat in front of it.** The
 * parked note said two to five, reasoning that anything shorter would catch a
 * master mid-thought with their hands off the keyboard while they read the map
 * — the one thing this must not do, because at that moment the screen is the
 * thing being used.
 *
 * That argument survives the measurement and turns out to cost almost nothing.
 * Any input dismisses this, including the pointer moving, so being caught
 * reading costs one movement and no click; and against that, three minutes of
 * an untouched panel is three minutes of a still map at full brightness, which
 * is exactly the burn the thing exists to prevent. At a minute it is a screen
 * that rests when you stop using it, which is what a screensaver is.
 *
 * It is also gated on a switch. A master who does not want it turns VIGILIA on
 * and the screen never rests at all.
 */
export const IDLE_MS = 1 * 60 * 1000;

/**
 * How often an input is allowed to reset the timer.
 *
 * A `pointermove` arrives at the refresh rate, and clearing and re-arming a
 * timeout sixty times a second to express "somebody moved the mouse" is the
 * tick this was explicitly not supposed to become. A timestamp costs a
 * comparison; the timer is only touched when the last touch was a second ago.
 *
 * It buys the idle delay up to one extra second of slack, which nothing
 * measures.
 */
export const REARM_MS = 1000;

/**
 * How fast the mark crosses the glass, in CSS pixels per second.
 *
 * Constant pixels per second rather than a fraction of the screen, which is what
 * the thing being imitated did: the same mark crosses a big screen slowly and a
 * small one quickly, and that is the joke's own pacing.
 */
export const SPEED_PX_PER_S = 72;

/**
 * The largest either term of the snapped ratio may be.
 *
 * A ceiling on density rather than a target: the search wants terms as large as
 * it can get within the tolerance, because that is what fills the box and makes
 * the corner rare. Raising it buys a denser path and a longer wait; the wait is
 * separately bounded, so the honest way to read this number is "how much of the
 * box the path is allowed to cover".
 *
 * **Sixteen rather than twelve, and it was twelve for one commit.** At twelve
 * an extreme aspect has no fraction that is both close enough and dense enough
 * — a 1920 x 420 tube offers `7/1` and nothing else within a tenth — so the
 * search fell through to its last resort and produced exactly the sparse figure
 * the floor exists to prevent. Measured across twelve tube shapes from a 360 px
 * phone to a 5K, sixteen leaves every one of them at or above the floor.
 */
export const MAX_CROSSINGS = 16;

/**
 * How far the snapped ratio may sit from the tube's true aspect, as a fraction.
 *
 * This is what the density is bought with. Ten per cent means the mark crosses
 * horizontally up to a tenth faster or slower than the nominal speed, which on
 * a bounce nobody is timing is invisible — and it is what lets the search reach
 * a fraction like `15/8` instead of being stuck on `2/1`.
 */
export const RATIO_TOLERANCE = 0.1;

/**
 * The smallest path the search is allowed to settle for, as cells of the `a x b`
 * grid one period traces.
 *
 * **A hard floor, and the only one here.** `1/1` is the diagonal and `2/1` is a
 * chevron — two closed figures that touch a corner every crossing or two and
 * cover a fraction of the glass. Both are what a nearest-fraction search
 * produces on a normal screen, and both read as broken rather than as a bounce.
 * Twelve cells is the smallest grid that still looks like something wandering.
 *
 * It outranks the corner's deadline below, which is the one preference here
 * with a real cost: on a screen big enough that no dense fraction fits the
 * deadline, the corner takes longer than it should rather than the path
 * collapsing. A payoff that did not arrive this session is a disappointment; a
 * logo ricocheting along one diagonal is a bug report.
 */
export const MIN_CELLS = 12;

/**
 * The earliest the corner may arrive, and **the lower bound is the whole joke.**
 *
 * A corner every fifteen seconds is not folklore, it is a screen test. The
 * thing is legendary precisely because it almost never happens, so a path that
 * delivers it constantly reads as broken even while it is doing exactly what it
 * was asked to.
 */
export const CORNER_MIN_MS = 40 * 1000;

/**
 * And the latest, which is not a count of crossings.
 *
 * The mark moves at a fixed number of pixels per second, so a crossing grows
 * with the screen and `MAX_CROSSINGS` of them grows with it twice over. At the
 * ceiling alone that is 4:13 on a 2560 x 1330 desktop, 7:18 on a 4K and 9:58 on
 * a 5K — none of it visible from the constant, and all of it longer than
 * anybody sits in front of a resting screen.
 *
 * It is a deadline rather than a rule: `MIN_CELLS` outranks it, so a screen
 * with no dense fraction inside the deadline overruns it instead of collapsing.
 * A 5K takes 3:09 for that reason.
 */
export const CORNER_MAX_MS = 150 * 1000;

/** Nothing may cross the glass faster than this, however small the box is. */
const MIN_CROSSING_MS = 2000;

export interface Box {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Path {
  /** The positions the mark's top-left corner may take: the tube minus the mark. */
  travel: Box;
  /** Milliseconds to cross `travel.width`. */
  xMs: number;
  /** Milliseconds to cross `travel.height`. */
  yMs: number;
  /** Milliseconds between one corner and the next. A whole multiple of both. */
  cornerMs: number;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

interface Candidate {
  a: number;
  b: number;
  /** How far `a/b` is from the tube's aspect, relative. */
  error: number;
  /** Cells of the grid one period traces: how much of the box the path covers. */
  cells: number;
  /** How long the corner takes, in milliseconds. */
  cornerMs: number;
}

/**
 * The fraction the path is built from.
 *
 * Only coprime pairs, because `4/2` is `2/1` with a longer period and the same
 * trajectory — carrying both would let the search believe it had found
 * something denser than it had.
 *
 * The preference order is what the module comment argues for, in four steps
 * that each give up one thing:
 *
 * 1. dense enough, close enough, corner inside the window → the densest
 * 2. dense enough, close enough, corner before the deadline → the densest
 * 3. dense enough, close enough → the **soonest** corner
 * 4. anything at all → the closest
 *
 * Step 3 is where the deadline is given up, so it ranks by how late the corner
 * is rather than by density: the density floor is already met and the only
 * thing left worth minimising is the overrun. Step 4 is unreachable on any
 * screen anybody owns — it exists because a tube of some shape must always get
 * an answer, and a wrong-looking speed is the least bad way to give it one.
 */
function chooseRatio(ratio: number, yMs: number): [number, number] {
  const all: Candidate[] = [];
  for (let b = 1; b <= MAX_CROSSINGS; b += 1) {
    for (let a = 1; a <= MAX_CROSSINGS; a += 1) {
      if (gcd(a, b) !== 1) continue;
      all.push({
        a,
        b,
        error: Math.abs(a / b - ratio) / ratio,
        cells: a * b,
        cornerMs: a * yMs,
      });
    }
  }

  const usable = all.filter((one) => one.cells >= MIN_CELLS && one.error <= RATIO_TOLERANCE);
  const byDeadline = usable.filter((one) => one.cornerMs <= CORNER_MAX_MS);

  const densest = (list: Candidate[]): Candidate | undefined =>
    [...list].sort((one, other) => other.cells - one.cells || one.error - other.error)[0];

  const chosen =
    densest(byDeadline.filter((one) => one.cornerMs >= CORNER_MIN_MS)) ??
    densest(byDeadline) ??
    [...usable].sort((one, other) => one.cornerMs - other.cornerMs || other.cells - one.cells)[0] ??
    [...all].sort((one, other) => one.error - other.error || other.cells - one.cells)[0];

  // `all` always holds `1/2`, so this is for the compiler rather than for a case.
  return chosen ? [chosen.a, chosen.b] : [1, 2];
}

/**
 * The path for a mark of this size on a tube of this size, or `null` when there
 * is no room to move it — a box smaller than the drawing, which is a phone held
 * the wrong way rather than a fault. The caller centres it and leaves it there.
 */
export function pathFor(tube: Box, mark: Box, speed: number = SPEED_PX_PER_S): Path | null {
  const travel: Box = {
    width: Math.max(0, tube.width - mark.width),
    height: Math.max(0, tube.height - mark.height),
  };
  if (travel.width <= 0 && travel.height <= 0) return null;
  if (speed <= 0) return null;

  const idealX = Math.max(MIN_CROSSING_MS, (travel.width / speed) * 1000);
  const idealY = Math.max(MIN_CROSSING_MS, (travel.height / speed) * 1000);

  // The vertical crossing is the one kept honest, so it is also the one the
  // corner is counted in: `a` of them, however `b` comes out.
  const [a, b] = chooseRatio(idealX / idealY, idealY);
  const yMs = idealY;
  const xMs = (yMs * a) / b;

  return { travel, xMs, yMs, cornerMs: yMs * a };
}

/** A triangle wave over cycles: 0 at every even whole number, 1 at every odd one. */
function triangle(cycles: number): number {
  const wrapped = ((cycles % 2) + 2) % 2;
  return wrapped <= 1 ? wrapped : 2 - wrapped;
}

/**
 * Where the mark's top-left corner is, `elapsed` milliseconds in.
 *
 * `phase` shifts the **clock**, not the axes, and the distinction is the whole
 * reason the corner survives it: one offset added to both waves moves where on
 * the path the mark starts without moving the path, so corners still arrive
 * every `cornerMs` — measured from a different zero. Two independent offsets
 * would be a different trajectory with no corners in it at all.
 *
 * It exists because zero phase starts the mark **in a corner**, which opens
 * with the payoff and then asks the viewer to wait for a repeat of something
 * they have already seen. A random offset starts it somewhere along the path,
 * and the first corner is a real wait.
 */
export function positionAt(path: Path, elapsed: number, phase: number = 0): Point {
  const at = elapsed + phase;
  return {
    x: path.travel.width * triangle(at / path.xMs),
    y: path.travel.height * triangle(at / path.yMs),
  };
}

/** Whether a point is a corner of the travel box, to within a pixel. */
export function isCorner(path: Path, at: Point, tolerance: number = 1): boolean {
  const onX = at.x <= tolerance || at.x >= path.travel.width - tolerance;
  const onY = at.y <= tolerance || at.y >= path.travel.height - tolerance;
  return onX && onY;
}
