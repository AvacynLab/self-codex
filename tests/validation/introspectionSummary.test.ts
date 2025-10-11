import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildIntrospectionSummary,
  persistIntrospectionSummary,
} from "../../src/validation/introspectionSummary.js";
import type { JsonRpcCallOutcome } from "../../src/validation/introspection.js";

/**
 * Fabricates a deterministic {@link JsonRpcCallOutcome} for testing purposes.
 * The helper keeps the payload minimal while still exercising the summary
 * aggregation logic in realistic conditions.
 */
function createOutcome(
  name: string,
  method: string,
  body: unknown,
  overrides: Partial<JsonRpcCallOutcome["check"]> = {},
): JsonRpcCallOutcome {
  return {
    call: { name, method },
    check: {
      name,
      startedAt: "2025-10-10T00:00:00.000Z",
      durationMs: overrides.durationMs ?? 10,
      request: overrides.request ?? {
        method: "POST",
        url: "http://127.0.0.1:8765/mcp",
        headers: {},
        body: { jsonrpc: "2.0", id: `${name}-id`, method },
      },
      response: {
        status: overrides.response?.status ?? 200,
        statusText: overrides.response?.statusText ?? "OK",
        headers: overrides.response?.headers ?? {},
        body,
      },
    },
  };
}

describe("introspection summary", () => {
  let workingDir: string;

  afterEach(async () => {
    if (workingDir) {
      await rm(workingDir, { recursive: true, force: true });
    }
  });

  it("aggregates the key JSON-RPC payloads and event diagnostics", () => {
    const outcomes: JsonRpcCallOutcome[] = [
      createOutcome("mcp_info", "mcp/info", { jsonrpc: "2.0", result: { info: { version: "1.2.3" } } }),
      createOutcome("mcp_capabilities", "mcp/capabilities", {
        jsonrpc: "2.0",
        result: { transports: ["http"], streaming: true },
      }),
      createOutcome("tools_list", "tools/list", {
        jsonrpc: "2.0",
        result: { tools: [{ name: "echo" }] },
      }),
      createOutcome("resources_list", "resources/list", {
        jsonrpc: "2.0",
        result: { resources: [{ name: "sample" }] },
      }),
      createOutcome("events_subscribe", "events/subscribe", {
        jsonrpc: "2.0",
        result: {
          events: [
            { seq: 1, type: "ready" },
            { seq: 3, type: "update" },
            { seq: 2, type: "out-of-order" },
            { type: "missing-seq" },
          ],
        },
      }),
    ];

    const summary = buildIntrospectionSummary(outcomes);

    expect(summary.calls).to.have.lengthOf(outcomes.length);
    expect(summary.info).to.deep.equal({ info: { version: "1.2.3" } });
    expect(summary.capabilities).to.deep.equal({ transports: ["http"], streaming: true });
    expect(summary.tools).to.deep.equal({ tools: [{ name: "echo" }] });
    expect(summary.resources).to.deep.equal({ resources: [{ name: "sample" }] });

    expect(summary.events).to.not.equal(undefined);
    expect(summary.events?.total).to.equal(4);
    expect(summary.events?.samples).to.have.lengthOf(3);
    expect(summary.events?.sequence.analysed).to.equal(true);
    expect(summary.events?.sequence.monotonic).to.equal(false);
    expect(summary.events?.sequence.violations).to.deep.equal([
      { index: 2, previous: 3, current: 2 },
      { index: 3, previous: 2, current: null },
    ]);
  });

  it("persists the summary to the report folder", async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-summary-"));
    const outcomes: JsonRpcCallOutcome[] = [
      createOutcome("mcp_info", "mcp/info", { jsonrpc: "2.0", result: { info: { version: "1.0.0" } } }),
    ];
    const summary = buildIntrospectionSummary(outcomes);

    const summaryPath = await persistIntrospectionSummary(workingDir, summary);
    expect(summaryPath).to.equal(join(workingDir, "report", "introspection_summary.json"));

    const persisted = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(persisted.generatedAt).to.equal(summary.generatedAt);
    expect(persisted.calls).to.have.lengthOf(1);
    expect(persisted.info).to.deep.equal({ info: { version: "1.0.0" } });
  });
});
