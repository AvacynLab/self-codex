import { strict as assert } from "node:assert";

import { BehaviorNodeDefinitionSchema } from "../../../src/executor/bt/types.js";

describe("executor/bt/types", () => {
  it("omits undefined optional fields from parsed definitions", () => {
    const definition = BehaviorNodeDefinitionSchema.parse({
      type: "sequence",
      id: undefined,
      children: [
        {
          type: "task",
          id: undefined,
          node_id: "node-1",
          tool: "tool.echo",
          input_key: undefined,
        },
      ],
    });

    assert.strictEqual(Object.prototype.hasOwnProperty.call(definition, "id"), false);
    const [child] = definition.children;
    assert.strictEqual(Object.prototype.hasOwnProperty.call(child, "id"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(child, "input_key"), false);
  });

  it("requires timeout nodes to define a static timeout or category", () => {
    assert.throws(() => {
      BehaviorNodeDefinitionSchema.parse({
        type: "timeout",
        child: {
          type: "task",
          node_id: "child",
          tool: "noop",
        },
      });
    }, /timeout nodes require timeout_ms or timeout_category/);
  });

  it("rejects non-finite complexity scores", () => {
    assert.throws(() => {
      BehaviorNodeDefinitionSchema.parse({
        type: "timeout",
        timeout_category: "profiling",
        complexity_score: Number.POSITIVE_INFINITY,
        child: {
          type: "task",
          node_id: "child",
          tool: "noop",
        },
      });
    }, /complexity_score must be finite/);
  });
});
