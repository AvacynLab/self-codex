import { expect } from "chai";

import {
  InMemorySearchJobStore,
  type InMemorySearchJobStoreOptions,
} from "../../../src/search/jobStoreMemory.js";
import {
  type JobFailure,
  type JobMeta,
  type JobProgress,
  type JobSummary,
} from "../../../src/search/jobStore.js";

/**
 * Helper returning deterministic metadata for the tests. Individual scenarios
 * override the pieces that need to vary (timestamps, tags, ...).
 */
const buildJobMeta = (id: string, createdAt: number, overrides: Partial<JobMeta> = {}): JobMeta => {
  const baseBudget = overrides.budget ?? {
    maxDurationMs: null,
    maxToolCalls: null,
    maxBytesOut: null,
  };

  const baseMeta: JobMeta = {
    id,
    createdAt,
    query: overrides.query ?? "rust concurrency",
    normalizedQuery: overrides.normalizedQuery ?? "rust concurrency",
    tags: overrides.tags ?? ["alpha"],
    requester: overrides.requester ?? "tester",
    budget: baseBudget,
    provenance: overrides.provenance ?? {
      trigger: "search.run",
      transport: "stdio",
      requestId: "req-1",
      requester: "tester",
      remoteAddress: null,
      extra: {},
    },
  };

  return {
    ...baseMeta,
    ...overrides,
    budget: baseBudget,
    provenance: {
      trigger: baseMeta.provenance.trigger,
      transport: baseMeta.provenance.transport,
      requestId: baseMeta.provenance.requestId,
      requester: baseMeta.provenance.requester,
      remoteAddress: baseMeta.provenance.remoteAddress,
      extra: { ...baseMeta.provenance.extra },
    },
  };
};

const createStore = (options: InMemorySearchJobStoreOptions = {}): InMemorySearchJobStore =>
  new InMemorySearchJobStore({
    ttlMs: options.ttlMs,
    clock: options.clock,
  });

describe("search/jobStoreMemory", () => {
  it("creates a job and returns an immutable snapshot", async () => {
    const createdAt = 1_700_000_000_000;
    const store = createStore();
    const job = buildJobMeta("job-1", createdAt, {
      tags: [" alpha ", "alpha", "beta"],
      provenance: {
        trigger: "search.run",
        transport: "stdio",
        requestId: "req-42",
        requester: "alice",
        remoteAddress: "127.0.0.1:8080",
        extra: { scenario: "unit" },
      },
    });

    await store.create(job);
    const record = await store.get("job-1");
    expect(record).to.not.equal(null);
    expect(record?.meta.id).to.equal("job-1");
    expect(record?.meta.tags).to.deep.equal(["alpha", "beta"]);
    expect(record?.state.status).to.equal("pending");
    expect(record?.state.createdAt).to.equal(createdAt);
    expect(record?.provenance.requestId).to.equal("req-42");

    if (!record) {
      throw new Error("record should not be null");
    }
    const snapshot = await store.get("job-1");
    expect(snapshot).to.not.equal(record);
  });

  it("rejects duplicate job identifiers", async () => {
    const store = createStore();
    const createdAt = 1_700_000_001_000;
    await store.create(buildJobMeta("dup", createdAt));

    try {
      await store.create(buildJobMeta("dup", createdAt + 1));
      expect.fail("second creation should throw");
    } catch (error) {
      expect((error as Error).message).to.include("already exists");
    }
  });

  it("enforces valid status transitions and timestamps", async () => {
    let now = 1_700_000_010_000;
    const store = createStore({ clock: () => now });
    await store.create(buildJobMeta("job-transition", now));

    await store.update("job-transition", {
      status: "running",
      updatedAt: now + 1,
      startedAt: now + 1,
      progress: {
        step: "download",
        message: "fetching",
        ratio: 0.1,
        updatedAt: now + 1,
      },
    });

    const summary: JobSummary = {
      consideredResults: 5,
      fetchedDocuments: 3,
      ingestedDocuments: 2,
      skippedDocuments: 1,
      artifacts: ["validation_run/search/jobs/job-transition.json"],
      metrics: { "latency.p95": 1200 },
      notes: "completed without retries",
    };
    const errors: JobFailure[] = [
      {
        code: "FETCH_TIMEOUT",
        message: "timeout while fetching example.com",
        stage: "fetch",
        occurredAt: now + 2,
        details: { url: "https://example.com" },
      },
    ];

    await store.update("job-transition", {
      status: "completed",
      updatedAt: now + 5,
      completedAt: now + 5,
      summary,
      errors,
    });

    const record = await store.get("job-transition");
    expect(record?.state.status).to.equal("completed");
    expect(record?.state.summary).to.deep.equal(summary);
    expect(record?.state.errors).to.deep.equal(errors);

    try {
      await store.update("job-transition", { status: "running", updatedAt: now + 6 });
      expect.fail("terminal jobs must be immutable");
    } catch (error) {
      expect((error as Error).message).to.include("immutable");
    }
  });

  it("filters jobs by status, tags and recency", async () => {
    let now = 1_700_000_020_000;
    const store = createStore({ clock: () => now });

    await store.create(buildJobMeta("job-a", now, { tags: ["alpha"] }));
    await store.create(buildJobMeta("job-b", now + 1, { tags: ["beta"] }));
    await store.create(buildJobMeta("job-c", now + 2, { tags: ["alpha", "gamma"] }));

    await store.update("job-a", {
      status: "running",
      updatedAt: now + 3,
      startedAt: now + 3,
    });
    await store.update("job-b", {
      status: "failed",
      updatedAt: now + 4,
      failedAt: now + 4,
      errors: [
        {
          code: "EXTRACT_ERROR",
          message: "extractor crashed",
          stage: "extract",
          occurredAt: now + 4,
          details: null,
        },
      ],
    });
    await store.update("job-c", {
      status: "running",
      updatedAt: now + 4,
      startedAt: now + 4,
    });
    await store.update("job-c", {
      status: "completed",
      updatedAt: now + 5,
      completedAt: now + 5,
      summary: {
        consideredResults: 2,
        fetchedDocuments: 1,
        ingestedDocuments: 1,
        skippedDocuments: 0,
        artifacts: [],
        metrics: {},
        notes: null,
      },
    });

    const byStatus = await store.list({ status: "completed" });
    expect(byStatus).to.have.lengthOf(1);
    expect(byStatus[0]?.meta.id).to.equal("job-c");

    const byTag = await store.list({ tag: "alpha" });
    expect(byTag.map((entry) => entry.meta.id)).to.deep.equal(["job-c", "job-a"]);

    const recent = await store.list({ since: now + 4 });
    expect(recent.map((entry) => entry.meta.id)).to.deep.equal(["job-c", "job-b"]);

    const limited = await store.list({ limit: 2 });
    expect(limited.map((entry) => entry.meta.id)).to.deep.equal(["job-c", "job-b"]);
  });

  it("garbage collects terminal jobs beyond the TTL", async () => {
    let now = 1_700_000_030_000;
    const store = createStore({ ttlMs: 10, clock: () => now });

    await store.create(buildJobMeta("job-old", now));
    await store.create(buildJobMeta("job-fresh", now));

    await store.update("job-old", {
      status: "running",
      updatedAt: now + 1,
      startedAt: now + 1,
    });
    await store.update("job-old", {
      status: "completed",
      updatedAt: now + 2,
      completedAt: now + 2,
      summary: {
        consideredResults: 1,
        fetchedDocuments: 1,
        ingestedDocuments: 1,
        skippedDocuments: 0,
        artifacts: [],
        metrics: {},
        notes: null,
      },
    });

    await store.update("job-fresh", {
      status: "failed",
      updatedAt: now + 8,
      failedAt: now + 8,
      errors: [
        {
          code: "DOWNLOAD_ERROR",
          message: "network reset",
          stage: "fetch",
          occurredAt: now + 8,
          details: null,
        },
      ],
    });

    now += 12;
    const purged = await store.gc(now);
    expect(purged).to.equal(1);
    expect(await store.get("job-old")).to.equal(null);
    expect(await store.get("job-fresh")).to.not.equal(null);
  });

  it("serialises concurrent updates to maintain consistency", async () => {
    let now = 1_700_000_040_000;
    const store = createStore({ clock: () => now });
    await store.create(buildJobMeta("job-concurrent", now));
    await store.update("job-concurrent", {
      status: "running",
      updatedAt: now + 1,
      startedAt: now + 1,
    });

    const updates = Array.from({ length: 5 }, (_, index) => {
      const progress: JobProgress = {
        step: index % 2 === 0 ? "download" : "extract",
        message: `stage-${index}`,
        ratio: index / 5,
        updatedAt: now + 2 + index,
      };
      now += 1;
      return store.update("job-concurrent", {
        updatedAt: now,
        progress,
      });
    });

    await Promise.all(updates);
    const record = await store.get("job-concurrent");
    expect(record?.state.progress?.message).to.equal("stage-4");
    expect(record?.state.progress?.step).to.equal("download");
  });

  it("defaults startedAt to the update timestamp when omitted", async () => {
    const store = createStore();
    await store.create(buildJobMeta("job-missing-start", 1_700_000_050_000));

    await store.update("job-missing-start", { status: "running", updatedAt: 1_700_000_050_001 });
    const record = await store.get("job-missing-start");
    expect(record?.state.startedAt).to.equal(1_700_000_050_001);
  });
});
