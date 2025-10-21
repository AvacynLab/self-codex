import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sinon from "sinon";

import { VectorMemoryIndex, VECTOR_MEMORY_MAX_CAPACITY } from "../../src/memory/vector.js";
import { PathResolutionError } from "../../src/paths.js";

/** Simple deterministic clock used to control timestamps in tests. */
class ManualClock {
  private current = 0;

  advance(ms: number): void {
    this.current += ms;
  }

  now(): number {
    return this.current;
  }
}

describe("vector memory index", () => {
  let rootDir: string;
  let clock: ManualClock;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vector-memory-"));
    clock = new ManualClock();
  });

  it("indexes documents and ranks results by cosine similarity", async () => {
    const index = await VectorMemoryIndex.create({ directory: rootDir, now: () => clock.now() });

    await index.upsert({
      text: "Incident response contain eradicate",
      tags: ["incident", "contain"],
      provenance: [{ sourceId: "kb://incident-playbook", type: "kg" }],
    });
    clock.advance(10);
    await index.upsert({ text: "Deploy automation pipeline and rollback", tags: ["deploy"] });
    clock.advance(10);
    await index.upsert({ text: "Contain malware and isolate hosts", tags: ["incident"] });

    const hits = index.search("contain incident response", { limit: 2, minScore: 0.2 });
    expect(hits).to.have.length(2);
    expect(hits[0].document.text).to.include("Incident response");
    expect(hits[1].document.text).to.include("Contain malware");
    expect(hits[0].score).to.be.greaterThan(hits[1].score);
    expect(hits[0].document.provenance).to.deep.equal([
      { sourceId: "kb://incident-playbook", type: "kg" },
    ]);
  });

  it("persists entries on disk and reloads them on startup", async () => {
    const index = await VectorMemoryIndex.create({ directory: rootDir, now: () => clock.now() });

    await index.upsert({
      text: "Generate remediation plan and document findings",
      tags: ["plan", "remediation"],
      metadata: { source: "child_collect", child_id: "child-123" },
      provenance: [
        { sourceId: "https://kb.example.org/remediation", type: "url", span: [0, 32], confidence: 0.8 },
      ],
    });

    const reloaded = await VectorMemoryIndex.create({ directory: rootDir });
    expect(reloaded.size()).to.equal(1);

    const hits = reloaded.search("remediation plan", { limit: 1 });
    expect(hits).to.have.length(1);
    expect(hits[0].document.metadata.child_id).to.equal("child-123");
    expect(hits[0].document.provenance).to.deep.equal([
      { sourceId: "https://kb.example.org/remediation", type: "url", span: [0, 32], confidence: 0.8 },
    ]);
  });

  it("evicts the oldest entries once the capacity is exceeded", async () => {
    const index = await VectorMemoryIndex.create({ directory: rootDir, now: () => clock.now(), maxDocuments: 2 });

    await index.upsert({ text: "Alpha release summary" });
    clock.advance(5);
    await index.upsert({ text: "Beta release summary" });
    clock.advance(5);
    await index.upsert({ text: "Gamma release summary" });

    expect(index.size()).to.equal(2);
    const hits = index.search("release", { limit: 5 });
    expect(hits.map((hit) => hit.document.text)).to.deep.equal([
      "Gamma release summary",
      "Beta release summary",
    ]);
  });

  it("rejects file names that would escape the index directory", async () => {
    try {
      await VectorMemoryIndex.create({ directory: rootDir, fileName: "../vector.json" });
      expect.fail("expected VectorMemoryIndex.create to reject a traversal attempt");
    } catch (error) {
      expect(error).to.be.instanceOf(PathResolutionError);
    }

    expect(() =>
      VectorMemoryIndex.createSync({ directory: rootDir, fileName: "..\\vector.json" }),
    ).to.throw(PathResolutionError);
  });

  it("removes documents via deleteMany and persists the truncated index", async () => {
    const index = await VectorMemoryIndex.create({ directory: rootDir, now: () => clock.now() });

    const first = await index.upsert({ text: "Alpha incident post-mortem" });
    clock.advance(1);
    const second = await index.upsert({ text: "Beta incident post-mortem" });

    expect(index.size()).to.equal(2);

    const removed = await index.deleteMany([first.id, "", second.id]);
    expect(removed).to.equal(2);
    expect(index.size()).to.equal(0);

    const reloaded = await VectorMemoryIndex.create({ directory: rootDir });
    expect(reloaded.size()).to.equal(0);
  });

  it("caps the configured capacity to the global ceiling", async () => {
    const index = await VectorMemoryIndex.create({
      directory: rootDir,
      now: () => clock.now(),
      maxDocuments: VECTOR_MEMORY_MAX_CAPACITY * 4,
    });

    const persistStub = sinon.stub(index as unknown as { persist: () => Promise<void> }, "persist").resolves();

    try {
      const oversubscribe = VECTOR_MEMORY_MAX_CAPACITY + 5;
      for (let i = 0; i < oversubscribe; i += 1) {
        await index.upsert({ text: `document ${i}` });
        clock.advance(1);
      }
    } finally {
      persistStub.restore();
    }

    expect(index.size()).to.equal(VECTOR_MEMORY_MAX_CAPACITY);
  });
});
