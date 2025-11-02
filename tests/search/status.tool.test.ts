import { describe, it } from "mocha";
import { expect } from "chai";
import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { StructuredLogger } from "../../src/logger.js";
import { InMemorySearchJobStore } from "../../src/search/jobStoreMemory.js";
import type { SearchJobStore } from "../../src/search/jobStore.js";
import { createSearchStatusHandler, SEARCH_STATUS_TOOL_NAME } from "../../src/tools/search_status.js";

function createExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("unexpected notification during search_status tests");
    },
    sendRequest: async () => {
      throw new Error("unexpected nested request during search_status tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function createJobStore(clock: () => number = () => Date.now()): SearchJobStore {
  return new InMemorySearchJobStore({ ttlMs: 86_400_000, clock });
}

describe("search.status tool", () => {
  it("signale l'indisponibilité lorsque la persistance est inactive", async () => {
    const logger = new StructuredLogger();
    const handler = createSearchStatusHandler({ logger, jobStore: null });
    const extras = createExtras("req-search-status-1");

    const result = await handler({ job_id: "search:job:demo" }, extras);
    expect(result.isError).to.equal(false);
    expect(result.structuredContent).to.deep.equal({
      ok: false,
      code: "persistence_unavailable",
      message: "la persistance des jobs de recherche est désactivée ou indisponible",
    });
    const textPayload = result.content?.[0]?.text ?? "";
    expect(textPayload).to.include(SEARCH_STATUS_TOOL_NAME);
    expect(textPayload).to.include("persistence_unavailable");
  });

  it("retourne un job complet lorsqu'il est présent dans le store", async () => {
    let now = 1_730_000_000_000;
    const clock = () => (now += 25);
    const jobStore = createJobStore(clock);
    const logger = new StructuredLogger();
    const handler = createSearchStatusHandler({ logger, jobStore });
    const extras = createExtras("req-search-status-2");

    await jobStore.create({
      id: "search:job:demo",
      createdAt: now,
      query: "recherche orchestrateur",
      normalizedQuery: "recherche orchestrateur",
      tags: ["ops", "demo"],
      requester: "alice@example.com",
      budget: { maxDurationMs: 120_000, maxToolCalls: null, maxBytesOut: null },
      provenance: {
        trigger: "search.run",
        transport: "stdio",
        requestId: "req-demo-1",
        requester: "alice@example.com",
        remoteAddress: null,
        extra: { scenario: "unit-test" },
      },
    });

    await jobStore.update("search:job:demo", {
      status: "running",
      startedAt: now + 10,
      updatedAt: now + 10,
      progress: {
        step: "initialising",
        message: "initialisation du pipeline",
        ratio: 0.1,
        updatedAt: now + 10,
      },
    });

    await jobStore.update("search:job:demo", {
      status: "completed",
      completedAt: now + 40,
      updatedAt: now + 40,
      progress: null,
      summary: {
        consideredResults: 6,
        fetchedDocuments: 4,
        ingestedDocuments: 3,
        skippedDocuments: 1,
        artifacts: ["validation_run/search/jobs/demo-summary.json"],
        metrics: { total_duration_ms: 32 },
        notes: null,
      },
      errors: [
        {
          code: "download_timeout",
          message: "timeout sur https://example.com/slow",
          stage: "fetch",
          occurredAt: now + 30,
          details: { url: "https://example.com/slow" },
        },
      ],
    });

    const result = await handler({ job_id: "search:job:demo" }, extras);
    expect(result.isError).to.equal(false);
    const payload = result.structuredContent as {
      ok: true;
      result: Record<string, unknown>;
    };
    expect(payload.ok).to.equal(true);
    const record = payload.result as Record<string, any>;
    expect(record.job_id).to.equal("search:job:demo");
    expect(record.meta.tags).to.deep.equal(["ops", "demo"]);
    expect(record.state.status).to.equal("completed");
    expect(record.state.summary.metrics.total_duration_ms).to.equal(32);
    expect(record.state.errors).to.have.lengthOf(1);
    expect(record.provenance.extra.scenario).to.equal("unit-test");
    expect(() => JSON.parse(result.content?.[0]?.text ?? "")).to.not.throw();
  });

  it("filtre les jobs selon statut et tags", async () => {
    let now = 1_740_000_000_000;
    const clock = () => (now += 50);
    const jobStore = createJobStore(clock);
    const logger = new StructuredLogger();
    const handler = createSearchStatusHandler({ logger, jobStore });
    const extras = createExtras("req-search-status-3");

    await jobStore.create({
      id: "search:job:alpha",
      createdAt: now,
      query: "observabilité",
      normalizedQuery: "observabilite",
      tags: ["ops"],
      requester: null,
      budget: { maxDurationMs: null, maxToolCalls: null, maxBytesOut: null },
      provenance: {
        trigger: "search.index",
        transport: "http",
        requestId: "req-alpha",
        requester: null,
        remoteAddress: "127.0.0.1",
        extra: {},
      },
    });
    await jobStore.update("search:job:alpha", {
      status: "running",
      startedAt: now + 5,
      updatedAt: now + 5,
      progress: {
        step: "fetch",
        message: "récupération des documents",
        ratio: 0.4,
        updatedAt: now + 5,
      },
    });

    await jobStore.create({
      id: "search:job:beta",
      createdAt: now + 100,
      query: "dashboard streaming",
      normalizedQuery: "dashboard streaming",
      tags: ["ops", "dashboard"],
      requester: null,
      budget: { maxDurationMs: null, maxToolCalls: null, maxBytesOut: null },
      provenance: {
        trigger: "search.run",
        transport: "stdio",
        requestId: "req-beta",
        requester: "operator",
        remoteAddress: null,
        extra: {},
      },
    });
    await jobStore.update("search:job:beta", {
      status: "running",
      startedAt: now + 120,
      updatedAt: now + 120,
      progress: {
        step: "extract",
        message: null,
        ratio: 0.6,
        updatedAt: now + 120,
      },
    });
    await jobStore.update("search:job:beta", {
      status: "completed",
      completedAt: now + 170,
      updatedAt: now + 170,
      summary: {
        consideredResults: 3,
        fetchedDocuments: 3,
        ingestedDocuments: 2,
        skippedDocuments: 1,
        artifacts: [],
        metrics: { total_duration_ms: 45 },
        notes: "ingestion partielle",
      },
      errors: [],
    });

    const result = await handler({ status: "completed", tag: "dashboard" }, extras);
    expect(result.isError).to.equal(false);
    const payload = result.structuredContent as { ok: true; result: Array<Record<string, any>> };
    expect(payload.result).to.have.lengthOf(1);
    expect(payload.result[0]!.job_id).to.equal("search:job:beta");
    expect(payload.result[0]!.meta.tags).to.include("dashboard");
  });
});
