import type { IncomingMessage } from "node:http";
import { Buffer } from "node:buffer";

/** Structured JSON payload returned by {@link readJsonBody}. */
export interface JsonBody<T> {
  /** Parsed JSON value. */
  readonly parsed: T;
  /** Raw UTF-8 string received over the wire. */
  readonly raw: string;
  /** Number of bytes read from the underlying socket. */
  readonly bytes: number;
}

/**
 * Reads and parses a JSON payload from an {@link IncomingMessage} stream while
 * enforcing an upper bound on the number of bytes accepted. The helper throws a
 * `413`-annotated error when the limit is breached so callers can surface the
 * correct HTTP response code.
 */
export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  maxBytes = 1 << 20,
): Promise<JsonBody<T>> {
  const buffers: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    // Normalise the chunk into a buffer regardless of the transport encoding.
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > maxBytes) {
      const error = new Error("Payload Too Large");
      Object.assign(error, { status: 413 });
      throw error;
    }

    buffers.push(buffer);
  }

  const raw = Buffer.concat(buffers).toString("utf8");
  return { parsed: JSON.parse(raw) as T, raw, bytes: totalBytes };
}

