import { EventEmitter } from "node:events";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
/**
 * Error emitted when callers provide an invalid pheromone type. The server maps
 * the code to `E-STIG-TYPE` so MCP clients can correct payloads without having
 * to inspect log files.
 */
export class StigmergyInvalidTypeError extends Error {
    code = "E-STIG-TYPE";
    details;
    constructor(type) {
        super("pheromone type must not be empty");
        this.name = "StigmergyInvalidTypeError";
        this.details = { type };
    }
}
/** Smallest intensity we keep in the field before considering it evaporated. */
const EPSILON = 1e-6;
/** Error raised when one entry of {@link StigmergyField.batchMark} fails. */
export class StigmergyBatchMarkError extends Error {
    index;
    entry;
    constructor(index, entry, cause) {
        super(`failed to apply stigmergy batch entry at index ${index}`, {
            cause: cause instanceof Error ? cause : undefined,
        });
        this.index = index;
        this.entry = entry;
        this.name = "StigmergyBatchMarkError";
    }
}
/**
 * Converts arbitrary pheromone bounds (either scheduler or stigmergy derived)
 * into a serialisable structure suitable for logs, events, or API responses.
 * When the upper bound is unbounded (`Infinity`) the helper returns `null`
 * instead so JSON consumers do not have to special-case the value.
 */
export function normalisePheromoneBoundsForTelemetry(bounds) {
    if (!bounds) {
        return null;
    }
    return {
        min_intensity: bounds.minIntensity,
        max_intensity: Number.isFinite(bounds.maxIntensity) ? bounds.maxIntensity : null,
        normalisation_ceiling: bounds.normalisationCeiling,
    };
}
/**
 * Deterministic stigmergic field storing pheromone intensities per node and type.
 * The field accumulates markings, supports exponential evaporation and notifies
 * observers whenever a value changes so schedulers can react in real time.
 */
export class StigmergyField {
    entries = new Map();
    totals = new Map();
    emitter = new EventEmitter();
    now;
    /**
     * Default half-life expressed in milliseconds. We store `null` explicitly so
     * the rest of the class never has to juggle with `undefined`, keeping the
     * upcoming `exactOptionalPropertyTypes` activation satisfied.
     */
    defaultHalfLifeMs;
    minIntensity;
    maxIntensity;
    evictionThreshold;
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
        if (options.defaultHalfLifeMs !== undefined && (!Number.isFinite(options.defaultHalfLifeMs) || options.defaultHalfLifeMs <= 0)) {
            throw new Error("defaultHalfLifeMs must be a positive finite number when provided");
        }
        if (options.minIntensity !== undefined && (!Number.isFinite(options.minIntensity) || options.minIntensity < 0)) {
            throw new Error("minIntensity must be a finite number greater than or equal to 0");
        }
        if (options.maxIntensity !== undefined && (!Number.isFinite(options.maxIntensity) || options.maxIntensity <= 0)) {
            throw new Error("maxIntensity must be a positive finite number when provided");
        }
        const min = options.minIntensity ?? 0;
        const max = options.maxIntensity ?? Number.POSITIVE_INFINITY;
        if (max <= min) {
            throw new Error("maxIntensity must be greater than minIntensity");
        }
        // Persist the optional half-life using an explicit `null` sentinel so
        // downstream helpers only deal with concrete numbers or a single
        // no-default branch when sanitising optional properties.
        this.defaultHalfLifeMs = options.defaultHalfLifeMs ?? null;
        this.minIntensity = min;
        this.maxIntensity = max;
        this.evictionThreshold = EPSILON;
    }
    /** Adds pheromone to the field and returns the updated point snapshot. */
    mark(nodeId, type, intensity) {
        if (!Number.isFinite(intensity) || intensity <= 0) {
            throw new Error("intensity must be a positive finite number");
        }
        const normalisedType = normaliseType(type);
        const timestamp = this.now();
        const key = this.makeKey(nodeId, normalisedType);
        const { snapshot, total } = this.applyEntryMutation({
            nodeId,
            type: normalisedType,
            delta: intensity,
            timestamp,
            key,
        });
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
    batchMark(entries) {
        if (entries.length === 0) {
            return [];
        }
        const originalEntries = new Map();
        for (const [key, entry] of this.entries.entries()) {
            originalEntries.set(key, { ...entry });
        }
        const originalTotals = new Map();
        for (const [nodeId, total] of this.totals.entries()) {
            originalTotals.set(nodeId, { ...total });
        }
        const results = [];
        const events = [];
        let currentIndex = -1;
        try {
            for (const [index, payload] of entries.entries()) {
                currentIndex = index;
                try {
                    if (!Number.isFinite(payload.intensity) || payload.intensity <= 0) {
                        throw new Error("intensity must be a positive finite number");
                    }
                    const normalisedType = normaliseType(payload.type);
                    const timestamp = this.now();
                    const key = this.makeKey(payload.nodeId, normalisedType);
                    const { snapshot, total } = this.applyEntryMutation({
                        nodeId: payload.nodeId,
                        type: normalisedType,
                        delta: payload.intensity,
                        timestamp,
                        key,
                    });
                    results.push({
                        point: snapshot,
                        nodeTotal: { nodeId: payload.nodeId, intensity: total.intensity, updatedAt: total.updatedAt },
                    });
                    events.push({
                        nodeId: payload.nodeId,
                        type: normalisedType,
                        intensity: snapshot.intensity,
                        totalIntensity: total.intensity,
                        updatedAt: snapshot.updatedAt,
                    });
                }
                catch (error) {
                    throw new StigmergyBatchMarkError(index, payload, error);
                }
            }
        }
        catch (error) {
            this.entries.clear();
            for (const [key, entry] of originalEntries.entries()) {
                this.entries.set(key, entry);
            }
            this.totals.clear();
            for (const [nodeId, total] of originalTotals.entries()) {
                this.totals.set(nodeId, total);
            }
            if (error instanceof StigmergyBatchMarkError) {
                throw error;
            }
            const entry = currentIndex >= 0 ? entries[currentIndex] : entries[0];
            throw new StigmergyBatchMarkError(currentIndex >= 0 ? currentIndex : 0, entry, error);
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
    evaporate(halfLifeMs) {
        const effectiveHalfLife = halfLifeMs ?? this.defaultHalfLifeMs;
        if (effectiveHalfLife === null) {
            throw new Error("halfLifeMs must be provided when no defaultHalfLifeMs is configured");
        }
        if (!Number.isFinite(effectiveHalfLife) || effectiveHalfLife <= 0) {
            throw new Error("halfLifeMs must be a positive finite number");
        }
        const timestamp = this.now();
        const changes = [];
        for (const [key, entry] of [...this.entries.entries()]) {
            const elapsed = Math.max(0, timestamp - entry.updatedAt);
            if (elapsed === 0) {
                // Nothing to decay yet but we still advance the reference timestamp.
                entry.updatedAt = timestamp;
                continue;
            }
            const decayFactor = Math.pow(0.5, elapsed / effectiveHalfLife);
            const decayed = entry.intensity * decayFactor;
            const nextIntensity = decayed <= this.evictionThreshold ? 0 : this.clampIntensity(decayed);
            const delta = nextIntensity - entry.intensity;
            if (Math.abs(delta) <= EPSILON) {
                entry.updatedAt = timestamp;
                continue;
            }
            if (nextIntensity <= this.evictionThreshold) {
                this.entries.delete(key);
            }
            else {
                entry.intensity = nextIntensity;
                entry.updatedAt = timestamp;
                this.entries.set(key, entry);
            }
            const total = this.adjustTotal(entry.nodeId, delta, timestamp);
            const change = {
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
    getNodeIntensity(nodeId) {
        const total = this.totals.get(nodeId);
        if (!total) {
            return undefined;
        }
        return { nodeId, intensity: total.intensity, updatedAt: total.updatedAt };
    }
    /**
     * Exposes the configured intensity bounds alongside the current
     * normalisation ceiling so downstream consumers can map pheromones to a
     * fixed scale without duplicating the field's logic.
     */
    getIntensityBounds() {
        const intensities = [...this.totals.values()].map((total) => total.intensity);
        const normalisationCeiling = this.resolveNormalisationCeiling(intensities);
        return {
            minIntensity: this.minIntensity,
            maxIntensity: this.maxIntensity,
            normalisationCeiling,
        };
    }
    /** Produces a deterministic snapshot of the entire field for diagnostics. */
    fieldSnapshot() {
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
    /** Builds a heatmap-friendly snapshot aggregating intensities per node and type. */
    heatmapSnapshot() {
        const generatedAt = this.now();
        const totals = new Map();
        const contributions = new Map();
        for (const entry of this.entries.values()) {
            const pointBucket = contributions.get(entry.nodeId) ?? [];
            pointBucket.push(entry);
            contributions.set(entry.nodeId, pointBucket);
            const total = totals.get(entry.nodeId);
            if (!total) {
                totals.set(entry.nodeId, { intensity: entry.intensity, updatedAt: entry.updatedAt });
            }
            else {
                total.intensity += entry.intensity;
                if (entry.updatedAt > total.updatedAt) {
                    total.updatedAt = entry.updatedAt;
                }
            }
        }
        const intensities = [...totals.values()].map((total) => total.intensity);
        const normalisationCeiling = this.resolveNormalisationCeiling(intensities);
        const cells = [];
        for (const [nodeId, total] of totals.entries()) {
            const rawPoints = contributions.get(nodeId) ?? [];
            const points = rawPoints
                .map((entry) => ({
                nodeId: entry.nodeId,
                type: entry.type,
                intensity: entry.intensity,
                normalised: this.normaliseIntensity(entry.intensity, normalisationCeiling),
                updatedAt: entry.updatedAt,
            }))
                .sort((a, b) => {
                if (b.intensity === a.intensity) {
                    return a.type.localeCompare(b.type);
                }
                return b.intensity - a.intensity;
            });
            const cell = {
                nodeId,
                totalIntensity: total.intensity,
                normalised: this.normaliseIntensity(total.intensity, normalisationCeiling),
                updatedAt: total.updatedAt,
                points,
            };
            cells.push(cell);
        }
        cells.sort((a, b) => {
            if (b.totalIntensity === a.totalIntensity) {
                return a.nodeId.localeCompare(b.nodeId);
            }
            return b.totalIntensity - a.totalIntensity;
        });
        return {
            generatedAt,
            minIntensity: this.minIntensity,
            maxIntensity: normalisationCeiling,
            cells,
        };
    }
    /** Registers a listener invoked for every mutation of the field. */
    onChange(listener) {
        this.emitter.on("change", listener);
        return () => {
            this.emitter.off("change", listener);
        };
    }
    emitChange(event) {
        this.emitter.emit("change", event);
    }
    adjustTotal(nodeId, delta, timestamp) {
        const current = this.totals.get(nodeId) ?? { intensity: 0, updatedAt: timestamp };
        const nextIntensity = current.intensity + delta;
        if (nextIntensity <= this.evictionThreshold) {
            this.totals.delete(nodeId);
            return { intensity: 0, updatedAt: timestamp };
        }
        const clamped = Math.min(this.maxIntensity, nextIntensity);
        const updated = { intensity: clamped, updatedAt: timestamp };
        this.totals.set(nodeId, updated);
        return updated;
    }
    cloneEntry(entry) {
        return { nodeId: entry.nodeId, type: entry.type, intensity: entry.intensity, updatedAt: entry.updatedAt };
    }
    makeKey(nodeId, type) {
        return `${nodeId}::${type}`;
    }
    applyEntryMutation(payload) {
        const existing = this.entries.get(payload.key);
        const previousIntensity = existing?.intensity ?? 0;
        const nextRaw = previousIntensity + payload.delta;
        const clamped = this.clampIntensity(nextRaw);
        const finalIntensity = clamped <= this.evictionThreshold ? 0 : clamped;
        const delta = finalIntensity - previousIntensity;
        if (finalIntensity <= this.evictionThreshold) {
            this.entries.delete(payload.key);
        }
        else {
            const entry = {
                nodeId: payload.nodeId,
                type: payload.type,
                intensity: finalIntensity,
                updatedAt: payload.timestamp,
            };
            this.entries.set(payload.key, entry);
        }
        const total = this.adjustTotal(payload.nodeId, delta, payload.timestamp);
        const snapshot = finalIntensity <= this.evictionThreshold
            ? { nodeId: payload.nodeId, type: payload.type, intensity: 0, updatedAt: payload.timestamp }
            : this.cloneEntry(this.entries.get(payload.key));
        return { snapshot, total };
    }
    clampIntensity(value) {
        return Math.min(this.maxIntensity, Math.max(0, value));
    }
    normaliseIntensity(value, ceiling) {
        const effectiveMax = ceiling;
        const span = effectiveMax - this.minIntensity;
        if (!Number.isFinite(span) || span <= 0) {
            return value > this.minIntensity ? 1 : 0;
        }
        if (value <= this.minIntensity) {
            return 0;
        }
        if (value >= effectiveMax) {
            return 1;
        }
        return (value - this.minIntensity) / span;
    }
    resolveNormalisationCeiling(intensities) {
        if (Number.isFinite(this.maxIntensity)) {
            return this.maxIntensity;
        }
        let observedMax = this.minIntensity;
        for (const value of intensities) {
            observedMax = Math.max(observedMax, value);
        }
        return observedMax === this.minIntensity ? this.minIntensity + 1 : observedMax;
    }
}
function normaliseType(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        throw new StigmergyInvalidTypeError(raw);
    }
    return trimmed.toLowerCase();
}
/** Formats an intensity bound into a concise human readable representation. */
export function formatPheromoneBoundValue(value) {
    if (value == null || !Number.isFinite(value)) {
        return "∞";
    }
    const rounded = Number(value.toFixed(3));
    const normalised = Object.is(rounded, -0) ? 0 : rounded;
    return normalised.toString();
}
/** Builds the tooltip displayed when hovering the pheromone heatmap. */
export function formatPheromoneBoundsTooltip(bounds) {
    if (!bounds) {
        return null;
    }
    const min = formatPheromoneBoundValue(bounds.min_intensity);
    const max = formatPheromoneBoundValue(bounds.max_intensity);
    const ceiling = formatPheromoneBoundValue(bounds.normalisation_ceiling);
    return `Min ${min} • Max ${max} • Ceiling ${ceiling}`;
}
/**
 * Generates pre-formatted rows describing the current pheromone bounds so
 * dashboards and autoscaler views can surface the data without reimplementing
 * formatting helpers.
 */
export function buildStigmergySummary(bounds) {
    if (!bounds) {
        const tooltip = "Les bornes ne sont pas encore disponibles : le champ n'a pas été initialisé.";
        return {
            bounds: null,
            rows: [
                { label: "Min intensity", value: "n/a", tooltip },
                { label: "Max intensity", value: "n/a", tooltip },
                { label: "Normalisation ceiling", value: "n/a", tooltip },
            ],
        };
    }
    return {
        bounds,
        rows: [
            {
                label: "Min intensity",
                value: formatPheromoneBoundValue(bounds.min_intensity),
                tooltip: "Borne basse appliquée avant normalisation (évite les valeurs négatives).",
            },
            {
                label: "Max intensity",
                value: formatPheromoneBoundValue(bounds.max_intensity),
                tooltip: "Borne haute appliquée avant normalisation (∞ signifie pas de plafond fixe).",
            },
            {
                label: "Normalisation ceiling",
                value: formatPheromoneBoundValue(bounds.normalisation_ceiling),
                tooltip: "Plafond utilisé pour calculer la valeur normalisée des cellules heatmap.",
            },
        ],
    };
}
//# sourceMappingURL=stigmergy.js.map