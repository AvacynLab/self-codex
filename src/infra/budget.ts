import { Buffer } from "node:buffer";

import { recordBudgetConsumptionMetric, recordBudgetExhaustionMetric } from "./tracing.js";

/**
 * Dimensions tracked by the {@link BudgetTracker}. The tracker keeps separate
 * counters for wall clock time, language tokens, tool invocations as well as
 * inbound and outbound byte volumes. Keeping the enum centralised simplifies
 * iteration and snapshot computation while providing exhaustive checking when
 * adding new dimensions in the future.
 */
const BUDGET_DIMENSIONS = ["timeMs", "tokens", "toolCalls", "bytesIn", "bytesOut"] as const;

/** Type representing the supported budget dimensions. */
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

/**
 * Declarative limits accepted by {@link BudgetTracker}. When a limit is set to
 * `null` or `undefined` the corresponding dimension is treated as unbounded.
 */
export interface BudgetLimits {
  timeMs?: number | null;
  tokens?: number | null;
  toolCalls?: number | null;
  bytesIn?: number | null;
  bytesOut?: number | null;
}

/**
 * Structure describing the instantaneous consumption for every dimension. All
 * counters are normalised to non-negative numbers so snapshots and refunds can
 * manipulate them without additional guards.
 */
export interface BudgetUsage {
  timeMs: number;
  tokens: number;
  toolCalls: number;
  bytesIn: number;
  bytesOut: number;
}

/** Partial consumption request accepted by {@link BudgetTracker.consume}. */
export type BudgetConsumption = Partial<BudgetUsage> & Record<string, number | undefined>;

/**
 * Metadata recorded alongside the last usage. The tracker exposes this inside
 * snapshots so logs and metrics can correlate depletion events with the agent
 * responsible for them.
 */
export interface BudgetUsageMetadata {
  actor?: string;
  operation?: string;
  stage?: string;
  detail?: string;
}

/** Usage record persisted in {@link BudgetSnapshot.lastUsage}. */
export interface BudgetUsageRecord {
  readonly charge: BudgetUsage;
  readonly metadata?: BudgetUsageMetadata;
}

/**
 * Snapshot returned by {@link BudgetTracker.snapshot}. The structure is
 * JSON-serialisable so it can be included verbatim in logs or telemetry
 * payloads without leaking live references to the tracker.
 */
export interface BudgetSnapshot {
  readonly limits: Readonly<BudgetLimits>;
  readonly consumed: BudgetUsage;
  readonly remaining: BudgetUsage;
  readonly exhausted: BudgetDimension[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsage?: BudgetUsageRecord | null;
}

/** Charge returned by {@link BudgetTracker.consume}. */
export type BudgetCharge = BudgetUsage;

/** Options accepted by the {@link BudgetTracker} constructor. */
export interface BudgetTrackerOptions {
  /** Optional monotonic clock override (useful in tests). */
  clock?: () => number;
}

/**
 * Error thrown when a budget dimension would become negative. The error carries
 * both the attempted charge and the remaining capacity so transports can build
 * consistent JSON-RPC payloads without guessing the underlying semantics.
 */
export class BudgetExceededError extends Error {
  public readonly dimension: BudgetDimension;
  public readonly remaining: number;
  public readonly attempted: number;
  public readonly limit: number;

  constructor(dimension: BudgetDimension, remaining: number, attempted: number, limit: number) {
    super(`budget exceeded on ${dimension}: attempted ${attempted}, remaining ${remaining}`);
    this.name = "BudgetExceededError";
    this.dimension = dimension;
    this.remaining = remaining;
    this.attempted = attempted;
    this.limit = limit;
  }
}

/**
 * Normalises partial usage objects by filling undefined fields with zero. The
 * helper keeps the tracker logic concise and ensures snapshots always expose
 * fully populated structures for downstream tooling.
 */
function normaliseUsage(partial?: Partial<BudgetUsage>): BudgetUsage {
  const usage: BudgetUsage = {
    timeMs: 0,
    tokens: 0,
    toolCalls: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
  if (!partial) {
    return usage;
  }
  for (const dimension of BUDGET_DIMENSIONS) {
    const value = partial[dimension];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      usage[dimension] = value;
    }
  }
  return usage;
}

/** Coerces raw limits into canonical numeric/null form. */
function normaliseLimits(input: BudgetLimits | undefined): Required<BudgetLimits> {
  const limits: Required<BudgetLimits> = {
    timeMs: null,
    tokens: null,
    toolCalls: null,
    bytesIn: null,
    bytesOut: null,
  };
  if (!input) {
    return limits;
  }
  for (const dimension of BUDGET_DIMENSIONS) {
    const value = input[dimension];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      limits[dimension] = value;
    }
  }
  return limits;
}

/** Adds together two usage objects without mutating the operands. */
function addUsage(base: BudgetUsage, delta: BudgetUsage): BudgetUsage {
  const next: BudgetUsage = { ...base };
  for (const dimension of BUDGET_DIMENSIONS) {
    next[dimension] += delta[dimension];
  }
  return next;
}

/** Subtracts usage values while guarding against negative rounding artefacts. */
function subtractUsage(base: BudgetUsage, delta: BudgetUsage): BudgetUsage {
  const next: BudgetUsage = { ...base };
  for (const dimension of BUDGET_DIMENSIONS) {
    const value = next[dimension] - delta[dimension];
    next[dimension] = value <= 0 ? 0 : value;
  }
  return next;
}

/**
 * Tracks multi-dimensional resource budgets for orchestrator operations. The
 * tracker is intentionally stateful so tool handlers can reserve capacity
 * before executing an expensive action and refund it if the operation aborts.
 */
export class BudgetTracker {
  private readonly limits: Required<BudgetLimits>;
  private consumed: BudgetUsage;
  private readonly createdAt: number;
  private updatedAt: number;
  private lastUsage: BudgetUsageRecord | null = null;
  private readonly clock: () => number;

  constructor(limits: BudgetLimits | undefined, options: BudgetTrackerOptions = {}) {
    this.clock = typeof options.clock === "function" ? options.clock : () => Date.now();
    this.limits = normaliseLimits(limits);
    this.consumed = normaliseUsage();
    this.createdAt = this.clock();
    this.updatedAt = this.createdAt;
  }

  /**
   * Attempts to deduct the provided consumption from the tracker. On success a
   * {@link BudgetCharge} object is returned so callers can refund the charge if
   * the underlying operation fails.
   */
  consume(consumption: BudgetConsumption, metadata?: BudgetUsageMetadata): BudgetCharge {
    const charge = normaliseUsage(consumption);
    const remaining = this.remaining();

    for (const dimension of BUDGET_DIMENSIONS) {
      const limit = this.limits[dimension];
      if (limit === null) {
        continue;
      }
      const available = remaining[dimension];
      const requested = charge[dimension];
      if (requested > 0 && requested > available) {
        recordBudgetExhaustionMetric(dimension, metadata);
        throw new BudgetExceededError(dimension, available, requested, limit);
      }
    }

    this.consumed = addUsage(this.consumed, charge);
    this.updatedAt = this.clock();
    this.lastUsage = { charge: { ...charge }, metadata };
    for (const dimension of BUDGET_DIMENSIONS) {
      const amount = charge[dimension];
      if (amount > 0) {
        recordBudgetConsumptionMetric(dimension, amount, metadata);
      }
    }
    return charge;
  }

  /** Refunds a previously applied {@link BudgetCharge}. */
  refund(charge: BudgetCharge | null | undefined): void {
    if (!charge) {
      return;
    }
    this.consumed = subtractUsage(this.consumed, charge);
    this.updatedAt = this.clock();
  }

  /** Returns the remaining capacity for every dimension. */
  remaining(): BudgetUsage {
    const remaining: BudgetUsage = normaliseUsage();
    for (const dimension of BUDGET_DIMENSIONS) {
      const limit = this.limits[dimension];
      if (limit === null) {
        remaining[dimension] = Number.POSITIVE_INFINITY;
        continue;
      }
      remaining[dimension] = Math.max(0, limit - this.consumed[dimension]);
    }
    return remaining;
  }

  /** Returns a serialisable snapshot of the tracker state. */
  snapshot(): BudgetSnapshot {
    const remaining = this.remaining();
    const exhausted: BudgetDimension[] = [];
    for (const dimension of BUDGET_DIMENSIONS) {
      const limit = this.limits[dimension];
      if (limit !== null && remaining[dimension] <= 0 && limit > 0) {
        exhausted.push(dimension);
      }
    }
    return {
      limits: { ...this.limits },
      consumed: { ...this.consumed },
      remaining,
      exhausted,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastUsage: this.lastUsage ? { charge: { ...this.lastUsage.charge }, metadata: this.lastUsage.metadata } : null,
    };
  }
}

/**
 * Provides a best-effort token estimate for arbitrary payloads. The heuristic
 * favours determinism over absolute accuracy: we fall back to JSON string
 * length divided by four when dealing with complex objects, which mirrors the
 * commonly observed byte-to-token ratio for GPT-style encodings.
 */
export function estimateTokenUsage(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return 1;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return 0;
    }
    return Math.max(1, Math.ceil(trimmed.split(/\s+/u).length));
  }
  if (Buffer.isBuffer(value)) {
    return Math.max(1, Math.ceil(value.byteLength / 4));
  }
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + estimateTokenUsage(entry), 0);
  }
  if (typeof value === "object") {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
    return Math.max(1, Math.ceil(text.length / 4));
  }
  const serialised = String(value);
  return serialised.length === 0 ? 0 : Math.max(1, Math.ceil(serialised.length / 4));
}

/**
 * Computes the UTF-8 byte size of arbitrary payloads. Objects are stringified
 * via JSON when possible and fall back to `String(value)` otherwise.
 */
export function measureBudgetBytes(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  if (Buffer.isBuffer(value)) {
    return value.byteLength;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return Buffer.byteLength(String(value), "utf8");
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const entry of value) {
      total += measureBudgetBytes(entry);
    }
    return total;
  }
  if (typeof value === "object") {
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      return Buffer.byteLength(String(value), "utf8");
    }
  }
  return Buffer.byteLength(String(value), "utf8");
}
