import { describe, it } from "mocha";
import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
  logJournal,
  snapshotKnowledgeGraph,
  restoreKnowledgeGraph,
  snapshotValueGraphConfiguration,
  restoreValueGraphConfiguration,
} from "../src/server.js";

/**
 * End-to-end scenario chaining the plan dry-run, value guard explanation and
 * knowledge graph assistance. The flow starts with a risky graph rejected by
 * the guard, inspects the explanation, then leverages knowledge suggestions and
 * the rewrite preview to execute a safe Behaviour Tree.
 */
describe("plan dry-run with knowledge assisted rewrite", function () {
  this.timeout(20_000);

  it("recovers from a rejected plan by applying the suggested rewrite", async () => {
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();
    const baselineKnowledge = snapshotKnowledgeGraph();
    const baselineValueConfig = snapshotValueGraphConfiguration();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-dry-run-knowledge-e2e", version: "1.0.0-test" });

    try {
      await server.close().catch(() => {});
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      logJournal.reset();
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableEventsBus: true,
        enablePlanLifecycle: true,
        enableReactiveScheduler: true,
        enableBT: true,
        enableStigmergy: true,
        enableAutoscaler: true,
        enableSupervisor: true,
        enableCancellation: true,
        enableValueGuard: true,
        enableValuesExplain: true,
        enableKnowledge: true,
        enableAssist: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-dry-run-knowledge-e2e" } });
      childProcessSupervisor.childrenIndex.restore({});
      restoreKnowledgeGraph([]);
      restoreValueGraphConfiguration(null);

      const insertResponse = await client.callTool({
        name: "kg_insert",
        arguments: {
          triples: [
            {
              subject: "safe-rollout",
              predicate: "includes",
              object: "sanitize",
              source: "playbook",
              confidence: 0.9,
            },
            {
              subject: "safe-rollout",
              predicate: "includes",
              object: "ship",
              source: "playbook",
              confidence: 0.85,
            },
            { subject: "task:sanitize", predicate: "label", object: "Sanitize" },
            { subject: "task:sanitize", predicate: "depends_on", object: "ingest" },
            { subject: "task:ship", predicate: "label", object: "Ship" },
            { subject: "task:ship", predicate: "depends_on", object: "sanitize" },
            { subject: "task:ingest", predicate: "label", object: "Ingest" },
          ],
        },
      });
      expect(insertResponse.isError ?? false).to.equal(false);

      const valuesResponse = await client.callTool({
        name: "values_set",
        arguments: {
          values: [
            { id: "privacy", weight: 1, tolerance: 0.2 },
            { id: "usability", weight: 0.5, tolerance: 0.5 },
          ],
          relationships: [{ from: "privacy", to: "usability", kind: "supports", weight: 0.3 }],
          default_threshold: 0.8,
        },
      });
      expect(valuesResponse.isError ?? false).to.equal(false);

      const riskyPlanGraph = {
        graph_id: "dry-run-kg-plan",
        graph_version: 1,
        nodes: [
          { id: "ingest", label: "Ingest", attributes: { kind: "task", bt_tool: "noop", bt_input_key: "ingest" } },
          {
            id: "scrape",
            label: "Scrape",
            attributes: { kind: "task", avoid: true, bt_tool: "noop", bt_input_key: "scrape" },
          },
          { id: "sanitize", label: "Sanitize", attributes: { kind: "task", bt_tool: "noop", bt_input_key: "sanitize" } },
          { id: "ship", label: "Ship", attributes: { kind: "task", bt_tool: "noop", bt_input_key: "ship" } },
        ],
        edges: [
          { from: "ingest", to: "scrape", label: "next", attributes: {} },
          { from: "scrape", to: "sanitize", label: "next", attributes: {} },
          { from: "sanitize", to: "ship", label: "next", attributes: {} },
        ],
        metadata: {},
      } as const;

      const impacts = [
        {
          nodeId: "scrape",
          value: "privacy",
          impact: "risk" as const,
          severity: 0.9,
          rationale: "Scraping personal data",
        },
        {
          nodeId: "sanitize",
          value: "privacy",
          impact: "support" as const,
          severity: 0.4,
          rationale: "Sanitises sensitive fields",
        },
        {
          nodeId: "ship",
          value: "usability",
          impact: "support" as const,
          severity: 0.5,
          rationale: "Delivers results",
        },
      ];

      const dryRunResponse = await client.callTool({
        name: "plan_dry_run",
        arguments: {
          plan_id: "plan-risky",
          plan_label: "Risky rollout",
          threshold: 0.8,
          graph: riskyPlanGraph,
          impacts,
        },
      });
      expect(dryRunResponse.isError ?? false).to.equal(false);
      const dryRunResult = dryRunResponse.structuredContent as {
        value_guard: { decision: { allowed: boolean; violations: Array<{ value: string }> } } | null;
        rewrite_preview: {
          graph: { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> };
          history: Array<{ rule: string; applied: number }>;
        } | null;
      };

      expect(dryRunResult.value_guard?.decision.allowed).to.equal(false);
      const violationValues = dryRunResult.value_guard?.decision.violations.map((violation) => violation.value) ?? [];
      expect(violationValues).to.include("privacy");
      const preview = dryRunResult.rewrite_preview;
      expect(preview).to.not.equal(null);
      const previewNodeIds = preview?.graph.nodes.map((node) => node.id) ?? [];
      expect(previewNodeIds).to.not.include("scrape");
      expect(previewNodeIds).to.include.members(["ingest", "sanitize", "ship"]);
      const rerouteHistory = preview?.history.find((entry) => entry.rule === "reroute-avoid");
      expect(rerouteHistory?.applied).to.be.greaterThan(0);

      const explainResponse = await client.callTool({
        name: "values_explain",
        arguments: {
          plan: {
            id: "plan-risky",
            label: "Risky rollout",
            impacts,
            threshold: 0.8,
          },
        },
      });
      expect(explainResponse.isError ?? false).to.equal(false);
      const explanation = explainResponse.structuredContent as {
        decision: { allowed: boolean };
        violations: Array<{ value: string; hint?: string }>;
      };
      expect(explanation.decision.allowed).to.equal(false);
      const firstViolation = explanation.violations[0];
      expect(firstViolation?.value).to.equal("privacy");
      if (firstViolation?.hint) {
        expect(firstViolation.hint).to.match(/privacy/i);
      }

      const suggestionResponse = await client.callTool({
        name: "kg_suggest_plan",
        arguments: { goal: "safe-rollout", context: { preferred_sources: ["playbook"], max_fragments: 1 } },
      });
      expect(suggestionResponse.isError ?? false).to.equal(false);
      const suggestion = suggestionResponse.structuredContent as {
        fragments: Array<{ nodes: Array<{ id: string }> }>;
        coverage: { suggested_tasks: string[] };
      };
      expect(suggestion.coverage.suggested_tasks).to.include.members(["sanitize", "ship"]);
      const fragmentNodeIds = suggestion.fragments[0]?.nodes.map((node) => node.id) ?? [];
      expect(fragmentNodeIds).to.include("sanitize");

      const safePlan = {
        id: "safe-rollout",
        nodes: [
          { id: "ingest", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "ingest" } },
          { id: "sanitize", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "sanitize" } },
          { id: "ship", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "ship" } },
        ],
        edges: [
          { id: "ingest->sanitize", from: { nodeId: "ingest" }, to: { nodeId: "sanitize" } },
          { id: "sanitize->ship", from: { nodeId: "sanitize" }, to: { nodeId: "ship" } },
        ],
      } as const;

      const compileResponse = await client.callTool({ name: "plan_compile_bt", arguments: { graph: safePlan } });
      expect(compileResponse.isError ?? false).to.equal(false);
      const compiledTree = compileResponse.structuredContent as { id: string; root: unknown };

      const runResponse = await client.callTool({
        name: "plan_run_bt",
        arguments: {
          tree: compiledTree,
          run_id: "safe-run", 
          op_id: "safe-op",
          job_id: "safe-job",
          graph_id: "safe-rollout",
          node_id: "sanitize",
        },
      });
      expect(runResponse.isError ?? false).to.equal(false);
      const runResult = runResponse.structuredContent as { status: string; idempotent: boolean };
      expect(runResult.status).to.equal("success");
      expect(runResult.idempotent).to.equal(false);
    } finally {
      await logJournal.flush().catch(() => {});
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      restoreKnowledgeGraph(baselineKnowledge);
      restoreValueGraphConfiguration(baselineValueConfig);
      await childProcessSupervisor.disposeAll().catch(() => {});
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});
