/**
 * The ingest path secret is the only credential the OsmAnd protocol has (R-02),
 * so comparing it must not leak how many characters matched.
 *
 * Compares UTF-16 code units rather than encoded bytes: TextEncoder is a
 * platform global, and this package may not depend on one (§6.5).
 */
export function constantTimeEquals(candidate: string, expected: string): boolean {
  // An empty expectation is a misconfigured Worker, not a match-everything rule.
  if (expected.length === 0) return false;

  let diff = candidate.length ^ expected.length;
  const length = Math.max(candidate.length, expected.length);
  for (let i = 0; i < length; i += 1) {
    // Reading past the end yields NaN from charCodeAt, so index defensively.
    const a = i < candidate.length ? candidate.charCodeAt(i) : 0;
    const b = i < expected.length ? expected.charCodeAt(i) : 0;
    diff |= a ^ b;
  }
  return diff === 0;
}
