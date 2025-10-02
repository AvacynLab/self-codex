import { z } from "zod";

import {
  type BehaviorNode,
  type BehaviorNodeDefinition,
  type BehaviorTickResult,
  type TickRuntime,
  type ToolInvoker,
} from "./types.js";
import {
  GuardNode,
  ParallelNode,
  RetryNode,
  SelectorNode,
  SequenceNode,
  TaskLeaf,
  TimeoutNode,
} from "./nodes.js";

/** Options accepted while instantiating Behaviour Tree nodes. */
export interface BuildBehaviorTreeOptions {
  /** Optional registry resolving the input schema for each tool. */
  taskSchemas?: Record<string, z.ZodTypeAny>;
}

/**
 * Interpreter responsible for ticking a Behaviour Tree. The class is stateless
 * besides the tree nodes themselves which maintain their cursor/attempt counts.
 */
export class BehaviorTreeInterpreter {
  constructor(private readonly root: BehaviorNode) {}

  /**
   * Execute a single tick using the provided runtime. Terminal results reset the
   * tree automatically so callers can trigger another run without manual cleanup.
   */
  async tick(runtime: Partial<TickRuntime> & { invokeTool: ToolInvoker }): Promise<BehaviorTickResult> {
    const resolvedRuntime: TickRuntime = {
      invokeTool: runtime.invokeTool,
      now: runtime.now ?? (() => Date.now()),
      wait: runtime.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      variables: runtime.variables ?? {},
    };
    const result = await this.root.tick(resolvedRuntime);
    if (result.status !== "running") {
      this.root.reset();
    }
    return result;
  }

  /** Reset the underlying tree to its initial state. */
  reset(): void {
    this.root.reset();
  }
}

/** Build a concrete Behaviour Tree from its serialised definition. */
export function buildBehaviorTree(
  definition: BehaviorNodeDefinition,
  options: BuildBehaviorTreeOptions = {},
  idPrefix = "root",
): BehaviorNode {
  const { taskSchemas = {} } = options;
  let autoIndex = 0;

  function nextId(prefix: string, provided?: string): string {
    if (provided && provided.trim().length > 0) {
      return provided;
    }
    const generated = `${prefix}-${autoIndex}`;
    autoIndex += 1;
    return generated;
  }

  function instantiate(node: BehaviorNodeDefinition, prefix: string): BehaviorNode {
    switch (node.type) {
      case "sequence": {
        const id = nextId(`${prefix}-sequence`, node.id);
        const children = node.children.map((child, index) => instantiate(child, `${id}-${index}`));
        return new SequenceNode(id, children);
      }
      case "selector": {
        const id = nextId(`${prefix}-selector`, node.id);
        const children = node.children.map((child, index) => instantiate(child, `${id}-${index}`));
        return new SelectorNode(id, children);
      }
      case "parallel": {
        const id = nextId(`${prefix}-parallel`, node.id);
        const children = node.children.map((child, index) => instantiate(child, `${id}-${index}`));
        return new ParallelNode(id, node.policy, children);
      }
      case "retry": {
        const id = nextId(`${prefix}-retry`, node.id);
        const child = instantiate(node.child, `${id}-child`);
        return new RetryNode(id, node.max_attempts, child, node.backoff_ms);
      }
      case "timeout": {
        const id = nextId(`${prefix}-timeout`, node.id);
        const child = instantiate(node.child, `${id}-child`);
        return new TimeoutNode(id, node.timeout_ms, child);
      }
      case "guard": {
        const id = nextId(`${prefix}-guard`, node.id);
        const child = instantiate(node.child, `${id}-child`);
        return new GuardNode(id, node.condition_key, node.expected, child);
      }
      case "task": {
        const id = nextId(`${prefix}-task`, node.id ?? node.node_id);
        const schema = taskSchemas[node.tool];
        return new TaskLeaf(id, node.tool, { inputKey: node.input_key, schema });
      }
      default: {
        const exhaustive: never = node;
        throw new Error(`Unsupported node type ${(exhaustive as { type: string }).type}`);
      }
    }
  }

  return instantiate(definition, idPrefix);
}
