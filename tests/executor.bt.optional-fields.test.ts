import { describe, it } from "mocha";
import { expect } from "chai";

import { BehaviorTreeInterpreter, buildBehaviorTree } from "../src/executor/bt/interpreter.js";
import { BehaviorNodeDefinitionSchema } from "../src/executor/bt/types.js";
import type {
  BehaviorNode,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";

/**
 * Behaviour Tree interpreter optional-field handling. These regressions verify
 * the runtime sanitisation introduced while enabling `exactOptionalPropertyTypes`.
 */
describe("behavior tree interpreter optional runtime fields", () => {
  it("sanitises optional definition fields when parsing behaviour trees", () => {
    const definition = BehaviorNodeDefinitionSchema.parse({
      type: "sequence",
      children: [
        {
          type: "task",
          node_id: "noop",
          tool: "noop",
        },
        {
          type: "timeout",
          timeout_category: "fast",
          child: {
            type: "retry",
            max_attempts: 1,
            child: {
              type: "task",
              node_id: "nested",
              tool: "noop",
            },
          },
        },
      ],
    });

    expect(Object.prototype.hasOwnProperty.call(definition, "id")).to.equal(false);
    expect(definition.children).to.have.lengthOf(2);

    const [taskNode, timeoutNode] = definition.children;
    expect(taskNode.type).to.equal("task");
    if (taskNode.type === "task") {
      expect(Object.prototype.hasOwnProperty.call(taskNode, "id")).to.equal(false);
      expect(Object.prototype.hasOwnProperty.call(taskNode, "input_key")).to.equal(false);
    }

    expect(timeoutNode.type).to.equal("timeout");
    if (timeoutNode.type === "timeout") {
      expect(Object.prototype.hasOwnProperty.call(timeoutNode, "id")).to.equal(false);
      expect(Object.prototype.hasOwnProperty.call(timeoutNode, "timeout_ms")).to.equal(false);
      expect(timeoutNode.timeout_category).to.equal("fast");

      const retryNode = timeoutNode.child;
      expect(retryNode.type).to.equal("retry");
      if (retryNode.type === "retry") {
        expect(Object.prototype.hasOwnProperty.call(retryNode, "id")).to.equal(false);
        expect(Object.prototype.hasOwnProperty.call(retryNode, "backoff_ms")).to.equal(false);
        expect(Object.prototype.hasOwnProperty.call(retryNode, "backoff_jitter_ms")).to.equal(false);

        const nestedTask = retryNode.child;
        expect(nestedTask.type).to.equal("task");
        if (nestedTask.type === "task") {
          expect(Object.prototype.hasOwnProperty.call(nestedTask, "id")).to.equal(false);
          expect(Object.prototype.hasOwnProperty.call(nestedTask, "input_key")).to.equal(false);
        }
      }
    }
  });

  it("retains optional definition fields when explicitly provided", () => {
    const definition = BehaviorNodeDefinitionSchema.parse({
      type: "retry",
      id: "retry-node", // Provided identifier should be preserved in the parse result.
      max_attempts: 3,
      backoff_ms: 50,
      child: {
        type: "task",
        id: "task-node",
        node_id: "task",
        tool: "noop",
        input_key: "payload",
      },
    });

    expect(definition.type).to.equal("retry");
    if (definition.type === "retry") {
      expect(definition.id).to.equal("retry-node");
      expect(definition.backoff_ms).to.equal(50);

      const child = definition.child;
      expect(child.type).to.equal("task");
      if (child.type === "task") {
        expect(child.id).to.equal("task-node");
        expect(child.input_key).to.equal("payload");
      }
    }
  });

  it("omits undefined runtime hooks when wiring a tick", async () => {
    const captured: TickRuntime[] = [];
    const stubNode: BehaviorNode = {
      id: "stub",
      async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
        captured.push(runtime);
        return { status: "success" };
      },
      reset(): void {
        // noop reset for the stub node used in the regression.
      },
    };
    const interpreter = new BehaviorTreeInterpreter(stubNode);

    await interpreter.tick({
      // The interpreter expects an invoker even when the stub never calls it.
      invokeTool: async () => undefined,
    });

    expect(captured).to.have.lengthOf(1);
    const runtime = captured[0];
    // The sanitiser must avoid materialising optional keys when the caller
    // omits them so strict optional typing can be enabled globally.
    expect(Object.prototype.hasOwnProperty.call(runtime, "cancellationSignal")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "isCancelled")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "throwIfCancelled")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "recommendTimeout")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "recordTimeoutOutcome")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "random")).to.equal(false);
  });

  it("preserves provided optional hooks and forwards them verbatim", async () => {
    const captured: TickRuntime[] = [];
    const controller = new AbortController();
    const stubNode: BehaviorNode = {
      id: "stub-hooks",
      async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
        captured.push(runtime);
        return { status: "success" };
      },
      reset(): void {},
    };
    const interpreter = new BehaviorTreeInterpreter(stubNode);

    const optionalHooks = {
      cancellationSignal: controller.signal,
      isCancelled: () => true,
      throwIfCancelled: () => {
        throw new Error("cancelled");
      },
      recommendTimeout: () => 42,
      recordTimeoutOutcome: () => undefined,
      random: () => 0.5,
    } as const;

    await interpreter.tick({
      invokeTool: async () => undefined,
      ...optionalHooks,
    });

    expect(captured).to.have.lengthOf(1);
    const runtime = captured[0];
    // All optional hooks must be preserved exactly as provided by callers.
    for (const [key, value] of Object.entries(optionalHooks)) {
      expect(runtime[key as keyof TickRuntime]).to.equal(value);
    }
  });

  it("omits undefined task outputs in the tick result", async () => {
    const tree = buildBehaviorTree(
      {
        type: "task",
        node_id: "noop-task",
        tool: "noop",
      },
      {},
      "bt",
    );
    const interpreter = new BehaviorTreeInterpreter(tree);

    const result = await interpreter.tick({
      invokeTool: async () => undefined,
    });

    expect(result.status).to.equal("success");
    expect(Object.prototype.hasOwnProperty.call(result, "output")).to.equal(false);
  });

  it("preserves concrete task outputs returned by tools", async () => {
    const tree = buildBehaviorTree(
      {
        type: "task",
        node_id: "echo-task",
        tool: "echo",
      },
      {},
      "bt",
    );
    const interpreter = new BehaviorTreeInterpreter(tree);

    const payload = { greeting: "hello" } as const;
    const result = await interpreter.tick({
      invokeTool: async () => payload,
    });

    expect(result).to.deep.equal({ status: "success", output: payload });
  });
});
