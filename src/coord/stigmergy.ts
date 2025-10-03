import { EventEmitter } from "node:events";

/**
 * Error emitted when callers provide an invalid pheromone type. The server maps
 * the code to `E-STIG-TYPE` so MCP clients can correct payloads without having
 * to inspect log files.
 */
export class StigmergyInvalidTypeError extends Error {
  public readonly code = "E-STIG-TYPE";
  public readonly details: { type: string };

  constructor(type: string) {
    super("pheromone type must not be empty");
    this.name = "StigmergyInvalidTypeError";
    this.details = { type };
  }
}

/** Smallest intensity we keep in the field before considering it evaporated. */
const EPSILON = 1e-6;

/** Options accepted by the {@link StigmergyField} constructor. */
export interface StigmergyFieldOptions {
  /** Custom clock leveraged to keep tests deterministic. Defaults to {@link Date.now}. */
  now?: () => number;
}

/** Snapshot representing the intensity of a specific pheromone type on a node. */
export interface StigmergyPointSnapshot {
  nodeId: string;
  type: string;
  intensity: number;
  updatedAt: number;
}

/** Aggregated intensity stored per node after accumulating all pheromone types. */
export interface StigmergyTotalSnapshot {
  nodeId: string;
  intensity: number;
  updatedAt: number;
}

/** Payload emitted every time the stigmergic field changes. */
export interface StigmergyChangeEvent {
  nodeId: string;
  type: string;
  intensity: number;
  totalIntensity: number;
  updatedAt: number;
}

/** Input payload accepted by {@link StigmergyField.batchMark}. */
export interface StigmergyBatchMarkInput {
  nodeId: string;
  type: string;
  intensity: number;
}

/** Snapshot returned by {@link StigmergyField.batchMark} for each entry. */
export interface StigmergyBatchMarkResult {
  point: StigmergyPointSnapshot;
  nodeTotal: StigmergyTotalSnapshot;
}

/** Complete snapshot of the field combining per-type and aggregated intensities. */
export interface StigmergyFieldSnapshot {
  generatedAt: number;
  points: StigmergyPointSnapshot[];
  totals: StigmergyTotalSnapshot[];
}

interface StigmergyEntry {
  nodeId: string;
  type: string;
  intensity: number;
  updatedAt: number;
}

interface NodeTotal {
  intensity: number;
  updatedAt: number;
}

/** Listener signature exposed by {@link StigmergyField.onChange}. */
export type StigmergyChangeListener = (event: StigmergyChangeEvent) => void;

/**
 * Deterministic stigmergic field storing pheromone intensities per node and type.
 * The field accumulates markings, supports exponential evaporation and notifies
 * observers whenever a value changes so schedulers can react in real time.
 */
export class StigmergyField {
  private readonly entries = new Map<string, StigmergyEntry>();
  private readonly totals = new Map<string, NodeTotal>();
  private readonly emitter = new EventEmitter();
  private readonly now: () => number;

  constructor(options: StigmergyFieldOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Adds pheromone to the field and returns the updated point snapshot. */
  mark(nodeId: string, type: string, intensity: number): StigmergyPointSnapshot {
    if (!Number.isFinite(intensity) || intensity <= 0) {
      throw new Error("intensity must be a positive finite number");
    }
    const normalisedType = normaliseType(type);
    const timestamp = this.now();
    const key = this.makeKey(nodeId, normalisedType);
    const existing = this.entries.get(key);
    const previousIntensity = existing?.intensity ?? 0;
    const nextIntensity = previousIntensity + intensity;
    const entry: StigmergyEntry = {
      nodeId,
      type: normalisedType,
      intensity: nextIntensity,
      updatedAt: timestamp,
    };
    this.entries.set(key, entry);
    const total = this.adjustTotal(nodeId, nextIntensity - previousIntensity, timestamp);
    const snapshot = this.cloneEntry(entry);
    this.emitChange({
      nodeId,
      type: normalisedType,
      intensity: snapshot.intensity,
      totalIntensity: total.intensity,
      updatedAt: snapshot.updatedAt,
    });
    return snapshot;
  }

  /**
   * Applies multiple markings atomically. Either every entry is committed or
   * the field is restored to its previous state. Events are only emitted once
   * the batch succeeds so downstream observers never observe partial updates.
   */
  batchMark(entries: ReadonlyArray<StigmergyBatchMarkInput>): StigmergyBatchMarkResult[] {
    if (entries.length === 0) {
      return [];
    }

    const originalEntries = new Map<string, StigmergyEntry>();
    for (const [key, entry] of this.entries.entries()) {
      originalEntries.set(key, { ...entry });
    }
    const originalTotals = new Map<string, NodeTotal>();
    for (const [nodeId, total] of this.totals.entries()) {
      originalTotals.set(nodeId, { ...total });
    }

    const results: StigmergyBatchMarkResult[] = [];
    const events: StigmergyChangeEvent[] = [];

    try {
      for (const payload of entries) {
        if (!Number.isFinite(payload.intensity) || payload.intensity <= 0) {
          throw new Error("intensity must be a positive finite number");
        }
        const normalisedType = normaliseType(payload.type);
        const timestamp = this.now();
        const key = this.makeKey(payload.nodeId, normalisedType);
        const existing = this.entries.get(key);
        const previousIntensity = existing?.intensity ?? 0;
        const nextIntensity = previousIntensity + payload.intensity;
        const entry: StigmergyEntry = {
          nodeId: payload.nodeId,
          type: normalisedType,
          intensity: nextIntensity,
          updatedAt: timestamp,
        };
        this.entries.set(key, entry);
        const total = this.adjustTotal(payload.nodeId, nextIntensity - previousIntensity, timestamp);
        const snapshot = this.cloneEntry(entry);
        results.push({ point: snapshot, nodeTotal: { nodeId: payload.nodeId, intensity: total.intensity, updatedAt: total.updatedAt } });
        events.push({
          nodeId: payload.nodeId,
          type: normalisedType,
          intensity: snapshot.intensity,
          totalIntensity: total.intensity,
          updatedAt: snapshot.updatedAt,
        });
      }
    } catch (error) {
      this.entries.clear();
      for (const [key, entry] of originalEntries.entries()) {
        this.entries.set(key, entry);
      }
      this.totals.clear();
      for (const [nodeId, total] of originalTotals.entries()) {
        this.totals.set(nodeId, total);
      }
      throw error;
    }

    for (const event of events) {
      this.emitChange(event);
    }

    return results;
  }

  /**
   * Applies exponential decay to all pheromones using the provided half-life.
   * Entries whose intensity drops below {@link EPSILON} are evicted from the
   * field. The method returns the list of points that changed so callers can
   * propagate updates.
   */
  evaporate(halfLifeMs: number): StigmergyChangeEvent[] {
    if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
      throw new Error("halfLifeMs must be a positive finite number");
    }
    const timestamp = this.now();
    const changes: StigmergyChangeEvent[] = [];
    for (const [key, entry] of [...this.entries.entries()]) {
      const elapsed = Math.max(0, timestamp - entry.updatedAt);
      if (elapsed === 0) {
        // Nothing to decay yet but we still advance the reference timestamp.
        entry.updatedAt = timestamp;
        continue;
      }
      const decayFactor = Math.pow(0.5, elapsed / halfLifeMs);
      const decayed = entry.intensity * decayFactor;
      const nextIntensity = decayed <= EPSILON ? 0 : decayed;
      const delta = nextIntensity - entry.intensity;
      if (Math.abs(delta) <= EPSILON) {
        entry.updatedAt = timestamp;
        continue;
      }

      if (nextIntensity <= EPSILON) {
        this.entries.delete(key);
      } else {
        entry.intensity = nextIntensity;
        entry.updatedAt = timestamp;
        this.entries.set(key, entry);
      }

      const total = this.adjustTotal(entry.nodeId, delta, timestamp);
      const change: StigmergyChangeEvent = {
        nodeId: entry.nodeId,
        type: entry.type,
        intensity: Math.max(0, nextIntensity),
        totalIntensity: total.intensity,
        updatedAt: timestamp,
      };
      changes.push(change);
      this.emitChange(change);
    }
    return changes;
  }

  /** Returns the aggregated intensity for a node across every pheromone type. */
  getNodeIntensity(nodeId: string): StigmergyTotalSnapshot | undefined {
    const total = this.totals.get(nodeId);
    if (!total) {
      return undefined;
    }
    return { nodeId, intensity: total.intensity, updatedAt: total.updatedAt };
  }

  /** Produces a deterministic snapshot of the entire field for diagnostics. */
  fieldSnapshot(): StigmergyFieldSnapshot {
    const generatedAt = this.now();
    const points = [...this.entries.values()]
      .map((entry) => this.cloneEntry(entry))
      .sort((a, b) => {
        if (b.intensity === a.intensity) {
          return a.nodeId.localeCompare(b.nodeId) || a.type.localeCompare(b.type);
        }
        return b.intensity - a.intensity;
      });
    const totals = [...this.totals.entries()]
      .map(([nodeId, total]) => ({ nodeId, intensity: total.intensity, updatedAt: total.updatedAt }))
      .sort((a, b) => {
        if (b.intensity === a.intensity) {
          return a.nodeId.localeCompare(b.nodeId);
        }
        return b.intensity - a.intensity;
      });
    return { generatedAt, points, totals };
  }

  /** Registers a listener invoked for every mutation of the field. */
  onChange(listener: StigmergyChangeListener): () => void {
    this.emitter.on("change", listener);
    return () => {
      this.emitter.off("change", listener);
    };
  }

  private emitChange(event: StigmergyChangeEvent): void {
    this.emitter.emit("change", event);
  }

  private adjustTotal(nodeId: string, delta: number, timestamp: number): NodeTotal {
    const current = this.totals.get(nodeId) ?? { intensity: 0, updatedAt: timestamp };
    const nextIntensity = Math.max(0, current.intensity + delta);
    if (nextIntensity <= EPSILON) {
      this.totals.delete(nodeId);
      return { intensity: 0, updatedAt: timestamp };
    }
    const updated: NodeTotal = { intensity: nextIntensity, updatedAt: timestamp };
    this.totals.set(nodeId, updated);
    return updated;
  }

  private cloneEntry(entry: StigmergyEntry): StigmergyPointSnapshot {
    return { nodeId: entry.nodeId, type: entry.type, intensity: entry.intensity, updatedAt: entry.updatedAt };
  }

  private makeKey(nodeId: string, type: string): string {
    return `${nodeId}::${type}`;
  }
}

function normaliseType(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new StigmergyInvalidTypeError(raw);
  }
  return trimmed.toLowerCase();
}
