import { describe, it } from "mocha";
import { expect } from "chai";

import { KnowledgeGraph } from "../src/knowledge/knowledgeGraph.js";
import { assistKnowledgeQuery, suggestPlanFragments } from "../src/knowledge/assist.js";
import type {
  HybridRetriever,
  HybridRetrieverHit,
  HybridRetrieverSearchOptions,
} from "../src/memory/retriever.js";

/**
 * Recursively asserts that the provided value does not contain explicit
 * `undefined` entries. Nested arrays and objects are traversed to make sure the
 * payloads remain compatible with `exactOptionalPropertyTypes`.
 */
function expectNoUndefined(value: unknown, path = "root"): void {
  if (value === null || value === undefined) {
    if (value === undefined) {
      expect.fail(`Value at ${path} should not be undefined`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoUndefined(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        expect.fail(`Value at ${path}.${key} should not be undefined`);
      }
      expectNoUndefined(entry, `${path}.${key}`);
    }
    return;
  }
}

describe("knowledge optional fields sanitisation", () => {
  it("omits optional plan fragment properties when the graph lacks metadata", () => {
    const graph = new KnowledgeGraph({ now: () => 0 });
    // Register a minimal plan pattern without optional labels or weights so the
    // resulting fragment exercises the optional-field sanitisation path.
    graph.insert({ subject: "plan:incident", predicate: "includes", object: "task:triage" });
    graph.insert({ subject: "task:triage", predicate: "depends_on", object: "task:detect" });
    graph.insert({ subject: "plan:incident", predicate: "includes", object: "task:detect" });

    const suggestion = suggestPlanFragments(graph, { goal: "plan:incident" });

    expect(suggestion.fragments).to.have.lengthOf(1);
    const fragment = suggestion.fragments[0];
    const triageNode = fragment.nodes.find((node) => node.id === "task:triage");
    expect(triageNode).to.exist;
    // The helper must avoid materialising an explicit `label` when the triple
    // does not provide one so strict optional typing can be enforced later on.
    expect(triageNode).to.not.have.property("label");
    expect(fragment.nodes).to.have.lengthOf(2);
    for (const node of fragment.nodes) {
      expect(node).to.not.have.property("label");
      expectNoUndefined(node, `fragment.nodes.${node.id}`);
    }

    // Preferred sources are omitted entirely when the caller does not provide a
    // context. Arrays should default to empty rather than `undefined`.
    expect(suggestion.preferred_sources_applied).to.deep.equal([]);
    expect(suggestion.preferred_sources_ignored).to.deep.equal([]);

    // Ensure no fragment fields leak explicit `undefined` placeholders.
    expectNoUndefined(suggestion);
  });

  it("forwards RAG options without leaking undefined properties", async () => {
    const graph = new KnowledgeGraph({ now: () => 0 });
    graph.insert({
      subject: "runbook",
      predicate: "includes",
      object: "task:escalate",
      source: "kb",
      confidence: 0.9,
    });

    const capturedOptions: HybridRetrieverSearchOptions[] = [];
    const retriever = {
      async search(query: string, options: HybridRetrieverSearchOptions): Promise<HybridRetrieverHit[]> {
        capturedOptions.push({ ...options });
        return [
          {
            id: "rag-1",
            text: "Escalate to the on-call team",
            score: 0.6,
            vectorScore: 0.6,
            lexicalScore: 0.2,
            tags: ["alpha"],
            matchedTags: ["alpha"],
            metadata: {},
            provenance: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ];
      },
    } as unknown as HybridRetriever;

    const result = await assistKnowledgeQuery(graph, {
      query: "Comment escalader un incident ?",
      context: "Prioriser la sévérité",
      ragRetriever: retriever,
      ragLimit: 4,
      ragMinScore: 0.2,
      domainTags: [" Alpha ", "", "beta", "alpha"],
    });

    expect(capturedOptions).to.have.lengthOf(1);
    expect(capturedOptions[0]).to.deep.equal({ limit: 4, minScore: 0.2, requiredTags: ["alpha", "beta"] });

    // The response should echo the trimmed context while omitting any
    // undefined optional fields in nested structures.
    expect(result.context).to.equal("Prioriser la sévérité");
    expect(result.coverage.rag_hits).to.equal(1);
    expect(result.rag_evidence[0]?.matched_tags).to.deep.equal(["alpha"]);
    expectNoUndefined(result);
  });
});
