import { describe, it } from "mocha";
import { expect } from "chai";

import {
  SandboxRegistry,
  SandboxHandlerResult,
} from "../src/sim/sandbox.js";

describe("sandbox registry", () => {
  it("executes registered handlers and returns metrics", async () => {
    const registry = new SandboxRegistry({ defaultTimeoutMs: 500 });
    registry.register("echo", async (request) => {
      expect(request.action).to.equal("echo");
      expect(request.payload).to.deep.equal({ ping: true });
      expect(request.signal.aborted).to.equal(false);
      const result: SandboxHandlerResult = {
        outcome: "success",
        preview: { pong: true },
        metrics: { duration_ms: 12.5, tokens: 4 },
      };
      return result;
    });

    const executed = await registry.execute({
      action: "echo",
      payload: { ping: true },
      metadata: { kind: "unit-test" },
      timeoutMs: 200,
    });

    expect(executed.status).to.equal("ok");
    expect(executed.preview).to.deep.equal({ pong: true });
    expect(executed.metrics).to.deep.equal({ duration_ms: 12.5, tokens: 4 });
    expect(executed.metadata).to.deep.equal({ kind: "unit-test" });
    expect(executed.durationMs).to.be.at.least(0);
  });

  it("records handler failures and timeouts", async () => {
    const registry = new SandboxRegistry({ defaultTimeoutMs: 50 });

    registry.register("fail", async () => ({
      outcome: "failure",
      error: new Error("mock failure"),
      preview: { note: "simulated" },
    }));

    const failed = await registry.execute({ action: "fail", payload: null });
    expect(failed.status).to.equal("error");
    expect(failed.reason).to.match(/mock failure/);
    expect(failed.preview).to.deep.equal({ note: "simulated" });

    registry.register("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { outcome: "success" };
    });

    const timedOut = await registry.execute({ action: "slow", payload: null, timeoutMs: 5 });
    expect(timedOut.status).to.equal("timeout");
    expect(timedOut.reason).to.equal("timeout_after_5ms");
  });

  it("returns skipped status when no handler is registered", async () => {
    const registry = new SandboxRegistry();
    const skipped = await registry.execute({ action: "unknown", payload: 1 });
    expect(skipped.status).to.equal("skipped");
    expect(skipped.reason).to.equal("handler_missing");
  });
});
