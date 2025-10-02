import { describe, it } from "mocha";
import { expect } from "chai";

import { BehaviorTreeInterpreter, buildBehaviorTree } from "../src/executor/bt/interpreter.js";
import type { BehaviorNodeDefinition } from "../src/executor/bt/types.js";

/**
 * Integration tests driving the interpreter end-to-end using the JSON
 * definitions produced by the compiler. The runtime is stubbed so we can assert
 * which tools were invoked during the execution.
 */
describe("behaviour tree interpreter", () => {
  it("executes tasks sequentially and exposes outputs", async () => {
    const definition: BehaviorNodeDefinition = {
      type: "sequence",
      id: "root",
      children: [
        { type: "task", id: "fetch", node_id: "fetch", tool: "noop", input_key: "fetch" },
        { type: "task", id: "deploy", node_id: "deploy", tool: "noop", input_key: "deploy" },
      ],
    };

    const interpreter = new BehaviorTreeInterpreter(buildBehaviorTree(definition));
    const calls: Array<{ tool: string; input: unknown }> = [];

    const result = await interpreter.tick({
      invokeTool: async (tool, input) => {
        calls.push({ tool, input });
        return { tool, input };
      },
      now: () => 0,
      wait: async () => {},
      variables: {
        fetch: { ref: "artifact" },
        deploy: { environment: "staging" },
      },
    });

    expect(result.status).to.equal("success");
    expect(calls).to.have.length(2);
    expect(calls[0]).to.deep.equal({ tool: "noop", input: { ref: "artifact" } });
    expect(calls[1]).to.deep.equal({ tool: "noop", input: { environment: "staging" } });
  });

  it("halts when a guard condition fails and resumes once satisfied", async () => {
    const definition: BehaviorNodeDefinition = {
      type: "sequence",
      id: "root",
      children: [
        { type: "task", id: "fetch", node_id: "fetch", tool: "noop", input_key: "fetch" },
        {
          type: "guard",
          id: "can-deploy",
          condition_key: "allow_deploy",
          expected: true,
          child: { type: "task", id: "deploy", node_id: "deploy", tool: "noop", input_key: "deploy" },
        },
      ],
    };

    const interpreter = new BehaviorTreeInterpreter(buildBehaviorTree(definition));
    const calls: Array<{ tool: string; input: unknown }> = [];

    const firstResult = await interpreter.tick({
      invokeTool: async (tool, input) => {
        calls.push({ tool, input });
        return null;
      },
      now: () => 0,
      wait: async () => {},
      variables: {
        fetch: { ref: "artifact" },
        deploy: { environment: "prod" },
        allow_deploy: false,
      },
    });

    expect(firstResult.status).to.equal("failure");
    expect(calls).to.have.length(1);

    const secondResult = await interpreter.tick({
      invokeTool: async (tool, input) => {
        calls.push({ tool, input });
        return null;
      },
      now: () => 0,
      wait: async () => {},
      variables: {
        fetch: { ref: "artifact" },
        deploy: { environment: "prod" },
        allow_deploy: true,
      },
    });

    expect(secondResult.status).to.equal("success");
    expect(calls).to.have.length(3);
    expect(calls.map((entry) => entry.tool)).to.deep.equal(["noop", "noop", "noop"]);
    expect(calls[2].input).to.deep.equal({ environment: "prod" });
  });
});
