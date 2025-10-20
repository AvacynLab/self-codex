import sinon from "sinon";

import { GraphState } from "../../src/graph/state.js";
import { StigmergyField } from "../../src/coord/stigmergy.js";
import {
  type PlanChildSupervisor,
  type PlanEventEmitter,
  type PlanToolContext,
} from "../../src/tools/planTools.js";
import { RecordingLogger } from "./recordingLogger.js";

/**
 * Options accepted by {@link createPlanToolContext}. The helper mirrors the
 * production shape while keeping every property optional so tests can override
 * just the pieces they exercise explicitly.
 */
export type PlanToolContextOverrides = Partial<PlanToolContext>;

/**
 * Builds a lightweight supervisor implementation that surfaces informative
 * errors when a method is invoked without being customised by the test. This
 * keeps fixtures honest while avoiding the unsafe `as unknown as` casts that
 * used to appear across the plan suites.
 */
export function createStubPlanChildSupervisor(
  overrides: Partial<PlanChildSupervisor> = {},
): PlanChildSupervisor {
  const missing = (operation: keyof PlanChildSupervisor): never => {
    throw new Error(`PlanChildSupervisor.${String(operation)} not implemented in test stub`);
  };

  return {
    async createChild(...args) {
      if (overrides.createChild) {
        return overrides.createChild(...args);
      }
      return missing("createChild");
    },
    async send(...args) {
      if (overrides.send) {
        return overrides.send(...args);
      }
      return missing("send");
    },
    async collect(...args) {
      if (overrides.collect) {
        return overrides.collect(...args);
      }
      return [];
    },
    async waitForMessage(...args) {
      if (overrides.waitForMessage) {
        return overrides.waitForMessage(...args);
      }
      return null;
    },
  } satisfies PlanChildSupervisor;
}

/**
 * Convenience factory that produces a fully initialised plan tool context while
 * remaining easily customisable for individual test scenarios.
 */
export function createPlanToolContext(
  overrides: PlanToolContextOverrides = {},
): PlanToolContext {
  const supervisor = overrides.supervisor ?? createStubPlanChildSupervisor();
  const logger = overrides.logger ?? new RecordingLogger();
  const emitEvent: PlanEventEmitter = overrides.emitEvent ?? (() => {});
  const stigmergy = overrides.stigmergy ?? new StigmergyField();

  return {
    supervisor,
    graphState: overrides.graphState ?? new GraphState(),
    logger,
    childrenRoot: overrides.childrenRoot ?? "/tmp/plan-tools",
    defaultChildRuntime: overrides.defaultChildRuntime ?? "codex",
    emitEvent,
    stigmergy,
    ...overrides,
  };
}

/**
 * Builds a {@link RecordingLogger} instrumented with Sinon spies so tests can
 * assert on structured log invocations without mutating the logger shape. The
 * spies are returned alongside the logger for convenience.
 */
export function createSpyPlanLogger(): {
  logger: PlanToolContext["logger"];
  spies: {
    debug: sinon.SinonSpy<[string, unknown?], void>;
    info: sinon.SinonSpy<[string, unknown?], void>;
    warn: sinon.SinonSpy<[string, unknown?], void>;
    error: sinon.SinonSpy<[string, unknown?], void>;
  };
} {
  const logger = new RecordingLogger();
  return {
    logger,
    spies: {
      debug: sinon.spy(logger, "debug"),
      info: sinon.spy(logger, "info"),
      warn: sinon.spy(logger, "warn"),
      error: sinon.spy(logger, "error"),
    },
  };
}
