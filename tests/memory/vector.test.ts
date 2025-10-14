import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { VectorMemoryIndex } from "../../src/memory/vector.js";

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

    await index.upsert({ text: "Incident response contain eradicate", tags: ["incident", "contain"] });
    clock.advance(10);
    await index.upsert({ text: "Deploy automation pipeline and rollback", tags: ["deploy"] });
    clock.advance(10);
    await index.upsert({ text: "Contain malware and isolate hosts", tags: ["incident"] });

    const hits = index.search("contain incident response", { limit: 2, minScore: 0.2 });
    expect(hits).to.have.length(2);
    expect(hits[0].document.text).to.include("Incident response");
    expect(hits[1].document.text).to.include("Contain malware");
    expect(hits[0].score).to.be.greaterThan(hits[1].score);
  });

  it("persists entries on disk and reloads them on startup", async () => {
    const index = await VectorMemoryIndex.create({ directory: rootDir, now: () => clock.now() });

    await index.upsert({
      text: "Generate remediation plan and document findings",
      tags: ["plan", "remediation"],
      metadata: { source: "child_collect", child_id: "child-123" },
    });

    const reloaded = await VectorMemoryIndex.create({ directory: rootDir });
    expect(reloaded.size()).to.equal(1);

    const hits = reloaded.search("remediation plan", { limit: 1 });
    expect(hits).to.have.length(1);
    expect(hits[0].document.metadata.child_id).to.equal("child-123");
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
});
