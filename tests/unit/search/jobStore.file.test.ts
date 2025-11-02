import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { expect } from "chai";

import { FileSearchJobStore } from "../../../src/search/jobStoreFile.js";
import {
  type JobFailure,
  type JobMeta,
  type JobSummary,
} from "../../../src/search/jobStore.js";

const buildJobMeta = (id: string, createdAt: number, overrides: Partial<JobMeta> = {}): JobMeta => {
  const baseBudget = overrides.budget ?? {
    maxDurationMs: null,
    maxToolCalls: null,
    maxBytesOut: null,
  };

  const baseMeta: JobMeta = {
    id,
    createdAt,
    query: overrides.query ?? "distributed systems",
    normalizedQuery: overrides.normalizedQuery ?? "distributed systems",
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

const createTempDirectory = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "search-job-store-file-"));
  return dir;
};

describe("search/jobStoreFile", () => {
  const directories: string[] = [];
  const stores: FileSearchJobStore[] = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) {
      await store.dispose();
    }
    for (const dir of directories.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("persists jobs to disk and recovers them on restart", async () => {
    const dir = await createTempDirectory();
    directories.push(dir);

    let clockNow = 1_700_100_000_000;
    const store = new FileSearchJobStore({
      directory: dir,
      clock: () => clockNow,
      fsyncMode: "always",
    });
    stores.push(store);

    await store.initialise();
    await store.create(
      buildJobMeta("job-durable", clockNow, {
        tags: [" durability ", "durability", "beta"],
        provenance: {
          trigger: "search.run",
          transport: "http",
          requestId: "req-42",
          requester: "alice",
          remoteAddress: "127.0.0.1:9000",
          extra: { mode: "unit" },
        },
      }),
    );

    clockNow += 10;
    await store.update("job-durable", {
      status: "running",
      startedAt: clockNow,
      updatedAt: clockNow,
      progress: {
        step: "download",
        message: "fetching",
        ratio: 0.2,
        updatedAt: clockNow,
      },
    });

    await store.dispose();

    const recovered = new FileSearchJobStore({ directory: dir, clock: () => clockNow });
    stores.push(recovered);
    await recovered.initialise();

    const record = await recovered.get("job-durable");
    expect(record?.state.status).to.equal("running");
    expect(record?.state.progress?.step).to.equal("download");
    expect(record?.meta.tags).to.deep.equal(["durability", "beta"]);
    expect(record?.provenance.remoteAddress).to.equal("127.0.0.1:9000");
  });

  it("compacts the journal after TTL-based garbage collection", async () => {
    const dir = await createTempDirectory();
    directories.push(dir);

    let clockNow = 1_700_200_000_000;
    const store = new FileSearchJobStore({
      directory: dir,
      clock: () => clockNow,
      ttlMs: 100,
      fsyncMode: "always",
    });
    stores.push(store);

    await store.initialise();

    await store.create(buildJobMeta("job-expired", clockNow));
    clockNow += 1;
    await store.update("job-expired", {
      status: "running",
      startedAt: clockNow,
      updatedAt: clockNow,
    });
    clockNow += 4;
    const summary: JobSummary = {
      consideredResults: 3,
      fetchedDocuments: 2,
      ingestedDocuments: 1,
      skippedDocuments: 0,
      artifacts: ["validation_run/search/jobs/job-expired.json"],
      metrics: { "latency.p95": 800 },
      notes: "completed",
    };
    const errors: JobFailure[] = [
      {
        code: "FETCH_TIMEOUT",
        message: "timeout",
        stage: "download",
        occurredAt: clockNow,
        details: { attempt: 1 },
      },
    ];
    await store.update("job-expired", {
      status: "completed",
      completedAt: clockNow,
      updatedAt: clockNow,
      summary,
      errors,
    });

    const beforeStat = await fs.stat(path.join(dir, "jobs.active.jsonl"));

    clockNow += 200;
    const purged = await store.gc(clockNow);
    expect(purged).to.equal(1);

    const journalPath = path.join(dir, "jobs.active.jsonl");
    const afterStat = await fs.stat(journalPath);
    expect(afterStat.mtimeMs).to.be.at.least(beforeStat.mtimeMs);
    expect(afterStat.size).to.be.at.most(beforeStat.size);

    const content = await fs.readFile(journalPath, "utf8");
    expect(content.trim()).to.equal("");
  });

  it("surfaces a warning when the lock file already exists", async () => {
    const dir = await createTempDirectory();
    directories.push(dir);

    const captured: string[] = [];
    const storeA = new FileSearchJobStore({ directory: dir, fsyncMode: "never" });
    stores.push(storeA);
    await storeA.initialise();

    const storeB = new FileSearchJobStore({
      directory: dir,
      fsyncMode: "never",
      log: (level, message) => {
        if (level === "warn") {
          captured.push(message);
        }
      },
    });
    stores.push(storeB);
    await storeB.initialise();

    expect(captured.some((entry) => entry.includes("lock already exists"))).to.equal(true);
  });
});

