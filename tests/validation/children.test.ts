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
  CHILDREN_JSONL_FILES,
  runChildrenPhase,
  buildChildrenSummary,
} from "../../src/validation/children.js";

/** Unit tests covering the Stage 5 child orchestration validation runner. */
describe("children validation runner", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;
  let runRoot: string;
  let environment: HttpEnvironmentSummary;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-children-runner-"));
    runRoot = await ensureRunStructure(workingDir, "validation_children");
    environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "8080",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "children-token",
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("persists conversation, JSONL artefacts, and summary statistics", async () => {
    const responses = [
      {
        jsonrpc: "2.0",
        result: {
          child: {
            id: "child-123",
            goal: "Collect telemetry for validation stage 5",
            limits: { cpu_ms: 4000, memory_mb: 128, wall_ms: 120000 },
          },
          events: [{ type: "child.spawned", seq: 1 }],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          attached: true,
          events: [{ type: "child.attached", seq: 2 }],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          limits: { cpu_ms: 1500, memory_mb: 96, wall_ms: 60000 },
          events: [{ type: "child.limit.updated", seq: 3 }],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          reply: {
            role: "assistant",
            content: [{ type: "text", text: "Telemetry captured." }],
          },
          events: [{ type: "child.limit.exceeded", seq: 4 }],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          terminated: true,
          events: [{ type: "child.terminated", seq: 5 }],
        },
      },
    ];

    const capturedRequests: Array<{ init?: RequestInit }> = [];

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({ init });
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await runChildrenPhase(runRoot, environment);

    expect(result.outcomes).to.have.lengthOf(5);
    expect(result.summary.childId).to.equal("child-123");
    expect(result.summary.updatedLimits?.cpu_ms).to.equal(1500);
    expect(result.summary.replyText).to.equal("Telemetry captured.");
    expect(result.summary.events.total).to.equal(5);
    expect(result.summary.events.types).to.have.property("child.limit.exceeded", 1);

    expect(result.conversationPath).to.be.a("string");
    const conversation = JSON.parse(await readFile(result.conversationPath!, "utf8"));
    expect(conversation.request).to.have.property("child_id");
    expect(conversation.response).to.have.property("result");

    const inputsLog = await readFile(join(runRoot, CHILDREN_JSONL_FILES.inputs), "utf8");
    const outputsLog = await readFile(join(runRoot, CHILDREN_JSONL_FILES.outputs), "utf8");
    const eventsLog = await readFile(join(runRoot, CHILDREN_JSONL_FILES.events), "utf8");
    const httpLog = await readFile(join(runRoot, CHILDREN_JSONL_FILES.log), "utf8");

    expect(inputsLog).to.contain("child_spawn_codex");
    expect(outputsLog).to.contain("child_kill");
    expect(eventsLog).to.contain("child.limit.updated");
    expect(httpLog).to.contain("limits");

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.childId).to.equal("child-123");
    expect(summaryDocument.artefacts.conversation).to.equal(result.conversationPath);

    const headers = capturedRequests[0]?.init?.headers;
    expect(headers).to.satisfy((value: HeadersInit | undefined) => {
      if (!value) {
        return false;
      }
      if (value instanceof Headers) {
        return value.get("authorization") === "Bearer children-token";
      }
      if (Array.isArray(value)) {
        return value.some(([key, headerValue]) => key.toLowerCase() === "authorization" && headerValue === "Bearer children-token");
      }
      const record = value as Record<string, string>;
      return record.authorization === "Bearer children-token";
    });
  });

  it("builds summaries from pre-recorded outcomes", async () => {
    const responses = [
      {
        jsonrpc: "2.0",
        result: {
          child: {
            id: "child-xyz",
            goal: "Hello child",
            limits: { cpu_ms: 2000, memory_mb: 64, wall_ms: 30000 },
          },
        },
      },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const phaseResult = await runChildrenPhase(runRoot, environment);
    const summary = buildChildrenSummary(runRoot, phaseResult.outcomes, {
      prompt: "Hello child",
      conversationPath: phaseResult.conversationPath,
    });

    expect(summary.calls).to.have.lengthOf(phaseResult.outcomes.length);
    expect(summary.goal).to.equal("Hello child");
    expect(summary.artefacts.requestsJsonl).to.equal(join(runRoot, CHILDREN_JSONL_FILES.inputs));
  });
});
