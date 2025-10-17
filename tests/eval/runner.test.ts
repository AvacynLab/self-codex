import { expect } from "chai";
import { describe, it } from "mocha";
import { resolve } from "node:path";

import { runScenario } from "../../src/eval/runner.js";
import type { EvaluationScenario } from "../../src/eval/scenario.js";
import type { EvaluationClient, EvaluationClientCallResult } from "../../src/eval/runner.js";

/**
 * The runner integrates scenario parsing, oracle execution, and constraint
 * checks. These tests rely on a stubbed evaluation client to exercise success
 * and failure paths deterministically.
 */
describe("scenario runner", () => {
  it("reports a successful scenario", async () => {
    const scenario: EvaluationScenario = {
      id: "success",
      objective: "run",
      tags: ["smoke"],
      constraints: { maxDurationMs: 200 },
      steps: [
        { id: "step-1", tool: "alpha", expect: { success: true, match: "ok" } },
        { id: "step-2", tool: "beta", expect: { success: true } },
      ],
      oracles: [
        { type: "regex", pattern: "oracle" },
        { type: "script", module: "tests/fixtures/eval/sampleOracle.mjs" },
      ],
    };
    const client = new StubClient([
      { toolName: "alpha", text: "ok oracle", duration: 40, tokens: 3 },
      { toolName: "beta", text: "follow-up", duration: 50, tokens: 2 },
    ]);
    const summary = await runScenario(scenario, client, { workspaceRoot: resolve(".") });
    expect(summary.success).to.equal(true);
    expect(summary.metrics.totalDurationMs).to.be.closeTo(90, 0.1);
    expect(summary.metrics.totalTokens).to.equal(5);
    expect(summary.constraintViolations).to.deep.equal([]);
  });

  it("captures step failures and halts execution", async () => {
    const scenario: EvaluationScenario = {
      id: "failure",
      objective: "fail",
      tags: [],
      constraints: {},
      steps: [
        {
          id: "fail-step",
          tool: "alpha",
          expect: { success: true, match: { pattern: "^expected$" } },
        },
        { id: "skipped", tool: "beta", expect: { success: true } },
      ],
      oracles: [{ type: "regex", pattern: "noop" }],
    };
    const client = new StubClient([
      { toolName: "alpha", text: "unexpected", duration: 10 },
      { toolName: "beta", text: "should-not-run", duration: 10 },
    ]);
    const summary = await runScenario(scenario, client, { workspaceRoot: resolve(".") });
    expect(summary.success).to.equal(false);
    expect(summary.steps).to.have.length(1);
    expect(summary.failureReasons.some((reason) => /fail-step/.test(reason))).to.equal(true);
  });

  it("flags constraint violations", async () => {
    const scenario: EvaluationScenario = {
      id: "constraints",
      objective: "budget",
      tags: [],
      constraints: { maxTokens: 1, maxToolCalls: 1 },
      steps: [
        { id: "alpha", tool: "alpha", expect: { success: true } },
        { id: "beta", tool: "beta", expect: { success: true } },
      ],
      oracles: [{ type: "regex", pattern: "token" }],
    };
    const client = new StubClient([
      { toolName: "alpha", text: "token", duration: 5, tokens: 1 },
      { toolName: "beta", text: "token", duration: 5, tokens: 4 },
    ]);
    const summary = await runScenario(scenario, client, { workspaceRoot: resolve(".") });
    expect(summary.success).to.equal(false);
    expect(summary.constraintViolations).to.deep.equal([
      "outil x2 > limite 1",
      "tokens 5 > budget 1",
    ]);
  });
});

class StubClient implements EvaluationClient {
  private index = 0;

  constructor(private readonly results: Array<{
    toolName: string;
    text: string;
    duration: number;
    tokens?: number;
    isError?: boolean;
  }>) {}

  async callTool(toolName: string, _args: Record<string, unknown>, _options?: { phaseId?: string }): Promise<EvaluationClientCallResult> {
    const result = this.results[this.index];
    this.index += 1;
    if (!result) {
      throw new Error(`Unexpected call: ${toolName}`);
    }
    return {
      toolName,
      traceId: `trace-${this.index}`,
      durationMs: result.duration,
      response: {
        isError: result.isError ?? false,
        content: [{ type: "text", text: result.text }],
        metadata: result.tokens !== undefined ? { cost: { totalTokens: result.tokens } } : undefined,
      },
    };
  }
}
