import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sinon from "sinon";

import { KnowledgeGraph } from "../src/knowledge/knowledgeGraph.js";
import {
  KgAssistInputSchema,
  handleKgAssist,
  type KnowledgeToolContext,
} from "../src/tools/knowledgeTools.js";
import { StructuredLogger } from "../src/logger.js";
import { LocalVectorMemory } from "../src/memory/vectorMemory.js";
import { HybridRetriever } from "../src/memory/retriever.js";

/** Unit tests covering the knowledge assistant helper. */
describe("knowledge assist answers", () => {
  afterEach(() => {
    sinon.restore();
  });
  it("synthesises an answer grounded in the knowledge graph", async () => {
    const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
    const logger = new StructuredLogger({ onEntry: () => undefined });
    const context: KnowledgeToolContext = { knowledgeGraph, logger };

    knowledgeGraph.insert({
      subject: "deploy",
      predicate: "présente",
      object: "risques de panne critique",
      source: "postmortem",
      confidence: 0.82,
      provenance: [{ sourceId: "kg://deploy-risk", type: "kg", confidence: 0.82 }],
    });
    knowledgeGraph.insert({
      subject: "deploy",
      predicate: "has_mitigation",
      object: "progressive rollout",
      source: "runbook",
      confidence: 0.74,
    });

    const parsed = KgAssistInputSchema.parse({ query: "Quels risques lors du déploiement ?", limit: 3 });
    const result = await handleKgAssist(context, parsed);

    expect(result.answer).to.contain("risque");
    expect(result.knowledge_evidence).to.have.length.greaterThan(0);
    expect(result.rag_evidence).to.have.length(0);
    expect(result.citations.some((entry) => entry.type === "kg")).to.equal(true);
    expect(result.coverage.knowledge_hits).to.equal(result.knowledge_evidence.length);
    expect(Object.prototype.hasOwnProperty.call(result, "context")).to.equal(false);
  });

  describe("with rag fallback", () => {
    let indexDir: string;
    let memory: LocalVectorMemory;
    let retriever: HybridRetriever;

    beforeEach(async () => {
      indexDir = await mkdtemp(join(tmpdir(), "kg-assist-rag-"));
      memory = await LocalVectorMemory.create({ directory: indexDir });
      const logger = new StructuredLogger({ onEntry: () => undefined });
      retriever = new HybridRetriever(memory, logger, { defaultLimit: 4, minVectorScore: 0.05 });
    });

    afterEach(async () => {
      await memory.clear();
      await rm(indexDir, { recursive: true, force: true });
    });

    it("falls back to RAG when the knowledge graph lacks relevant facts", async () => {
      const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
      const logger = new StructuredLogger({ onEntry: () => undefined });

      await memory.upsert([
        {
          id: "security-checklist",
          text: "Mettre en place une alerte rollback et monitorer les erreurs critiques.",
          tags: ["security", "release"],
          provenance: [{ sourceId: "rag://rollback-alert", type: "rag", confidence: 0.9 }],
        },
        {
          id: "marketing-update",
          text: "Préparer une annonce marketing.",
          tags: ["marketing"],
          provenance: [{ sourceId: "rag://marketing", type: "rag" }],
        },
      ]);

      const context: KnowledgeToolContext = {
        knowledgeGraph,
        logger,
        rag: {
          getRetriever: async () => retriever,
          defaultDomainTags: ["security"],
          minScore: 0.05,
        },
      };

      const parsed = KgAssistInputSchema.parse({
        query: "Comment détecter un rollback dangereux ?",
        limit: 2,
        min_score: 0.05,
        domain_tags: ["security"],
      });

      const result = await handleKgAssist(context, parsed);

      expect(result.knowledge_evidence).to.have.length(0);
      expect(result.rag_evidence).to.have.length(1);
      expect(result.rag_evidence[0].id).to.equal("security-checklist");
      expect(result.citations.some((entry) => entry.type === "rag")).to.equal(true);
      expect(result.answer).to.contain("alerte rollback");
    });
  });

  it("omits undefined retriever search options when domain tags are absent", async () => {
    const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
    const logger = new StructuredLogger({ onEntry: () => undefined });
    const retriever = { search: sinon.stub().resolves([]) } as unknown as HybridRetriever;

    const context: KnowledgeToolContext = {
      knowledgeGraph,
      logger,
      rag: {
        getRetriever: async () => retriever,
        defaultDomainTags: [],
        minScore: 0.2,
      },
    };

    const parsed = KgAssistInputSchema.parse({ query: "Quelle est la politique de sauvegarde ?", limit: 2 });
    await handleKgAssist(context, parsed);

    sinon.assert.calledOnce(retriever.search as sinon.SinonStub);
    const [, options] = (retriever.search as sinon.SinonStub).firstCall.args as [string, Record<string, unknown>];
    expect(Object.prototype.hasOwnProperty.call(options, "requiredTags")).to.equal(false);
  });
});
