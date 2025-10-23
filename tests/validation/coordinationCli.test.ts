import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeCoordinationCli,
  parseCoordinationCliOptions,
  type CoordinationCliOverrides,
} from "../../src/validation/coordinationCli.js";
import {
  COORDINATION_JSONL_FILES,
  type CoordinationPhaseOptions,
  type CoordinationSummary,
} from "../../src/validation/coordination.js";

/** CLI-level tests ensuring the Stage 7 workflow remains ergonomic. */
describe("coordination validation CLI", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-coordination-cli-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("merges coordination overrides without leaking undefined fields", async () => {
    let capturedOptions: CoordinationPhaseOptions | undefined;
    const overrides: CoordinationCliOverrides = {
      phaseOptions: { coordination: { blackboardKey: "base-key", consensusTopic: undefined } },
      runner: async (runRoot, _environment, options) => {
        capturedOptions = options;
        const summary: CoordinationSummary = {
          artefacts: {
            inputsJsonl: join(runRoot, COORDINATION_JSONL_FILES.inputs),
            outputsJsonl: join(runRoot, COORDINATION_JSONL_FILES.outputs),
            eventsJsonl: join(runRoot, COORDINATION_JSONL_FILES.events),
            httpSnapshotLog: join(runRoot, COORDINATION_JSONL_FILES.log),
          },
          blackboard: { eventCount: 0 },
          stigmergy: { marksApplied: 0, lastSnapshot: null },
          contractNet: {},
          consensus: {
            tally: null,
            preferredOutcome: null,
            tieDetectedFromTally: false,
          },
        };
        const summaryPath = join(runRoot, "report", "coordination_summary.json");
        await writeFile(summaryPath, JSON.stringify(summary), "utf8");
        return { outcomes: [], summary, summaryPath };
      },
    };

    const logger = { log: () => undefined };
    const env = {
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "9000",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "",
    } as NodeJS.ProcessEnv;

    await executeCoordinationCli(
      { baseDir: workingDir, runId: "validation_cli", stigDomain: "cli-domain" },
      env,
      logger,
      overrides,
    );

    expect(capturedOptions?.coordination).to.deep.equal({
      blackboardKey: "base-key",
      stigDomain: "cli-domain",
    });
    expect(
      capturedOptions?.coordination &&
        Object.prototype.hasOwnProperty.call(capturedOptions.coordination, "consensusTopic"),
    ).to.equal(false);
    expect(
      capturedOptions?.coordination &&
        Object.prototype.hasOwnProperty.call(capturedOptions.coordination, "contractTopic"),
    ).to.equal(false);
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parseCoordinationCliOptions([
      "--run-id",
      "validation_cli",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--bb-key",
      "custom:key",
      "--stig-domain",
      "custom-domain",
      "--contract-topic",
      "custom-topic",
      "--consensus-topic",
      "custom-consensus",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_cli",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
      blackboardKey: "custom:key",
      stigDomain: "custom-domain",
      contractTopic: "custom-topic",
      consensusTopic: "custom-consensus",
    });
  });

  it("executes the CLI workflow and surfaces artefact locations", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { key: "bb", value: {} } },
      { jsonrpc: "2.0", result: { key: "bb", value: {} } },
      { jsonrpc: "2.0", result: { items: [] } },
      { jsonrpc: "2.0", result: { watch_id: "watch-1", events: [{ type: "bb.set", seq: 1 }] } },
      { jsonrpc: "2.0", result: { key: "bb", value: { status: "in-flight" } } },
      { jsonrpc: "2.0", result: { key: "bb", value: { status: "done" } } },
      { jsonrpc: "2.0", result: { events: [{ type: "bb.update", seq: 2 }, { type: "bb.update", seq: 3 }] } },
      { jsonrpc: "2.0", result: { events: [] } },
      { jsonrpc: "2.0", result: { mark_id: "mark-1" } },
      { jsonrpc: "2.0", result: { marks: [] } },
      { jsonrpc: "2.0", result: { remaining: [] } },
      {
        jsonrpc: "2.0",
        result: {
          announcement_id: "announce-1",
          proposals: [
            { id: "proposal-1", agent_id: "agent.alpha" },
            { id: "proposal-2", agent_id: "agent.beta" },
          ],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          proposals: [
            { id: "proposal-1", agent_id: "agent.alpha" },
            { id: "proposal-2", agent_id: "agent.beta" },
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

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const logs: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => logs.push(args) };

    const { runRoot, result } = await executeCoordinationCli(
      { baseDir: workingDir, runId: "validation_cli" },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9000",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "cli-token",
      } as NodeJS.ProcessEnv,
      logger,
    );

    expect(runRoot).to.equal(join(workingDir, "validation_cli"));
    expect(result.summary.blackboard.eventCount).to.equal(3);
    expect(result.summary.contractNet.proposalCount).to.equal(2);
    expect(result.summary.consensus.outcome).to.equal("validation_tie_break_preference");

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.artefacts.eventsJsonl).to.equal(join(runRoot, COORDINATION_JSONL_FILES.events));

    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(COORDINATION_JSONL_FILES.inputs);
    expect(flattenedLogs).to.contain("Summary");
    expect(flattenedLogs).to.contain("Blackboard events observed");
    expect(flattenedLogs).to.contain("Contract-Net proposals");
    expect(flattenedLogs).to.contain("Consensus outcome");
  });
});
