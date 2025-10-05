/**
 * Serialises an arbitrary payload so it can be written on a single `data:` line
 * in a Server-Sent Events (SSE) stream. JSON encoding leaves Unicode line
 * separators (U+2028/U+2029) untouched which breaks the SSE contract by
 * introducing unintended record delimiters. The helper therefore performs an
 * additional escape pass for carriage returns, line feeds and Unicode line
 * separators while preserving the ability for consumers to recover the original
 * data through `JSON.parse`.
 */
export function serialiseForSse(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
