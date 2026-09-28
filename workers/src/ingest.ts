import { parseOsmAndPing, type ParseResult } from '@q4413/core';

/**
 * OsmAnd protocol HTTP adapter (R-01, R-09).
 *
 * Traccar Client sends parameters in the query string on some platforms and in
 * the POST body on others, and R-01 requires both. The two are merged, query
 * first, and handed to the pure decoder in packages/core.
 */
export async function readPingPairs(request: Request): Promise<Array<[string, string]>> {
  const url = new URL(request.url);
  const pairs: Array<[string, string]> = [...url.searchParams];

  if (request.method !== 'POST') return pairs;

  const contentType = request.headers.get('content-type') ?? '';
  const body = await request.text();
  if (body.trim() === '') return pairs;

  if (contentType.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (value !== null && typeof value !== 'object') pairs.push([key, String(value)]);
        }
      }
    } catch {
      // A body that is not JSON after all is ignored; the query string may still
      // carry a complete ping, and a device is never told about our parsing.
    }
    return pairs;
  }

  // Default to form encoding: that is what Traccar Client posts.
  for (const [key, value] of new URLSearchParams(body)) pairs.push([key, value]);
  return pairs;
}

export async function decodePing(request: Request, receivedAt: number): Promise<ParseResult> {
  return parseOsmAndPing(await readPingPairs(request), receivedAt);
}
