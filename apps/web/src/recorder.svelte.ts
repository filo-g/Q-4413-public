import { download } from './download.ts';
import { pickRecordingType, recordingFileName } from './export.ts';

/**
 * R-65's second file: the replay, recorded.
 *
 * ## Three decisions, and the first two are the whole feature
 *
 * **It is a capture of this tab, never of the screen.** `getDisplayMedia` will
 * happily hand back a display, and what that records is the browser: address
 * bar, tabs, whatever else is on the desktop. `preferCurrentTab` with
 * `displaySurface: 'browser'` asks for the page's own rendered content, so the
 * frame starts at the top of the document and the terminal fills it.
 *
 * **The controls are hidden for the duration, and the tube is not.** The whole
 * screen is the thing worth recording — the bezel, the scanlines, the callsigns,
 * R-12's circles, the zone dashes — and the bar, the dock and any open panel are
 * the parts that are furniture for running the game rather than the game. So
 * they go, through one attribute on the root element, and everything else stays
 * exactly as it is on screen.
 *
 * Cropping the video to the map was tried first and is not the same thing: it
 * cuts the bezel off with the controls, and the bezel is most of what makes a
 * recording of this app look like the machine it is pretending to be.
 *
 * The cost is that the master loses their controls while recording, which is
 * why **Escape stops a recording** and is the first rung of the panel's Escape
 * ladder. The browser's own "stop sharing" bar is the other way out.
 *
 * **It is not a canvas capture, and may not become one.** §14.3 leaves the map
 * style with no `symbol` layers, so every callsign and marker label is a DOM
 * marker over the WebGL canvas: `canvas.captureStream()` exports the dots and
 * not one word. Compositing the labels back into a second canvas to fix that is
 * the second renderer R-53 exists to prevent, arriving as a drawing rather than
 * as a mode.
 */
export type RecorderError = 'UNSUPPORTED' | 'DENIED' | 'UNKNOWN';

/** The slice of the API this uses, named so the casts stay in one place. */
interface DisplayMedia {
  getDisplayMedia(constraints: Record<string, unknown>): Promise<MediaStream>;
}
export class Recorder {
  recording = $state(false);
  error = $state<RecorderError | null>(null);

  #recorder: MediaRecorder | undefined;
  #stream: MediaStream | undefined;
  #chunks: Blob[] = [];
  #game: { name?: string; id?: string } = {};

  /**
   * Both halves are needed and they are not the same question: Firefox on
   * Android has `MediaRecorder` and no `getDisplayMedia`, and a button that
   * opens a picker and then cannot record is worse than one that is not there.
   */
  get supported(): boolean {
    if (typeof navigator === 'undefined' || typeof MediaRecorder === 'undefined') return false;
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  async start(game: { name?: string; id?: string }): Promise<void> {
    if (this.recording) return;
    this.error = null;
    if (!this.supported) {
      this.error = 'UNSUPPORTED';
      return;
    }
    const type = pickRecordingType((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!type) {
      this.error = 'UNSUPPORTED';
      return;
    }

    let stream: MediaStream;
    try {
      stream = await (navigator.mediaDevices as unknown as DisplayMedia).getDisplayMedia({
        // The tab, not the screen. `selfBrowserSurface: 'include'` is what stops
        // the browser excluding the very tab doing the asking, which is the one
        // being recorded.
        video: { displaySurface: 'browser' },
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        // Deliberately off. A master's laptop is in a room with people talking
        // about who is out: a recording of the screen is a document about the
        // game, and a recording of the room is a document about them.
        audio: false,
      });
    } catch (cause) {
      // Cancelling the picker is the ordinary path through here, not a fault:
      // it arrives as NotAllowedError exactly as a denied permission does, and
      // neither is worth a console line.
      this.error = (cause as Error)?.name === 'NotAllowedError' ? 'DENIED' : 'UNKNOWN';
      return;
    }

    // One attribute, and the stylesheet does the rest. Set before the recorder
    // starts so the first frame is already without the furniture.
    document.documentElement.dataset['recording'] = '';

    this.#game = game;
    this.#chunks = [];
    this.#stream = stream;
    this.#recorder = new MediaRecorder(stream, { mimeType: type });
    this.#recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.#chunks.push(event.data);
    };
    this.#recorder.onstop = () => this.#finish(type);
    // Stopping the share from the browser's own bar is the other way out, and
    // the one a master is most likely to reach for. Without this the recorder
    // keeps running against a dead track and the file never lands.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stop());
    // A timeslice, so a long recording arrives in pieces rather than as one
    // buffer the tab has to hold whole.
    this.#recorder.start(1_000);
    this.recording = true;
  }

  stop(): void {
    if (!this.recording) return;
    this.recording = false;
    delete document.documentElement.dataset['recording'];
    // The blob is assembled in `onstop`, which fires after the last chunk.
    this.#recorder?.stop();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
  }

  #finish(type: string): void {
    const chunks = this.#chunks;
    this.#chunks = [];
    this.#recorder = undefined;
    if (chunks.length === 0) return;
    download(new Blob(chunks, { type }), recordingFileName(this.#game, Date.now(), type));
  }
}

export const recorder = new Recorder();
