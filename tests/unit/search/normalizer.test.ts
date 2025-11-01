import { expect } from "chai";

import {
  deduplicateSegments,
  finalizeDocId,
  type StructuredDocument,
  type StructuredSegment,
} from "../../../src/search/index.js";

describe("search/normalizer", () => {
  it("reassigns the document identifier and regenerates segment ids", () => {
    const document = createDocument({
      id: "temp",
      segments: [
        createSegment({ id: "temp#raw-1", text: "Title", kind: "title" }),
        createSegment({ id: "temp#raw-2", text: "Paragraph", kind: "paragraph" }),
      ],
    });

    const finalised = finalizeDocId(document, "doc-final");
    expect(finalised.id).to.equal("doc-final");
    expect(finalised.segments.map((segment) => segment.id)).to.deep.equal(["doc-final#1", "doc-final#2"]);
  });

  it("deduplicates textual segments while preserving figures", () => {
    const document = createDocument({
      segments: [
        createSegment({ id: "doc#raw-1", text: "Title", kind: "title" }),
        createSegment({ id: "doc#raw-2", text: "  Title   ", kind: "title" }),
        createSegment({ id: "doc#raw-3", text: "Paragraph", kind: "paragraph" }),
        createSegment({ id: "doc#raw-4", text: "Paragraph", kind: "paragraph" }),
        createSegment({ id: "doc#raw-5", text: "", kind: "paragraph" }),
        createSegment({ id: "doc#raw-6", text: "", kind: "figure", sourceId: "img-1" }),
        createSegment({ id: "doc#raw-7", text: "", kind: "figure", sourceId: "img-2" }),
      ],
    });

    const deduped = deduplicateSegments(document);
    expect(deduped.segments).to.have.lengthOf(4);
    expect(deduped.segments.map((segment) => segment.kind)).to.deep.equal([
      "title",
      "paragraph",
      "figure",
      "figure",
    ]);
    expect(deduped.segments[0]?.text).to.equal("Title");
    expect(deduped.segments[1]?.text).to.equal("Paragraph");
  });

  it("derives the document title from the first title segment when missing", () => {
    const document = createDocument({
      title: null,
      segments: [
        createSegment({ id: "doc#raw-1", text: "  Synthèse   ", kind: "title" }),
        createSegment({ id: "doc#raw-2", text: "Contenu", kind: "paragraph" }),
      ],
    });

    const deduped = deduplicateSegments(document);
    expect(deduped.title).to.equal("Synthèse");
  });

  it("normalises combining accents so NFD and NFC variants deduplicate", () => {
    const composed = "Résumé"; // already NFC composed form for baseline
    const decomposed = "Re\u0301sume\u0301"; // intentionally NFD with combining acute accents

    const document = createDocument({
      segments: [
        createSegment({ id: "doc#raw-1", text: composed, kind: "paragraph" }),
        createSegment({ id: "doc#raw-2", text: decomposed, kind: "paragraph" }),
      ],
    });

    const deduped = deduplicateSegments(document);
    expect(deduped.segments).to.have.lengthOf(1);
    expect(deduped.segments[0]?.text).to.equal("Résumé");
  });

  it("falls back to the first meaningful title when the provided title is blank", () => {
    const document = createDocument({
      title: "   ",
      segments: [
        createSegment({ id: "doc#raw-1", text: "Rapport annuel", kind: "title" }),
        createSegment({ id: "doc#raw-2", text: "Contenu", kind: "paragraph" }),
      ],
    });

    const deduped = deduplicateSegments(document);
    expect(deduped.title).to.equal("Rapport annuel");
  });
});

function createDocument(overrides: Partial<StructuredDocument>): StructuredDocument {
  return {
    id: "doc",
    url: "https://example.com",
    title: "Example",
    language: "en",
    description: null,
    checksum: "hash",
    mimeType: "text/html",
    size: 123,
    fetchedAt: 1,
    segments: [],
    provenance: {
      searxQuery: "query",
      engines: [],
      categories: [],
      position: null,
      sourceUrl: "https://example.com",
    },
    ...overrides,
  };
}

function createSegment(overrides: Partial<StructuredSegment>): StructuredSegment {
  return {
    id: "doc#raw-1",
    kind: "paragraph",
    text: "text",
    ...overrides,
  };
}

