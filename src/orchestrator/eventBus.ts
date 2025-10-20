/**
 * Aggregates the orchestrator's event bus wiring so the runtime no longer has
 * to manage subscriptions directly. The helper instantiates the shared
 * {@link EventBus}, bridges coordination primitives (blackboard, stigmergy,
 * Contract-Net, value guard, cancellation feed) and exposes a disposer that
 * tears everything down in a deterministic order.
 *
 * Keeping the setup isolated here dramatically reduces the cognitive load when
 * editing `runtime.ts` and allows tests to exercise the wiring in isolation
 * without bootstrapping the entire orchestrator.
 */
import { EventBus } from "../events/bus.js";
import {
  bridgeBlackboardEvents,
  bridgeStigmergyEvents,
  bridgeCancellationEvents,
  bridgeContractNetEvents,
  bridgeConsensusEvents,
  bridgeValueEvents,
  createContractNetWatcherTelemetryListener,
} from "../events/bridges.js";
import type { BlackboardStore } from "../coord/blackboard.js";
import type { StigmergyField } from "../coord/stigmergy.js";
import type { ContractNetCoordinator } from "../coord/contractNet.js";
import type { ValueGraph } from "../values/valueGraph.js";
import {
  ContractNetWatcherTelemetryRecorder,
  watchContractNetPheromoneBounds,
} from "../coord/contractNetWatchers.js";
import type { StructuredLogger } from "../logger.js";

const DEFAULT_HISTORY_LIMIT = 5_000;

/**
 * Immutable dependencies required to bootstrap the orchestrator event bus.
 *
 * The shape intentionally mirrors the state already constructed by
 * `runtime.ts`, allowing the composition root to pass the existing singletons
 * without having to instantiate additional scaffolding in tests.
 */
export interface OrchestratorEventBusDependencies {
  /** Structured logger used for diagnostic messages and disposal warnings. */
  readonly logger: StructuredLogger;
  /** Shared blackboard store mirrored to the event bus. */
  readonly blackboard: BlackboardStore;
  /** Stigmergic field tracked for pheromone telemetry. */
  readonly stigmergy: StigmergyField;
  /** Contract-Net coordinator emitting auction lifecycle events. */
  readonly contractNet: ContractNetCoordinator;
  /** Value guard graph broadcasting guard decisions and configuration changes. */
  readonly valueGraph: ValueGraph;
  /** Telemetry recorder aggregating Contract-Net watcher statistics. */
  readonly contractNetWatcherTelemetry: ContractNetWatcherTelemetryRecorder;
  /** Optional override applied to the unified event bus history limit. */
  readonly historyLimit?: number;
}

/** Result returned by {@link createOrchestratorEventBus}. */
export interface OrchestratorEventBusSetup {
  /** Shared event bus used by HTTP handlers and streaming endpoints. */
  readonly bus: EventBus;
  /**
   * Tears down every bridge in the reverse order of their registration while
   * guarding against duplicate invocations.
   */
  readonly dispose: () => void;
}

/**
 * Instantiates the orchestrator event bus, wires coordination primitives and
 * returns a disposer that unwinds the subscriptions deterministically.
 */
export function createOrchestratorEventBus(
  dependencies: OrchestratorEventBusDependencies,
): OrchestratorEventBusSetup {
  const {
    logger,
    blackboard,
    stigmergy,
    contractNet,
    valueGraph,
    contractNetWatcherTelemetry,
    historyLimit = DEFAULT_HISTORY_LIMIT,
  } = dependencies;

  const bus = new EventBus({ historyLimit });
  // Collect disposer handles so teardown runs in reverse registration order.
  const disposers: Array<() => void> = [];

  const register = (disposer: (() => void) | undefined): void => {
    if (typeof disposer === "function") {
      disposers.push(disposer);
    }
  };

  register(
    bridgeBlackboardEvents({
      blackboard,
      bus,
    }),
  );

  register(
    bridgeStigmergyEvents({
      field: stigmergy,
      bus,
    }),
  );

  register(
    bridgeCancellationEvents({
      bus,
    }),
  );

  register(
    bridgeContractNetEvents({
      coordinator: contractNet,
      bus,
    }),
  );

  register(
    bridgeConsensusEvents({
      bus,
    }),
  );

  register(
    bridgeValueEvents({
      graph: valueGraph,
      bus,
    }),
  );

  const detachWatcher = watchContractNetPheromoneBounds({
    field: stigmergy,
    contractNet,
    logger,
    onTelemetry: createContractNetWatcherTelemetryListener({
      bus,
      recorder: contractNetWatcherTelemetry,
    }),
  });
  register(detachWatcher);

  let disposed = false;

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    // Reverse order ensures bridges that depend on others are unwound last.
    while (disposers.length > 0) {
      const detach = disposers.pop();
      if (!detach) {
        continue;
      }
      try {
        detach();
      } catch (error) {
        logger.warn("event_bus_dispose_error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  return { bus, dispose };
}
