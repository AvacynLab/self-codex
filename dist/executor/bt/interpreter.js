import { GuardNode, ParallelNode, RetryNode, SelectorNode, SequenceNode, TaskLeaf, TimeoutNode, CancellableNode, } from "./nodes.js";
/**
 * Interpreter responsible for ticking a Behaviour Tree. The class is stateless
 * besides the tree nodes themselves which maintain their cursor/attempt counts.
 */
export class BehaviorTreeInterpreter {
    root;
    constructor(root) {
        this.root = root;
    }
    /**
     * Execute a single tick using the provided runtime. Terminal results reset the
     * tree automatically so callers can trigger another run without manual cleanup.
     */
    async tick(runtime) {
        const resolvedRuntime = {
            invokeTool: runtime.invokeTool,
            now: runtime.now ?? (() => Date.now()),
            wait: runtime.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
            variables: runtime.variables ?? {},
            cancellationSignal: runtime.cancellationSignal,
            isCancelled: runtime.isCancelled,
            throwIfCancelled: runtime.throwIfCancelled,
            recommendTimeout: runtime.recommendTimeout,
            recordTimeoutOutcome: runtime.recordTimeoutOutcome,
        };
        const result = await this.root.tick(resolvedRuntime);
        if (result.status !== "running") {
            this.root.reset();
        }
        return result;
    }
    /** Reset the underlying tree to its initial state. */
    reset() {
        this.root.reset();
    }
}
/** Build a concrete Behaviour Tree from its serialised definition. */
export function buildBehaviorTree(definition, options = {}, idPrefix = "root") {
    const { taskSchemas = {}, statusReporter } = options;
    let autoIndex = 0;
    function nextId(prefix, provided) {
        if (provided && provided.trim().length > 0) {
            return provided;
        }
        const generated = `${prefix}-${autoIndex}`;
        autoIndex += 1;
        return generated;
    }
    function track(node) {
        if (!statusReporter) {
            return node;
        }
        return {
            id: node.id,
            async tick(runtime) {
                statusReporter(node.id, "running");
                try {
                    const result = await node.tick(runtime);
                    statusReporter(node.id, result.status);
                    return result;
                }
                catch (error) {
                    statusReporter(node.id, "failure");
                    throw error;
                }
            },
            reset() {
                node.reset();
            },
        };
    }
    function instantiate(node, prefix) {
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
                return track(new RetryNode(id, node.max_attempts, child, node.backoff_ms));
            }
            case "timeout": {
                const id = nextId(`${prefix}-timeout`, node.id);
                const child = instantiate(node.child, `${id}-child`);
                return track(new TimeoutNode(id, node.timeout_ms ?? null, child, { category: node.timeout_category ?? null, complexityScore: node.complexity_score ?? null }));
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
                return track(new TaskLeaf(id, node.tool, { inputKey: node.input_key, schema }));
            }
            default: {
                const exhaustive = node;
                throw new Error(`Unsupported node type ${exhaustive.type}`);
            }
        }
    }
    return instantiate(definition, idPrefix);
}
