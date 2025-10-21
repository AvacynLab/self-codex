import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sinon from "sinon";

import { LocalVectorMemory } from "../../src/memory/vectorMemory.js";
import {
  VectorMemoryIndex,
  type VectorDocumentInput,
  type VectorSearchOptions,
} from "../../src/memory/vector.js";

describe("local vector memory", () => {
  let indexDir: string;

  beforeEach(async () => {
    indexDir = await mkdtemp(join(tmpdir(), "local-vector-memory-"));
  });

  afterEach(() => {
    sinon.restore();
  });

  afterEach(async () => {
    await rm(indexDir, { recursive: true, force: true });
  });

  it("upserts documents and returns defensive snapshots", async () => {
    const memory = await LocalVectorMemory.create({ directory: indexDir });

    const [snapshot] = await memory.upsert([
      {
        text: "Incident response handbook",
        tags: ["incident", "playbook"],
        metadata: { owner: "sre" },
        provenance: [{ sourceId: "https://kb.example.org/ir", type: "url" }],
      },
    ]);

    expect(memory.size()).to.equal(1);
    expect(snapshot.text).to.include("Incident response");
    expect(snapshot.provenance).to.deep.equal([{ sourceId: "https://kb.example.org/ir", type: "url" }]);

    snapshot.metadata.owner = "tampered";
    snapshot.provenance.push({ sourceId: "https://evil", type: "url" });

    const hits = await memory.search("incident response");
    expect(hits).to.have.length(1);
    expect(hits[0].document.metadata.owner).to.equal("sre");
    expect(hits[0].document.provenance).to.deep.equal([
      { sourceId: "https://kb.example.org/ir", type: "url" },
    ]);
  });

  it("filters search results by required tags", async () => {
    const memory = await LocalVectorMemory.create({ directory: indexDir });
    await memory.upsert([
      { text: "Deploy automation pipeline", tags: ["deploy", "automation"] },
      { text: "Rollback strategy playbook", tags: ["rollback", "playbook"] },
    ]);

    const hits = await memory.search("playbook", { requiredTags: ["rollback", "playbook"] });
    expect(hits).to.have.length(1);
    expect(hits[0].document.text).to.include("Rollback");
    expect(hits[0].matchedTags).to.deep.equal(["rollback", "playbook"]);
  });

  it("deletes documents via the vector memory facade", async () => {
    const memory = await LocalVectorMemory.create({ directory: indexDir });
    const [first, second] = await memory.upsert([
      { text: "Alpha retrospective" },
      { text: "Beta retrospective" },
    ]);

    expect(memory.size()).to.equal(2);

    const removed = await memory.delete([first.id, second.id]);
    expect(removed).to.equal(2);
    expect(memory.size()).to.equal(0);
  });

  it("omits undefined optional fields when delegating upserts to the index", async () => {
    const memory = await LocalVectorMemory.create({ directory: indexDir });
    const originalUpsert = VectorMemoryIndex.prototype.upsert;
    const captured: VectorDocumentInput[] = [];
    sinon.stub(VectorMemoryIndex.prototype, "upsert").callsFake(function (this: VectorMemoryIndex, payload) {
      captured.push(payload);
      return originalUpsert.call(this, payload);
    });

    await memory.upsert([{ text: "Observability notebook" }]);

    expect(captured).to.have.length(1);
    const payload = captured[0]!;
    expect(Object.prototype.hasOwnProperty.call(payload, "id")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "tags")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "metadata")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "createdAt")).to.equal(false);
  });

  it("omits absent search options when calling the underlying index", async () => {
    const memory = await LocalVectorMemory.create({ directory: indexDir });
    await memory.upsert([{ text: "Runbook" }]);

    const originalSearch = VectorMemoryIndex.prototype.search;
    const captured: VectorSearchOptions[] = [];
    sinon.stub(VectorMemoryIndex.prototype, "search").callsFake(function (this: VectorMemoryIndex, query, options = {}) {
      captured.push(options);
      return originalSearch.call(this, query, options);
    });

    await memory.search("Runbook");

    expect(captured).to.have.length(1);
    const options = captured[0]!;
    expect(Object.prototype.hasOwnProperty.call(options, "limit")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(options, "minScore")).to.equal(false);
  });
});

