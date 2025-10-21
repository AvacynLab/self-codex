import type { ChildSupervisorContract } from "../../src/children/supervisor.js";

/**
 * Options accepted by {@link createStubChildSupervisor}. Each property mirrors a
 * method of {@link ChildSupervisorContract} so tests can override just the
 * behaviour they exercise. Unspecified operations throw to keep fixtures
 * honest.
 */
export interface ChildSupervisorStubOverrides {
  childrenIndex?: ChildSupervisorContract["childrenIndex"];
  createChildId?: ChildSupervisorContract["createChildId"];
  createChild?: ChildSupervisorContract["createChild"];
  registerHttpChild?: ChildSupervisorContract["registerHttpChild"];
  getHttpEndpoint?: ChildSupervisorContract["getHttpEndpoint"];
  status?: ChildSupervisorContract["status"];
  send?: ChildSupervisorContract["send"];
  waitForMessage?: ChildSupervisorContract["waitForMessage"];
  collect?: ChildSupervisorContract["collect"];
  stream?: ChildSupervisorContract["stream"];
  attachChild?: ChildSupervisorContract["attachChild"];
  setChildRole?: ChildSupervisorContract["setChildRole"];
  setChildLimits?: ChildSupervisorContract["setChildLimits"];
  cancel?: ChildSupervisorContract["cancel"];
  kill?: ChildSupervisorContract["kill"];
  waitForExit?: ChildSupervisorContract["waitForExit"];
  gc?: ChildSupervisorContract["gc"];
  getAllowedTools?: ChildSupervisorContract["getAllowedTools"];
}

/**
 * Builds a lightweight implementation of {@link ChildSupervisorContract}. The helper provides
 * deterministic defaults for read-only methods and explicit errors for missing overrides so tests
 * do not silently rely on behaviour they never configured.
 */
export function createStubChildSupervisor(
  overrides: ChildSupervisorStubOverrides = {},
): ChildSupervisorContract {
  const missing = (operation: keyof ChildSupervisorStubOverrides): never => {
    throw new Error(`ChildSupervisorContract.${String(operation)} not implemented in test stub`);
  };

  const childrenIndex = overrides.childrenIndex ?? {
    list: () => [],
    getChild: () => undefined,
  };

  return {
    childrenIndex,
    createChildId: overrides.createChildId ?? (() => "child-stub"),
    async createChild(...args) {
      if (overrides.createChild) {
        return overrides.createChild(...args);
      }
      return missing("createChild");
    },
    async registerHttpChild(...args) {
      if (overrides.registerHttpChild) {
        return overrides.registerHttpChild(...args);
      }
      return missing("registerHttpChild");
    },
    getHttpEndpoint(childId) {
      if (overrides.getHttpEndpoint) {
        return overrides.getHttpEndpoint(childId);
      }
      return null;
    },
    status(childId) {
      if (overrides.status) {
        return overrides.status(childId);
      }
      return missing("status");
    },
    async send(...args) {
      if (overrides.send) {
        return overrides.send(...args);
      }
      return missing("send");
    },
    async waitForMessage(...args) {
      if (overrides.waitForMessage) {
        return overrides.waitForMessage(...args);
      }
      return missing("waitForMessage");
    },
    async collect(...args) {
      if (overrides.collect) {
        return overrides.collect(...args);
      }
      return missing("collect");
    },
    stream(childId, options) {
      if (overrides.stream) {
        return overrides.stream(childId, options);
      }
      return missing("stream");
    },
    async attachChild(...args) {
      if (overrides.attachChild) {
        return overrides.attachChild(...args);
      }
      return missing("attachChild");
    },
    async setChildRole(...args) {
      if (overrides.setChildRole) {
        return overrides.setChildRole(...args);
      }
      return missing("setChildRole");
    },
    async setChildLimits(...args) {
      if (overrides.setChildLimits) {
        return overrides.setChildLimits(...args);
      }
      return missing("setChildLimits");
    },
    async cancel(...args) {
      if (overrides.cancel) {
        return overrides.cancel(...args);
      }
      return missing("cancel");
    },
    async kill(...args) {
      if (overrides.kill) {
        return overrides.kill(...args);
      }
      return missing("kill");
    },
    async waitForExit(...args) {
      if (overrides.waitForExit) {
        return overrides.waitForExit(...args);
      }
      return missing("waitForExit");
    },
    gc(childId) {
      if (overrides.gc) {
        overrides.gc(childId);
        return;
      }
    },
    getAllowedTools(childId) {
      if (overrides.getAllowedTools) {
        return overrides.getAllowedTools(childId);
      }
      return [];
    },
  } satisfies ChildSupervisorContract;
}
