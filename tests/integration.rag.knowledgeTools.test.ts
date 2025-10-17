import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StructuredLogger } from "../src/logger.js";
import { LocalVectorMemory } from "../src/memory/vectorMemory.js";
import { HybridRetriever } from "../src/memory/retriever.js";
import { handleRagIngest, handleRagQuery, type RagToolContext } from "../src/tools/ragTools.js";
import { KnowledgeGraph } from "../src/knowledge/knowledgeGraph.js";
import { handleKgInsert, handleKgQuery, type KnowledgeToolContext } from "../src/tools/knowledgeTools.js";

/**
 * Integration coverage ensuring that `rag_ingest` / `rag_query` outputs can be
 * forwarded into knowledge-graph tooling while preserving provenance metadata.
 */
describe("rag + knowledge tools integration", () => {
  let indexDir: string;
  let ragContext: RagToolContext;
  let knowledgeGraph: KnowledgeGraph;
  let knowledgeContext: KnowledgeToolContext;

  beforeEach(async () => {
    indexDir = await mkdtemp(join(tmpdir(), "rag-kg-"));

    // Initialise an in-memory vector backend and hybrid retriever for RAG.
    const memory = await LocalVectorMemory.create({ directory: indexDir });
    const logger = new StructuredLogger({ onEntry: () => undefined });
    const retriever = new HybridRetriever(memory, logger);
    ragContext = { memory, retriever, logger };

    // Knowledge tooling relies on the shared logger for auditability.
    knowledgeGraph = new KnowledgeGraph();
    knowledgeContext = { knowledgeGraph, logger };
  });

  afterEach(async () => {
    await ragContext.memory.clear();
    await rm(indexDir, { recursive: true, force: true });
  });

  it("propagates rag chunk provenance into stored knowledge triples", async () => {
    // Seed the vector memory with a runbook excerpt that downstream planners could cite.
    await handleRagIngest(ragContext, {
      documents: [
        {
          id: "ir-handbook",
          text: "Incident response handbook with containment and recovery steps.",
          tags: ["Security", "Runbook"],
          provenance: [{ sourceId: "file://handbook.md", type: "file" }],
        },
      ],
      chunk_size: 256,
      chunk_overlap: 32,
    });

    // Query for containment guidance so we capture the provenance emitted by the retriever.
    const ragResult = await handleRagQuery(ragContext, {
      query: "containment guidance",
      limit: 2,
      min_score: 0.05,
      include_metadata: true,
    });

    expect(ragResult.total).to.equal(1);
    const hit = ragResult.hits[0];

    // Use the retrieved chunk as evidence for a new knowledge triple, carrying RAG provenance forward.
    const insertResult = handleKgInsert(knowledgeContext, {
      triples: [
        {
          subject: "incident-response",
          predicate: "has-runbook",
          object: "containment",
          source: "rag_ingest",
          confidence: 0.9,
          provenance: [
            ...hit.provenance,
            { sourceId: `rag://${hit.id}`, type: "rag", span: [0, hit.text.length], confidence: 0.8 },
          ],
        },
      ],
    });

    expect(insertResult.created).to.equal(1);
    expect(insertResult.total).to.equal(1);

    const queryResult = handleKgQuery(knowledgeContext, {
      subject: "incident-response",
      limit: 5,
      order: "asc",
    });

    expect(queryResult.total).to.equal(1);
    const triple = queryResult.triples[0];
    expect(triple.subject).to.equal("incident-response");
    expect(triple.predicate).to.equal("has-runbook");
    expect(triple.object).to.equal("containment");

    // The stored triple must reference both the original file and the derived RAG chunk as provenance inputs.
    const provenanceSources = triple.provenance.map((entry) => `${entry.type}:${entry.sourceId}`);
    expect(provenanceSources).to.include("file:file://handbook.md");
    expect(provenanceSources).to.include(`rag:rag://${hit.id}`);

    const ragEntry = triple.provenance.find((entry) => entry.type === "rag");
    expect(ragEntry?.span).to.deep.equal([0, hit.text.length]);
    expect(ragEntry?.confidence).to.equal(0.8);
  });
});
