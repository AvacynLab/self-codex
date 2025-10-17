import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LocalVectorMemory } from "../../src/memory/vectorMemory.js";
import { HybridRetriever } from "../../src/memory/retriever.js";
import { StructuredLogger } from "../../src/logger.js";
import { handleRagIngest, handleRagQuery, type RagToolContext } from "../../src/tools/ragTools.js";

function createContext(indexDir: string): Promise<RagToolContext> {
  return LocalVectorMemory.create({ directory: indexDir }).then((memory) => {
    const logger = new StructuredLogger({ onEntry: () => undefined });
    const retriever = new HybridRetriever(memory, logger);
    return { memory, retriever, logger };
  });
}

describe("rag tools", () => {
  let indexDir: string;
  let context: RagToolContext;

  beforeEach(async () => {
    indexDir = await mkdtemp(join(tmpdir(), "rag-tools-"));
    context = await createContext(indexDir);
  });

  afterEach(async () => {
    await context.memory.clear();
    await rm(indexDir, { recursive: true, force: true });
  });

  it("chunks documents during ingestion and preserves chunk metadata", async () => {
    const text = [
      "Incident response handbook",
      "\n\n",
      "1. Detect incidents\n2. Contain threats\n3. Recover services",
    ].join("");

    const result = await handleRagIngest(context, {
      documents: [
        {
          id: "ir-handbook",
          text,
          tags: ["Security"],
          provenance: [{ sourceId: "file://handbook.md", type: "file" }],
        },
      ],
      chunk_size: 120,
      chunk_overlap: 20,
      default_tags: ["Runbook"],
    });

    expect(result.documents).to.equal(1);
    expect(result.chunks).to.equal(2);
    expect(result.stored).to.have.length(2);
    expect(result.stored[0].metadata).to.have.property("chunk");
    const chunkMetadata = result.stored[0].metadata.chunk as {
      index: number;
      start: number;
      end: number;
      source_id: string | null;
      document_index: number;
    };
    expect(chunkMetadata.index).to.equal(0);
    expect(chunkMetadata.document_index).to.equal(0);
    expect(chunkMetadata.source_id).to.equal("ir-handbook");
    expect(chunkMetadata.start).to.equal(0);
    expect(chunkMetadata.end).to.be.greaterThan(chunkMetadata.start);
    expect(result.stored[0].tags).to.include.members(["security", "runbook"]);
    expect(result.stored[0].provenance[0].sourceId).to.equal("file://handbook.md");
  });

  it("returns provenance when querying ingested chunks", async () => {
    await handleRagIngest(context, {
      documents: [
        {
          id: "ir-handbook",
          text: "Incident response handbook with containment guidance.",
          tags: ["Security"],
          provenance: [{ sourceId: "file://handbook.md", type: "file" }],
        },
      ],
      default_tags: ["Runbook"],
    });

    const query = await handleRagQuery(context, {
      query: "containment guidance",
      limit: 3,
      min_score: 0.05,
      include_metadata: true,
    });

    expect(query.total).to.equal(1);
    expect(query.hits[0].provenance).to.deep.equal([{ sourceId: "file://handbook.md", type: "file" }]);
    expect(query.hits[0].metadata).to.not.be.null;
    expect(query.hits[0].tags).to.include.members(["security", "runbook"]);
  });
});
