import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
/** Error raised when a log operation fails. */
export class LogJournalError extends Error {
    code;
    constructor(message, code = "E-LOG-JOURNAL") {
        super(message);
        this.code = code;
        this.name = "LogJournalError";
    }
}
/** Constants controlling memory usage and rotation defaults. */
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MiB keeps artefacts small.
const DEFAULT_MAX_FILE_COUNT = 5;
/** Ensures a string bucket identifier is safe to use within file paths. */
function sanitiseBucketId(raw) {
    const trimmed = raw.trim();
    if (!trimmed.length) {
        return "default";
    }
    const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, "-");
    return safe.slice(0, 120) || "default";
}
/** Resolve the base directory for a given stream. */
function resolveStreamDir(rootDir, stream) {
    switch (stream) {
        case "server":
            return join(rootDir, "server");
        case "run":
            return join(rootDir, "runs");
        case "child":
            return join(rootDir, "children");
        default:
            return rootDir;
    }
}
/** Creates the JSONL file path for a bucket. */
function resolveBucketPath(rootDir, stream, bucketId) {
    const baseDir = resolveStreamDir(rootDir, stream);
    const safeId = sanitiseBucketId(bucketId);
    return join(baseDir, `${safeId}.jsonl`);
}
/**
 * Maintains correlated log entries for the orchestrator. Entries are preserved in memory for fast
 * access and mirrored to JSONL artefacts with size-based rotation.
 */
export class LogJournal {
    rootDir;
    maxEntries;
    maxFileSize;
    maxFileCount;
    buckets = new Map();
    constructor(options) {
        this.rootDir = resolve(options.rootDir);
        this.maxEntries = Math.max(1, options.maxEntriesPerBucket ?? DEFAULT_MAX_ENTRIES);
        this.maxFileSize = Math.max(64 * 1024, options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE);
        this.maxFileCount = Math.max(1, options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT);
    }
    /** Clears all in-memory entries and resets sequence counters. */
    reset() {
        this.buckets.clear();
    }
    /**
     * Records a new correlated entry. The write is synchronous from the caller perspective while file
     * persistence is enqueued to guarantee ordering without blocking orchestrator hot paths.
     */
    record(input) {
        const bucketId = input.bucketId?.trim() && input.bucketId.trim().length > 0 ? input.bucketId.trim() : "orchestrator";
        const key = this.buildBucketKey(input.stream, bucketId);
        const state = this.getOrCreateBucket(input.stream, bucketId, key);
        const seq = input.seq && input.seq > state.lastSeq ? input.seq : state.lastSeq + 1;
        state.lastSeq = Math.max(state.lastSeq, seq);
        const ts = typeof input.ts === "number" && Number.isFinite(input.ts) ? Math.floor(input.ts) : Date.now();
        const entry = {
            seq,
            ts,
            stream: input.stream,
            bucketId,
            level: input.level,
            message: input.message,
            data: input.data,
            jobId: input.jobId ?? null,
            runId: input.runId ?? null,
            opId: input.opId ?? null,
            graphId: input.graphId ?? null,
            nodeId: input.nodeId ?? null,
            childId: input.childId ?? null,
        };
        state.entries.push(entry);
        if (state.entries.length > this.maxEntries) {
            state.entries.splice(0, state.entries.length - this.maxEntries);
        }
        state.writeQueue = state.writeQueue
            .then(() => this.appendToFile(state, entry))
            .catch(() => {
            // Reset the queue so subsequent writes are not blocked by transient errors.
            state.writeQueue = Promise.resolve();
        });
        this.buckets.set(key, state);
        return entry;
    }
    /** Retrieves a slice of log entries ordered by their sequence number. */
    tail(input) {
        const bucketId = input.bucketId?.trim() && input.bucketId.trim().length > 0 ? input.bucketId.trim() : "orchestrator";
        const key = this.buildBucketKey(input.stream, bucketId);
        const state = this.buckets.get(key);
        if (!state) {
            return { entries: [], nextSeq: 0 };
        }
        const fromSeq = typeof input.fromSeq === "number" && input.fromSeq >= 0 ? input.fromSeq : 0;
        const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(Math.floor(input.limit), this.maxEntries) : this.maxEntries;
        const filtered = state.entries.filter((entry) => entry.seq > fromSeq);
        const ordered = filtered.sort((a, b) => a.seq - b.seq).slice(0, limit);
        const nextSeq = ordered.length ? ordered[ordered.length - 1].seq : state.lastSeq;
        return { entries: ordered, nextSeq };
    }
    /** Waits for all pending file writes to complete. */
    async flush() {
        await Promise.all(Array.from(this.buckets.values(), (bucket) => bucket.writeQueue));
    }
    buildBucketKey(stream, bucketId) {
        return `${stream}:${bucketId}`;
    }
    getOrCreateBucket(stream, bucketId, key) {
        const existing = this.buckets.get(key);
        if (existing) {
            return existing;
        }
        const filePath = resolveBucketPath(this.rootDir, stream, bucketId);
        return {
            entries: [],
            lastSeq: 0,
            writeQueue: Promise.resolve(),
            bytesWritten: 0,
            writerReady: false,
            filePath,
        };
    }
    async appendToFile(state, entry) {
        try {
            if (!state.writerReady) {
                await this.ensureWriter(state);
            }
            const line = `${JSON.stringify(entry)}\n`;
            await this.rotateIfNeeded(state, Buffer.byteLength(line, "utf8"));
            await appendFile(state.filePath, line, "utf8");
            state.bytesWritten += Buffer.byteLength(line, "utf8");
        }
        catch (error) {
            // On persistence failure, attempt to reset the bucket so future writes can retry.
            state.writerReady = false;
            state.bytesWritten = 0;
            throw new LogJournalError(error instanceof Error ? error.message : `log_persist_failed:${String(error)}`, "E-LOG-WRITE");
        }
    }
    async ensureWriter(state) {
        const directory = dirname(state.filePath);
        await mkdir(directory, { recursive: true });
        try {
            const stats = await stat(state.filePath);
            state.bytesWritten = stats.size;
        }
        catch (error) {
            if (error.code === "ENOENT") {
                state.bytesWritten = 0;
            }
            else {
                throw error;
            }
        }
        state.writerReady = true;
    }
    async rotateIfNeeded(state, nextWriteBytes) {
        if (state.bytesWritten + nextWriteBytes <= this.maxFileSize) {
            return;
        }
        await this.rotateFiles(state.filePath);
        state.bytesWritten = 0;
    }
    async rotateFiles(target) {
        const directory = dirname(target);
        await mkdir(directory, { recursive: true });
        // Remove the oldest file if needed so rotation can proceed.
        const oldest = `${target}.${this.maxFileCount}`;
        try {
            await rm(oldest, { force: true });
        }
        catch {
            // Ignore removal errors: the file may not exist on the first rotations.
        }
        for (let index = this.maxFileCount - 1; index >= 1; index -= 1) {
            const source = `${target}.${index}`;
            const destination = `${target}.${index + 1}`;
            try {
                await rename(source, destination);
            }
            catch (error) {
                if (error.code !== "ENOENT") {
                    throw error;
                }
            }
        }
        try {
            await rename(target, `${target}.1`);
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }
}
