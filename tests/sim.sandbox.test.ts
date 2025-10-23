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
    // Optional fields should disappear entirely when the handler omits them so
    // the strict optional property semantics stay satisfied.
    expect(failed).to.not.have.property("metadata");
    expect(failed).to.not.have.property("metrics");

    registry.register("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { outcome: "success" };
    });

    const timedOut = await registry.execute({ action: "slow", payload: null, timeoutMs: 5 });
    expect(timedOut.status).to.equal("timeout");
    expect(timedOut.reason).to.equal("timeout_after_5ms");
    expect(timedOut).to.not.have.property("metadata");
  });

  it("returns skipped status when no handler is registered", async () => {
    const registry = new SandboxRegistry();
    const skipped = await registry.execute({ action: "unknown", payload: 1 });
    expect(skipped.status).to.equal("skipped");
    expect(skipped.reason).to.equal("handler_missing");
    expect(skipped).to.not.have.property("metadata");
  });

  it("isole les payloads/metadata et capture les erreurs levées", async () => {
    const registry = new SandboxRegistry({ defaultTimeoutMs: 100 });
    // The payload intentionally mixes plain objects with Arrays, Maps and Sets
    // to ensure the sandbox performs a genuine deep clone instead of relying
    // on mutation errors to protect against shared references.
    const payload = {
      nested: { value: 1 },
      list: [1, 2, 3],
      map: new Map<string, number>([["a", 1]]),
      set: new Set(["alpha"]),
    };
    // Metadata carries its own Set so that the test asserts cloning across all
    // supported container types (records, arrays, sets and maps).
    const metadata = {
      nested: { label: "demo" },
      tags: new Set(["unit", "test"]),
    };
    let payloadMutationBlocked = false;
    let metadataMutationBlocked = false;

    registry.register("mutate", (request) => {
      try {
        (request.payload as { nested: { value: number } }).nested.value = 42;
      } catch {
        payloadMutationBlocked = true;
      }
      try {
        (request.payload as typeof payload).list.push(99);
      } catch {
        payloadMutationBlocked = true;
      }
      try {
        (request.payload as typeof payload).map.set("b", 2);
      } catch {
        payloadMutationBlocked = true;
      }
      try {
        (request.payload as typeof payload).set.add("beta");
      } catch {
        payloadMutationBlocked = true;
      }
      try {
        (request.metadata as { nested: { label: string } }).nested.label = "patched";
      } catch {
        metadataMutationBlocked = true;
      }
      try {
        (request.metadata as typeof metadata).tags.add("patched");
      } catch {
        metadataMutationBlocked = true;
      }
      throw new Error("boom");
    });

    const result = await registry.execute({ action: "mutate", payload, metadata });
    expect(result.status).to.equal("error");
    expect(result.reason).to.equal("boom");
    expect(payloadMutationBlocked).to.equal(true);
    expect(metadataMutationBlocked).to.equal(true);
    expect(payload.nested.value).to.equal(1);
    expect(payload.list).to.deep.equal([1, 2, 3]);
    expect(Array.from(payload.map.entries())).to.deep.equal([["a", 1]]);
    expect(Array.from(payload.set.values())).to.deep.equal(["alpha"]);
    expect(metadata.nested.label).to.equal("demo");
    expect(Array.from(metadata.tags.values())).to.deep.equal(["unit", "test"]);
  });

  it("signale correctement les timeouts et propage l'abort aux handlers", async () => {
    const registry = new SandboxRegistry({ defaultTimeoutMs: 20 });
    let observedAbort = false;

    registry.register("slow", async (request) => {
      request.signal.addEventListener("abort", () => {
        observedAbort = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { outcome: "success" };
    });

    const timedOut = await registry.execute({ action: "slow", payload: null, timeoutMs: 5 });
    expect(timedOut.status).to.equal("timeout");
    expect(timedOut.reason).to.equal("timeout_after_5ms");
    expect(observedAbort).to.equal(true);
  });
});
