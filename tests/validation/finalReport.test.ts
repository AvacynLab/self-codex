import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFinalReport } from "../../src/validation/finalReport.js";

/**
 * Integration-style assertions for the final report aggregator. The suite
 * fabricates a miniature validation run containing a handful of JSONL artefacts
 * so we can confirm the generated findings, summary and recommendations match
 * the new playbook expectations captured in AGENTS.md.
 */
describe("validation final report", () => {
  let workspaceRoot: string;
  let runRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "codex-final-report-"));
    runRoot = join(workspaceRoot, "runs", "validation_2099-01-01");
    await mkdir(join(runRoot, "inputs"), { recursive: true });
    await mkdir(join(runRoot, "outputs"), { recursive: true });
    await mkdir(join(runRoot, "events"), { recursive: true });
    await mkdir(join(runRoot, "logs"), { recursive: true });
    await mkdir(join(runRoot, "report"), { recursive: true });

    // Stage 00 context so the preflight section is marked as complete.
    await writeFile(
      join(runRoot, "report", "context.json"),
      `${JSON.stringify({ generatedAt: "2099-01-01T00:00:00Z", runId: "validation_2099-01-01" }, null, 2)}\n`,
      "utf8",
    );

    // Stage 05 — spawn succeeds, send fails to exercise incident reporting.
    await writeFile(
      join(runRoot, "inputs", "02_tx.jsonl"),
      [
        {
          name: "nominal:tx_begin_initial",
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: { authorization: "Bearer token" },
            body: { jsonrpc: "2.0", id: "1", method: "tx_begin", params: { graph_id: "g" } },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "outputs", "02_tx.jsonl"),
      [
        {
          name: "nominal:tx_begin_initial",
          startedAt: "2099-01-01T00:00:00Z",
          durationMs: 90,
          response: { status: 200, statusText: "OK", headers: {}, body: { result: { transaction_id: "tx-1" } } },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    // Stage 04 — record the Graph Forge analysis call only so the report flags
    // the missing autosave coverage. The autosave artefacts are intentionally
    // absent which should surface a checklist reminder in the findings.
    await writeFile(
      join(runRoot, "inputs", "04_forge.jsonl"),
      [
        {
          name: "graph_forge_analyze",
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: { authorization: "Bearer token" },
            body: {
              jsonrpc: "2.0",
              id: "graph_forge_analyze_stage4",
              method: "tools/call",
              params: {
                name: "graph_forge_analyze",
                arguments: { source: "graph sample", entry_graph: "ValidationPipeline" },
              },
            },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "outputs", "04_forge.jsonl"),
      [
        {
          name: "graph_forge_analyze",
          startedAt: "2099-01-01T00:00:03Z",
          durationMs: 180,
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { result: { content: [{ type: "text", text: "{\"report\":\"ok\"}" }] } },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(join(runRoot, "events", "04_forge.jsonl"), "", "utf8");
    await writeFile(join(runRoot, "logs", "graph_forge_http.json"), "{}\n", "utf8");
    await mkdir(join(runRoot, "artifacts", "forge"), { recursive: true });
    await writeFile(join(runRoot, "artifacts", "forge", "analysis.json"), "{\"status\":\"ok\"}\n", "utf8");

    await writeFile(
      join(runRoot, "inputs", "05_children.jsonl"),
      [
        {
          name: "spawn:child_spawn_codex",
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: { authorization: "Bearer token" },
            body: { jsonrpc: "2.0", id: "1", method: "child_spawn_codex", params: { goal: "test" } },
          },
        },
        {
          name: "interaction:child_send",
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: { authorization: "Bearer token" },
            body: {
              jsonrpc: "2.0",
              id: "2",
              method: "child_send",
              params: { child_id: "child-1", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
            },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "outputs", "05_children.jsonl"),
      [
        {
          name: "spawn:child_spawn_codex",
          startedAt: "2099-01-01T00:00:01Z",
          durationMs: 120,
          response: { status: 200, statusText: "OK", headers: {}, body: { result: { child_id: "child-1" } } },
        },
        {
          name: "interaction:child_send",
          startedAt: "2099-01-01T00:00:02Z",
          durationMs: 450,
          response: {
            status: 429,
            statusText: "Too Many Requests",
            headers: {},
            body: { error: "quota exceeded" },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "events", "05_children.jsonl"),
      [
        { scenario: "spawn", event: { type: "child.spawned" } },
        { scenario: "interaction", event: { type: "child.limit.exceeded" } },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    // Stage 05 HTTP log and artefact directory so the byte accounting covers
    // logs, summaries and auxiliary folders in addition to JSONL traces.
    await writeFile(join(runRoot, "logs", "children_http.json"), "{}\n", "utf8");
    await mkdir(join(runRoot, "artifacts", "children"), { recursive: true });
    await writeFile(join(runRoot, "artifacts", "children", "conversation.json"), "{\"messages\":[]}\n", "utf8");
    await writeFile(
      join(runRoot, "report", "children_summary.json"),
      `${JSON.stringify(
        {
          capturedAt: "2099-01-01T00:00:03Z",
          childId: "child-1",
          calls: [
            {
              scenario: "spawn",
              name: "spawn:child_spawn_codex",
              method: "child_spawn_codex",
              status: 200,
              durationMs: 120,
            },
            {
              scenario: "interaction",
              name: "interaction:child_send",
              method: "child_send",
              status: 429,
              durationMs: 450,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Stage 06 — compile succeeds, run_bt succeeds but lifecycle/cancellation
    // coverage is intentionally omitted to trigger the checklist hints.
    await writeFile(
      join(runRoot, "inputs", "06_plans.jsonl"),
      [
        {
          name: "compile:plan_compile_bt",
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: { authorization: "Bearer token" },
            body: { jsonrpc: "2.0", id: "11", method: "plan_compile_bt", params: { graph_id: "validation_plan_bt" } },
          },
        },
        {
          name: "run_bt:plan_run_bt",
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: { authorization: "Bearer token" },
            body: {
              jsonrpc: "2.0",
              id: "12",
              method: "plan_run_bt",
              params: { tree: { id: "validation_plan_bt" }, variables: { payload: { objective: "validation" } } },
            },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "outputs", "06_plans.jsonl"),
      [
        {
          name: "compile:plan_compile_bt",
          startedAt: "2099-01-01T00:00:04Z",
          durationMs: 210,
          response: { status: 200, statusText: "OK", headers: {}, body: { result: { tree: { id: "validation_plan_bt" } } } },
        },
        {
          name: "run_bt:plan_run_bt",
          startedAt: "2099-01-01T00:00:05Z",
          durationMs: 320,
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { result: { run_id: "validation_bt_run", op_id: "plan-op-1", final_status: "SUCCESS" } },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "events", "06_plans.jsonl"),
      [
        { event: { seq: 1, type: "plan.status", status: "RUNNING" } },
        { event: { seq: 2, type: "plan.status", status: "SUCCESS" } },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(join(runRoot, "logs", "plans_http.json"), "{}\n", "utf8");
    await writeFile(
      join(runRoot, "report", "plans_summary.json"),
      `${JSON.stringify({ completedAt: "2099-01-01T00:00:06Z" }, null, 2)}\n`,
      "utf8",
    );

    // Stage 08 — capture a single knowledge query so the coverage logic can
    // highlight the missing values scenarios and associated JSON-RPC methods.
    await writeFile(
      join(runRoot, "inputs", "08_knowledge.jsonl"),
      [
        {
          name: "knowledge:kg_assist_primary",
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: { authorization: "Bearer token" },
            body: {
              jsonrpc: "2.0",
              id: "21",
              method: "kg_assist",
              params: { query: "help", context: "validation" },
            },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "outputs", "08_knowledge.jsonl"),
      [
        {
          name: "knowledge:kg_assist_primary",
          startedAt: "2099-01-01T00:00:07Z",
          durationMs: 150,
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { result: { answer: "Voici un plan" } },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "events", "08_knowledge.jsonl"),
      [
        { scenario: "knowledge", event: { seq: 1, type: "knowledge.event" } },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(join(runRoot, "logs", "knowledge_http.json"), "{}\n", "utf8");
    await mkdir(join(runRoot, "artifacts", "knowledge"), { recursive: true });
    await writeFile(join(runRoot, "artifacts", "knowledge", "subgraph.json"), "{\"nodes\":[]}\n", "utf8");
    await writeFile(
      join(runRoot, "report", "knowledge_summary.json"),
      `${JSON.stringify({ analysedAt: "2099-01-01T00:00:08Z" }, null, 2)}\n`,
      "utf8",
    );

    // Stage 09 — record a single invalid-schema probe so the final report can
    // point out the missing robustness checks (unknown tool, idempotency,
    // crash simulation and timeout handling).
    await writeFile(
      join(runRoot, "inputs", "09_robustness.jsonl"),
      [
        {
          name: "invalid-schema:graph_diff_invalid",
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: { authorization: "Bearer token" },
            body: {
              jsonrpc: "2.0",
              id: "31",
              method: "graph_diff",
              params: { graph_id: 42 },
            },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "outputs", "09_robustness.jsonl"),
      [
        {
          name: "invalid-schema:graph_diff_invalid",
          startedAt: "2099-01-01T00:00:09Z",
          durationMs: 50,
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { result: { ok: true } },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "events", "09_robustness.jsonl"),
      [
        {
          scenario: "invalid-schema",
          event: { seq: 1, type: "robustness.invalid" },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(join(runRoot, "logs", "robustness_http.json"), "{}\n", "utf8");
    await writeFile(
      join(runRoot, "report", "robustness_summary.json"),
      `${JSON.stringify({ completedAt: "2099-01-01T00:00:09Z" }, null, 2)}\n`,
      "utf8",
    );

    // Stage 10 — capture a single latency probe so the coverage logic flags the
    // missing concurrency burst required by the playbook.
    await writeFile(
      join(runRoot, "inputs", "10_performance.jsonl"),
      [
        {
          scenario: "latency",
          name: "tools_call_echo",
          attempt: 0,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "latency sample" } },
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: { authorization: "Bearer token" },
            body: {
              jsonrpc: "2.0",
              id: "performance-1",
              method: "tools/call",
              params: { name: "echo", arguments: { text: "latency sample" } },
            },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "outputs", "10_performance.jsonl"),
      [
        {
          scenario: "latency",
          name: "tools_call_echo",
          attempt: 0,
          durationMs: 75,
          response: { status: 200, statusText: "OK", headers: {}, body: { result: { content: "ok" } } },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "events", "10_performance.jsonl"),
      [
        {
          scenario: "latency",
          name: "tools_call_echo",
          capturedAt: "2099-01-01T00:00:09Z",
          event: { seq: 1, type: "performance.latency", durationMs: 75 },
        },
        {
          scenario: "latency",
          name: "tools_call_echo",
          capturedAt: "2099-01-01T00:00:09Z",
          event: { seq: 2, type: "performance.summary", samples: 1 },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(join(runRoot, "logs", "performance_http.json"), "{}\n", "utf8");
    await writeFile(
      join(runRoot, "report", "perf_summary.json"),
      `${JSON.stringify(
        {
          artefacts: {
            inputsJsonl: join(runRoot, "inputs", "10_performance.jsonl"),
            outputsJsonl: join(runRoot, "outputs", "10_performance.jsonl"),
            eventsJsonl: join(runRoot, "events", "10_performance.jsonl"),
            httpSnapshotLog: join(runRoot, "logs", "performance_http.json"),
          },
          latency: {
            label: "echo latency",
            toolName: "echo",
            samples: 1,
            averageMs: 75,
            minMs: 75,
            maxMs: 75,
            p50Ms: 75,
            p95Ms: 75,
            p99Ms: 75,
          },
          concurrency: { groups: [] },
          logs: {
            path: "/tmp/mcp_http.log",
            existedBefore: true,
            existedAfter: true,
            sizeBeforeBytes: 1024,
            sizeAfterBytes: 2048,
            growthBytes: 1024,
            rotated: false,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Stage 11 — only capture the unauthorized probe so coverage hints flag
    // the missing filesystem and redaction checks.
    await writeFile(
      join(runRoot, "inputs", "11_security.jsonl"),
      [
        {
          scenario: "auth",
          name: "unauthorized:mcp_info",
          method: "mcp/info",
          request: {
            method: "POST",
            url: "http://localhost:8765/mcp",
            headers: {},
            body: {
              jsonrpc: "2.0",
              id: "security-unauthorized",
              method: "mcp/info",
              params: {},
            },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "outputs", "11_security.jsonl"),
      [
        {
          scenario: "auth",
          name: "unauthorized:mcp_info",
          method: "mcp/info",
          startedAt: "2099-01-01T00:00:10Z",
          durationMs: 33,
          response: {
            status: 401,
            statusText: "Unauthorized",
            headers: {},
            body: { error: { code: 401, message: "missing token" } },
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(
      join(runRoot, "events", "11_security.jsonl"),
      [
        {
          scenario: "auth",
          name: "unauthorized:mcp_info",
          event: { seq: 1, type: "security.unauthorized", status: 401 },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    await writeFile(join(runRoot, "logs", "security_http.json"), "{}\n", "utf8");
    await writeFile(
      join(runRoot, "report", "security_summary.json"),
      `${JSON.stringify(
        {
          checks: [
            {
              scenario: "auth",
              name: "unauthorized:mcp_info",
              method: "mcp/info",
              status: 401,
              statusText: "Unauthorized",
              requireAuth: false,
            },
          ],
          unauthorized: {
            calls: [
              {
                scenario: "auth",
                name: "unauthorized:mcp_info",
                status: 401,
                success: true,
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Stage 07 — introduce out-of-order sequences to ensure detection works.
    await writeFile(
      join(runRoot, "events", "07_coord.jsonl"),
      [
        { event: { seq: 10, type: "bb_set" } },
        { event: { seq: 12, type: "bb_get" } },
        { event: { seq: 11, type: "bb_query" } },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    // Stage 01 introspection summary provides expected tool coverage.
    await writeFile(
      join(runRoot, "report", "introspection_summary.json"),
      `${JSON.stringify(
        {
          tools: {
            tools: [
              { name: "child_spawn_codex" },
              { name: "child_send" },
              { name: "graph_patch" },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Custom package manifest so the report surfaces deterministic versions.
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ version: "9.9.9-test", dependencies: { "@modelcontextprotocol/sdk": "1.2.3" } }, null, 2)}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("aggregates artefacts into findings, summary and recommendations", async () => {
    const clock = () => new Date("2099-01-01T12:00:00Z");
    const result = await runFinalReport(runRoot, {
      now: clock,
      packageJsonPath: join(workspaceRoot, "package.json"),
    });

    expect(result.runId).to.equal("validation_2099-01-01");
    expect(result.findings.metrics.totalCalls).to.equal(10);
    expect(result.findings.metrics.errorCount).to.equal(2);
    expect(result.findings.tools).to.have.lengthOf(10);
    expect(result.findings.tools.some((tool) => tool.toolName === "tx_begin")).to.equal(true);

    const childSend = result.findings.tools.find((tool) => tool.toolName === "child_send");
    expect(childSend?.status).to.equal("KO");
    expect(childSend?.latency.p50Ms).to.equal(450);
    expect(childSend?.latency.p95Ms).to.equal(450);
    expect(childSend?.latency.p99Ms).to.equal(450);

    expect(result.findings.coverage.missingTools).to.deep.equal(["graph_patch"]);
    expect(result.findings.incidents).to.have.lengthOf(2);
    expect(result.findings.incidents.map((incident) => incident.errorMessage)).to.include("quota exceeded");

    const stageTransactions = result.findings.stages.find((stage) => stage.id === "03");
    expect(stageTransactions?.scenarios).to.deep.equal(["nominal"]);
    expect(stageTransactions?.missingScenarios).to.deep.equal(["concurrency", "error", "export"]);
    expect(stageTransactions?.methods).to.deep.equal(["tx_begin"]);
    expect(stageTransactions?.missingMethods).to.deep.equal([
      "causal_export",
      "graph_diff",
      "graph_lock",
      "graph_patch",
      "graph_unlock",
      "tx_commit",
      "tx_rollback",
      "values_graph_export",
    ]);
    expect(stageTransactions?.notes).to.include("scénarios manquants: concurrency, error, export");
    expect(stageTransactions?.notes).to.include("méthodes manquantes: causal_export");

    const stageForge = result.findings.stages.find((stage) => stage.id === "04");
    expect(stageForge?.scenarios).to.deep.equal(["graph_forge_analyze"]);
    expect(stageForge?.missingScenarios).to.deep.equal(["graph_state_autosave"]);
    expect(stageForge?.calls).to.deep.equal(["graph_forge_analyze"]);
    expect(stageForge?.missingCalls).to.deep.equal([
      "graph_state_autosave:start",
      "graph_state_autosave:stop",
    ]);
    expect(stageForge?.methods).to.deep.equal(["tools/call"]);
    expect(stageForge?.missingMethods).to.deep.equal([]);
    expect(stageForge?.notes).to.include("scénarios manquants: graph_state_autosave");
    expect(stageForge?.notes).to.include(
      "appels manquants: graph_state_autosave:start, graph_state_autosave:stop",
    );
    expect(stageForge?.eventSequenceMonotonic).to.equal(null);

    const stageChildren = result.findings.stages.find((stage) => stage.id === "05");
    expect(stageChildren?.notes).to.include("séquence événements indisponible");
    expect(stageChildren?.notes).to.include("scénarios manquants: attach, limits, teardown");
    expect(stageChildren?.notes).to.include("méthodes manquantes: child_attach, child_kill, child_set_limits");
    expect(stageChildren?.notes).to.include("spawn enfant réussi (statut 200, id child-1)");
    expect(stageChildren?.eventSequenceMonotonic).to.equal(null);
    expect(stageChildren?.scenarios).to.deep.equal(["interaction", "spawn"]);
    expect(stageChildren?.missingScenarios).to.deep.equal(["attach", "limits", "teardown"]);
    expect(stageChildren?.methods).to.deep.equal(["child_send", "child_spawn_codex"]);
    expect(stageChildren?.missingMethods).to.deep.equal(["child_attach", "child_kill", "child_set_limits"]);

    const expectedTransactionsBytes =
      (await stat(join(runRoot, "inputs", "02_tx.jsonl"))).size +
      (await stat(join(runRoot, "outputs", "02_tx.jsonl"))).size;

    const expectedForgeBytes =
      (await stat(join(runRoot, "inputs", "04_forge.jsonl"))).size +
      (await stat(join(runRoot, "outputs", "04_forge.jsonl"))).size +
      (await stat(join(runRoot, "events", "04_forge.jsonl"))).size +
      (await stat(join(runRoot, "logs", "graph_forge_http.json"))).size +
      (await stat(join(runRoot, "artifacts", "forge", "analysis.json"))).size;
    expect(stageForge?.artefactBytes).to.equal(expectedForgeBytes);

    const expectedChildrenBytes =
      (await stat(join(runRoot, "inputs", "05_children.jsonl"))).size +
      (await stat(join(runRoot, "outputs", "05_children.jsonl"))).size +
      (await stat(join(runRoot, "events", "05_children.jsonl"))).size +
      (await stat(join(runRoot, "logs", "children_http.json"))).size +
      (await stat(join(runRoot, "report", "children_summary.json"))).size +
      (await stat(join(runRoot, "artifacts", "children", "conversation.json"))).size;
    expect(stageChildren?.artefactBytes).to.equal(expectedChildrenBytes);

    expect(stageTransactions?.artefactBytes).to.equal(expectedTransactionsBytes);

    const stagePlans = result.findings.stages.find((stage) => stage.id === "06");
    expect(stagePlans?.scenarios).to.deep.equal(["compile", "run_bt"]);
    expect(stagePlans?.missingScenarios).to.deep.equal(["cancellation", "lifecycle", "reactive"]);
    expect(stagePlans?.methods).to.deep.equal(["plan_compile_bt", "plan_run_bt"]);
    expect(stagePlans?.missingMethods).to.deep.equal([
      "plan_cancel",
      "plan_pause",
      "plan_resume",
      "plan_run_reactive",
      "plan_status",
    ]);
    expect(stagePlans?.notes).to.include("scénarios manquants: cancellation, lifecycle, reactive");
    expect(stagePlans?.notes).to.include("méthodes manquantes: plan_cancel");

    const expectedPlansBytes =
      (await stat(join(runRoot, "inputs", "06_plans.jsonl"))).size +
      (await stat(join(runRoot, "outputs", "06_plans.jsonl"))).size +
      (await stat(join(runRoot, "events", "06_plans.jsonl"))).size +
      (await stat(join(runRoot, "logs", "plans_http.json"))).size +
      (await stat(join(runRoot, "report", "plans_summary.json"))).size;
    expect(stagePlans?.artefactBytes).to.equal(expectedPlansBytes);

    const stageKnowledge = result.findings.stages.find((stage) => stage.id === "08");
    expect(stageKnowledge?.scenarios).to.deep.equal(["knowledge"]);
    expect(stageKnowledge?.missingScenarios).to.deep.equal(["values"]);
    expect(stageKnowledge?.methods).to.deep.equal(["kg_assist"]);
    expect(stageKnowledge?.missingMethods).to.deep.equal([
      "causal_export",
      "kg_get_subgraph",
      "kg_suggest_plan",
      "values_explain",
      "values_graph_export",
    ]);
    expect(stageKnowledge?.notes).to.include("scénarios manquants: values");
    expect(stageKnowledge?.notes).to.include("méthodes manquantes: causal_export");
    expect(stageKnowledge?.eventSequenceMonotonic).to.equal(true);

    const expectedKnowledgeBytes =
      (await stat(join(runRoot, "inputs", "08_knowledge.jsonl"))).size +
      (await stat(join(runRoot, "outputs", "08_knowledge.jsonl"))).size +
      (await stat(join(runRoot, "events", "08_knowledge.jsonl"))).size +
      (await stat(join(runRoot, "logs", "knowledge_http.json"))).size +
      (await stat(join(runRoot, "report", "knowledge_summary.json"))).size +
      (await stat(join(runRoot, "artifacts", "knowledge", "subgraph.json"))).size;
    expect(stageKnowledge?.artefactBytes).to.equal(expectedKnowledgeBytes);

    const stageRobustness = result.findings.stages.find((stage) => stage.id === "09");
    expect(stageRobustness?.scenarios).to.deep.equal(["invalid-schema"]);
    expect(stageRobustness?.missingScenarios).to.deep.equal([
      "child-crash",
      "idempotency",
      "timeout",
      "unknown-tool",
    ]);
    expect(stageRobustness?.methods).to.deep.equal(["graph_diff"]);
    expect(stageRobustness?.missingMethods).to.deep.equal([
      "child_spawn_codex",
      "plan_run_reactive",
      "tool_unknown_method",
      "tx_begin",
    ]);
    expect(stageRobustness?.notes).to.include("scénarios manquants: child-crash, idempotency, timeout, unknown-tool");
    expect(stageRobustness?.notes).to.include(
      "méthodes manquantes: child_spawn_codex, plan_run_reactive, tool_unknown_method, tx_begin",
    );
    expect(stageRobustness?.eventSequenceMonotonic).to.equal(true);

    const expectedRobustnessBytes =
      (await stat(join(runRoot, "inputs", "09_robustness.jsonl"))).size +
      (await stat(join(runRoot, "outputs", "09_robustness.jsonl"))).size +
      (await stat(join(runRoot, "events", "09_robustness.jsonl"))).size +
      (await stat(join(runRoot, "logs", "robustness_http.json"))).size +
      (await stat(join(runRoot, "report", "robustness_summary.json"))).size;
    expect(stageRobustness?.artefactBytes).to.equal(expectedRobustnessBytes);

    const stagePerformance = result.findings.stages.find((stage) => stage.id === "10");
    expect(stagePerformance?.scenarios).to.deep.equal(["latency"]);
    expect(stagePerformance?.missingScenarios).to.deep.equal(["concurrency"]);
    expect(stagePerformance?.methods).to.deep.equal(["tools/call"]);
    expect(stagePerformance?.missingMethods).to.deep.equal([]);
    expect(stagePerformance?.notes).to.include("scénarios manquants: concurrency");
    expect(stagePerformance?.eventSequenceMonotonic).to.equal(true);

    const expectedPerformanceBytes =
      (await stat(join(runRoot, "inputs", "10_performance.jsonl"))).size +
      (await stat(join(runRoot, "outputs", "10_performance.jsonl"))).size +
      (await stat(join(runRoot, "events", "10_performance.jsonl"))).size +
      (await stat(join(runRoot, "logs", "performance_http.json"))).size +
      (await stat(join(runRoot, "report", "perf_summary.json"))).size;
    expect(stagePerformance?.artefactBytes).to.equal(expectedPerformanceBytes);

    const stageSecurity = result.findings.stages.find((stage) => stage.id === "11");
    expect(stageSecurity?.scenarios).to.deep.equal(["auth"]);
    expect(stageSecurity?.missingScenarios).to.deep.equal(["filesystem", "redaction"]);
    expect(stageSecurity?.methods).to.deep.equal(["mcp/info"]);
    expect(stageSecurity?.missingMethods).to.deep.equal(["tools/call"]);
    expect(stageSecurity?.notes).to.include("scénarios manquants: filesystem, redaction");
    expect(stageSecurity?.notes).to.include("méthodes manquantes: tools/call");
    expect(stageSecurity?.eventSequenceMonotonic).to.equal(true);

    const expectedSecurityBytes =
      (await stat(join(runRoot, "inputs", "11_security.jsonl"))).size +
      (await stat(join(runRoot, "outputs", "11_security.jsonl"))).size +
      (await stat(join(runRoot, "events", "11_security.jsonl"))).size +
      (await stat(join(runRoot, "logs", "security_http.json"))).size +
      (await stat(join(runRoot, "report", "security_summary.json"))).size;
    expect(stageSecurity?.artefactBytes).to.equal(expectedSecurityBytes);

    const expectedContextBytes = (await stat(join(runRoot, "report", "context.json"))).size;
    const expectedIntrospectionBytes = (await stat(join(runRoot, "report", "introspection_summary.json"))).size;
    const expectedCoordinationBytes = (await stat(join(runRoot, "events", "07_coord.jsonl"))).size;
    const expectedTotalBytes =
      expectedTransactionsBytes +
      expectedForgeBytes +
      expectedChildrenBytes +
      expectedPlansBytes +
      expectedKnowledgeBytes +
      expectedRobustnessBytes +
      expectedPerformanceBytes +
      expectedSecurityBytes +
      expectedContextBytes +
      expectedIntrospectionBytes +
      expectedCoordinationBytes;

    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "03", bytes: expectedTransactionsBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "04", bytes: expectedForgeBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "05", bytes: expectedChildrenBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "06", bytes: expectedPlansBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "08", bytes: expectedKnowledgeBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "09", bytes: expectedRobustnessBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "10", bytes: expectedPerformanceBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "11", bytes: expectedSecurityBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "00", bytes: expectedContextBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "01", bytes: expectedIntrospectionBytes });
    expect(result.findings.kpis.artefactBytes.byStage).to.deep.include({ stageId: "07", bytes: expectedCoordinationBytes });
    expect(result.findings.kpis.artefactBytes.total).to.equal(expectedTotalBytes);

    const stageCoordination = result.findings.stages.find((stage) => stage.id === "07");
    expect(stageCoordination?.notes).to.include("séquence événements non monotone");
    expect(stageCoordination?.eventSequenceMonotonic).to.equal(false);
    expect(stageCoordination?.scenarios).to.deep.equal([]);
    expect(stageCoordination?.missingScenarios).to.deep.equal([
      "blackboard",
      "consensus",
      "contract-net",
      "stigmergy",
    ]);
    expect(stageCoordination?.methods).to.deep.equal([]);
    expect(stageCoordination?.missingMethods).to.deep.equal([
      "bb_get",
      "bb_query",
      "bb_set",
      "bb_watch",
      "bb_watch_poll",
      "cnp_announce",
      "cnp_award",
      "cnp_poll",
      "consensus_status",
      "consensus_vote",
      "stig_decay",
      "stig_mark",
      "stig_snapshot",
    ]);
    expect(stageCoordination?.notes).to.include(
      "scénarios manquants: blackboard, consensus, contract-net, stigmergy",
    );
    expect(stageCoordination?.notes).to.include(
      "méthodes manquantes: bb_get, bb_query, bb_set, bb_watch, bb_watch_poll",
    );

    expect(result.findings.kpis.eventSequences).to.deep.include({ stageId: "05", monotonic: null });
    expect(result.findings.kpis.eventSequences).to.deep.include({ stageId: "06", monotonic: true });
    expect(result.findings.kpis.eventSequences).to.deep.include({ stageId: "07", monotonic: false });
    expect(result.findings.kpis.eventSequences).to.deep.include({ stageId: "08", monotonic: true });
    expect(result.findings.kpis.eventSequences).to.deep.include({ stageId: "09", monotonic: true });
    expect(result.findings.kpis.eventSequences).to.deep.include({ stageId: "10", monotonic: true });
    expect(result.findings.kpis.eventSequences).to.deep.include({ stageId: "11", monotonic: true });

    const findingsRaw = await readFile(result.findingsPath, "utf8");
    expect(findingsRaw).to.include("\"totalCalls\": 2");

    const summaryRaw = await readFile(result.summaryPath, "utf8");
    expect(summaryRaw).to.include("Validation report");
    expect(summaryRaw).to.include("Enfants / self-fork");
    expect(summaryRaw).to.include("Planification & exécution");
    expect(summaryRaw).to.include("Connaissance & valeurs");
    expect(summaryRaw).to.include("Robustesse & erreurs");
    expect(summaryRaw).to.include("Performance");
    expect(summaryRaw).to.include("Sécurité & redaction");
    expect(summaryRaw).to.include("p50 (ms)");
    expect(summaryRaw).to.include("Séquences événements");
    expect(summaryRaw).to.include("séquence non monotone");
    expect(summaryRaw).to.include("Taille totale des artefacts");
    expect(summaryRaw).to.include("scénarios manquants");
    expect(summaryRaw).to.include("appels manquants: graph_state_autosave:start, graph_state_autosave:stop");
    expect(summaryRaw).to.include("child_attach, child_kill, child_set_limits");
    expect(summaryRaw).to.include("plan_cancel, plan_pause, plan_resume, plan_run_reactive, plan_status");
    expect(summaryRaw).to.include("bb_get, bb_query, bb_set, bb_watch, bb_watch_poll");
    expect(summaryRaw).to.include("child_spawn_codex, plan_run_reactive, tool_unknown_method, tx_begin");
    expect(summaryRaw).to.include("scénarios manquants: concurrency");
    expect(summaryRaw).to.include("scénarios manquants: filesystem, redaction");
    expect(summaryRaw).to.include("spawn enfant réussi (statut 200, id child-1)");
    expect(summaryRaw).to.include("kg_get_subgraph, kg_suggest_plan, values_explain, values_graph_export");
    expect(summaryRaw).to.include("méthodes manquantes: tools/call");

    const recommendationsRaw = await readFile(result.recommendationsPath, "utf8");
    expect(recommendationsRaw).to.include("quota exceeded");
  });

  it("normalises whitespace-separated autosave call labels before computing coverage", async () => {
    const autosaveInputs = [
      {
        name: "graph_state_autosave start",
        request: {
          method: "POST",
          url: "http://localhost:8765/mcp",
          headers: { authorization: "Bearer token" },
          body: {
            jsonrpc: "2.0",
            id: "graph_state_autosave_start_stage4",
            method: "tools/call",
            params: {
              name: "graph_state_autosave",
              arguments: { action: "start", path: "autosave.json", interval_ms: 1500 },
            },
          },
        },
      },
      {
        name: "graph_state_autosave stop",
        request: {
          method: "POST",
          url: "http://localhost:8765/mcp",
          headers: { authorization: "Bearer token" },
          body: {
            jsonrpc: "2.0",
            id: "graph_state_autosave_stop_stage4",
            method: "tools/call",
            params: { name: "graph_state_autosave", arguments: { action: "stop" } },
          },
        },
      },
    ];

    const autosaveOutputs = [
      {
        name: "graph_state_autosave start",
        startedAt: "2099-01-01T00:00:04Z",
        durationMs: 120,
        response: { status: 200, statusText: "OK", headers: {}, body: { result: { ok: true } } },
      },
      {
        name: "graph_state_autosave stop",
        startedAt: "2099-01-01T00:00:06Z",
        durationMs: 80,
        response: { status: 200, statusText: "OK", headers: {}, body: { result: { ok: true } } },
      },
    ];

    await writeFile(
      join(runRoot, "inputs", "04_forge.jsonl"),
      autosaveInputs.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      { encoding: "utf8", flag: "a" },
    );

    await writeFile(
      join(runRoot, "outputs", "04_forge.jsonl"),
      autosaveOutputs.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      { encoding: "utf8", flag: "a" },
    );

    const clock = () => new Date("2099-01-01T12:00:00Z");
    const result = await runFinalReport(runRoot, {
      now: clock,
      packageJsonPath: join(workspaceRoot, "package.json"),
    });

    const stageForge = result.findings.stages.find((stage) => stage.id === "04");
    expect(stageForge?.calls).to.deep.equal([
      "graph_forge_analyze",
      "graph_state_autosave:start",
      "graph_state_autosave:stop",
    ]);
    expect(stageForge?.missingCalls).to.deep.equal([]);
    expect(stageForge?.scenarios).to.deep.equal(["graph_forge_analyze", "graph_state_autosave"]);
    expect(stageForge?.missingScenarios).to.deep.equal([]);
  });
});
