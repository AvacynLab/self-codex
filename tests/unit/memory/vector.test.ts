import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "chai";

import { VectorMemoryIndex } from "../../../src/memory/vector.js";

const TMP_PREFIX = join(tmpdir(), "vector-index-");

describe("memory/vector", () => {
  it("normalises metadata language and docId fields", async () => {
    const directory = await mkdtemp(TMP_PREFIX);
    let clock = 1;
    const index = await VectorMemoryIndex.create({
      directory,
      maxDocuments: 10,
      maxChunksPerDocument: 4,
      now: () => clock++,
    });

    const stored = await index.upsert({
      id: "chunk-1",
      text: "Document chunk",
      metadata: { document_id: " Doc-42 ", language: "EN" },
    });

    expect(stored.metadata.docId).to.equal("Doc-42");
    expect(stored.metadata.language).to.equal("en");
    expect("document_id" in stored.metadata).to.equal(false);

    await index.clear();
    await rm(directory, { recursive: true, force: true });
  });

  it("enforces the per-document chunk cap by evicting the oldest entries", async () => {
    const directory = await mkdtemp(TMP_PREFIX);
    let clock = 1;
    const index = await VectorMemoryIndex.create({
      directory,
      maxDocuments: 10,
      maxChunksPerDocument: 2,
      now: () => clock++,
    });

    await index.upsert({
      id: "chunk-1",
      text: "Doc 1 chunk",
      metadata: { docId: "doc-1" },
    });
    await index.upsert({
      id: "chunk-2",
      text: "Doc 1 chunk again",
      metadata: { docId: "doc-1" },
    });
    await index.upsert({
      id: "chunk-3",
      text: "Doc 1 new chunk",
      metadata: { docId: "doc-1" },
    });

    expect(index.size()).to.equal(2);
    const deleted = await index.deleteMany(["chunk-1"]);
    expect(deleted).to.equal(0);

    const results = index.search("Doc", { minScore: 0 });
    const identifiers = results.map((hit) => hit.document.id);
    expect(identifiers).to.have.members(["chunk-2", "chunk-3"]);

    await index.clear();
    await rm(directory, { recursive: true, force: true });
  });
});
