/**
 * The two files a finished game can be taken out as (R-65).
 *
 * Naming and format decisions only — the parts that are arithmetic, so the root
 * suite can hold them. **It has no DOM in it on purpose**: `tsconfig.tests.json`
 * compiles this file with `lib` at node, which is what keeps it checkable there,
 * and one `document` would take it straight back out. Saving is `download.ts`
 * and the capture is `recorder.svelte.ts`; neither decides anything this file
 * does not.
 *
 * **What is in the JSON is the reason the control says so where it is pressed.**
 * A track window is real positions for named people, with eliminations and drop
 * points among them (§10). It is not a credential and it is not a secret, and it
 * is also not a file to leave in a downloads folder without knowing that.
 */

/** Filename-safe, and short enough to still read as a name in a file listing. */
export function slug(value: string): string {
  return (
    value
      .normalize('NFD')
      // Combining marks, so "Sector Cañón" survives and "ñ" becomes "n"
      // rather than disappearing with the letter it sits on.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'partida'
  );
}

/**
 * `YYYY-MM-DD-HHmm`, in the reader's own timezone.
 *
 * The one place in this app that does not use the server's clock on purpose:
 * every timestamp on screen is an age or a countdown, where a device clock would
 * be wrong in a way that matters (R-36), and this is a label on a file somebody
 * will look for by when they remember the game happening.
 */
export function stamp(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

export function trackFileName(game: { name?: string; id?: string }, from: number): string {
  return `q4413-${slug(game.name || game.id || '')}-${stamp(from)}.json`;
}

export function recordingFileName(
  game: { name?: string; id?: string },
  at: number,
  mimeType: string,
): string {
  return `q4413-${slug(game.name || game.id || '')}-${stamp(at)}.${extensionFor(mimeType)}`;
}

/**
 * What a browser will actually record.
 *
 * Chrome and Firefox produce WebM and Safari produces MP4, and a file named
 * `.webm` holding MP4 opens in nothing. The list is in preference order and the
 * predicate is injected so the choice is testable without a MediaRecorder.
 *
 * `''` when nothing on the list is supported, which the caller treats as "this
 * browser cannot record" rather than guessing — MediaRecorder's own default
 * container is unspecified, and a file whose type nobody declared is the same
 * problem one step later.
 */
export const RECORDING_TYPES: readonly string[] = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export function pickRecordingType(
  supported: (type: string) => boolean,
  candidates: readonly string[] = RECORDING_TYPES,
): string {
  return candidates.find((type) => supported(type)) ?? '';
}

export function extensionFor(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}
