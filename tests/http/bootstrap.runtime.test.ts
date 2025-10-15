import { expect } from "chai";

import { StructuredLogger, type LogEntry } from "../../src/logger.js";
import { prepareHttpRuntime } from "../../src/http/bootstrap.js";
import type { HttpRuntimeOptions } from "../../src/serverOptions.js";
import type { EventStore } from "../../src/eventStore.js";
import type { FileIdempotencyStore } from "../../src/infra/idempotencyStore.file.js";

function createHttpOptions(overrides: Partial<HttpRuntimeOptions> = {}): HttpRuntimeOptions {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 8765,
    path: "/mcp",
    enableJson: true,
    stateless: true,
    ...overrides,
  };
}

function createEventStoreStub(): EventStore {
  return {
    getEventCount: () => 4,
    getMaxHistory: () => 16,
    setMaxHistory: () => {
      /* no-op */
    },
    append: () => {
      throw new Error("append should not be called during bootstrap tests");
    },
  } as unknown as EventStore;
}

describe("http/bootstrap", () => {
  it("prepares idempotency and readiness wiring for stateless HTTP", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const options = createHttpOptions({ stateless: true });
    const createStoreCalls: string[] = [];
    const fakeStore = { checkHealth: async () => undefined } as unknown as FileIdempotencyStore;

    const prepared = await prepareHttpRuntime(
      { options, logger, eventStore: createEventStoreStub() },
      {
        resolveRunsRoot: () => "/sandbox/runs",
        createIdempotencyStore: async (directory) => {
          createStoreCalls.push(directory);
          return fakeStore;
        },
        loadGraphForge: async () => ({ loaded: true }),
      },
    );

    expect(prepared.runsRoot).to.equal("/sandbox/runs");
    expect(createStoreCalls).to.deep.equal(["/sandbox/runs/idempotency"]);
    expect(prepared.idempotencyStore).to.equal(fakeStore);
    expect(prepared.extras).to.have.property("idempotency");
    expect(prepared.extras.idempotency?.store).to.equal(fakeStore);
    expect(prepared.extras.idempotency?.ttlMs ?? prepared.extras.idempotency?.ttl_ms).to.be.a("number");
    expect(prepared.extras.readiness).to.not.equal(undefined);

    await prepared.extras.readiness?.check?.();

    const infoEntry = entries.find((entry) => entry.message === "http_idempotency_store_ready");
    expect(infoEntry).to.not.equal(undefined);
    expect((infoEntry?.payload as Record<string, unknown> | undefined)?.directory).to.equal(
      "/sandbox/runs/idempotency",
    );
  });

  it("logs an error when the idempotency store fails to initialise", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const options = createHttpOptions({ stateless: true });

    const prepared = await prepareHttpRuntime(
      { options, logger, eventStore: createEventStoreStub() },
      {
        resolveRunsRoot: () => "/sandbox/runs",
        createIdempotencyStore: async () => {
          throw new Error("disk unavailable");
        },
        loadGraphForge: async () => undefined,
      },
    );

    expect(prepared.idempotencyStore).to.equal(null);
    expect(prepared.extras).to.not.have.property("idempotency");

    const errorEntry = entries.find((entry) => entry.message === "http_idempotency_store_failed");
    expect(errorEntry).to.not.equal(undefined);
    expect((errorEntry?.payload as Record<string, unknown> | undefined)?.message).to.include("disk unavailable");
  });
});
