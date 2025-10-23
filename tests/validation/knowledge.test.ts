import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectHttpEnvironment,
  ensureRunStructure,
  type HttpEnvironmentSummary,
} from "../../src/validation/runSetup.js";
import {
  KNOWLEDGE_JSONL_FILES,
  buildKnowledgeSummary,
  runKnowledgePhase,
} from "../../src/validation/knowledge.js";

/** Unit tests covering the Stage 8 knowledge & values validation runner. */
describe("knowledge validation runner", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;
  let runRoot: string;
  let environment: HttpEnvironmentSummary;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-knowledge-runner-"));
    runRoot = await ensureRunStructure(workingDir, "validation_knowledge");
    environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "8080",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "knowledge-token",
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("persists artefacts and summary statistics for the knowledge workflow", async () => {
    const responseQueue = [
      { jsonrpc: "2.0", result: { answer: "Les risques principaux", citations: [{ id: "doc-1" }] } },
      {
        jsonrpc: "2.0",
        result: {
          plan: {
            title: "Validation knowledge/values",
            steps: [
              { id: "collect", description: "Collecter les artefacts" },
              { id: "analyser", description: "Analyser les biais" },
            ],
          },
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          graph: {
            nodes: [
              { id: "root" },
              { id: "values" },
              { id: "knowledge" },
            ],
            edges: [
              { from: "root", to: "values" },
              { from: "values", to: "knowledge" },
            ],
          },
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          topic: "gouvernance des connaissances",
          explanation: "Concilier transparence et protection.",
          citations: [{ id: "doc-1" }, { id: "doc-2" }],
          events: [{ type: "values.audit", seq: 1 }],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          topic: "gouvernance des connaissances",
          explanation: "Concilier transparence et protection.",
          citations: [{ id: "doc-1" }],
        },
      },
      { jsonrpc: "2.0", result: { graph: { nodes: [{ id: "values" }] } } },
      { jsonrpc: "2.0", result: { snapshot: { values: ["ethics", "compliance"] } } },
    ];

    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(init.body.toString()));
      }
      const payload = responseQueue.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await runKnowledgePhase(runRoot, environment);

    expect(result.outcomes).to.have.length(7);
    expect(responseQueue).to.have.length(0);

    const summary = JSON.parse(
      await readFile(join(runRoot, "report", "knowledge_summary.json"), "utf8"),
    ) as ReturnType<typeof buildKnowledgeSummary>;

    expect(summary.knowledge.assistQuery).to.contain("risques principaux");
    expect(summary.knowledge.planSteps).to.equal(2);
    expect(summary.values.explanationConsistent).to.equal(true);
    expect(summary.artefacts.valuesGraphExport).to.be.a("string");
    expect(summary.artefacts.causalExport).to.be.a("string");

    const eventsLog = await readFile(join(runRoot, KNOWLEDGE_JSONL_FILES.events), "utf8");
    expect(eventsLog).to.contain("values.audit");

    const valuesExport = JSON.parse(
      await readFile(join(runRoot, "artifacts", "knowledge", "values_graph_export.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(valuesExport).to.have.property("graph");

    const inputsLog = await readFile(join(runRoot, KNOWLEDGE_JSONL_FILES.inputs), "utf8");
    const outputsLog = await readFile(join(runRoot, KNOWLEDGE_JSONL_FILES.outputs), "utf8");
    expect(inputsLog).to.contain("kg_assist_primary");
    expect(outputsLog).to.contain("values_causal_export_snapshot");

    const firstCall = capturedBodies[0] as { method?: string };
    expect(firstCall.method).to.equal("kg_assist");

    const firstOutcomeCall = result.outcomes[0]?.call;
    expect(
      firstOutcomeCall && Object.prototype.hasOwnProperty.call(firstOutcomeCall, "captureEvents"),
    ).to.equal(false);
    const graphExportCall = result.outcomes.find(
      (outcome) => outcome.call.name === "values_graph_export_snapshot",
    );
    expect(graphExportCall?.call.captureEvents).to.equal(false);
  });

  it("throws when values explanations diverge between runs", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { answer: "Analyse", citations: [{ id: "doc-1" }] } },
      { jsonrpc: "2.0", result: { plan: { title: "Plan", steps: [{ id: "collect" }, { id: "analyser" }] } } },
      {
        jsonrpc: "2.0",
        result: {
          graph: {
            nodes: [{ id: "root" }, { id: "values" }, { id: "knowledge" }],
            edges: [
              { from: "root", to: "values" },
              { from: "values", to: "knowledge" },
            ],
          },
        },
      },
      { jsonrpc: "2.0", result: { topic: "ethics", explanation: "Première réponse", citations: [{ id: "doc" }] } },
      { jsonrpc: "2.0", result: { topic: "ethics", explanation: "Deuxième réponse" } },
      { jsonrpc: "2.0", result: { graph: { nodes: [{ id: "values" }] } } },
      { jsonrpc: "2.0", result: { snapshot: {} } },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let error: unknown;
    try {
      await runKnowledgePhase(runRoot, environment);
    } catch (err) {
      error = err;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain("remain stable");
  });

  it("throws when the knowledge subgraph omits requested nodes", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { answer: "Analyse", citations: [{ id: "doc-1" }] } },
      { jsonrpc: "2.0", result: { plan: { title: "Plan", steps: [{ id: "collect" }, { id: "analyser" }] } } },
      {
        jsonrpc: "2.0",
        result: {
          graph: {
            nodes: [{ id: "root" }],
            edges: [],
          },
        },
      },
      { jsonrpc: "2.0", result: { topic: "ethics", explanation: "Réponse", citations: [{ id: "doc" }] } },
      { jsonrpc: "2.0", result: { topic: "ethics", explanation: "Réponse" } },
      { jsonrpc: "2.0", result: { graph: { nodes: [{ id: "values" }] } } },
      { jsonrpc: "2.0", result: { snapshot: {} } },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let error: unknown;
    try {
      await runKnowledgePhase(runRoot, environment);
    } catch (err) {
      error = err;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain("kg_get_subgraph returned");
  });

  it("omits undefined optional fields from the knowledge summary", () => {
    const summary = buildKnowledgeSummary(runRoot, [], {
      valuesGraphExportPath: null,
      causalExportPath: null,
    });

    expect(Object.prototype.hasOwnProperty.call(summary.knowledge, "assistQuery")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(summary.knowledge, "planTitle")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(summary.knowledge, "planSteps")).to.equal(false);
    expect(summary.values.explanationConsistent).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(summary.values, "topic")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(summary.values, "citationCount")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(summary.artefacts, "valuesGraphExport")).to.equal(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(summary.artefacts, "causalExport")).to.equal(false);
  });
});
