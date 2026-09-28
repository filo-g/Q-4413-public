import { describe, expect, it } from 'vitest';

import { etaSeconds, poiDistances } from '@q4413/core';
import type { Game, Poi } from '@q4413/shared';

import { etaParts, formatDistance, formatEta } from '../apps/web/src/format.ts';

/**
 * Distance and rough time to a point (R-18, R-44, R-45), and the rendering rule
 * that comes with it: **"≈4 min", never "4:12"**. The formatter is tested
 * alongside the arithmetic because the requirement is about what reaches the
 * screen, not about the number.
 */
const CONFIG: Pick<
  Game['config'],
  'detourFactor' | 'walkingSpeed' | 'poiProximityRadius'
> = {
  detourFactor: 1.35,
  walkingSpeed: 1.4,
  poiProximityRadius: 50,
};

/** At the venue's latitude, so the metre spacing below is the real thing. */
const LAT = 36.657;
const north = (metres: number) => LAT + metres / 111_132;

const poi = (id: string, metres: number): Poi => ({
  id,
  name: id,
  lat: north(metres),
  lon: -4.478,
  category: 'OTHER',
});

describe('etaSeconds() — R-45', () => {
  it('is the straight line, inflated for detours, at walking speed', () => {
    // 420 m × 1.35 / 1.4 = 405 s.
    expect(etaSeconds(420, CONFIG)).toBeCloseTo(405, 5);
  });

  it('is zero at zero distance, and for a distance that is not a number', () => {
    expect(etaSeconds(0, CONFIG)).toBe(0);
    expect(etaSeconds(-5, CONFIG)).toBe(0);
    expect(etaSeconds(Number.NaN, CONFIG)).toBe(0);
  });
});

describe('poiDistances()', () => {
  const pois = [poi('far', 800), poi('near', 30), poi('middle', 200)];

  it('orders by distance and measures each one', () => {
    const list = poiDistances({ lat: LAT, lon: -4.478 }, pois, CONFIG);
    expect(list.map((entry) => entry.poi.id)).toEqual(['near', 'middle', 'far']);
    expect(list[0]?.metres).toBeCloseTo(30, 0);
    expect(list[0]?.seconds).toBeCloseTo(etaSeconds(list[0]!.metres, CONFIG), 5);
  });

  /**
   * `near` is a display flag and nothing else. R-16 makes POIs visible from the
   * start and R-18 says proximity unlocks nothing, so the far ones stay in the
   * list — the car park is useful precisely when you are nowhere near it.
   */
  it('flags what is inside the proximity radius without dropping anything', () => {
    const list = poiDistances({ lat: LAT, lon: -4.478 }, pois, CONFIG);
    expect(list).toHaveLength(3);
    expect(list.filter((entry) => entry.near).map((entry) => entry.poi.id)).toEqual(['near']);
  });

  it('gives no distances at all with no position of its own', () => {
    const list = poiDistances(undefined, pois, CONFIG);
    expect(list).toHaveLength(3);
    for (const entry of list) {
      expect(Number.isNaN(entry.metres)).toBe(true);
      expect(entry.near).toBe(false);
    }
  });
});

describe('what reaches the screen', () => {
  /** R-45 is explicit: a rounded minute figure, and never a clock. */
  it('renders a rough time, never a precise one', () => {
    expect(formatEta(etaSeconds(420, CONFIG))).toBe('~ 7min');
    expect(formatEta(30)).toBe('<1min');
    expect(formatEta(Number.NaN)).toBe('—');
    expect(formatEta(etaSeconds(420, CONFIG))).not.toContain(':');
  });

  /**
   * `Eta.svelte` sets the mark smaller than the number, which it can only do if
   * the two arrive separately. The split is the part that can rot: a mark that
   * came back inside `value` would still read correctly and would silently stop
   * being styled, because nothing about a string says which half is which.
   */
  it('hands the mark over separately, so it can be set apart from the number', () => {
    expect(etaParts(etaSeconds(420, CONFIG))).toEqual({ mark: '~', value: '7min' });
    expect(etaParts(420).value).not.toContain('~');
  });

  /** The two forms are the same reading; only the string form joins them. */
  it('keeps the one-string form in step with the parts', () => {
    for (const seconds of [420, 30, 3600, Number.NaN]) {
      const { mark, value } = etaParts(seconds);
      expect(formatEta(seconds)).toBe(mark ? `${mark} ${value}` : value);
    }
  });

  it('coarsens distance as it grows, for the same reason', () => {
    expect(formatDistance(37.4)).toBe('37m');
    expect(formatDistance(214)).toBe('210m');
    expect(formatDistance(1_240)).toBe('1.2km');
    expect(formatDistance(Number.NaN)).toBe('—');
  });
});
