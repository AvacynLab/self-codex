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

  it("captures trace identifiers when the client throws", async () => {
    const scenario: EvaluationScenario = {
      id: "trace-id",
      objective: "propagate trace",
      tags: [],
      constraints: {},
      steps: [{ id: "alpha", tool: "alpha", expect: { success: false } }],
      oracles: [],
    };
    const client = new StubClient([
      {
        toolName: "alpha",
        duration: 5,
        error: { message: "transport failure", traceId: "trace-from-error" },
      },
    ]);

    const summary = await runScenario(scenario, client, { workspaceRoot: resolve(".") });
    expect(summary.steps[0]?.traceId).to.equal("trace-from-error");
    expect(summary.steps[0]?.message).to.equal("transport failure");
  });

  it("reads token usage from alternate metadata fields", async () => {
    const scenario: EvaluationScenario = {
      id: "tokens",
      objective: "aggregate tokens",
      tags: [],
      constraints: {},
      steps: [{ id: "alpha", tool: "alpha", expect: { success: true } }],
      oracles: [],
    };
    const client = new StubClient([
      {
        toolName: "alpha",
        text: "done",
        duration: 7,
        tokens: 11,
        tokenField: "tokensTotal",
      },
    ]);

    const summary = await runScenario(scenario, client, { workspaceRoot: resolve(".") });
    expect(summary.metrics.totalTokens).to.equal(11);
    expect(summary.steps[0]?.tokensConsumed).to.equal(11);
  });

  it("omits optional step messages when invocations succeed", async () => {
    const scenario: EvaluationScenario = {
      id: "message-omission",
      objective: "ensure optional fields stay absent",
      tags: [],
      constraints: {},
      steps: [{ id: "alpha", tool: "alpha", expect: { success: true } }],
      oracles: [],
    };
    const client = new StubClient([{ toolName: "alpha", text: "ok", duration: 5 }]);

    const summary = await runScenario(scenario, client, { workspaceRoot: resolve(".") });
    const result = summary.steps[0]!;
    expect(result.success).to.equal(true);
    expect(Object.prototype.hasOwnProperty.call(result, "message")).to.equal(false);
    expect(result.tokensConsumed).to.equal(null);
  });
});

class StubClient implements EvaluationClient {
  private index = 0;

  constructor(
    private readonly results: Array<{
      toolName: string;
      text?: string;
      duration: number;
      tokens?: number;
      tokenField?: TokenField;
      isError?: boolean;
      error?: { message: string; traceId?: string };
    }>,
  ) {}

  async callTool(
    toolName: string,
    _args: Record<string, unknown>,
    _options?: { phaseId?: string },
  ): Promise<EvaluationClientCallResult> {
    const result = this.results[this.index];
    this.index += 1;
    if (!result) {
      throw new Error(`Unexpected call: ${toolName}`);
    }
    if (result.error) {
      throw new StubTraceError(result.error.message, result.error.traceId);
    }
    let metadata: Record<string, unknown> | undefined;
    if (result.tokens !== undefined) {
      const field: TokenField = result.tokenField ?? "totalTokens";
      metadata = { cost: { [field]: result.tokens } };
    }
    return {
      toolName,
      traceId: `trace-${this.index}`,
      durationMs: result.duration,
      response: {
        isError: result.isError ?? false,
        content: [{ type: "text", text: result.text ?? "" }],
        ...(metadata ? { metadata } : {}),
      },
    };
  }
}

/**
 * Lightweight error carrying a trace identifier so the tests can assert the
 * runner preserves the diagnostic context exposed by transport layers.
 */
class StubTraceError extends Error {
  constructor(message: string, readonly traceId?: string) {
    super(message);
    this.name = "StubTraceError";
  }
}

type TokenField = "totalTokens" | "tokensTotal" | "total";
