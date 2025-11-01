import { expect } from "chai";

import {
  createKnowledgeTripleRunGuard,
  dedupeTripleBatch,
  fingerprintTriple,
  withProvenance,
  type KnowledgeTripleInput,
} from "../../../src/knowledge/knowledgeGraph.js";

import type { Provenance } from "../../../src/types/provenance.js";

describe("knowledgeGraph utilities", () => {
  it("dedupeTripleBatch removes duplicates while preserving order", () => {
    const triples: KnowledgeTripleInput[] = [
      { subject: "s", predicate: "p", object: "o1" },
      { subject: "s", predicate: "p", object: "o2" },
      { subject: "s", predicate: "p", object: "o1" },
      { subject: " s ", predicate: " p ", object: " o2 " },
    ];

    const unique = dedupeTripleBatch(triples);

    expect(unique).to.have.length(2);
    expect(unique[0].object).to.equal("o1");
    expect(unique[1].object).to.equal("o2");
  });

  it("withProvenance deduplicates repeated entries across batches", () => {
    const batchA: Provenance[] = [
      { sourceId: "https://example.com", type: "url" },
      { sourceId: "sha256:abc", type: "file" },
    ];
    const batchB: Provenance[] = [
      { sourceId: "https://example.com", type: "url" },
      { sourceId: "sha256:abc", type: "file" },
      { sourceId: "https://example.com", type: "url", span: [0, 10] },
    ];

    const merged = withProvenance(batchA, batchB);

    expect(merged).to.have.length(2);
    const [urlEntry] = merged.filter((entry) => entry.type === "url");
    expect(urlEntry).to.not.equal(undefined);
    expect(urlEntry?.span).to.deep.equal([0, 10]);
    const fileEntry = merged.find((entry) => entry.type === "file");
    expect(fileEntry?.sourceId).to.equal("sha256:abc");
  });

  it("createKnowledgeTripleRunGuard suppresses duplicate triples within a run", () => {
    const guard = createKnowledgeTripleRunGuard();
    const triple = { subject: " subject ", predicate: " predicate", object: "object  " };

    expect(guard.remember(triple)).to.equal(true);
    expect(guard.remember({ subject: "subject", predicate: "predicate", object: "object" })).to.equal(false);
    expect(guard.size()).to.equal(1);

    guard.reset();
    expect(guard.size()).to.equal(0);
    expect(guard.remember({ subject: "subject", predicate: "predicate", object: "object" })).to.equal(true);
  });

  it("fingerprintTriple returns null when components are blank", () => {
    expect(fingerprintTriple("", "predicate", "object")).to.equal(null);
    expect(fingerprintTriple("subject", "", "object")).to.equal(null);
    expect(fingerprintTriple("subject", "predicate", "")).to.equal(null);
  });
});
