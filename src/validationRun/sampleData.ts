import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { KnowledgeTripleSnapshot } from "../knowledge/knowledgeGraph.js";
import type { DocumentSummary, KnowledgeGraphDocumentSummary, VectorChunkSummary } from "./execution.js";
import { computeScenarioTimingReportFromEvents, writeScenarioDashboardExport } from "./metrics.js";
import { recordScenarioRun, type ScenarioErrorEntry } from "./artefacts.js";
import { ensureValidationRunLayout, type ValidationRunLayout } from "./layout.js";
import {
  VALIDATION_SCENARIOS,
  formatScenarioSlug,
  type ValidationScenarioDefinition,
} from "./scenario.js";

/** Representation of a knowledge triple used by the sample dataset. */
interface ScenarioKnowledgeTripleSeed {
  readonly predicate: string;
  readonly object: string;
  readonly confidence: number;
}

/**
 * Minimal description of a vector chunk associated with a document. Each
 * segment label is later namespaced to keep identifiers unique per scenario.
 */
interface ScenarioVectorSegmentSeed {
  readonly label: string;
  readonly tokenCount: number;
  readonly textLength: number;
}

/**
 * Synthetic document metadata used to generate knowledge, vector and timing
 * artefacts for a scenario.
 */
interface ScenarioDocumentSeed {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly language: string;
  readonly description: string;
  readonly mimeType: string;
  readonly checksum: string;
  readonly size: number;
  readonly fetchedOffset: number;
  readonly segmentCount: number;
  readonly knowledgeMentions: readonly string[];
  readonly knowledge: readonly ScenarioKnowledgeTripleSeed[];
  readonly segments: readonly ScenarioVectorSegmentSeed[];
}

/** Duration profile applied to the synthetic event stream of a scenario. */
interface StageProfile {
  readonly searxQuery: number;
  readonly fetchUrl: readonly number[];
  readonly extractWithUnstructured: readonly number[];
  readonly ingestToGraph: number;
  readonly ingestToVector: number;
  readonly tookMs: number;
}

/** Error event seed mirrored in `events.ndjson`. */
interface ScenarioErrorEventSeed {
  readonly category: string;
  readonly message: string;
  readonly stage?: string;
  readonly url?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Narrative summary persisted inside the synthetic `response.json`. */
interface ScenarioResponseSummary {
  readonly summary: string;
  readonly highlights: readonly string[];
  readonly recommendations: readonly string[];
}

/** Definition describing how to synthesise artefacts for a given scenario. */
interface ScenarioSeedDefinition {
  readonly documents: readonly ScenarioDocumentSeed[];
  readonly stageProfile: StageProfile;
  readonly response: ScenarioResponseSummary;
  readonly errors: readonly ScenarioErrorEntry[];
  readonly errorEvents: readonly ScenarioErrorEventSeed[];
  readonly logNotes: readonly string[];
  readonly citations?: readonly { docId: string; url: string }[];
}

/** Options controlling where the sample dataset is materialised. */
export interface SeedSampleValidationDataOptions {
  readonly layout?: ValidationRunLayout;
  readonly baseRoot?: string;
}

/** Synthetic artefacts shared by the CLI and unit tests. */
export interface SampleScenarioData {
  readonly response: Record<string, unknown>;
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly errors: ReadonlyArray<ScenarioErrorEntry>;
  readonly knowledgeChanges: ReadonlyArray<Record<string, unknown>>;
  readonly vectorUpserts: ReadonlyArray<Record<string, unknown>>;
  readonly serverLog: ReadonlyArray<string>;
  readonly knowledgeGraph: ReadonlyArray<KnowledgeTripleSnapshot>;
  readonly knowledgeSummaries: ReadonlyArray<KnowledgeGraphDocumentSummary>;
  readonly documents: ReadonlyArray<DocumentSummary>;
  readonly vectorSummaries: ReadonlyArray<VectorChunkSummary>;
}

/**
 * Pre-generated validation scenarios enabling deterministic exploration of the
 * tooling without hitting external services.
 */
const BASE_TIME = Date.parse("2025-01-15T09:00:00Z");

export const SAMPLE_VALIDATION_SCENARIOS: Readonly<Record<number, SampleScenarioData>> =
  buildSampleDataset();

/** Materialises the synthetic dataset inside `validation_run/`. */
export async function seedSampleValidationData(
  options: SeedSampleValidationDataOptions = {},
): Promise<void> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));

  for (const scenario of VALIDATION_SCENARIOS) {
    const sample = SAMPLE_VALIDATION_SCENARIOS[scenario.id];
    if (!sample) {
      throw new Error(`Aucune donnée d'exemple définie pour le scénario ${scenario.id}.`);
    }

    const timings = computeScenarioTimingReportFromEvents(sample.events);

    await recordScenarioRun(
      scenario.id,
      {
        input: scenario.input,
        response: sample.response,
        events: sample.events,
        timings: timings.report,
        errors: sample.errors,
        kgChanges: sample.knowledgeChanges,
        vectorUpserts: sample.vectorUpserts,
        serverLog: sample.serverLog,
      },
      { layout },
    );

    const artifactDir = path.join(layout.artifactsDir, formatScenarioSlug(scenario));
    await mkdir(artifactDir, { recursive: true });
    await writeJson(path.join(artifactDir, "knowledge_graph.json"), sample.knowledgeGraph);
    await writeJson(path.join(artifactDir, "documents_summary.json"), sample.documents);
    await writeJson(path.join(artifactDir, "knowledge_summary.json"), sample.knowledgeSummaries);
    await writeJson(path.join(artifactDir, "vector_chunks.json"), sample.vectorSummaries);
    await writeJson(path.join(artifactDir, "response_summary.json"), sample.response);
    if (timings.notes.length > 0) {
      await writeJson(path.join(artifactDir, "timing_notes.json"), timings.notes);
    }

    await writeScenarioDashboardExport(scenario.id, timings.report, {
      layout,
      now: new Date(BASE_TIME + scenario.id * 60_000),
    });
  }
}

/** Serialises the provided payload to prettified JSON with a trailing newline. */
async function writeJson(targetPath: string, payload: unknown): Promise<void> {
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
}

/** Builds the scenario dataset eagerly so it can be reused by tests. */
function buildSampleDataset(): Readonly<Record<number, SampleScenarioData>> {
  const scenarios: Record<number, SampleScenarioData> = {};
  const definitions = new Map<number, ValidationScenarioDefinition>();
  for (const scenario of VALIDATION_SCENARIOS) {
    definitions.set(scenario.id, scenario);
  }

  scenarios[1] = buildScenarioSample(definitions.get(1)!, buildPdfScienceSeed());
  scenarios[2] = buildScenarioSample(definitions.get(2)!, buildHtmlLongSeed());
  scenarios[3] = buildScenarioSample(definitions.get(3)!, buildNewsFreshnessSeed());
  scenarios[4] = buildScenarioSample(definitions.get(4)!, buildMultilingualSeed());
  scenarios[5] = buildScenarioSample(definitions.get(5)!, buildIdempotenceSeed());
  scenarios[6] = buildScenarioSample(definitions.get(6)!, buildRobotsSeed());
  scenarios[7] = buildScenarioSample(definitions.get(7)!, buildUnstableSourcesSeed());
  scenarios[8] = buildScenarioSample(definitions.get(8)!, buildDirectIndexSeed());
  scenarios[9] = buildScenarioSample(definitions.get(9)!, buildModerateLoadSeed());
  scenarios[10] = buildRagScenarioSample(definitions.get(10)!);

  return scenarios;
}

/**
 * Builds the synthetic artefacts for search-driven scenarios (S01–S09). The
 * helper expands concise document seeds into the full collection of artefacts
 * expected by the validation playbook.
 */
function buildScenarioSample(
  scenario: ValidationScenarioDefinition,
  seed: ScenarioSeedDefinition,
): SampleScenarioData {
  const slug = formatScenarioSlug(scenario);
  const baseTime = BASE_TIME + scenario.id * 45_000;
  const documents: DocumentSummary[] = [];
  const knowledgeSummaries: KnowledgeGraphDocumentSummary[] = [];
  const knowledgeGraph: KnowledgeTripleSnapshot[] = [];
  const vectorSummaries: VectorChunkSummary[] = [];
  const knowledgeChanges: Record<string, unknown>[] = [];
  const vectorUpserts: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];

  const fetchDurations = seed.stageProfile.fetchUrl;
  const extractDurations = seed.stageProfile.extractWithUnstructured;
  if (fetchDurations.length !== seed.documents.length) {
    throw new Error(
      `Profil fetchUrl (${fetchDurations.length}) incompatible avec ${seed.documents.length} documents pour ${slug}.`,
    );
  }
  if (extractDurations.length !== seed.documents.length) {
    throw new Error(
      `Profil extract (${extractDurations.length}) incompatible avec ${seed.documents.length} documents pour ${slug}.`,
    );
  }

  let knowledgeOrdinal = scenario.id * 100;

  seed.documents.forEach((doc, index) => {
    const fetchedAt = baseTime + doc.fetchedOffset;
    documents.push({
      id: doc.id,
      url: doc.url,
      title: doc.title,
      language: doc.language,
      description: doc.description,
      mimeType: doc.mimeType,
      checksum: doc.checksum,
      size: doc.size,
      fetchedAt,
      segmentCount: doc.segmentCount,
      provenance: [
        {
          sourceId: doc.url,
          type: "url",
        },
      ],
    });

    knowledgeSummaries.push({
      subject: `doc:${doc.id}`,
      tripleCount: doc.knowledge.length,
      created: fetchedAt + 2_000,
      updated: fetchedAt + 2_600,
      mentions: [...doc.knowledgeMentions],
    });

    doc.knowledge.forEach((triple) => {
      knowledgeOrdinal += 1;
      const snapshot: KnowledgeTripleSnapshot = {
        id: `kg:${slug}:${knowledgeOrdinal}`,
        subject: `doc:${doc.id}`,
        predicate: triple.predicate,
        object: triple.object,
        source: doc.url,
        provenance: [
          {
            sourceId: doc.id,
            type: "url",
          },
        ],
        confidence: triple.confidence,
        insertedAt: fetchedAt + 2_400,
        updatedAt: fetchedAt + 2_400,
        revision: 0,
        ordinal: knowledgeOrdinal,
      };
      knowledgeGraph.push(snapshot);
      knowledgeChanges.push({
        scenario: slug,
        docId: doc.id,
        triple: {
          predicate: snapshot.predicate,
          object: snapshot.object,
        },
        insertedAt: snapshot.insertedAt,
      });
    });

    doc.segments.forEach((segment) => {
      vectorSummaries.push({
        chunkId: `chunk:${doc.id}:${segment.label}`,
        tokenCount: segment.tokenCount,
        segmentIds: [`seg:${doc.id}:${segment.label}`],
        metadata: {
          docId: doc.id,
          section: segment.label,
        },
        tags: [doc.mimeType.startsWith("text/") ? "html" : "pdf", segment.label],
        provenance: [
          {
            sourceId: doc.id,
            type: "url",
          },
        ],
        createdAt: fetchedAt + 3_200,
        updatedAt: fetchedAt + 3_200,
        textLength: segment.textLength,
      });
    });

    vectorUpserts.push({
      docId: doc.id,
      chunkIds: doc.segments.map((segment) => `chunk:${doc.id}:${segment.label}`),
      tokenTotal: doc.segments.reduce((acc, segment) => acc + segment.tokenCount, 0),
      tookMs: 180 + index * 5,
    });

    events.push(
      createStageEvent({
        stage: "fetchUrl",
        durationMs: fetchDurations[index],
        documentId: doc.id,
        success: true,
        timestamp: baseTime + 4_000 + index * 600,
      }),
    );
    events.push(
      createStageEvent({
        stage: "extractWithUnstructured",
        durationMs: extractDurations[index],
        documentId: doc.id,
        success: true,
        timestamp: baseTime + 7_000 + index * 600,
      }),
    );
    events.push(createIngestionEvent({ docId: doc.id, documentsIngested: 1 }));
  });

  events.unshift(
    createStageEvent({
      stage: "searxQuery",
      durationMs: seed.stageProfile.searxQuery,
      tookMs: seed.stageProfile.tookMs,
      jobId: `validation:${slug}`,
      timestamp: baseTime + 2_000,
    }),
  );
  events.push(
    createStageEvent({
      stage: "ingestToGraph",
      durationMs: seed.stageProfile.ingestToGraph,
      documentsIngested: seed.documents.length,
      timestamp: baseTime + 10_500,
    }),
  );
  events.push(
    createStageEvent({
      stage: "ingestToVector",
      durationMs: seed.stageProfile.ingestToVector,
      documentsIngested: seed.documents.length,
      timestamp: baseTime + 11_200,
    }),
  );

  seed.errorEvents.forEach((error) => {
    events.push(
      createErrorEvent({
        category: error.category,
        message: error.message,
        ...(error.stage ? { stage: error.stage } : {}),
        ...(error.url ? { url: error.url } : {}),
        ...(error.metadata ? { metadata: error.metadata } : {}),
      }),
    );
  });

  const response = buildScenarioResponse(scenario, seed);
  const serverLog = buildServerLog(`validation:${slug}`, seed.logNotes);

  return {
    response,
    events,
    errors: seed.errors,
    knowledgeChanges,
    vectorUpserts,
    serverLog,
    knowledgeGraph,
    knowledgeSummaries,
    documents,
    vectorSummaries,
  };
}

/** Builds the synthetic response payload persisted to `response.json`. */
function buildScenarioResponse(
  scenario: ValidationScenarioDefinition,
  seed: ScenarioSeedDefinition,
): Record<string, unknown> {
  const slug = formatScenarioSlug(scenario);
  const documents = seed.documents.map((doc) => ({
    id: doc.id,
    title: doc.title,
    url: doc.url,
    snippet: doc.snippet,
    language: doc.language,
    score: doc.score,
  }));

  const response: Record<string, unknown> = {
    scenarioId: scenario.id,
    slug,
    label: scenario.label,
    query: extractScenarioQuery(scenario),
    summary: seed.response.summary,
    highlights: [...seed.response.highlights],
    recommendations: [...seed.response.recommendations],
    documents,
  };

  if (seed.citations) {
    response.citations = seed.citations;
  }

  return response;
}

/** Extracts a human readable query from the scenario input when available. */
function extractScenarioQuery(scenario: ValidationScenarioDefinition): string | null {
  const input = scenario.input;
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  const query = record.query;
  return typeof query === "string" ? query : null;
}

/** Synthetic server log excerpt providing high level breadcrumbs. */
function buildServerLog(job: string, notes: readonly string[]): string[] {
  const now = new Date(BASE_TIME).toISOString();
  return notes.map((note, index) => {
    const timestamp = new Date(BASE_TIME + index * 1_000).toISOString();
    return `[${timestamp}] INFO ${job} ${note}`;
  }).concat(`[` + now + `] INFO ${job} completed`);
}

/** Builds an event representing a stage duration sample. */
function createStageEvent(args: {
  readonly stage: string;
  readonly durationMs: number;
  readonly documentId?: string;
  readonly documentsIngested?: number;
  readonly success?: boolean;
  readonly tookMs?: number;
  readonly jobId?: string;
  readonly timestamp?: number;
}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    kind: "search:stage",
    stage: args.stage,
    durationMs: args.durationMs,
  };
  if (args.documentId) {
    event.documentId = args.documentId;
  }
  if (typeof args.documentsIngested === "number") {
    event.documentsIngested = args.documentsIngested;
  }
  if (typeof args.success === "boolean") {
    event.success = args.success;
  }
  if (typeof args.tookMs === "number") {
    event.tookMs = args.tookMs;
  }
  if (args.jobId) {
    event.jobId = args.jobId;
  }
  if (typeof args.timestamp === "number") {
    event.timestamp = args.timestamp;
  }
  return event;
}

/** Builds a doc_ingested event for idempotence verification. */
function createIngestionEvent(args: {
  readonly docId: string;
  readonly documentsIngested: number;
}): Record<string, unknown> {
  return {
    kind: "search:doc_ingested",
    payload: {
      doc_id: args.docId,
    },
    documentsIngested: args.documentsIngested,
  };
}

/** Builds a structured error event stored in `events.ndjson`. */
function createErrorEvent(args: {
  readonly category: string;
  readonly message: string;
  readonly stage?: string;
  readonly url?: string;
  readonly metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    kind: "search:error",
    category: args.category,
    message: args.message,
  };
  if (args.stage) {
    event.stage = args.stage;
  }
  if (args.url) {
    event.url = args.url;
  }
  if (args.metadata) {
    event.metadata = args.metadata;
  }
  return event;
}

function buildPdfScienceSeed(): ScenarioSeedDefinition {
  return {
    documents: [
      {
        id: "S01-ARX-001",
        url: "https://arxiv.org/abs/2501.01234",
        title: "Evaluating Multimodal LLMs in 2025",
        snippet: "Comprehensive survey covering evaluation metrics for multimodal LLMs.",
        score: 0.92,
        language: "en",
        description: "Comparative study of evaluation protocols for multimodal models.",
        mimeType: "application/pdf",
        checksum: "sha256:7a1f37759b9e304d3ed4b9c9a51280f7",
        size: 154_321,
        fetchedOffset: 75_000,
        segmentCount: 2,
        knowledgeMentions: ["evaluation", "multimodal", "benchmarks"],
        knowledge: [
          { predicate: "type", object: "ResearchPaper", confidence: 0.94 },
          { predicate: "focuses_on", object: "Multimodal LLM evaluation", confidence: 0.9 },
        ],
        segments: [
          { label: "abstract", tokenCount: 248, textLength: 1_024 },
          { label: "conclusion", tokenCount: 232, textLength: 912 },
        ],
      },
      {
        id: "S01-ARX-002",
        url: "https://arxiv.org/abs/2501.04567",
        title: "Benchmarking RAG Strategies for Scientific QA",
        snippet: "Benchmarks contrasting graph-grounded and vector-grounded retrieval.",
        score: 0.88,
        language: "en",
        description: "Comparison of graph-grounded and vector-grounded RAG pipelines.",
        mimeType: "application/pdf",
        checksum: "sha256:9f5b0e90b135bb4a9d6f4bb4ac29d61f",
        size: 132_204,
        fetchedOffset: 79_000,
        segmentCount: 2,
        knowledgeMentions: ["rag", "graph", "vector"],
        knowledge: [
          { predicate: "compares", object: "Graph-grounded RAG", confidence: 0.9 },
          { predicate: "compares", object: "Vector-grounded RAG", confidence: 0.88 },
        ],
        segments: [
          { label: "abstract", tokenCount: 256, textLength: 1_040 },
          { label: "discussion", tokenCount: 244, textLength: 968 },
        ],
      },
      {
        id: "S01-ARX-003",
        url: "https://arxiv.org/abs/2501.07890",
        title: "Context Windows for Cross-Modal Reasoning",
        snippet: "Exploration of long-context strategies for multimodal models.",
        score: 0.84,
        language: "en",
        description: "Study of adaptive context windows for multimodal reasoning tasks.",
        mimeType: "application/pdf",
        checksum: "sha256:54ecf4a8d0a8e7a22e3562dd0d3ebfa6",
        size: 165_882,
        fetchedOffset: 82_000,
        segmentCount: 2,
        knowledgeMentions: ["context", "multimodal", "windows"],
        knowledge: [
          { predicate: "studies", object: "Cross-modal context windows", confidence: 0.91 },
          { predicate: "proposes", object: "Adaptive attention spans", confidence: 0.87 },
        ],
        segments: [
          { label: "abstract", tokenCount: 250, textLength: 1_032 },
          { label: "analysis", tokenCount: 238, textLength: 940 },
        ],
      },
    ],
    stageProfile: {
      searxQuery: 840,
      fetchUrl: [1_120, 1_080, 1_040],
      extractWithUnstructured: [940, 910, 900],
      ingestToGraph: 420,
      ingestToVector: 430,
      tookMs: 3_650,
    },
    response: {
      summary:
        "Trois PDF arXiv couvrant l'évaluation RAG multimodale ont été ingérés et indexés.",
      highlights: [
        "6 chunks vectoriels générés pour les sections clés",
        "18 triples ajoutés au graphe de connaissances",
        "Timeout transitoire résolu automatiquement",
      ],
      recommendations: [
        "Conserver la configuration actuelle de retry sur arxiv.org",
        "Poursuivre l'analyse comparative graph vs vector",
      ],
    },
    errors: [
      {
        category: "network_error",
        message: "Timeout transitoire sur arxiv.org résolu après retry.",
        url: "https://arxiv.org/abs/2501.07890",
        metadata: { retry: true, attempts: 2 },
      },
    ],
    errorEvents: [
      {
        category: "network_error",
        message: "Timeout during warm-up fetch retried successfully.",
        stage: "fetchUrl",
        url: "https://arxiv.org/abs/2501.07890",
        metadata: { retry: true },
      },
    ],
    logNotes: [
      "starting scenario with searx query",
      "fetched 3 results across arxiv",
      "ingested documents into knowledge graph",
      "vector index updated with 6 chunks",
      "scenario completed successfully",
    ],
  };
}
function buildHtmlLongSeed(): ScenarioSeedDefinition {
  return {
    documents: [
      {
        id: "S02-TDS-001",
        url: "https://towardsdatascience.com/evaluating-rag-metrics-production",
        title: "Evaluating RAG Metrics for Production Systems",
        snippet: "Playbook for selecting online and offline metrics when shipping RAG.",
        score: 0.89,
        language: "en",
        description: "Metric selection checklist for production-grade RAG systems.",
        mimeType: "text/html",
        checksum: "sha256:234c1588f5c7f1b4dbd8a57de77289c1",
        size: 96_102,
        fetchedOffset: 125_000,
        segmentCount: 2,
        knowledgeMentions: ["metrics", "production", "rag"],
        knowledge: [
          { predicate: "advises", object: "Online evaluation for RAG", confidence: 0.86 },
          { predicate: "lists", object: "Precision, recall, answer relevance", confidence: 0.83 },
        ],
        segments: [
          { label: "intro", tokenCount: 210, textLength: 860 },
          { label: "table", tokenCount: 198, textLength: 780 },
        ],
      },
      {
        id: "S02-TDS-002",
        url: "https://towardsdatascience.com/visual-diagnostics-rag",
        title: "Visual Diagnostics for Retrieval-Augmented Generation",
        snippet: "How to analyse image-heavy RAG corpora with lightweight tooling.",
        score: 0.82,
        language: "en",
        description: "Image-rich article exploring debugging workflows for RAG.",
        mimeType: "text/html",
        checksum: "sha256:8333d43ee6d852c098e7b15d1af6f1e9",
        size: 102_440,
        fetchedOffset: 128_000,
        segmentCount: 2,
        knowledgeMentions: ["diagnostics", "images", "rag"],
        knowledge: [
          { predicate: "describes", object: "Heatmap-based error analysis", confidence: 0.84 },
          { predicate: "highlights", object: "Importance of multimodal assets", confidence: 0.8 },
        ],
        segments: [
          { label: "intro", tokenCount: 205, textLength: 832 },
          { label: "gallery", tokenCount: 192, textLength: 768 },
        ],
      },
    ],
    stageProfile: {
      searxQuery: 910,
      fetchUrl: [1_180, 1_140],
      extractWithUnstructured: [1_020, 990],
      ingestToGraph: 380,
      ingestToVector: 390,
      tookMs: 3_200,
    },
    response: {
      summary: "Deux articles riches en médias ont été intégrés pour tester l'extraction HTML.",
      highlights: [
        "Balises img sans alt détectées et loguées",
        "Segmentation vectorielle adaptée aux sections longues",
      ],
      recommendations: [
        "Renforcer la validation des attributs alt côté extraction",
        "Documenter les métriques de suivi pour le contenu riche",
      ],
    },
    errors: [
      {
        category: "parse_error",
        message: "Attribut alt manquant sur une image, chunk ignoré.",
        url: "https://towardsdatascience.com/visual-diagnostics-rag",
        metadata: { element: "img", issue: "missing_alt" },
      },
    ],
    errorEvents: [
      {
        category: "parse_error",
        message: "Image without alt attribute skipped during extraction.",
        stage: "extractWithUnstructured",
        url: "https://towardsdatascience.com/visual-diagnostics-rag",
        metadata: { tag: "img" },
      },
    ],
    logNotes: [
      "received 2 rich HTML documents",
      "extracted hero images and captions",
      "persisted metrics to validation_run",
      "vector store chunks normalised",
      "scenario finished with minor parse warnings",
    ],
  };
}
function buildNewsFreshnessSeed(): ScenarioSeedDefinition {
  return {
    documents: [
      {
        id: "S03-NEWS-001",
        url: "https://www.euronews.com/tech/2025/01/10/eu-funds-responsible-ai",
        title: "EU Funds Responsible AI Research in 2025",
        snippet: "New €150M programme boosting responsible LLM development across Europe.",
        score: 0.9,
        language: "en",
        description: "Funding initiative supporting responsible AI research in Europe.",
        mimeType: "text/html",
        checksum: "sha256:6c8fafe981c20c7a2a50df9d72b9e933",
        size: 88_201,
        fetchedOffset: 170_000,
        segmentCount: 2,
        knowledgeMentions: ["funding", "responsible", "ai"],
        knowledge: [
          { predicate: "announces", object: "€150M responsible AI programme", confidence: 0.85 },
          { predicate: "targets", object: "European LLM research", confidence: 0.82 },
        ],
        segments: [
          { label: "intro", tokenCount: 198, textLength: 790 },
          { label: "quote", tokenCount: 182, textLength: 702 },
        ],
      },
      {
        id: "S03-NEWS-002",
        url: "https://www.lemonde.fr/technologies/article/2025/01/12/benchmark-rag-national",
        title: "France Launches National RAG Benchmark",
        snippet: "Public-private consortium introduces open benchmark for retrieval systems.",
        score: 0.86,
        language: "fr",
        description: "Consortium public-privé pour évaluer les systèmes de récupération.",
        mimeType: "text/html",
        checksum: "sha256:5f2299f5a0b243f72d1fb38db58c725e",
        size: 74_822,
        fetchedOffset: 171_500,
        segmentCount: 2,
        knowledgeMentions: ["benchmark", "rag", "france"],
        knowledge: [
          { predicate: "launches", object: "Benchmark RAG national", confidence: 0.83 },
          { predicate: "partners_with", object: "Public-private consortium", confidence: 0.8 },
        ],
        segments: [
          { label: "intro", tokenCount: 176, textLength: 680 },
          { label: "details", tokenCount: 168, textLength: 640 },
        ],
      },
      {
        id: "S03-NEWS-003",
        url: "https://www.dw.com/en/germany-llm-safety-report-2025/a-123456",
        title: "German Universities Share LLM Safety Findings",
        snippet: "Research hubs publish guidance on mitigating hallucinations in LLMs.",
        score: 0.81,
        language: "en",
        description: "Guidance for mitigating hallucinations and reinforcing monitoring.",
        mimeType: "text/html",
        checksum: "sha256:aa3e4aa1c727a05ea4a7981f7fab75a5",
        size: 69_554,
        fetchedOffset: 172_200,
        segmentCount: 1,
        knowledgeMentions: ["safety", "germany", "llm"],
        knowledge: [
          { predicate: "reports", object: "LLM hallucination mitigation", confidence: 0.82 },
        ],
        segments: [
          { label: "intro", tokenCount: 170, textLength: 660 },
        ],
      },
    ],
    stageProfile: {
      searxQuery: 760,
      fetchUrl: [980, 940, 930],
      extractWithUnstructured: [820, 780, 760],
      ingestToGraph: 360,
      ingestToVector: 370,
      tookMs: 2_880,
    },
    response: {
      summary: "Actualités européennes et nationales sur le financement et la sécurité des LLMs.",
      highlights: [
        "Couverture FR/EN respectant la fraîcheur",
        "Mise à jour du graphe de connaissances avec des politiques publiques",
      ],
      recommendations: [
        "Surveiller l'impact du benchmark français sur les évaluations futures",
      ],
    },
    errors: [],
    errorEvents: [],
    logNotes: [
      "collected european ai policy updates",
      "processed multilingual articles",
      "updated knowledge graph with policy signals",
      "vector index enriched with news segments",
      "scenario completed without warnings",
    ],
  };
}
function buildMultilingualSeed(): ScenarioSeedDefinition {
  return {
    documents: [
      {
        id: "S04-ACL-001",
        url: "https://aclanthology.org/2024.acl-long.123",
        title: "Comparing RAG Strategies for Multilingual QA",
        snippet: "ACL study evaluating retrieval strategies across FR/EN corpora.",
        score: 0.9,
        language: "en",
        description: "Analysis of multilingual retrieval performance for QA systems.",
        mimeType: "application/pdf",
        checksum: "sha256:1f2a3b4c5d6e7f8090a1b2c3d4e5f607",
        size: 142_204,
        fetchedOffset: 205_000,
        segmentCount: 2,
        knowledgeMentions: ["multilingual", "qa", "rag"],
        knowledge: [
          { predicate: "evaluates", object: "Multilingual RAG pipelines", confidence: 0.9 },
          { predicate: "reports", object: "Precision gains on FR corpora", confidence: 0.85 },
        ],
        segments: [
          { label: "abstract", tokenCount: 240, textLength: 980 },
          { label: "results", tokenCount: 228, textLength: 920 },
        ],
      },
      {
        id: "S04-ACL-002",
        url: "https://aclanthology.org/2024.acl-long.210",
        title: "Graph-Augmented Retrieval for Code-Switched Dialogue",
        snippet: "Techniques for stabilising bilingual dialogue retrieval.",
        score: 0.84,
        language: "en",
        description: "Graph-augmented retrieval applied to code-switched conversations.",
        mimeType: "application/pdf",
        checksum: "sha256:abcd1234efef56789011121314151617",
        size: 138_552,
        fetchedOffset: 207_000,
        segmentCount: 2,
        knowledgeMentions: ["code-switch", "dialogue", "graph"],
        knowledge: [
          { predicate: "introduces", object: "Graph augmentation for code-switched dialogue", confidence: 0.87 },
          { predicate: "observes", object: "Stability gains for bilingual queries", confidence: 0.84 },
        ],
        segments: [
          { label: "abstract", tokenCount: 236, textLength: 952 },
          { label: "analysis", tokenCount: 220, textLength: 888 },
        ],
      },
      {
        id: "S04-ACL-003",
        url: "https://aclanthology.org/2024.acl-long.333",
        title: "Évaluation du RAG sur corpus francophones",
        snippet: "Analyse des performances RAG pour les publications francophones.",
        score: 0.83,
        language: "fr",
        description: "Étude ciblée sur l'évaluation des systèmes RAG en français.",
        mimeType: "application/pdf",
        checksum: "sha256:ffeeddccbbaa00998877665544332211",
        size: 129_004,
        fetchedOffset: 209_000,
        segmentCount: 2,
        knowledgeMentions: ["français", "évaluation", "rag"],
        knowledge: [
          { predicate: "analyse", object: "Performances RAG francophones", confidence: 0.86 },
          { predicate: "propose", object: "Corpus d'évaluation mixte", confidence: 0.82 },
        ],
        segments: [
          { label: "abstract", tokenCount: 230, textLength: 940 },
          { label: "conclusion", tokenCount: 218, textLength: 880 },
        ],
      },
    ],
    stageProfile: {
      searxQuery: 890,
      fetchUrl: [1_050, 1_030, 1_020],
      extractWithUnstructured: [930, 910, 920],
      ingestToGraph: 410,
      ingestToVector: 420,
      tookMs: 3_180,
    },
    response: {
      summary: "Comparaison FR/EN réussie avec ingestion complète des PDF ACL.",
      highlights: [
        "Couverture équilibrée FR/EN",
        "Graph augmentation confirmée sur dialogues bilingues",
      ],
      recommendations: ["Poursuivre l'entraînement de modèles bilingues"],
    },
    errors: [],
    errorEvents: [],
    logNotes: [
      "downloaded multilingual pdf corpus",
      "extracted bilingual sections",
      "updated knowledge graph with multilingual triples",
      "vector store contains balanced FR/EN chunks",
      "scenario closed with successful comparison",
    ],
  };
}
function buildIdempotenceSeed(): ScenarioSeedDefinition {
  return {
    documents: [
      {
        id: "S01-ARX-001",
        url: "https://arxiv.org/abs/2501.01234",
        title: "Evaluating Multimodal LLMs in 2025",
        snippet: "Re-run validation to confirm idempotent ingestion of arXiv PDFs.",
        score: 0.91,
        language: "en",
        description: "Rejoue S01 pour vérifier l'absence de doublons.",
        mimeType: "application/pdf",
        checksum: "sha256:7a1f37759b9e304d3ed4b9c9a51280f7",
        size: 154_321,
        fetchedOffset: 245_000,
        segmentCount: 2,
        knowledgeMentions: ["evaluation", "multimodal", "benchmarks"],
        knowledge: [
          { predicate: "type", object: "ResearchPaper", confidence: 0.94 },
          { predicate: "focuses_on", object: "Multimodal LLM evaluation", confidence: 0.9 },
        ],
        segments: [
          { label: "abstract_rerun", tokenCount: 249, textLength: 1_028 },
          { label: "conclusion_rerun", tokenCount: 231, textLength: 908 },
        ],
      },
      {
        id: "S01-ARX-002",
        url: "https://arxiv.org/abs/2501.04567",
        title: "Benchmarking RAG Strategies for Scientific QA",
        snippet: "Second execution validating deduplication of search results.",
        score: 0.88,
        language: "en",
        description: "Vérifie que les pipelines RAG restent idempotents.",
        mimeType: "application/pdf",
        checksum: "sha256:9f5b0e90b135bb4a9d6f4bb4ac29d61f",
        size: 132_204,
        fetchedOffset: 248_000,
        segmentCount: 2,
        knowledgeMentions: ["rag", "graph", "vector"],
        knowledge: [
          { predicate: "compares", object: "Graph-grounded RAG", confidence: 0.9 },
          { predicate: "compares", object: "Vector-grounded RAG", confidence: 0.88 },
        ],
        segments: [
          { label: "abstract_rerun", tokenCount: 255, textLength: 1_036 },
          { label: "discussion_rerun", tokenCount: 243, textLength: 960 },
        ],
      },
      {
        id: "S01-ARX-003",
        url: "https://arxiv.org/abs/2501.07890",
        title: "Context Windows for Cross-Modal Reasoning",
        snippet: "Ensures long-context PDFs remain deduplicated on subsequent runs.",
        score: 0.85,
        language: "en",
        description: "Double exécution pour contrôler les collisions de docId.",
        mimeType: "application/pdf",
        checksum: "sha256:54ecf4a8d0a8e7a22e3562dd0d3ebfa6",
        size: 165_882,
        fetchedOffset: 250_000,
        segmentCount: 2,
        knowledgeMentions: ["context", "multimodal", "windows"],
        knowledge: [
          { predicate: "studies", object: "Cross-modal context windows", confidence: 0.91 },
          { predicate: "proposes", object: "Adaptive attention spans", confidence: 0.87 },
        ],
        segments: [
          { label: "abstract_rerun", tokenCount: 251, textLength: 1_030 },
          { label: "analysis_rerun", tokenCount: 237, textLength: 934 },
        ],
      },
    ],
    stageProfile: {
      searxQuery: 830,
      fetchUrl: [1_100, 1_070, 1_030],
      extractWithUnstructured: [930, 900, 890],
      ingestToGraph: 410,
      ingestToVector: 420,
      tookMs: 3_520,
    },
    response: {
      summary: "Rerun S01 exécuté sans duplication ; les docIds correspondent au premier passage.",
      highlights: ["Docs identiques détectés", "Chunks vectoriels mis à jour sans doublon"],
      recommendations: ["Continuer à monitorer les collisions de checksum"],
    },
    errors: [],
    errorEvents: [],
    logNotes: [
      "reran pdf ingestion for idempotence",
      "documents matched existing checksums",
      "no new knowledge triples inserted",
      "vector deduplication confirmed",
      "scenario concluded with matching docIds",
    ],
    citations: [
      { docId: "S01-ARX-001", url: "https://arxiv.org/abs/2501.01234" },
      { docId: "S01-ARX-002", url: "https://arxiv.org/abs/2501.04567" },
      { docId: "S01-ARX-003", url: "https://arxiv.org/abs/2501.07890" },
    ],
  };
}
function buildRobotsSeed(): ScenarioSeedDefinition {
  return {
    documents: [
      {
        id: "S06-DATA-001",
        url: "https://datasets.example.org/llm/benchmark-dataset.zip",
        title: "Benchmark Dataset for LLM Evaluation",
        snippet: "Large PDF bundle summarising multimodal evaluation datasets.",
        score: 0.78,
        language: "en",
        description: "Dataset landing page compliant with robots.txt.",
        mimeType: "text/html",
        checksum: "sha256:1122aabbccddeeff0011223344556677",
        size: 58_200,
        fetchedOffset: 282_000,
        segmentCount: 2,
        knowledgeMentions: ["dataset", "llm", "benchmark"],
        knowledge: [
          { predicate: "hosts", object: "LLM benchmark dataset", confidence: 0.8 },
          { predicate: "describes", object: "Download limits for large files", confidence: 0.78 },
        ],
        segments: [
          { label: "intro", tokenCount: 160, textLength: 640 },
          { label: "download", tokenCount: 150, textLength: 600 },
        ],
      },
      {
        id: "S06-DATA-002",
        url: "https://datahub.example.net/rag/large-pdf-guide.pdf",
        title: "Handling Large PDFs for Retrieval Pipelines",
        snippet: "Guide explaining chunking strategies for large PDF assets.",
        score: 0.75,
        language: "en",
        description: "PDF respectant la taille maximale configurée (15MB).",
        mimeType: "application/pdf",
        checksum: "sha256:8899ddeeff0011223344556677889900",
        size: 14_500_000,
        fetchedOffset: 284_000,
        segmentCount: 2,
        knowledgeMentions: ["chunking", "pdf", "limits"],
        knowledge: [
          { predicate: "recommends", object: "Chunking large PDFs", confidence: 0.82 },
          { predicate: "warns", object: "Respect storage quotas", confidence: 0.79 },
        ],
        segments: [
          { label: "abstract", tokenCount: 220, textLength: 900 },
          { label: "guidelines", tokenCount: 208, textLength: 840 },
        ],
      },
    ],
    stageProfile: {
      searxQuery: 780,
      fetchUrl: [1_050, 1_020],
      extractWithUnstructured: [810, 820],
      ingestToGraph: 340,
      ingestToVector: 350,
      tookMs: 2_940,
    },
    response: {
      summary: "Scénario robots & taille max complété : un domaine bloqué, un fichier ignoré pour taille.",
      highlights: [
        "Robots.txt respecté pour datasets.example.com",
        "Fichier >15MB rejeté avec classification",
      ],
      recommendations: ["Activer SEARCH_FETCH_RESPECT_ROBOTS=1 en production"],
    },
    errors: [
      {
        category: "robots_denied",
        message: "Robots.txt interdit l'accès à /private/report.pdf.",
        url: "https://datasets.example.com/private/report.pdf",
      },
      {
        category: "max_size_exceeded",
        message: "Fichier de 32MB ignoré (limite 15MB).",
        url: "https://oversized.example.org/rag/huge.pdf",
        metadata: { size: 33_554_432, limit: 15_000_000 },
      },
    ],
    errorEvents: [
      {
        category: "robots_denied",
        message: "Access disallowed by robots.txt",
        stage: "fetchUrl",
        url: "https://datasets.example.com/private/report.pdf",
      },
      {
        category: "max_size_exceeded",
        message: "Content length 32MB exceeds configured maximum.",
        stage: "fetchUrl",
        url: "https://oversized.example.org/rag/huge.pdf",
        metadata: { limitBytes: 15_000_000 },
      },
    ],
    logNotes: [
      "checked robots directives for dataset domains",
      "skipped disallowed endpoint",
      "downloaded permitted dataset landing page",
      "ignored oversized pdf gracefully",
      "scenario completed with classified errors",
    ],
  };
}
function buildUnstableSourcesSeed(): ScenarioSeedDefinition {
  return {
    documents: [
      {
        id: "S07-NEWS-001",
        url: "https://status.example.com/blog/search-outage-analysis",
        title: "Search Outage Analysis and Mitigation",
        snippet: "Post-mortem describing mitigation strategies for flaky domains.",
        score: 0.74,
        language: "en",
        description: "Blog post analysant les incidents 5xx récurrents.",
        mimeType: "text/html",
        checksum: "sha256:1010aa55bb55cc55dd55ee55ff55aa55",
        size: 64_102,
        fetchedOffset: 315_000,
        segmentCount: 2,
        knowledgeMentions: ["outage", "mitigation", "monitoring"],
        knowledge: [
          { predicate: "details", object: "Retry jitter for 5xx errors", confidence: 0.79 },
          { predicate: "recommends", object: "Circuit breaker for flaky domains", confidence: 0.77 },
        ],
        segments: [
          { label: "intro", tokenCount: 170, textLength: 680 },
          { label: "mitigation", tokenCount: 162, textLength: 648 },
        ],
      },
      {
        id: "S07-GUIDE-002",
        url: "https://docs.example.org/reliability/rag-retry-guide",
        title: "RAG Retry Guide for Unstable Sources",
        snippet: "Checklist for handling intermittent failures in data pipelines.",
        score: 0.72,
        language: "en",
        description: "Guide de bonnes pratiques pour gérer les erreurs intermittentes.",
        mimeType: "text/html",
        checksum: "sha256:2222bb66cc66dd66ee66ff6600112233",
        size: 59_880,
        fetchedOffset: 317_000,
        segmentCount: 2,
        knowledgeMentions: ["retry", "timeouts", "rag"],
        knowledge: [
          { predicate: "lists", object: "Backoff parameters for fetch", confidence: 0.78 },
          { predicate: "suggests", object: "Mark flaky domains for review", confidence: 0.76 },
        ],
        segments: [
          { label: "intro", tokenCount: 165, textLength: 660 },
          { label: "checklist", tokenCount: 158, textLength: 632 },
        ],
      },
    ],
    stageProfile: {
      searxQuery: 800,
      fetchUrl: [1_180, 1_140],
      extractWithUnstructured: [860, 840],
      ingestToGraph: 360,
      ingestToVector: 365,
      tookMs: 3_060,
    },
    response: {
      summary: "Gestion des sources instables : deux documents ingérés, erreurs classées.",
      highlights: [
        "Deux timeouts classés network_error",
        "Circuit breaker conseillé pour example.net",
      ],
      recommendations: ["Configurer un cache de 10 minutes pour les domaines instables"],
    },
    errors: [
      {
        category: "network_error",
        message: "Timeout 504 sur example.net après trois tentatives.",
        url: "https://example.net/flaky.pdf",
        metadata: { attempts: 3, timeoutMs: 15_000 },
      },
      {
        category: "network_error",
        message: "Connexion interrompue sur unstable.example.org.",
        url: "https://unstable.example.org/resource.html",
      },
    ],
    errorEvents: [
      {
        category: "network_error",
        message: "504 Gateway Timeout from example.net",
        stage: "fetchUrl",
        url: "https://example.net/flaky.pdf",
        metadata: { attempts: 3 },
      },
      {
        category: "network_error",
        message: "Connection reset by peer",
        stage: "fetchUrl",
        url: "https://unstable.example.org/resource.html",
      },
    ],
    logNotes: [
      "triggered backoff for flaky domains",
      "classified repeated timeouts",
      "captured guidance documents",
      "updated remediation notes",
      "scenario ended with actionable errors",
    ],
  };
}
function buildDirectIndexSeed(): ScenarioSeedDefinition {
  return {
    documents: [
      {
        id: "S08-DIRECT-001",
        url: "https://arxiv.org/pdf/2407.12345.pdf",
        title: "Graph-Augmented Retrieval for Multimodal Agents",
        snippet: "Preprint ingested directement sans requête Searx.",
        score: 0.88,
        language: "en",
        description: "PDF récupéré via ingestion directe.",
        mimeType: "application/pdf",
        checksum: "sha256:5566aaee112233445566778899aabbcc",
        size: 4_200_000,
        fetchedOffset: 348_000,
        segmentCount: 2,
        knowledgeMentions: ["graph", "multimodal", "retrieval"],
        knowledge: [
          { predicate: "proposes", object: "Graph-augmented retrieval agent", confidence: 0.88 },
          { predicate: "evaluates", object: "Hybrid RAG pipelines", confidence: 0.86 },
        ],
        segments: [
          { label: "abstract", tokenCount: 238, textLength: 960 },
          { label: "method", tokenCount: 226, textLength: 904 },
        ],
      },
      {
        id: "S08-DIRECT-002",
        url: "https://research.facebook.com/publications/2025-direct-indexing.pdf",
        title: "Direct Indexing for Enterprise Knowledge Bases",
        snippet: "Meta AI whitepaper sur l'ingestion directe et la gouvernance.",
        score: 0.84,
        language: "en",
        description: "Document technique importé depuis une URL listée.",
        mimeType: "application/pdf",
        checksum: "sha256:6677bbff2233445566778899aabbccdd",
        size: 3_880_000,
        fetchedOffset: 350_000,
        segmentCount: 2,
        knowledgeMentions: ["enterprise", "governance", "indexing"],
        knowledge: [
          { predicate: "explains", object: "Direct indexing governance", confidence: 0.85 },
          { predicate: "highlights", object: "Audit trails for ingestion", confidence: 0.82 },
        ],
        segments: [
          { label: "abstract", tokenCount: 232, textLength: 928 },
          { label: "governance", tokenCount: 220, textLength: 880 },
        ],
      },
    ],
    stageProfile: {
      searxQuery: 320,
      fetchUrl: [1_040, 1_000],
      extractWithUnstructured: [900, 880],
      ingestToGraph: 340,
      ingestToVector: 345,
      tookMs: 2_480,
    },
    response: {
      summary: "Ingestion directe complétée avec deux documents stratégiques.",
      highlights: [
        "RAG exécuté sans requête externe",
        "Audit trail généré pour chaque URL",
      ],
      recommendations: ["Utiliser ce flux pour les documents internes sensibles"],
    },
    errors: [],
    errorEvents: [],
    logNotes: [
      "processing direct ingestion urls",
      "downloaded arxiv preprint",
      "fetched enterprise whitepaper",
      "persisted knowledge graph and vectors",
      "scenario done without searx usage",
    ],
  };
}
function buildModerateLoadSeed(): ScenarioSeedDefinition {
  return {
    documents: [
      {
        id: "S09-GRAPH-001",
        url: "https://graphresearch.org/blog/knowledge-graphs-rag-2025",
        title: "Knowledge Graph Patterns for 2025 RAG Systems",
        snippet: "Overview of graph-centric retrieval strategies for modern LLMs.",
        score: 0.87,
        language: "en",
        description: "Blog technique sur les patterns KG pour RAG.",
        mimeType: "text/html",
        checksum: "sha256:9090aa11bb22cc33dd44ee55ff667788",
        size: 78_300,
        fetchedOffset: 380_000,
        segmentCount: 2,
        knowledgeMentions: ["knowledge graph", "rag", "patterns"],
        knowledge: [
          { predicate: "lists", object: "Topology patterns for retrieval", confidence: 0.83 },
          { predicate: "recommends", object: "Hybrid scoring for RAG", confidence: 0.82 },
        ],
        segments: [
          { label: "intro", tokenCount: 190, textLength: 760 },
          { label: "patterns", tokenCount: 184, textLength: 736 },
        ],
      },
      {
        id: "S09-GRAPH-002",
        url: "https://graphresearch.org/reports/rag-benchmarks-2025.pdf",
        title: "RAG Benchmarks 2025",
        snippet: "Comprehensive benchmark covering 12 graph-based retrieval scenarios.",
        score: 0.84,
        language: "en",
        description: "Rapport PDF sur les benchmarks RAG basés graphes.",
        mimeType: "application/pdf",
        checksum: "sha256:8080aa22bb33cc44dd55ee66ff778899",
        size: 5_200_000,
        fetchedOffset: 382_000,
        segmentCount: 2,
        knowledgeMentions: ["benchmark", "performance", "graph"],
        knowledge: [
          { predicate: "evaluates", object: "Graph retrieval latency", confidence: 0.84 },
          { predicate: "summarises", object: "p95 results across datasets", confidence: 0.82 },
        ],
        segments: [
          { label: "abstract", tokenCount: 240, textLength: 960 },
          { label: "results", tokenCount: 232, textLength: 928 },
        ],
      },
      {
        id: "S09-GRAPH-003",
        url: "https://vectorlabs.ai/blog/hybrid-rag-graph-vector",
        title: "Hybrid RAG: Graph + Vector Pipelines",
        snippet: "Guidelines for balancing vector and graph retrieval.",
        score: 0.82,
        language: "en",
        description: "Article sur l'orchestration hybride vector+graph.",
        mimeType: "text/html",
        checksum: "sha256:7070aa33bb44cc55dd66ee77ff889900",
        size: 72_210,
        fetchedOffset: 384_000,
        segmentCount: 2,
        knowledgeMentions: ["hybrid", "vector", "graph"],
        knowledge: [
          { predicate: "describes", object: "Hybrid orchestration", confidence: 0.81 },
          { predicate: "notes", object: "Trade-offs between recall and cost", confidence: 0.8 },
        ],
        segments: [
          { label: "intro", tokenCount: 188, textLength: 752 },
          { label: "tradeoffs", tokenCount: 176, textLength: 704 },
        ],
      },
      {
        id: "S09-GRAPH-004",
        url: "https://vectorlabs.ai/datasets/rag-graph-case-study.pdf",
        title: "Case Study: Graph RAG in Production",
        snippet: "Detailed case study showing latency/performance metrics.",
        score: 0.8,
        language: "en",
        description: "Case study PDF sur un déploiement graph RAG.",
        mimeType: "application/pdf",
        checksum: "sha256:6060aa44bb55cc66dd77ee88ff990011",
        size: 4_600_000,
        fetchedOffset: 386_000,
        segmentCount: 2,
        knowledgeMentions: ["case study", "latency", "production"],
        knowledge: [
          { predicate: "reports", object: "p95 latency improvements", confidence: 0.83 },
          { predicate: "details", object: "Cost profile of graph ingestion", confidence: 0.81 },
        ],
        segments: [
          { label: "abstract", tokenCount: 236, textLength: 944 },
          { label: "metrics", tokenCount: 224, textLength: 896 },
        ],
      },
      {
        id: "S09-GRAPH-005",
        url: "https://vectorlabs.ai/blog/visualising-knowledge-graphs",
        title: "Visualising Knowledge Graphs for Analysts",
        snippet: "Tips for building dashboards that combine RAG metrics and graphs.",
        score: 0.78,
        language: "en",
        description: "Article illustrant la visualisation des KG.",
        mimeType: "text/html",
        checksum: "sha256:5050aa55bb66cc77dd88ee99ffa00112",
        size: 68_440,
        fetchedOffset: 388_000,
        segmentCount: 2,
        knowledgeMentions: ["visualisation", "analytics", "knowledge graph"],
        knowledge: [
          { predicate: "explains", object: "Dashboard patterns", confidence: 0.79 },
          { predicate: "encourages", object: "Aligning RAG metrics with KG views", confidence: 0.77 },
        ],
        segments: [
          { label: "intro", tokenCount: 180, textLength: 720 },
          { label: "visuals", tokenCount: 170, textLength: 680 },
        ],
      },
    ],
    stageProfile: {
      searxQuery: 2_380,
      fetchUrl: [1_180, 1_150, 1_140, 1_130, 1_120],
      extractWithUnstructured: [1_020, 1_000, 980, 970, 960],
      ingestToGraph: 460,
      ingestToVector: 470,
      tookMs: 5_850,
    },
    response: {
      summary: "Charge modérée réussie : cinq documents ingérés, latences dans les objectifs.",
      highlights: [
        "p95 searxQuery < 3s",
        "p95 extract < 2s",
      ],
      recommendations: ["Poursuivre la collecte de métriques pour scénarios haute charge"],
    },
    errors: [],
    errorEvents: [],
    logNotes: [
      "launched moderate-load query",
      "retrieved 5 representative documents",
      "processed pdf and html mix",
      "aggregated metrics for reporting",
      "scenario satisfied performance thresholds",
    ],
  };
}
function buildRagScenarioSample(
  scenario: ValidationScenarioDefinition,
): SampleScenarioData {
  const slug = formatScenarioSlug(scenario);
  const baseTime = BASE_TIME + scenario.id * 45_000;
  const jobId = `validation:${slug}`;

  const events: Record<string, unknown>[] = [
    {
      type: "rag_scenario_prepared",
      timestamp: baseTime,
      jobId,
      scenarios: [
        "S01_pdf_science",
        "S02_html_long_images",
        "S03_actualites_fraicheur",
        "S04_multilingue_fr_en",
        "S05_idempotence",
        "S06_robots_taille_max",
        "S07_sources_instables",
        "S08_indexation_directe",
        "S09_charge_moderee",
      ],
      missing: [],
      knowledgeSubjects: 15,
      knowledgeTriples: 42,
      vectorDocuments: 18,
      notes: ["Agrégation synthétique des scénarios S01 à S09"],
    },
    {
      type: "rag_scenario_completed",
      timestamp: baseTime + 1_200,
      jobId,
      knowledgeHits: 5,
      ragHits: 4,
      citations: 3,
      tookMs: 1_200,
    },
    {
      kind: "rag:citations_recorded",
      documentsIngested: 3,
      payload: {
        docIds: ["S01-ARX-001", "S03-NEWS-002", "S09-GRAPH-004"],
      },
    },
  ];

  const response = {
    scenarioId: scenario.id,
    slug,
    label: scenario.label,
    query: extractScenarioQuery(scenario),
    answer:
      "Le rapport RAG synthétise les segments ingérés : evaluation multimodale, actualités européennes et benchmarks graph.",
    citations: [
      { docId: "S01-ARX-001", url: "https://arxiv.org/abs/2501.01234" },
      { docId: "S03-NEWS-002", url: "https://www.lemonde.fr/technologies/article/2025/01/12/benchmark-rag-national" },
      { docId: "S09-GRAPH-004", url: "https://vectorlabs.ai/datasets/rag-graph-case-study.pdf" },
    ],
    summary:
      "Synthèse RAG générée à partir des artefacts consolidés : citations alignées sur les documents ingérés.",
    highlights: [
      "Références croisées avec le graphe de connaissances",
      "Vector store agrégé pour S10",
    ],
    recommendations: ["Valider manuellement les citations avant publication"],
  } satisfies Record<string, unknown>;

  const serverLog = buildServerLog(jobId, [
    "aggregating knowledge graph subjects",
    "building combined vector index",
    "executed rag quality question",
    "validated citations",
    "rag scenario completed",
  ]);

  return {
    response,
    events,
    errors: [],
    knowledgeChanges: [],
    vectorUpserts: [],
    serverLog,
    knowledgeGraph: [],
    knowledgeSummaries: [],
    documents: [],
    vectorSummaries: [],
  };
}
