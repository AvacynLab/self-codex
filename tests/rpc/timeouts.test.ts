import { expect } from "chai";

import { handleJsonRpc, server } from "../../src/server.js";
import {
  resolveRpcTimeoutBudget,
  normaliseTimeoutBudget,
  setRpcTimeoutOverride,
  resetRpcTimeoutOverrides,
} from "../../src/rpc/timeouts.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Synthetic RPC method registered for timeout enforcement tests. */
const TIMEOUT_PROBE_METHOD = `unit_timeout/${Date.now()}`;

let handlerRegistry: Map<string, unknown> | undefined;

before(() => {
  handlerRegistry = (server.server as unknown as { _requestHandlers?: Map<string, unknown> })._requestHandlers;
  if (!handlerRegistry) {
    throw new Error("JSON-RPC handler registry unavailable");
  }
  handlerRegistry.set(TIMEOUT_PROBE_METHOD, async (request: { params?: unknown }) => {
    const params = request.params;
    const delay =
      params && typeof params === "object" && !Array.isArray(params)
        ? Number((params as { delay_ms?: unknown }).delay_ms ?? 0)
        : 0;
    if (Number.isFinite(delay) && delay > 0) {
      await wait(Math.max(0, Math.trunc(delay)));
    }
    return { ok: true, delay_ms: Number.isFinite(delay) ? Math.max(0, Math.trunc(delay)) : 0 };
  });
});

after(() => {
  handlerRegistry?.delete(TIMEOUT_PROBE_METHOD);
});

afterEach(() => {
  resetRpcTimeoutOverrides();
});

describe("RPC timeouts", () => {
  it("assigns tailored budgets to graph methods", () => {
    const graphBudget = resolveRpcTimeoutBudget("tools/call", "graph_mutate");
    expect(graphBudget.timeoutMs).to.equal(60_000);
    expect(graphBudget.maxMs).to.equal(180_000);

    const observabilityBudget = normaliseTimeoutBudget(resolveRpcTimeoutBudget("resources/list"), null);
    expect(observabilityBudget.timeoutMs).to.equal(15_000);
    expect(observabilityBudget.maxMs).to.equal(45_000);
  });

  it("aborts slow tools once the timeout budget expires", async () => {
    const overrideBudget = { timeoutMs: 25, minMs: 10, maxMs: 50 } as const;
    setRpcTimeoutOverride("method", TIMEOUT_PROBE_METHOD, overrideBudget);

    const startedAt = Date.now();
    const response = await handleJsonRpc(
      {
        jsonrpc: "2.0" as const,
        id: "timeout-test",
        method: TIMEOUT_PROBE_METHOD,
        params: { delay_ms: 200 },
      },
      { transport: "test" },
    );
    const elapsed = Date.now() - startedAt;

    expect(response.error).to.not.equal(undefined);
    expect(response.error?.code).to.equal(-32001);
    expect(response.error?.message).to.equal("JSON-RPC handler exceeded timeout after 25ms");
    expect(response.error?.data).to.deep.equal({ timeout_ms: 25 });
    expect(elapsed).to.be.lessThan(150);
  });
});
