import { createHash } from "node:crypto";

import {
  createKnowledgeTripleRunGuard,
  dedupeTripleBatch,
  type KnowledgeGraph,
  type KnowledgeInsertResult,
  type KnowledgeTripleInput,
  upsertTriple,
  withProvenance,
} from "../../knowledge/knowledgeGraph.js";
import type { StructuredDocument, StructuredSegment } from "../types.js";

/** Prefix applied to subjects so search sourced triples remain isolated. */
const SEARCH_DOCUMENT_SUBJECT_PREFIX = "search:document:" as const;

/** Canonical predicates emitted when persisting search documents. */
export const P = Object.freeze({
  type: "rdf:type",
  title: "dc:title",
  lang: "dc:language",
  src: "dc:source",
  description: "dc:description",
  mentions: "search:mentions",
  fetchMetadata: "search:fetch_metadata",
} as const);

/**
 * Basic French/English stop word list used when extracting mentions.  The
 * values favour clarity over exhaustiveness: we intentionally keep the list
 * compact so it is easy to audit and extend if the heuristics misfire.
 */
const STOP_WORDS = new Set<string>([
  "a",
  "about",
  "after",
  "alors",
  "and",
  "are",
  "as",
  "au",
  "aux",
  "avec",
  "avant",
  "be",
  "been",
  "but",
  "by",
  "ce",
  "ces",
  "cet",
  "cette",
  "dans",
  "de",
  "des",
  "du",
  "during",
  "each",
  "en",
  "est",
  "et",
  "for",
  "from",
  "had",
  "has",
  "have",
  "il",
  "into",
  "is",
  "its",
  "la",
  "le",
  "les",
  "mais",
  "not",
  "of",
  "on",
  "or",
  "par",
  "pas",
  "plus",
  "pour",
  "que",
  "qui",
  "sans",
  "sont",
  "sur",
  "the",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "un",
  "une",
  "via",
  "was",
  "were",
  "while",
  "with",
]);

/** Allowed segment kinds when generating textual mentions. */
const MENTION_KINDS = new Set<StructuredSegment["kind"]>(["paragraph", "title", "list"]);

/** Default cap applied to the extracted mention list. */
const MAX_MENTION_TERMS = 12;

/**
 * Context dependencies required to ingest search documents into the knowledge
 * graph.  The in-memory graph is injected to keep the implementation trivial to
 * test and deterministic.
 */
export interface KnowledgeGraphIngestDependencies {
  readonly graph: KnowledgeGraph;
}

/** Description of a triple persisted while ingesting a document. */
export interface KnowledgeGraphIngestedTriple {
  readonly predicate: string;
  readonly object: string;
  readonly result: KnowledgeInsertResult;
}

/** Outcome returned by {@link KnowledgeGraphIngestor.ingest}. */
export interface KnowledgeGraphIngestResult {
  readonly subject: string;
  readonly triples: readonly KnowledgeGraphIngestedTriple[];
  readonly mentions: readonly string[];
}

/**
 * Ingests structured documents into the knowledge graph.  The helper emits a
 * handful of well known triples (type, language, source...) and extracts
 * high-level mentions so downstream planners can pivot on emerging topics.
 */
export class KnowledgeGraphIngestor {
  private readonly graph: KnowledgeGraph;

  constructor(dependencies: KnowledgeGraphIngestDependencies) {
    this.graph = dependencies.graph;
  }

  ingest(document: StructuredDocument): KnowledgeGraphIngestResult {
    const subject = buildSubject(document.id);
    const baseProvenance = withProvenance(
      [
        { sourceId: document.provenance.sourceUrl, type: "url" as const },
        { sourceId: document.url, type: "url" as const },
      ],
      [{ sourceId: `sha256:${document.checksum}`, type: "file" as const }],
    );

    const sourcePayload = {
      url: document.url,
      advertised_url: document.provenance.sourceUrl,
      fetched_at: new Date(document.fetchedAt).toISOString(),
      checksum: document.checksum,
      mime_type: document.mimeType ?? null,
      size: document.size,
    } as const;

    const triples: KnowledgeTripleInput[] = [];

    const enqueue = (triple: KnowledgeTripleInput) => {
      triples.push(triple);
    };

    enqueue({
      subject,
      predicate: P.type,
      object: "search:Document",
      source: document.provenance.sourceUrl,
      provenance: baseProvenance,
    });

    enqueue({
      subject,
      predicate: P.src,
      object: document.url,
      source: document.provenance.sourceUrl,
      provenance: baseProvenance,
    });

    enqueue({
      subject,
      predicate: P.fetchMetadata,
      object: JSON.stringify(sourcePayload),
      source: document.provenance.sourceUrl,
      provenance: baseProvenance,
    });

    if (document.title) {
      enqueue({
        subject,
        predicate: P.title,
        object: document.title,
        source: document.provenance.sourceUrl,
        provenance: baseProvenance,
      });
    }

    if (document.description) {
      enqueue({
        subject,
        predicate: P.description,
        object: document.description,
        source: document.provenance.sourceUrl,
        provenance: baseProvenance,
      });
    }

    if (document.language) {
      enqueue({
        subject,
        predicate: P.lang,
        object: document.language,
        source: document.provenance.sourceUrl,
        provenance: baseProvenance,
      });
    }

    const mentionTerms = extractKeyTerms(document);
    for (const [index, term] of mentionTerms.entries()) {
      enqueue({
        subject,
        predicate: P.mentions,
        object: term,
        source: document.provenance.sourceUrl,
        provenance: withProvenance(baseProvenance, [buildMentionProvenance(subject, index)]),
      });
    }

    const aggregated: KnowledgeGraphIngestedTriple[] = [];
    // Local debounce ensures identical (subject, predicate, object) tuples are
    // only written once per ingest run even if upstream helpers emit duplicates.
    const runGuard = createKnowledgeTripleRunGuard();
    for (const triple of dedupeTripleBatch(triples)) {
      if (!runGuard.remember(triple)) {
        continue;
      }
      aggregated.push({
        predicate: triple.predicate,
        object: triple.object,
        result: upsertTriple(this.graph, triple),
      });
    }

    return {
      subject,
      triples: aggregated,
      mentions: mentionTerms,
    };
  }
}

/** Derives a deterministic subject for knowledge graph triples. */
function buildSubject(documentId: string): string {
  return `${SEARCH_DOCUMENT_SUBJECT_PREFIX}${documentId}`;
}

/**
 * Extracts a compact list of key terms from the structured document.  The
 * helper lowercases tokens, removes stop words and prefers the most frequent
 * occurrences so the resulting mentions remain meaningful even when the source
 * material is noisy.
 */
export function extractKeyTerms(document: StructuredDocument): string[] {
  const frequency = new Map<string, number>();

  const consider = (text: string) => {
    const tokens = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

    for (const token of tokens) {
      const count = frequency.get(token) ?? 0;
      frequency.set(token, count + 1);
    }
  };

  if (document.title) {
    consider(document.title);
  }
  if (document.description) {
    consider(document.description);
  }

  for (const segment of document.segments) {
    if (!MENTION_KINDS.has(segment.kind)) {
      continue;
    }
    if (!segment.text) {
      continue;
    }
    consider(segment.text);
  }

  const entries = Array.from(frequency.entries()).filter(([, count]) => count >= 2);
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.slice(0, MAX_MENTION_TERMS).map(([token]) => token);
}

/** Builds provenance entries pointing to synthetic mention identifiers. */
function buildMentionProvenance(subject: string, index: number) {
  const fingerprint = createHash("sha256").update(`${subject}:mention:${index}`).digest("hex");
  return { sourceId: `kg://${fingerprint}`, type: "kg" as const };
}
