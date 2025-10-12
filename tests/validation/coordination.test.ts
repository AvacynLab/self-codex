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
  COORDINATION_JSONL_FILES,
  buildCoordinationSummary,
  runCoordinationPhase,
} from "../../src/validation/coordination.js";

/** Unit tests covering the Stage 7 coordination validation runner. */
describe("coordination validation runner", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;
  let runRoot: string;
  let environment: HttpEnvironmentSummary;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-coordination-runner-"));
    runRoot = await ensureRunStructure(workingDir, "validation_coordination");
    environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "8080",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "coord-token",
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("persists artefacts and summary statistics for the coordination workflow", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { key: "validation:coordination:task", value: { priority: "high" } } },
      { jsonrpc: "2.0", result: { key: "validation:coordination:task", value: { priority: "high" } } },
      { jsonrpc: "2.0", result: { items: [{ key: "validation:coordination:task", value: { priority: "high" } }] } },
      { jsonrpc: "2.0", result: { watch_id: "watch-1", events: [{ type: "bb.set", seq: 1 }] } },
      { jsonrpc: "2.0", result: { key: "validation:coordination:task", value: { priority: "high", progress: "in-flight" } } },
      { jsonrpc: "2.0", result: { key: "validation:coordination:task", value: { priority: "high", status: "complete" } } },
      {
        jsonrpc: "2.0",
        result: {
          events: [
            { type: "bb.update", seq: 2 },
            { type: "bb.update", seq: 3 },
          ],
        },
      },
      { jsonrpc: "2.0", result: { events: [] } },
      { jsonrpc: "2.0", result: { mark_id: "mark-1" } },
      { jsonrpc: "2.0", result: { marks: [{ key: "beacon", intensity: 0.8 }] } },
      { jsonrpc: "2.0", result: { remaining: [] } },
      {
        jsonrpc: "2.0",
        result: {
          announcement_id: "announce-1",
          proposals: [
            { id: "proposal-1", score: 0.9, agent_id: "agent.alpha" },
            { id: "proposal-2", score: 0.85, agent_id: "agent.beta" },
          ],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          proposals: [
            { id: "proposal-1", score: 0.9, agent_id: "agent.alpha" },
            { id: "proposal-2", score: 0.85, agent_id: "agent.beta" },
          ],
        },
      },
      { jsonrpc: "2.0", result: { announcement_id: "announce-1", awarded_agent_id: "agent.alpha" } },
      {
        jsonrpc: "2.0",
        result: {
          outcome: "validation_tie_break_preference",
          votes: 2,
          tie: false,
          tally: { plan_alpha: 1, plan_beta: 1 },
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          decision: "validation_tie_break_preference",
          votes: 2,
          tie: false,
          tally: { plan_alpha: 1, plan_beta: 1 },
        },
      },
    ];

    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(init.body.toString()));
      }
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await runCoordinationPhase(runRoot, environment);

    expect(result.outcomes).to.have.length(16);
    expect(responses).to.have.length(0);

    const summary = JSON.parse(
      await readFile(join(runRoot, "report", "coordination_summary.json"), "utf8"),
    ) as ReturnType<typeof buildCoordinationSummary>;

    expect(summary.blackboard.key).to.equal("validation:coordination:task");
    expect(summary.blackboard.eventCount).to.equal(3);
    expect(summary.contractNet.announcementId).to.equal("announce-1");
    expect(summary.contractNet.proposalCount).to.equal(2);
    expect(summary.contractNet.awardedAgentId).to.equal("agent.alpha");
    expect(summary.consensus.outcome).to.equal("validation_tie_break_preference");
    expect(summary.consensus.votes).to.equal(2);
    expect(summary.consensus.tieDetectedFromTally).to.equal(true);

    const eventsLog = await readFile(join(runRoot, COORDINATION_JSONL_FILES.events), "utf8");
    const eventEntries = eventsLog.trim().split(/\n+/);
    expect(eventEntries).to.have.length(3);

    const inputsLog = await readFile(join(runRoot, COORDINATION_JSONL_FILES.inputs), "utf8");
    const outputsLog = await readFile(join(runRoot, COORDINATION_JSONL_FILES.outputs), "utf8");
    expect(inputsLog).to.contain("bb_set_initial_task");
    expect(outputsLog).to.contain("cnp_award");

    expect(capturedBodies[0]).to.have.property("method", "bb_set");
  });

  it("fails fast when the Stage 7 invariants are not satisfied", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { key: "validation:coordination:task", value: { priority: "high" } } },
      { jsonrpc: "2.0", result: { key: "validation:coordination:task", value: { priority: "high" } } },
      { jsonrpc: "2.0", result: { items: [] } },
      { jsonrpc: "2.0", result: { watch_id: "watch-1", events: [{ type: "bb.set", seq: 1 }] } },
      { jsonrpc: "2.0", result: { key: "validation:coordination:task", value: { priority: "high" } } },
      { jsonrpc: "2.0", result: { key: "validation:coordination:task", value: { priority: "high" } } },
      { jsonrpc: "2.0", result: { events: [] } },
      { jsonrpc: "2.0", result: { events: [] } },
      { jsonrpc: "2.0", result: { mark_id: "mark-1" } },
      { jsonrpc: "2.0", result: { marks: [] } },
      { jsonrpc: "2.0", result: { remaining: [] } },
      {
        jsonrpc: "2.0",
        result: {
          announcement_id: "announce-1",
          proposals: [{ id: "proposal-1", score: 0.9, agent_id: "agent.alpha" }],
        },
      },
      { jsonrpc: "2.0", result: { proposals: [{ id: "proposal-1", score: 0.9, agent_id: "agent.alpha" }] } },
      { jsonrpc: "2.0", result: { announcement_id: "announce-1" } },
      { jsonrpc: "2.0", result: { outcome: "plan_alpha", votes: 1, tie: false, tally: { plan_alpha: 1 } } },
      { jsonrpc: "2.0", result: { decision: "plan_alpha", votes: 1, tie: false, tally: { plan_alpha: 1 } } },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await runCoordinationPhase(runRoot, environment);
      expect.fail("Expected Stage 07 validation to fail when invariants are not satisfied");
    } catch (error) {
      expect(String(error)).to.match(/Stage 07 validation incomplete/);
    }
  });
});
