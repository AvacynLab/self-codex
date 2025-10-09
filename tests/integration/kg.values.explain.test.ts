import { describe, it } from "mocha";
import { expect } from "chai";

import { KnowledgeGraph } from "../../src/knowledge/knowledgeGraph.js";
import { ValueGraph } from "../../src/values/valueGraph.js";
import {
  KgInsertInputSchema,
  KgQueryInputSchema,
  KgSuggestPlanInputSchema,
  handleKgInsert,
  handleKgQuery,
  handleKgSuggestPlan,
  type KnowledgeToolContext,
} from "../../src/tools/knowledgeTools.js";
import {
  ValuesSetInputSchema,
  ValuesExplainInputSchema,
  handleValuesSet,
  handleValuesExplain,
  type ValueToolContext,
} from "../../src/tools/valueTools.js";
import { StructuredLogger } from "../../src/logger.js";

/**
 * Ensures the knowledge and value guard toolchains validate their Zod schemas and produce
 * rich explanations that downstream validation campaigns can persist as artefacts.
 */
describe("knowledge + values tool integration", () => {
  it("validates payloads and returns detailed plan explanations", () => {
    let now = 100;
    const knowledgeGraph = new KnowledgeGraph({ now: () => now });
    const valueGraph = new ValueGraph({ now: () => now });
    const logger = new StructuredLogger();

    const knowledgeContext: KnowledgeToolContext = { knowledgeGraph, logger };
    const valueContext: ValueToolContext = { valueGraph, logger };

    // Populate the knowledge graph with a minimal plan so suggestions and queries succeed.
    const insertInput = KgInsertInputSchema.parse({
      triples: [
        { subject: "project", predicate: "includes", object: "design", confidence: 0.9, source: "playbook" },
        { subject: "project", predicate: "includes", object: "ship", confidence: 0.85, source: "ops" },
        { subject: "task:design", predicate: "label", object: "Design" },
        { subject: "task:ship", predicate: "label", object: "Ship" },
        { subject: "task:ship", predicate: "depends_on", object: "design" },
      ],
    });
    const insertResult = handleKgInsert(knowledgeContext, insertInput);
    expect(insertResult.inserted).to.have.length(5);

    const queryResult = handleKgQuery(
      knowledgeContext,
      KgQueryInputSchema.parse({ predicate: "includes", subject: "project" }),
    );
    expect(queryResult.triples.map((triple) => triple.object)).to.deep.equal(["design", "ship"]);

    const suggestion = handleKgSuggestPlan(
      knowledgeContext,
      KgSuggestPlanInputSchema.parse({ goal: "project", context: { preferred_sources: ["playbook"] } }),
    );
    expect(suggestion.goal).to.equal("project");
    expect(suggestion.fragments).to.not.be.empty;

    // Configure the value graph so the explanation call has meaningful context.
    const setResult = handleValuesSet(
      valueContext,
      ValuesSetInputSchema.parse({
        values: [
          { id: "safety", label: "Safety", tolerance: 0.2 },
          { id: "speed", label: "Speed", tolerance: 0.4 },
        ],
        relationships: [{ from: "safety", to: "speed", kind: "supports", weight: 0.5 }],
        default_threshold: 0.6,
      }),
    );
    expect(setResult.summary.values).to.equal(2);
    expect(setResult.summary.relationships).to.equal(1);

    // The plan intentionally violates the safety tolerance so the explanation surfaces a narrative.
    const explanation = handleValuesExplain(
      valueContext,
      ValuesExplainInputSchema.parse({
        plan: {
          id: "plan-1",
          label: "Launch Iteration",
          impacts: [
            { value: "safety", impact: "risk", severity: 0.9, rationale: "Missing reviews" },
            { value: "speed", impact: "support", severity: 0.3, source: "automation" },
          ],
          run_id: "run-123",
          op_id: "op-xyz",
        },
      }),
    );

    expect(explanation.op_id).to.be.a("string");
    expect(explanation.decision.allowed).to.equal(false);
    expect(explanation.decision.violations).to.not.be.empty;
    expect(explanation.violations[0]).to.have.property("hint");
    expect(explanation.violations[0].primaryContributor).to.not.equal(null);
  });
});
