import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeKnowledgeCli,
  parseKnowledgeCliOptions,
} from "../../src/validation/knowledgeCli.js";
import { KNOWLEDGE_JSONL_FILES } from "../../src/validation/knowledge.js";

/** CLI-level tests ensuring the Stage 8 workflow remains ergonomic. */
describe("knowledge validation CLI", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-knowledge-cli-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parseKnowledgeCliOptions([
      "--run-id",
      "validation_cli",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--assist-query",
      "Quels risques",
      "--values-topic",
      "gouvernance",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_cli",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
      assistQuery: "Quels risques",
      valuesTopic: "gouvernance",
    });
  });

  it("executes the CLI workflow and surfaces artefact locations", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { answer: "Les risques", citations: [{ id: "doc-1" }] } },
      {
        jsonrpc: "2.0",
        result: {
          plan: { title: "Validation knowledge", steps: [{ id: "collect" }, { id: "analyser" }] },
        },
      },
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
      {
        jsonrpc: "2.0",
        result: {
          topic: "gouvernance",
          explanation: "Stabilité",
          citations: [{ id: "doc-1" }],
        },
      },
      { jsonrpc: "2.0", result: { topic: "gouvernance", explanation: "Stabilité" } },
      { jsonrpc: "2.0", result: { graph: { nodes: [] } } },
      { jsonrpc: "2.0", result: { snapshot: { items: [] } } },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const logs: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => logs.push(args) };

    const { runRoot, result } = await executeKnowledgeCli(
      { baseDir: workingDir, runId: "validation_cli", assistQuery: "Quels risques" },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9000",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "cli-token",
      } as NodeJS.ProcessEnv,
      logger,
    );

    expect(runRoot).to.equal(join(workingDir, "validation_cli"));
    expect(result.summary.knowledge.planSteps).to.equal(2);
    expect(result.summary.values.explanationConsistent).to.equal(true);

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.artefacts.inputsJsonl).to.equal(join(runRoot, KNOWLEDGE_JSONL_FILES.inputs));

    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(KNOWLEDGE_JSONL_FILES.inputs);
    expect(flattenedLogs).to.contain("Knowledge validation summary");
    expect(flattenedLogs).to.contain("assist citations");
    expect(flattenedLogs).to.contain("subgraph:");
  });
});
