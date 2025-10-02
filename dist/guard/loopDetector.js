const DEFAULT_LOOP_WINDOW_MS = 60_000;
const DEFAULT_MAX_ALTERNATIONS = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const TASK_DURATION_ALPHA = 0.2;
function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, value));
}
function buildLoopKey(from, to, signature) {
    const participantsKey = [from, to].sort().join("::");
    return `${participantsKey}|${signature}`;
}
function sanitizeIdentifier(value, kind) {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`${kind} identifier must be a non-empty string`);
    }
    return trimmed;
}
/**
 * Watches interactions between orchestrator components to detect short loops and
 * recommend mitigation strategies (warnings or forced termination). The
 * detector also maintains aggregated task statistics to derive adaptive timeout
 * recommendations.
 */
export class LoopDetector {
    loopWindowMs;
    maxAlternations;
    warnAtAlternations;
    defaultTimeoutMs;
    configuredProfiles;
    loopStates = new Map();
    taskProfiles = new Map();
    constructor(options = {}) {
        this.loopWindowMs = options.loopWindowMs && options.loopWindowMs > 0 ? options.loopWindowMs : DEFAULT_LOOP_WINDOW_MS;
        this.maxAlternations = options.maxAlternations && options.maxAlternations > 0 ? options.maxAlternations : DEFAULT_MAX_ALTERNATIONS;
        const warn = options.warnAtAlternations && options.warnAtAlternations >= 1 ? options.warnAtAlternations : this.maxAlternations - 1;
        this.warnAtAlternations = warn < 1 ? 1 : warn;
        this.defaultTimeoutMs = options.defaultTimeoutMs && options.defaultTimeoutMs > 0 ? options.defaultTimeoutMs : DEFAULT_TIMEOUT_MS;
        this.configuredProfiles = new Map(Object.entries(options.taskTimeouts ?? {}));
    }
    /**
     * Clears any recorded loop state and telemetry. Primarily used by tests.
     */
    reset() {
        this.loopStates.clear();
        this.taskProfiles.clear();
    }
    /**
     * Records a new exchange and checks whether it participates in an alternating
     * loop pattern. When the amount of direction flips reaches the warning or kill
     * thresholds an alert is returned.
     */
    recordInteraction(sample) {
        const from = sanitizeIdentifier(sample.from, "from");
        const to = sanitizeIdentifier(sample.to, "to");
        const signature = sanitizeIdentifier(sample.signature, "signature");
        const timestamp = sample.timestamp ?? Date.now();
        this.pruneStates(timestamp);
        const direction = `${from}->${to}`;
        const loopKey = buildLoopKey(from, to, signature);
        let state = this.loopStates.get(loopKey);
        if (!state) {
            state = this.createState(sample, direction, timestamp, signature);
            this.loopStates.set(loopKey, state);
            return null;
        }
        const elapsedSinceLast = timestamp - state.lastTimestamp;
        if (elapsedSinceLast > this.loopWindowMs) {
            state = this.createState(sample, direction, timestamp, signature);
            this.loopStates.set(loopKey, state);
            return null;
        }
        if (state.lastDirection === direction) {
            state = this.createState(sample, direction, timestamp, signature);
            this.loopStates.set(loopKey, state);
            return null;
        }
        state.alternations += 1;
        state.lastDirection = direction;
        state.lastTimestamp = timestamp;
        state.participants.add(from);
        state.participants.add(to);
        if (sample.childId) {
            state.childIds.add(sample.childId);
        }
        if (sample.taskId) {
            state.taskIds.add(sample.taskId);
        }
        if (sample.taskType) {
            state.taskTypes.add(sample.taskType);
        }
        const shouldKill = state.alternations >= this.maxAlternations;
        const shouldWarn = !shouldKill && state.alternations >= this.warnAtAlternations;
        if (!shouldKill && !shouldWarn) {
            return null;
        }
        const recommendation = shouldKill ? "kill" : "warn";
        const reasonBase = `Detected ${state.alternations} alternating exchanges repeating signature "${signature}"`;
        const alert = {
            type: "loop_detected",
            participants: Array.from(state.participants),
            childIds: Array.from(state.childIds),
            taskIds: Array.from(state.taskIds),
            taskTypes: Array.from(state.taskTypes),
            signature,
            occurrences: state.alternations,
            windowMs: this.loopWindowMs,
            firstTimestamp: state.firstTimestamp,
            lastTimestamp: state.lastTimestamp,
            recommendation,
            reason: shouldKill ? `${reasonBase}; termination recommended to break the loop.` : `${reasonBase}; investigate before escalation.`,
        };
        if (shouldKill) {
            this.loopStates.delete(loopKey);
        }
        return alert;
    }
    /**
     * Registers task runtime metrics to compute adaptive timeout suggestions.
     */
    recordTaskObservation(observation) {
        const type = sanitizeIdentifier(observation.taskType, "taskType");
        if (!Number.isFinite(observation.durationMs) || observation.durationMs <= 0) {
            return;
        }
        const timestamp = observation.timestamp ?? Date.now();
        const stats = this.taskProfiles.get(type);
        if (!stats) {
            this.taskProfiles.set(type, {
                meanDuration: observation.durationMs,
                sampleCount: 1,
                successCount: observation.success ? 1 : 0,
                lastObservedAt: timestamp,
            });
            return;
        }
        const previousMean = stats.meanDuration;
        const updatedMean = previousMean * (1 - TASK_DURATION_ALPHA) + observation.durationMs * TASK_DURATION_ALPHA;
        stats.meanDuration = updatedMean;
        stats.sampleCount += 1;
        if (observation.success) {
            stats.successCount += 1;
        }
        stats.lastObservedAt = timestamp;
    }
    /**
     * Suggests a timeout for the provided task type by combining configuration
     * hints with the observed runtime telemetry.
     */
    recommendTimeout(taskType, complexityScore = 1) {
        const type = sanitizeIdentifier(taskType, "taskType");
        const profile = this.configuredProfiles.get(type);
        const baseMs = profile?.baseMs ?? this.defaultTimeoutMs;
        const minMs = profile?.minMs ?? Math.max(5_000, Math.floor(baseMs * 0.75));
        const maxMs = profile?.maxMs ?? Math.max(baseMs * 4, baseMs + 120_000);
        const multiplier = profile?.complexityMultiplier ?? 1.5;
        const clampedComplexity = clampNumber(complexityScore, 0.25, 8);
        const stats = this.taskProfiles.get(type);
        let recommended = baseMs * Math.max(1, clampedComplexity * (multiplier > 1 ? multiplier / 2 : multiplier));
        if (stats) {
            const successRatio = stats.successCount / stats.sampleCount;
            const predictiveBudget = stats.meanDuration * multiplier * clampedComplexity;
            recommended = Math.max(baseMs, predictiveBudget);
            if (successRatio < 0.35) {
                recommended = Math.min(recommended, baseMs * 1.2);
            }
        }
        return Math.round(clampNumber(recommended, minMs, maxMs));
    }
    createState(sample, direction, timestamp, signature) {
        const participants = new Set([sample.from.trim(), sample.to.trim()]);
        const childIds = new Set();
        const taskIds = new Set();
        const taskTypes = new Set();
        if (sample.childId) {
            childIds.add(sample.childId);
        }
        if (sample.taskId) {
            taskIds.add(sample.taskId);
        }
        if (sample.taskType) {
            taskTypes.add(sample.taskType);
        }
        return {
            signature,
            participants,
            childIds,
            taskIds,
            taskTypes,
            lastDirection: direction,
            alternations: 0,
            firstTimestamp: timestamp,
            lastTimestamp: timestamp,
        };
    }
    pruneStates(now) {
        for (const [key, state] of this.loopStates.entries()) {
            if (now - state.lastTimestamp > this.loopWindowMs) {
                this.loopStates.delete(key);
            }
        }
    }
}
