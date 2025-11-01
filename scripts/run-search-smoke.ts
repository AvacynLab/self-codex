#!/usr/bin/env node
/**
 * Runs a lightweight smoke test against the dockerised search stack. The script
 * boots the compose file, executes a real `search.run` pipeline using the
 * repository code and validates that documents, knowledge graph triples and
 * vector embeddings were produced. Designed to be human-friendly: failures are
 * reported with actionable guidance and resources are always torn down.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSearchStackManager,
  resolveStackLifecyclePolicy,
} from "./lib/searchStack.js";
import { assessSmokeRun } from "./lib/searchSmokePlan.js";
import { StructuredLogger } from "../src/logger.js";
import { EventStore } from "../src/eventStore.js";
import { loadSearchConfig } from "../src/search/config.js";
import { SearxClient } from "../src/search/searxClient.js";
import { SearchDownloader } from "../src/search/downloader.js";
import { UnstructuredExtractor } from "../src/search/extractor.js";
import { KnowledgeGraph } from "../src/knowledge/knowledgeGraph.js";
import { KnowledgeGraphIngestor } from "../src/search/ingest/toKnowledgeGraph.js";
import { LocalVectorMemory } from "../src/memory/vectorMemory.js";
import { VectorStoreIngestor } from "../src/search/ingest/toVectorStore.js";
import { SearchPipeline } from "../src/search/pipeline.js";
import { SearchMetricsRecorder } from "../src/search/metrics.js";
import {
  type ValidationScenarioDefinition,
  formatScenarioSlug,
} from "../src/validationRun/scenario.js";
import { persistSearchScenarioArtefacts } from "./lib/searchArtifacts.js";
import { ensureValidationRunLayout } from "../src/validationRun/layout.js";

const manager = createSearchStackManager();

/**
 * Synthetic scenario definition dedicated to the docker smoke run. Using a high id keeps
 * the slug (`S90_search_smoke`) distinct from the formal validation scenarios while still
 * benefiting from the shared directory preparation helpers.
 */
const SMOKE_SCENARIO: ValidationScenarioDefinition = {
  id: 90,
  label: "Recherche (smoke)",
  slugHint: "search_smoke",
  description: "Sanity check hitting the dockerised Searx + Unstructured stack.",
  input: {},
};

/**
 * Environment overrides required to reach the dockerised services from host and
 * to keep the smoke flow lightweight (fewer concurrent fetches and a faster
 * Unstructured strategy).
 */
const ENV_OVERRIDES: Record<string, string> = {
  SEARCH_SEARX_BASE_URL: "http://127.0.0.1:8080",
  UNSTRUCTURED_BASE_URL: "http://127.0.0.1:8000",
  SEARCH_INJECT_GRAPH: "1",
  SEARCH_INJECT_VECTOR: "1",
  SEARCH_PARALLEL_FETCH: "2",
  SEARCH_PARALLEL_EXTRACT: "1",
  SEARCH_FETCH_RESPECT_ROBOTS: "1",
  UNSTRUCTURED_STRATEGY: "fast",
  UNSTRUCTURED_TIMEOUT_MS: "60000",
};

function applyEnvOverrides(): Map<string, string | undefined> {
  const backup = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
    backup.set(key, process.env[key]);
    process.env[key] = value;
  }
  return backup;
}

function restoreEnv(backup: Map<string, string | undefined>): void {
  for (const [key, value] of backup.entries()) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

async function createPipeline(workDir: string): Promise<{
  pipeline: SearchPipeline;
  knowledgeGraph: KnowledgeGraph;
  vectorMemory: LocalVectorMemory;
}> {
  const logger = new StructuredLogger();
  const eventStore = new EventStore({ maxHistory: 512, logger });
  const config = loadSearchConfig();
  const knowledgeGraph = new KnowledgeGraph();
  const vectorMemory = await LocalVectorMemory.create({ directory: workDir });
  const pipeline = new SearchPipeline({
    config,
    searxClient: new SearxClient(config),
    downloader: new SearchDownloader(config.fetch),
    extractor: new UnstructuredExtractor(config),
    knowledgeIngestor: new KnowledgeGraphIngestor({ graph: knowledgeGraph }),
    vectorIngestor: new VectorStoreIngestor({ memory: vectorMemory }),
    eventStore,
    logger,
    metrics: new SearchMetricsRecorder(),
  });
  return { pipeline, knowledgeGraph, vectorMemory };
}

async function runSmoke(): Promise<void> {
  const available = await manager.isDockerAvailable();
  if (!available) {
    console.warn("Docker is not available on this host, skipping search smoke test.");
    return;
  }

  // Respect lifecycle overrides so the smoke validation can reuse containers
  // provisioned by previous suites (for example the e2e flow in CI).
  const lifecycle = resolveStackLifecyclePolicy();
  if (lifecycle.shouldBringUp) {
    await manager.bringUpStack();
  }
  let workDir: string | null = null;
  const envBackup = applyEnvOverrides();
  try {
    await manager.waitForSearxReady();
    await manager.waitForUnstructuredReady();

    workDir = await mkdtemp(join(tmpdir(), "search-smoke-"));
    const { pipeline, knowledgeGraph, vectorMemory } = await createPipeline(workDir);

    /**
     * Reliable smoke probes prioritise lightweight HTML sources to avoid PDF
     * processing timeouts in Unstructured. Each plan is attempted sequentially
     * until the ingestion criteria are satisfied.
     */
    const plans: Array<{ query: string; categories: string[]; maxResults: number }> = [
      {
        query: "site:wikipedia.org retrieval augmented generation",
        categories: ["general"],
        maxResults: 3,
      },
      {
        query: "site:docs.python.org data classes tutorial",
        categories: ["general"],
        maxResults: 3,
      },
    ];

    let finalAssessment: ReturnType<typeof assessSmokeRun> | null = null;
  let lastJob: Awaited<ReturnType<SearchPipeline["runSearchJob"]>> | null = null;
  const attemptedPlans: Array<{ query: string; categories: string[]; maxResults: number }> = [];

    for (const plan of plans) {
      attemptedPlans.push(plan);
      const job = await pipeline.runSearchJob({
        ...plan,
        fetchContent: true,
        injectGraph: true,
        injectVector: true,
      });

      lastJob = job;
      finalAssessment = assessSmokeRun({
        documents: job.documents.length,
        graphTriples: knowledgeGraph.count(),
        vectorEmbeddings: vectorMemory.size(),
      });

      console.info("Search smoke stats:", {
        query: plan.query,
        documents: job.documents.length,
        graphTriples: knowledgeGraph.count(),
        vectorEmbeddings: vectorMemory.size(),
        errors: job.errors.length,
      });

      if (finalAssessment.ok) {
        break;
      }
    }

    if (!finalAssessment?.ok) {
      const message = `${finalAssessment?.message ?? "Smoke validation failed."} See docker logs for more details.`;
      if (lastJob) {
        console.error("Last smoke job errors:", lastJob.errors);
      }
      throw new Error(message);
    }

    if (!lastJob) {
      throw new Error("Smoke run completed without producing a job result.");
    }

    if (!workDir) {
      throw new Error("Temporary workspace directory was not initialised.");
    }

    const layout = await ensureValidationRunLayout();
    const scenarioSlug = formatScenarioSlug(SMOKE_SCENARIO);
    const vectorIndexPath = join(workDir, "index.json");
    const vectorSnapshot = await readVectorIndexSafe(vectorIndexPath);
    const eventSnapshot = eventStore.getSnapshot().map((event) => ({ ...event }));
    const timings = buildTimingSummary(eventSnapshot, lastJob.jobId);

    await persistSearchScenarioArtefacts(
      {
        input: {
          attemptedPlans,
          selectedPlan: lastJob.query,
          overrides: ENV_OVERRIDES,
        },
        response: {
          jobId: lastJob.jobId,
          stats: lastJob.stats,
          documents: lastJob.documents.map((doc) => ({
            id: doc.id,
            url: doc.url,
            mimeType: doc.mimeType,
            title: doc.title,
            language: doc.language,
            checksum: doc.checksum,
          })),
          errorCount: lastJob.errors.length,
        },
        events: eventSnapshot,
        timings,
        errors: lastJob.errors.map((error) => ({ ...error })),
        kgChanges: knowledgeGraph
          .exportAll()
          .map((triple) => ({ ...triple })),
        vectorUpserts: vectorSnapshot,
        serverLog: buildServerLogPlaceholder(scenarioSlug),
      },
      {
        scenario: SMOKE_SCENARIO,
        baseRoot: layout.root,
        slugOverride: scenarioSlug,
      },
    );
  } finally {
    restoreEnv(envBackup);
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
    if (lifecycle.shouldTearDown) {
      await manager.tearDownStack({ allowFailure: true });
    }
  }
}

runSmoke().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

/**
 * Builds a compact timing summary describing when the orchestrated job started and
 * completed. The helper looks at the recorded event timestamps to avoid relying on
 * wall-clock measurements sprinkled across the script.
 */
function buildTimingSummary(
  events: ReadonlyArray<Record<string, unknown>>,
  jobId: string,
): Record<string, unknown> {
  const timestamps = events
    .filter((event) => (event.jobId ?? null) === jobId)
    .map((event) => Number.parseInt(String(event.ts ?? ""), 10))
    .filter((value) => Number.isFinite(value));
  const startedAt = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const completedAt = timestamps.length > 0 ? Math.max(...timestamps) : null;
  return {
    jobId,
    startedAt,
    completedAt,
    tookMs: startedAt !== null && completedAt !== null ? completedAt - startedAt : null,
    eventCount: events.length,
  };
}

/**
 * Reads the vector index snapshot written by {@link LocalVectorMemory}. The helper returns
 * an empty array when the index does not exist yet so artefact generation remains tolerant of
 * scenarios that skip vector ingestion.
 */
async function readVectorIndexSafe(indexPath: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => ({ ...entry }));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return [];
}

/**
 * Produces a deterministic log placeholder reminding operators how to capture the docker
 * compose logs manually. Capturing the full log stream from the script would require piping
 * `docker compose logs`, which is intentionally deferred to operators.
 */
function buildServerLogPlaceholder(scenarioSlug: string): string {
  const timestamp = new Date().toISOString();
  return `# ${scenarioSlug}\nNo docker compose logs were captured automatically.\n` +
    `Generated at: ${timestamp}\nInspect with: docker compose -f docker/docker-compose.search.yml logs --tail=200\n`;
}
