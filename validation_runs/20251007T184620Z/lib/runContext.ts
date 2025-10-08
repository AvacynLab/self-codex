import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Describes the absolute paths of the artefact directories managed for a
 * validation run. Each sub-folder hosts a dedicated category of evidence that
 * must be collected while exercising the MCP server.
 */
export interface RunDirectories {
  /** Directory that stores the JSON payloads sent to the MCP tools. */
  readonly inputs: string;
  /** Directory that stores the raw JSON responses returned by the server. */
  readonly outputs: string;
  /** Directory that contains event stream captures serialised as JSON Lines. */
  readonly events: string;
  /** Directory that aggregates timestamped execution logs. */
  readonly logs: string;
  /** Directory that mirrors the resources fetched via the MCP resource APIs. */
  readonly resources: string;
  /** Directory dedicated to the human and machine readable reports. */
  readonly report: string;
}

/**
 * Represents the contextual information shared across validation steps,
 * including the run identifier, the resolved filesystem layout and a
 * deterministic trace identifier generator.
 */
export interface RunContext {
  /** Identifier chosen for the validation run (mirrors the timestamp folder). */
  readonly runId: string;
  /** Absolute path of the run root directory. */
  readonly rootDir: string;
  /** Lazily created directories storing the audit artefacts. */
  readonly directories: RunDirectories;
  /** Function that yields unique trace identifiers for MCP invocations. */
  readonly createTraceId: () => string;
}

/**
 * Ensures that the canonical directory structure exists for the validation
 * artefacts. Missing folders are created lazily, whereas pre-existing ones are
 * left untouched to preserve potential manual notes.
 */
export async function ensureRunDirectories(runRoot: string): Promise<RunDirectories> {
  const directories: RunDirectories = {
    inputs: path.join(runRoot, 'inputs'),
    outputs: path.join(runRoot, 'outputs'),
    events: path.join(runRoot, 'events'),
    logs: path.join(runRoot, 'logs'),
    resources: path.join(runRoot, 'resources'),
    report: path.join(runRoot, 'report'),
  };

  await Promise.all(
    Object.values(directories).map(async (dir) => {
      try {
        const stats = await stat(dir);
        if (!stats.isDirectory()) {
          throw new Error(`Path ${dir} exists but is not a directory`);
        }
      } catch (error: unknown) {
        await mkdir(dir, { recursive: true });
      }
    }),
  );

  return directories;
}

/**
 * Builds a deterministic trace identifier generator. The factory derives a
 * reproducible 32-hex digest from the provided seed and a monotonic counter,
 * ensuring that retries can share the same trace identifier when the seed is
 * preserved. The prefix helps quickly differentiate trace identifiers from
 * other IDs when scanning logs.
 */
export function createTraceIdFactory(seed: string = randomUUID()): () => string {
  const sanitizedSeed = seed.replace(/[^a-zA-Z0-9_-]/g, '');
  let counter = 0;

  return () => {
    counter += 1;
    const hash = createHash('sha256');
    hash.update(sanitizedSeed);
    hash.update(':');
    hash.update(counter.toString(10));

    return `trace-${hash.digest('hex').slice(0, 32)}`;
  };
}

/**
 * Creates a high-level context object that the validation harness can pass to
 * each stage of the checklist. The helper combines directory initialisation and
 * trace identifier generation while keeping the API intentionally small to ease
 * testing.
 */
export async function createRunContext(params: {
  /** Run identifier that should match the timestamp-based folder name. */
  readonly runId: string;
  /** Absolute path to the workspace root (repository root). */
  readonly workspaceRoot: string;
  /** Optional seed used to make trace identifier generation reproducible. */
  readonly traceSeed?: string;
}): Promise<RunContext> {
  const rootDir = path.join(params.workspaceRoot, 'validation_runs', params.runId);
  const directories = await ensureRunDirectories(rootDir);

  return {
    runId: params.runId,
    rootDir,
    directories,
    createTraceId: createTraceIdFactory(params.traceSeed),
  };
}
