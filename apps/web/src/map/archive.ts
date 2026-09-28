import type { RangeResponse, Source } from 'pmtiles';

/**
 * Reading the `.pmtiles` archive **whole**, once, instead of by HTTP range.
 *
 * §14.4 originally put the archive on R2 and read it with range requests, which
 * is what object storage is good at. It is served next to the bundle now
 * (R-52b), and Cloudflare's asset server answers a range request with a `200`
 * and the whole body. `pmtiles`' own `FetchSource` treats that as fatal:
 *
 * > Server returned no content-length header or content-length exceeding
 * > request. Check that your storage backend supports HTTP Byte Serving.
 *
 * So the archive is fetched once as an ordinary GET and every read after that
 * is a slice of an `ArrayBuffer`. Three things follow, and the third is why
 * this exists rather than leaning on the service worker:
 *
 * - **the origin never has to serve bytes**, which is what makes storage a
 *   choice rather than a constraint;
 * - **it costs one request instead of dozens** — the header, the directory and
 *   every tile come out of memory;
 * - **it works where the service worker does not.** The worker is registered in
 *   production only, and even there it does not control the page that installed
 *   it until a reload. Without this, the map would be broken in `vite dev` and
 *   on a player's very first load, which are the two places it gets looked at.
 *
 * The cost is holding the archive in memory. At §14.2's sizes — a few MB over a
 * commercial estate, and the 25 MiB asset ceiling above that — that is a
 * fraction of what MapLibre's own tile cache uses.
 */
export class WholeArchiveSource implements Source {
  readonly #url: string;
  #buffer: Promise<ArrayBuffer> | undefined;
  #etag: string | undefined;

  constructor(url: string) {
    this.#url = url;
  }

  getKey(): string {
    return this.#url;
  }

  /**
   * Started on the first read and shared by every read after it. `pmtiles`
   * asks for the header before anything else and then issues the directory and
   * tile reads concurrently; without one shared promise each of those would
   * start its own download of the whole file.
   */
  #load(): Promise<ArrayBuffer> {
    this.#buffer ??= fetch(this.#url).then(async (response) => {
      if (!response.ok) {
        throw new Error(`basemap archive ${this.#url}: ${response.status}`);
      }
      // Weak etags are dropped for the same reason pmtiles drops them: they do
      // not promise byte-for-byte identity, which is the only thing an offset
      // into an archive can be validated against.
      /**
       * **A 404 here arrives as a 200 full of HTML**, and it did.
       *
       * `not_found_handling` is `single-page-application`, so an archive path
       * that does not exist — a stale `Game.basemap.pmtilesUrl` left over from a
       * previous `BASEMAP_VERSION`, which a deploy cannot fix because it never
       * reseeds — comes back as `index.html` with a 200. `pmtiles` then reads
       * the first seven bytes and says *"wrong magic number for pmtiles
       * archive"*, which names the symptom and hides the cause completely.
       *
       * Checked here rather than by content-type: Cloudflare's asset server
       * sends none at all for `.pmtiles`, so the type is unreliable in the
       * healthy case and useless in the broken one. The magic is `PMTiles`.
       */
      const body = await response.arrayBuffer();
      const magic = new TextDecoder().decode(body.slice(0, 7));
      if (magic !== 'PMTiles') {
        throw new Error(
          `${this.#url} is not a pmtiles archive (starts "${magic.replace(/[^\x20-\x7e]/g, '.')}"). ` +
            'A missing archive is served as index.html with a 200 — the configured path is ' +
            'probably from an older BASEMAP_VERSION. POST /api/master/game/geo to re-derive it.',
        );
      }
      const etag = response.headers.get('etag');
      this.#etag = etag?.startsWith('W/') ? undefined : (etag ?? undefined);
      return body;
    });
    return this.#buffer;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buffer = await this.#load();
    return {
      data: buffer.slice(offset, offset + length),
      ...(this.#etag === undefined ? {} : { etag: this.#etag }),
    };
  }
}

/**
 * A configured archive as something fetchable.
 *
 * Same-origin archives are configured as a **path** — `/basemap/v3/madrid.pmtiles`
 * — which is what makes the deploy the upload (R-52b). MapLibre needs a URL, and
 * `Protocol` matches a `pmtiles://` reference in the style against `Source.getKey()`
 * by string, so both sides have to be resolved the same way and exactly once.
 *
 * An absolute URL passes through unchanged, which is what an R2 or CDN archive
 * still is.
 *
 * @param origin the page's origin, passed rather than read, so this stays a
 *               pure function the root suite can call without a DOM.
 */
export function absoluteArchiveUrl(url: string, origin: string): string {
  return new URL(url, origin).toString();
}
