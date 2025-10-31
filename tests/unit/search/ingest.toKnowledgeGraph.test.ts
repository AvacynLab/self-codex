import { expect } from "chai";
import sinon from "sinon";

import {
  KnowledgeGraphIngestor,
  extractKeyTerms,
  type StructuredDocument,
  P,
} from "../../../src/search/index.js";
import { KnowledgeGraph } from "../../../src/knowledge/knowledgeGraph.js";

describe("search/ingest/toKnowledgeGraph", () => {
  afterEach(() => {
    sinon.restore();
  });

  const baseDocument: StructuredDocument = {
    id: "doc-42",
    url: "https://example.com/doc",
    title: "LLM search pipelines",
    language: "en",
    description: "Pipeline connecting searx results to graph ingestion.",
    checksum: "abc123",
    mimeType: "text/html",
    size: 2048,
    fetchedAt: 1_700_000_000_000,
    segments: [
      { id: "seg-1", kind: "title", text: "LLM Search Pipeline", metadata: { page: 1 } },
      {
        id: "seg-2",
        kind: "paragraph",
        text: "The pipeline fetches documents and populates the knowledge graph, making the pipeline resilient.",
      },
      {
        id: "seg-3",
        kind: "paragraph",
        text: "Graph ingestion deduplicates mentions and attaches provenance to the pipeline output.",
      },
    ],
    provenance: {
      searxQuery: "llm search pipeline",
      engines: ["ddg", "wikipedia"],
      categories: ["general"],
      position: 2,
      sourceUrl: "https://source.example/doc",
    },
  };

  it("persists canonical triples and mentions", () => {
    const graph = new KnowledgeGraph({ now: () => 1234 });
    const ingestor = new KnowledgeGraphIngestor({ graph });

    const result = ingestor.ingest(baseDocument);

    expect(result.subject).to.equal("search:document:doc-42");
    expect(result.triples).to.have.length.greaterThan(0);
    expect(result.mentions.length).to.be.greaterThan(0);

    const storedTriples = graph
      .exportAll()
      .filter((triple) => triple.subject === result.subject);

    expect(storedTriples.some((triple) => triple.predicate === P.type)).to.equal(true);
    expect(storedTriples.some((triple) => triple.predicate === P.src)).to.equal(true);

    const mentionTriple = storedTriples.find((triple) => triple.predicate === P.mentions);
    expect(mentionTriple).to.not.equal(undefined);
    expect(result.mentions).to.include(mentionTriple?.object ?? "");
    expect(mentionTriple?.provenance.length ?? 0).to.be.greaterThan(0);
    const provenanceSources = new Set((mentionTriple?.provenance ?? []).map((entry) => entry.sourceId));
    expect(provenanceSources.has(baseDocument.url)).to.equal(true);
    expect(provenanceSources.has(baseDocument.provenance.sourceUrl)).to.equal(true);
  });

  it("extracts key terms while skipping stop words", () => {
    const terms = extractKeyTerms({
      ...baseDocument,
      segments: [
        { id: "seg-1", kind: "title", text: "Analyse des pipelines LLM" },
        { id: "seg-2", kind: "paragraph", text: "Le pipeline collecte et agrège les résultats." },
        { id: "seg-3", kind: "paragraph", text: "Les résultats sont ensuite injectés dans le graphe." },
      ],
    });

    expect(terms).to.include("pipeline");
    expect(terms).to.not.include("les");
    expect(terms.length).to.be.lessThanOrEqual(12);
  });

  it("does not insert duplicate triples when the payload repeats data", () => {
    const graph = new KnowledgeGraph({ now: () => 42 });
    const ingestor = new KnowledgeGraphIngestor({ graph });

    const noisyDocument: StructuredDocument = {
      ...baseDocument,
      description: baseDocument.description,
      segments: [
        ...baseDocument.segments,
        { id: "seg-4", kind: "paragraph", text: "The pipeline remains the pipeline of record." },
      ],
    };

    const first = ingestor.ingest(noisyDocument);
    const second = ingestor.ingest(noisyDocument);

    expect(first.triples.length).to.be.greaterThan(0);
    expect(second.triples.length).to.equal(first.triples.length);

    const triples = graph.exportAll().filter((triple) => triple.subject === first.subject);
    const keySet = new Set(triples.map((triple) => `${triple.subject}|${triple.predicate}|${triple.object}`));
    expect(keySet.size).to.equal(triples.length);
  });
});
