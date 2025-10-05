/**
 * Parses a Server-Sent Events (SSE) stream payload into individual event
 * records. The helper mirrors the line-oriented framing performed by
 * `EventSource`, splitting each record by blank lines and decoding well-known
 * fields (`id`, `event`, `data`). Data lines are left as raw strings so tests
 * can further assert transport escaping before running `JSON.parse`.
 */
export function parseSseStream(stream: string): Array<{
  id: string | null;
  event: string | null;
  data: string[];
}> {
  const events: Array<{ id: string | null; event: string | null; data: string[] }> = [];
  const records = stream.split("\n\n");

  for (const record of records) {
    if (!record.trim()) {
      continue;
    }

    let id: string | null = null;
    let event: string | null = null;
    const data: string[] = [];

    for (const line of record.split("\n")) {
      if (line.startsWith("id: ")) {
        id = line.slice("id: ".length);
      } else if (line.startsWith("event: ")) {
        event = line.slice("event: ".length);
      } else if (line.startsWith("data: ")) {
        data.push(line.slice("data: ".length));
      }
    }

    events.push({ id, event, data });
  }

  return events;
}
