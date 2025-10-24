import { expect } from "chai";
import sinon from "sinon";
import { z } from "zod";

import { TaskLeaf } from "../src/executor/bt/nodes.js";
import type { TickRuntime } from "../src/executor/bt/types.js";

/**
 * Behaviour Tree task leaf schema validation ensures runtime payloads honour
 * the declarative contracts provided by plan tools.
 */
describe("behaviour tree task leaf schema validation", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("validates inputs against the provided schema before invoking tools", async () => {
    const schema = z
      .object({
        count: z.number().int().min(0),
      })
      .strict();
    const invokeTool = sinon.stub().resolves({ ok: true });
    const runtime: TickRuntime = {
      invokeTool,
      variables: { payload: { count: 3 } },
    };

    const leaf = new TaskLeaf("schema-validated-task", "noop", { inputKey: "payload", schema });

    const result = await leaf.tick(runtime);

    expect(result).to.deep.equal({ status: "success", output: { ok: true } });
    sinon.assert.calledOnceWithExactly(invokeTool, "noop", { count: 3 });
  });

  it("rejects invalid payloads surfaced by the runtime variables", async () => {
    const schema = z
      .object({
        count: z.number().int().min(0),
      })
      .strict();
    const invokeTool = sinon.stub().resolves({ ok: true });
    const runtime: TickRuntime = {
      invokeTool,
      variables: { payload: { count: -1 } },
    };

    const leaf = new TaskLeaf("schema-invalid-task", "noop", { inputKey: "payload", schema });

    await leaf.tick(runtime).then(
      () => {
        expect.fail("TaskLeaf should not invoke tools when schema validation fails");
      },
      (error) => {
        expect(error).to.be.instanceOf(z.ZodError);
      },
    );
    sinon.assert.notCalled(invokeTool);
  });
});
