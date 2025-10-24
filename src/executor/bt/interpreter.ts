import { runtimeTimers } from "../../runtime/timers.js";
import { omitUndefinedEntries } from "../../utils/object.js";

import {
  type BTStatus,
  type BehaviorNode,
  type BehaviorTaskSchema,
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
  CancellableNode,
} from "./nodes.js";

/** Options accepted while instantiating Behaviour Tree nodes. */
export interface BuildBehaviorTreeOptions {
  /** Optional registry resolving the input schema for each tool. */
  taskSchemas?: Record<string, BehaviorTaskSchema>;
  /** Optional callback invoked whenever a node reports a new status. */
  statusReporter?: (nodeId: string, status: BTStatus) => void;
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
    const optionalServices = omitUndefinedEntries({
      /** Forward optional hooks only when explicitly provided by the runtime. */
      random: runtime.random,
      cancellationSignal: runtime.cancellationSignal,
      isCancelled: runtime.isCancelled,
      throwIfCancelled: runtime.throwIfCancelled,
      recommendTimeout: runtime.recommendTimeout,
      recordTimeoutOutcome: runtime.recordTimeoutOutcome,
    });
    const resolvedRuntime: TickRuntime = {
      invokeTool: runtime.invokeTool,
      now: runtime.now ?? (() => Date.now()),
      wait:
        runtime.wait ??
        ((ms: number) =>
          new Promise((resolve) => {
            runtimeTimers.setTimeout(resolve, ms);
          })),
      /**
       * Behaviour Tree nodes observe a snapshot of the variable map. When
       * callers omit it we default to an empty record to avoid leaking
       * `variables: undefined` once strict optional typing is enforced.
       */
      variables: runtime.variables ?? {},
      ...optionalServices,
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
  const { taskSchemas = {}, statusReporter } = options;
  let autoIndex = 0;

  function nextId(prefix: string, provided?: string): string {
    if (provided && provided.trim().length > 0) {
      return provided;
    }
    const generated = `${prefix}-${autoIndex}`;
    autoIndex += 1;
    return generated;
  }

  function track(node: BehaviorNode): BehaviorNode {
    if (!statusReporter) {
      return node;
    }
    return {
      id: node.id,
      async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
        statusReporter(node.id, "running");
        try {
          const result = await node.tick(runtime);
          statusReporter(node.id, result.status);
          return result;
        } catch (error) {
          statusReporter(node.id, "failure");
          throw error;
        }
      },
      reset(): void {
        node.reset();
      },
    } satisfies BehaviorNode;
  }

  function instantiate(node: BehaviorNodeDefinition, prefix: string): BehaviorNode {
    switch (node.type) {
      case "sequence": {
        const id = nextId(`${prefix}-sequence`, node.id);
        const children = node.children.map((child, index) => instantiate(child, `${id}-${index}`));
        return track(new SequenceNode(id, children));
      }
      case "selector": {
        const id = nextId(`${prefix}-selector`, node.id);
        const children = node.children.map((child, index) => instantiate(child, `${id}-${index}`));
        return track(new SelectorNode(id, children));
      }
      case "parallel": {
        const id = nextId(`${prefix}-parallel`, node.id);
        const children = node.children.map((child, index) => instantiate(child, `${id}-${index}`));
        return track(new ParallelNode(id, node.policy, children));
      }
      case "retry": {
        const id = nextId(`${prefix}-retry`, node.id);
        const child = instantiate(node.child, `${id}-child`);
        return track(new RetryNode(id, node.max_attempts, child, node.backoff_ms, node.backoff_jitter_ms));
      }
      case "timeout": {
        const id = nextId(`${prefix}-timeout`, node.id);
        const child = instantiate(node.child, `${id}-child`);
        return track(
          new TimeoutNode(
            id,
            node.timeout_ms ?? null,
            child,
            { category: node.timeout_category ?? null, complexityScore: node.complexity_score ?? null },
          ),
        );
      }
      case "guard": {
        const id = nextId(`${prefix}-guard`, node.id);
        const child = instantiate(node.child, `${id}-child`);
        return track(new GuardNode(id, node.condition_key, node.expected, child));
      }
      case "cancellable": {
        const id = nextId(`${prefix}-cancellable`, node.id);
        const child = instantiate(node.child, `${id}-child`);
        return track(new CancellableNode(id, child));
      }
      case "task": {
        const id = nextId(`${prefix}-task`, node.id ?? node.node_id);
        const schema = taskSchemas[node.tool];
        const options = omitUndefinedEntries({
          /**
           * Preserve the optional task metadata without materialising
           * `undefined` keys so planner-derived Behaviour Trees remain
           * compatible with `exactOptionalPropertyTypes`.
           */
          inputKey: node.input_key,
          schema,
        });
        return track(new TaskLeaf(id, node.tool, options));
      }
      default: {
        const exhaustive: never = node;
        throw new Error(`Unsupported node type ${(exhaustive as { type: string }).type}`);
      }
    }
  }

  return instantiate(definition, idPrefix);
}
