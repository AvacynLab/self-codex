import { setTimeout as delay } from "node:timers/promises";

import type { DashboardHttpResponse } from "../../../src/monitor/dashboard.js";

/**
 * In-memory `DashboardHttpResponse` implementation tailored for SSE tests. The
 * stub records headers and body chunks while exposing hooks to simulate
 * backpressure via controlled `drain` events.
 */
export class StreamResponse implements DashboardHttpResponse {
  public statusCode: number | null = null;
  public headersSent = false;
  public finished = false;
  public readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private pendingDrainSignals = 0;

  writeHead(status: number, headers?: Record<string, string | number | readonly string[]>): this;
  writeHead(
    status: number,
    statusMessage: string,
    headers?: Record<string, string | number | readonly string[]>,
  ): this;
  writeHead(
    status: number,
    statusMessageOrHeaders?: string | Record<string, string | number | readonly string[]>,
    maybeHeaders?: Record<string, string | number | readonly string[]>,
  ): this {
    this.statusCode = status;
    const headers = typeof statusMessageOrHeaders === "object" && statusMessageOrHeaders !== null
      ? statusMessageOrHeaders
      : maybeHeaders;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
      }
    }
    this.headersSent = true;
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
  }

  write(chunk: string | Uint8Array): boolean {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.chunks.push(buffer);
    this.headersSent = true;

    if (this.pendingDrainSignals > 0) {
      this.pendingDrainSignals -= 1;
      return false;
    }

    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk) {
      this.write(chunk);
    }
    this.finished = true;
    this.emit("finish");
    this.emit("close");
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    const handlers = this.listeners.get(event);
    handlers?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const handlers = this.listeners.get(event);
    if (!handlers || handlers.size === 0) {
      return false;
    }
    for (const handler of Array.from(handlers)) {
      try {
        handler(...args);
      } catch {
        // Swallow listener exceptions to keep tests focused on server behaviour.
      }
    }
    return true;
  }

  /** Returns the concatenated SSE body for convenience. */
  get body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  /** Extracts the JSON payloads transported within `data:` SSE lines. */
  get dataEvents(): string[] {
    const events: string[] = [];
    const frames = this.body.split("\n\n");
    for (const frame of frames) {
      if (!frame.trim()) {
        continue;
      }
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          events.push(line.slice("data: ".length));
        }
      }
    }
    return events;
  }

  /** Triggers simulated backpressure for the next {@link count} writes. */
  triggerBackpressure(count = 1): void {
    this.pendingDrainSignals = Math.max(this.pendingDrainSignals, 0) + count;
  }

  /** Emits the `drain` event so buffered writes can resume. */
  emitDrain(): void {
    this.emit("drain");
  }
}

/**
 * Awaits until the response emits at least {@link minCount} SSE payloads or the
 * timeout elapses. The helper mirrors the asynchronous flushing behaviour of
 * the bounded SSE buffer.
 */
export async function waitForSseEvents(
  response: StreamResponse,
  minCount: number,
  timeoutMs = 1_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const events = response.dataEvents;
    if (events.length >= minCount) {
      return events;
    }
    await delay(10);
  }
  return response.dataEvents;
}
