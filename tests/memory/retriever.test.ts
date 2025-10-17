import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LocalVectorMemory } from "../../src/memory/vectorMemory.js";
import { HybridRetriever } from "../../src/memory/retriever.js";
import { StructuredLogger } from "../../src/logger.js";

/** No-op logger used to avoid polluting test output. */
function createTestLogger(): StructuredLogger {
  return new StructuredLogger({ onEntry: () => undefined });
}

describe("HybridRetriever", () => {
  let indexDir: string;

  beforeEach(async () => {
    indexDir = await mkdtemp(join(tmpdir(), "hybrid-retriever-"));
  });

  afterEach(async () => {
    await rm(indexDir, { recursive: true, force: true });
  });

  it("combines lexical and vector signals while preserving provenance", async () => {
    const memory = await LocalVectorMemory.create({ directory: indexDir });
    await memory.upsert([
      {
        id: "ir-handbook",
        text: "Incident response handbook covering containment, eradication and recovery steps.",
        tags: ["security", "runbook"],
        provenance: [{ sourceId: "https://kb.example.org/ir", type: "url" }],
      },
      {
        id: "postmortem",
        text: "Postmortem template for analysing outages and documenting action items.",
        tags: ["postmortem"],
        provenance: [{ sourceId: "https://kb.example.org/pm", type: "url" }],
      },
    ]);

    const retriever = new HybridRetriever(memory, createTestLogger());
    const hits = await retriever.search("incident response runbook", { limit: 2 });

    expect(hits).to.have.length.greaterThan(0);
    expect(hits[0].id).to.equal("ir-handbook");
    expect(hits[0].vectorScore).to.be.greaterThan(0.2);
    expect(hits[0].lexicalScore).to.be.greaterThan(0.3);
    expect(hits[0].score).to.be.at.least(hits[0].vectorScore);
    expect(hits[0].provenance).to.deep.equal([{ sourceId: "https://kb.example.org/ir", type: "url" }]);
    expect(hits[0].tags).to.include.members(["security", "runbook"]);
  });

  it("assigns partial credit to lexical near-misses using Levenshtein distance", async () => {
    const memory = await LocalVectorMemory.create({ directory: indexDir });
    await memory.upsert([
      {
        id: "analyse-outage",
        text: "We analyse outage reports thoroughly and update the recovery playbooks regularly.",
      },
      {
        id: "analyze-incidents",
        text: "We analyze incidents quickly with playbooks for escalation and follow-up actions.",
      },
    ]);

    const retriever = new HybridRetriever(memory, createTestLogger(), {
      lexicalWeight: 0.6,
      vectorWeight: 0.4,
    });
    const hits = await retriever.search("analyze outage reports", { limit: 2 });

    expect(hits).to.have.length(2);
    expect(hits[0].id).to.equal("analyse-outage");
    expect(hits[0].lexicalScore).to.be.greaterThan(0.6);
    expect(hits[1].lexicalScore).to.be.below(0.6);
    expect(hits[0].lexicalScore).to.be.greaterThan(hits[1].lexicalScore);
  });

  it("respects required tag filters when ranking hits", async () => {
    const memory = await LocalVectorMemory.create({ directory: indexDir });
    await memory.upsert([
      { text: "Production incident analysis", tags: ["security", "incident"] },
      { text: "Marketing campaign plan", tags: ["marketing"] },
    ]);

    const retriever = new HybridRetriever(memory, createTestLogger());
    const hits = await retriever.search("incident", { requiredTags: ["security"], limit: 3 });

    expect(hits).to.have.length(1);
    expect(hits[0].tags).to.include("security");
    expect(hits[0].matchedTags).to.deep.equal(["security"]);
  });

  it("returns top-k hits sorted by score and logs latency metrics", async () => {
    const memory = await LocalVectorMemory.create({
      directory: indexDir,
      now: (() => {
        let current = 0;
        return () => (current += 1);
      })(),
    });
    await memory.upsert([
      { id: "plan-alpha", text: "Incident response plan covering detection, identification, containment, eradication et recovery." },
      { id: "plan-beta", text: "Incident response checklist : escalade, containment, eradication, restoration." },
      { id: "plan-gamma", text: "Incident response playbook avec triage, containment, eradication et lessons learned." },
      { id: "plan-delta", text: "Security incident plan : detection rapide, containment efficace, eradication puis recovery." },
      { id: "plan-epsilon", text: "Guide d'exercices incident response incluant containment, eradication et communication." },
      { id: "plan-zeta", text: "Operational readiness review pour incident response plan et communication recovery." },
    ]);

    const entries: Array<{ message: string; payload?: unknown }> = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push({ message: entry.message, payload: entry.payload }) });
    const retriever = new HybridRetriever(memory, logger);

    const hits = await retriever.search("incident response containment eradication recovery plan", { limit: 5 });

    expect(hits).to.have.length(5);
    for (let index = 1; index < hits.length; index += 1) {
      expect(hits[index - 1].score).to.be.at.least(hits[index].score);
    }
    const log = entries.find((entry) => entry.message === "rag_retriever_search");
    expect(log).to.not.equal(undefined);
    const payload = log?.payload as Record<string, unknown> | undefined;
    expect(payload?.limit).to.equal(5);
    expect(payload?.returned).to.equal(5);
    expect(payload?.fetched).to.be.greaterThan(0);
    expect(payload?.took_ms).to.be.at.least(0);
  });

  it("keeps retrieval latency under the smoke-test budget for moderate corpora", async function () {
    this.timeout(10_000);

    const memory = await LocalVectorMemory.create({ directory: indexDir });
    const documents = Array.from({ length: 240 }, (_, index) => ({
      text: `Operational readiness drill #${index}: incident response with containment, eradication, and recovery steps described in detail to stress lexical scoring ${index}.`,
      tags: index % 2 === 0 ? ["runbook", "incident"] : ["incident"],
    }));

    // Persist the synthetic corpus sequentially so the deterministic timestamps
    // roughly mimic real ingestion flows while keeping the harness predictable.
    for (const document of documents) {
      await memory.upsert([{ ...document }]);
    }

    const retriever = new HybridRetriever(memory, createTestLogger(), {
      overfetchFactor: 2.5,
      defaultLimit: 12,
    });

    const startedAt = process.hrtime.bigint();
    const hits = await retriever.search("incident response containment eradication recovery", {
      limit: 12,
      requiredTags: ["incident"],
    });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    expect(hits.length).to.equal(12);
    expect(elapsedMs).to.be.below(500, `retrieval should stay under the 500ms smoke budget, observed ${elapsedMs.toFixed(1)}ms`);
  });
});
