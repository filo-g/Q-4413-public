import { describe, expect, it } from 'vitest';

import {
  extensionFor,
  pickRecordingType,
  recordingFileName,
  slug,
  stamp,
  trackFileName,
  RECORDING_TYPES,
} from '../apps/web/src/export.ts';

/**
 * R-65's two files, in the parts that are decisions rather than DOM.
 *
 * The container choice is the one worth a suite of its own: Chrome and Firefox
 * record WebM and Safari records MP4, and a file named `.webm` holding MP4
 * opens in nothing — a failure that happens on somebody else's machine, after
 * the game, when the recording is the only copy.
 */
describe('slug', () => {
  it('folds accents rather than dropping the letter under them', () => {
    expect(slug('Sector Cañón')).toBe('sector-canon');
    expect(slug('Partida de Añoreta')).toBe('partida-de-anoreta');
  });

  it('never produces a name that is empty or edged with separators', () => {
    expect(slug('')).toBe('partida');
    expect(slug('///')).toBe('partida');
    expect(slug('  Q-4413  ')).toBe('q-4413');
  });

  it('bounds the length, because the rest of the name still has to fit', () => {
    expect(slug('x'.repeat(200)).length).toBe(40);
  });
});

describe('stamp', () => {
  /**
   * Local time on purpose, and the one timestamp in the app that is: every other
   * is an age or a countdown measured against the server (R-36), and this is a
   * label somebody will look for by when they remember the game happening.
   */
  it('is a sortable local stamp to the minute', () => {
    const at = new Date(2026, 8, 23, 9, 5).getTime();
    expect(stamp(at)).toBe('2026-09-23-0905');
  });
});

describe('file names', () => {
  const at = new Date(2026, 8, 23, 21, 14).getTime();

  it('names the track after the game and the window it starts at', () => {
    expect(trackFileName({ name: 'Nave Central' }, at)).toBe('q4413-nave-central-2026-09-23-2114.json');
  });

  it('falls back to the id when a game has no name', () => {
    expect(trackFileName({ id: 'default' }, at)).toBe('q4413-default-2026-09-23-2114.json');
    expect(trackFileName({}, at)).toBe('q4413-partida-2026-09-23-2114.json');
  });

  it('gives the recording the extension of what was actually recorded', () => {
    expect(recordingFileName({ name: 'X' }, at, 'video/webm;codecs=vp9')).toMatch(/\.webm$/);
    expect(recordingFileName({ name: 'X' }, at, 'video/mp4')).toMatch(/\.mp4$/);
  });
});

describe('pickRecordingType', () => {
  it('takes the first supported container in preference order', () => {
    expect(pickRecordingType((type) => type === 'video/webm')).toBe('video/webm');
    expect(pickRecordingType(() => true)).toBe(RECORDING_TYPES[0]);
  });

  /** Safari: no WebM at all, and the name has to follow. */
  it('falls through to mp4 when webm is unsupported', () => {
    const type = pickRecordingType((candidate) => candidate.includes('mp4'));
    expect(type).toBe('video/mp4');
    expect(extensionFor(type)).toBe('mp4');
  });

  /**
   * Nothing supported answers with nothing, which the caller reads as "this
   * browser cannot record". Guessing would hand MediaRecorder its unspecified
   * default container and move the same problem one step later, to a file whose
   * type nobody declared.
   */
  it('answers empty rather than guessing', () => {
    expect(pickRecordingType(() => false)).toBe('');
  });
});
