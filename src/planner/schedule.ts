import { PlanSpecificationError, type PlannerPlan, type PlannerTask } from "./domain.js";

/**
 * Error thrown when a plan cannot be scheduled (cycles, missing dependencies,
 * inconsistent metadata…). The {@link code} mirrors the taxonomy used by the
 * planner tool so transports can surface deterministic diagnostics.
 */
export class PlanSchedulingError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = "PlanSchedulingError";
    this.code = code;
    this.details = details;
  }
}

/** Schedule metadata computed for a single task. */
export interface PlanScheduleTask {
  id: string;
  name?: string;
  description?: string;
  dependsOn: string[];
  estimatedDurationMs: number;
  earliestStartMs: number;
  earliestFinishMs: number;
  latestStartMs: number;
  latestFinishMs: number;
  slackMs: number;
  level: number;
  resources: PlannerTask["resources"];
}

/** Tasks grouped by logical execution phase (level). */
export interface PlanSchedulePhase {
  index: number;
  earliestStartMs: number;
  tasks: PlanScheduleTask[];
}

/** Result returned by {@link buildPlanSchedule}. */
export interface PlanSchedule {
  planId: string;
  totalEstimatedDurationMs: number;
  criticalPath: string[];
  phases: PlanSchedulePhase[];
  tasks: Record<string, PlanScheduleTask>;
  adjacency: Record<string, string[]>;
}

interface TopologyResult {
  order: PlannerTask[];
  adjacency: Map<string, Set<string>>;
  predecessors: Map<string, Set<string>>;
}

/**
 * Builds a mutable schedule entry for a task while omitting metadata left
 * unspecified by the planner document. Returning a clean object here prevents
 * downstream projections (`phases`, `tasks`) from leaking keys bound to the
 * `undefined` sentinel when `exactOptionalPropertyTypes` is enabled.
 */
function createScheduleTask(task: PlannerTask): PlanScheduleTask {
  const duration = task.estimated_duration_ms ?? 0;
  const scheduleTask: PlanScheduleTask = {
    id: task.id,
    dependsOn: [...task.depends_on],
    estimatedDurationMs: duration,
    earliestStartMs: 0,
    earliestFinishMs: duration,
    latestStartMs: 0,
    latestFinishMs: duration,
    slackMs: 0,
    level: 0,
    resources: task.resources,
  };

  if (task.name !== undefined) {
    scheduleTask.name = task.name;
  }
  if (task.description !== undefined) {
    scheduleTask.description = task.description;
  }

  return scheduleTask;
}

/** Compute a deterministic topological ordering or throw when cycles exist. */
function resolvePlanTopology(plan: PlannerPlan): TopologyResult {
  const tasksById = new Map<string, PlannerTask>();
  for (const task of plan.tasks) {
    tasksById.set(task.id, task);
  }

  const adjacency = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const task of plan.tasks) {
    adjacency.set(task.id, new Set());
    predecessors.set(task.id, new Set());
    indegree.set(task.id, 0);
  }

  for (const task of plan.tasks) {
    for (const dependency of task.depends_on) {
      const dependencyTask = tasksById.get(dependency);
      if (!dependencyTask) {
        throw new PlanSchedulingError(`task ${task.id} depends on unknown task ${dependency}`, "E-PLAN-MISSING", {
          taskId: task.id,
          missingDependency: dependency,
        });
      }
      adjacency.get(dependency)!.add(task.id);
      predecessors.get(task.id)!.add(dependency);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const ready: string[] = Array.from(indegree.entries())
    .filter(([, value]) => value === 0)
    .map(([taskId]) => taskId)
    .sort();

  const ordered: PlannerTask[] = [];
  while (ready.length > 0) {
    const currentId = ready.shift()!;
    const currentTask = tasksById.get(currentId);
    if (!currentTask) {
      throw new PlanSpecificationError(`task ${currentId} disappeared during scheduling`, "E-PLAN-INTERNAL");
    }
    ordered.push(currentTask);
    for (const neighbour of adjacency.get(currentId) ?? []) {
      const remaining = (indegree.get(neighbour) ?? 0) - 1;
      indegree.set(neighbour, remaining);
      if (remaining === 0) {
        ready.push(neighbour);
      }
    }
    ready.sort();
  }

  if (ordered.length !== plan.tasks.length) {
    throw new PlanSchedulingError(`plan ${plan.id} contains dependency cycles`, "E-PLAN-CYCLE", {
      totalTasks: plan.tasks.length,
      ordered: ordered.length,
    });
  }

  return { order: ordered, adjacency, predecessors };
}

/**
 * Build a critical-path-aware schedule for the provided planner document. The
 * function computes earliest/latest times and groups tasks by execution level so
 * runtimes can derive batching or parallelism policies.
 */
export function buildPlanSchedule(plan: PlannerPlan): PlanSchedule {
  const topology = resolvePlanTopology(plan);

  const metrics = new Map<string, PlanScheduleTask>();
  const adjacencyObject: Record<string, string[]> = {};

  for (const [taskId, children] of topology.adjacency.entries()) {
    adjacencyObject[taskId] = Array.from(children).sort();
  }

  for (const task of plan.tasks) {
    metrics.set(task.id, createScheduleTask(task));
  }

  for (const task of topology.order) {
    const info = metrics.get(task.id)!;
    let earliestStart = 0;
    let level = 0;
    for (const dependency of task.depends_on) {
      const dependencyInfo = metrics.get(dependency)!;
      earliestStart = Math.max(earliestStart, dependencyInfo.earliestFinishMs);
      level = Math.max(level, dependencyInfo.level + 1);
    }
    info.level = level;
    info.earliestStartMs = earliestStart;
    info.earliestFinishMs = earliestStart + info.estimatedDurationMs;
  }

  let totalDuration = 0;
  for (const info of metrics.values()) {
    totalDuration = Math.max(totalDuration, info.earliestFinishMs);
  }

  const reverseOrder = [...topology.order].reverse();
  for (const task of reverseOrder) {
    const info = metrics.get(task.id)!;
    const children = topology.adjacency.get(task.id);
    if (!children || children.size === 0) {
      info.latestFinishMs = totalDuration;
    } else {
      let latestFinish = Number.POSITIVE_INFINITY;
      for (const childId of children) {
        const childInfo = metrics.get(childId)!;
        latestFinish = Math.min(latestFinish, childInfo.latestStartMs);
      }
      info.latestFinishMs = Number.isFinite(latestFinish) ? latestFinish : totalDuration;
    }
    info.latestStartMs = info.latestFinishMs - info.estimatedDurationMs;
    info.slackMs = Math.max(0, info.latestStartMs - info.earliestStartMs);
  }

  const phasesByLevel = new Map<number, PlanSchedulePhase>();
  for (const info of metrics.values()) {
    let phase = phasesByLevel.get(info.level);
    if (!phase) {
      phase = {
        index: info.level,
        earliestStartMs: info.earliestStartMs,
        tasks: [],
      };
      phasesByLevel.set(info.level, phase);
    }
    phase.earliestStartMs = Math.min(phase.earliestStartMs, info.earliestStartMs);
    phase.tasks.push(info);
  }

  const phases = Array.from(phasesByLevel.values())
    .sort((a, b) => a.index - b.index)
    .map((phase) => ({
      ...phase,
      tasks: phase.tasks.sort((a, b) => a.earliestStartMs - b.earliestStartMs || a.id.localeCompare(b.id)),
    }));

  const criticalPath = Array.from(metrics.values())
    .filter((task) => task.slackMs === 0)
    .sort((a, b) => a.earliestStartMs - b.earliestStartMs)
    .map((task) => task.id);

  const tasks: Record<string, PlanScheduleTask> = {};
  for (const [taskId, info] of metrics.entries()) {
    tasks[taskId] = info;
  }

  return {
    planId: plan.id,
    totalEstimatedDurationMs: totalDuration,
    criticalPath,
    phases,
    tasks,
    adjacency: adjacencyObject,
  };
}

export { resolvePlanTopology };
