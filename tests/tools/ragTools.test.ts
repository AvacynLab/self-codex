import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  LocalVectorMemory,
  type VectorMemory,
  type VectorMemoryUpsertInput,
  type VectorMemorySearchHit,
  type VectorMemorySearchOptions,
} from "../../src/memory/vectorMemory.js";
import type { VectorMemoryDocument } from "../../src/memory/vector.js";
import { HybridRetriever } from "../../src/memory/retriever.js";
import { StructuredLogger } from "../../src/logger.js";
import { handleRagIngest, handleRagQuery, type RagToolContext } from "../../src/tools/ragTools.js";

/**
 * In-memory `VectorMemory` double recording each upsert batch. The helper keeps
 * the surface aligned with the production contract while exposing the raw
 * payloads so tests can assert optional properties remain omitted.
 */
class RecordingVectorMemory implements VectorMemory {
  public readonly batches: VectorMemoryUpsertInput[][] = [];

  size(): number {
    return 0;
  }

  async clear(): Promise<void> {
    this.batches.splice(0, this.batches.length);
  }

  async delete(_ids: Iterable<string>): Promise<number> {
    return 0;
  }

  async upsert(inputs: VectorMemoryUpsertInput[]): Promise<VectorMemoryDocument[]> {
    this.batches.push(inputs.map((entry) => ({ ...entry })));
    return inputs.map((input, index) => ({
      id: input.id ?? `generated-${index}`,
      text: input.text,
      tags: [...(input.tags ?? [])],
      metadata: { ...(input.metadata ?? {}) },
      provenance: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      embedding: {},
      norm: 0,
      tokenCount: input.text.length,
    }));
  }

  async search(
    _query: string,
    _options?: VectorMemorySearchOptions,
  ): Promise<VectorMemorySearchHit[]> {
    return [];
  }
}

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

  it("omits vector identifiers when documents omit ids", async () => {
    const memory = new RecordingVectorMemory();
    const logger = new StructuredLogger({ onEntry: () => undefined });
    const retriever = new HybridRetriever(memory, logger);
    const context: RagToolContext = { memory, retriever, logger };

    await handleRagIngest(context, {
      documents: [
        {
          text: "Standalone note without deterministic identifier.",
          provenance: [{ sourceId: "note.md", type: "file" }],
        },
      ],
    });

    expect(memory.batches).to.have.lengthOf(1);
    const [batch] = memory.batches;
    expect(batch).to.have.lengthOf(1);
    expect(Object.prototype.hasOwnProperty.call(batch[0]!, "id"))
      .to.equal(false, "upsert payloads must omit id when no base document id is supplied");
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

  it("omits metadata when callers disable metadata inclusion", async () => {
    await handleRagIngest(context, {
      documents: [
        {
          id: "ir-handbook",
          text: "Incident response handbook with containment guidance.",
          tags: ["Security"],
          provenance: [{ sourceId: "file://handbook.md", type: "file" }],
        },
      ],
    });

    const query = await handleRagQuery(context, {
      query: "containment guidance",
      limit: 1,
      min_score: 0.05,
      include_metadata: false,
    });

    expect(query.total).to.equal(1);
    expect(query.hits[0].metadata).to.equal(null);
  });

  it("drops undefined provenance fields before forwarding to the vector memory", async () => {
    const memory = new RecordingVectorMemory();
    const logger = new StructuredLogger({ onEntry: () => undefined });
    const retriever = new HybridRetriever(memory, logger);
    const context: RagToolContext = { memory, retriever, logger };

    await handleRagIngest(context, {
      documents: [
        {
          text: "Document with partially specified provenance metadata.",
          provenance: [
            { sourceId: "doc-1", type: "file", span: undefined, confidence: undefined },
            { sourceId: "doc-2", type: "url", span: [0, 10] },
          ],
        },
      ],
    });

    const [batch] = memory.batches;
    expect(batch).to.have.lengthOf(1);
    const [payload] = batch;
    expect(payload?.provenance).to.be.an("array").with.length(2);
    expect(Object.prototype.hasOwnProperty.call(payload?.provenance?.[0] ?? {}, "span")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(payload?.provenance?.[0] ?? {}, "confidence")).to.equal(false);
    expect(payload?.provenance?.[1]).to.have.property("span");
  });
});
