#!/usr/bin/env node
/**
 * Runs a lightweight smoke test against the dockerised search stack. The script
 * boots the compose file, executes a real `search.run` pipeline using the
 * repository code and validates that documents, knowledge graph triples and
 * vector embeddings were produced. Designed to be human-friendly: failures are
 * reported with actionable guidance and resources are always torn down.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSearchStackManager } from "./lib/searchStack.js";
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

const manager = createSearchStackManager();

/** Environment overrides required to reach the dockerised services from host. */
const ENV_OVERRIDES: Record<string, string> = {
  SEARCH_SEARX_BASE_URL: "http://127.0.0.1:8080",
  UNSTRUCTURED_BASE_URL: "http://127.0.0.1:8000",
  SEARCH_INJECT_GRAPH: "1",
  SEARCH_INJECT_VECTOR: "1",
  SEARCH_FETCH_PARALLEL: "2",
  SEARCH_FETCH_RESPECT_ROBOTS: "1",
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

  await manager.bringUpStack();
  let workDir: string | null = null;
  const envBackup = applyEnvOverrides();
  try {
    await manager.waitForSearxReady();
    await manager.waitForUnstructuredReady();

    workDir = await mkdtemp(join(tmpdir(), "search-smoke-"));
    const { pipeline, knowledgeGraph, vectorMemory } = await createPipeline(workDir);

    const job = await pipeline.runSearchJob({
      query: "site:arxiv.org LLM 2025 filetype:pdf",
      categories: ["files", "general"],
      maxResults: 4,
      fetchContent: true,
      injectGraph: true,
      injectVector: true,
    });

    const assessment = assessSmokeRun({
      documents: job.documents.length,
      graphTriples: knowledgeGraph.count(),
      vectorEmbeddings: vectorMemory.size(),
    });

    console.info("Search smoke stats:", {
      documents: job.documents.length,
      graphTriples: knowledgeGraph.count(),
      vectorEmbeddings: vectorMemory.size(),
      errors: job.errors.length,
    });

    if (!assessment.ok) {
      throw new Error(`${assessment.message} See docker logs for more details.`);
    }
  } finally {
    restoreEnv(envBackup);
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
    await manager.tearDownStack({ allowFailure: true });
  }
}

runSmoke().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
