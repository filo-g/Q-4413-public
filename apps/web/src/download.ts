/**
 * A blob to a file the browser saves (R-65).
 *
 * Its own module because it is the one line of `export.ts`'s job that touches
 * the document, and that file is compiled by the root suite with no DOM library
 * — which is what keeps every naming and container decision in it testable.
 *
 * The anchor is created, clicked and thrown away in the same turn, and the
 * object URL is revoked after it: a URL kept alive holds the whole blob in
 * memory, and a six-hour track is several megabytes of it.
 */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Not revoked synchronously: Safari has cancelled the download of a URL
  // revoked in the same task. A macrotask later is after the click has been
  // handed to the download manager.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
