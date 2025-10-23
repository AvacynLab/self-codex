import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { LocalVectorMemory } from "../../src/memory/vectorMemory.js";
import type {
  VectorDocumentInput,
  VectorMemoryDocument,
  VectorMemoryIndex,
  VectorMemorySearchHit,
} from "../../src/memory/vector.js";

/**
 * Minimal in-memory stub mirroring the subset of {@link VectorMemoryIndex} used
 * by {@link LocalVectorMemory}. The stub captures the options forwarded by the
 * memory facade so tests can assert optional fields never leak as `undefined`.
 */
class FakeVectorIndex implements VectorMemoryIndex {
  public readonly upsert = sinon.stub<Parameters<VectorMemoryIndex["upsert"]>, Promise<VectorMemoryDocument>>();
  public readonly search = sinon.stub<Parameters<VectorMemoryIndex["search"]>, ReturnType<VectorMemoryIndex["search"]>>();
  public readonly deleteMany = sinon.stub<Parameters<VectorMemoryIndex["deleteMany"]>, ReturnType<VectorMemoryIndex["deleteMany"]>>();
  public readonly clear = sinon.stub<Parameters<VectorMemoryIndex["clear"]>, ReturnType<VectorMemoryIndex["clear"]>>();
  public readonly size = sinon.stub<Parameters<VectorMemoryIndex["size"]>, ReturnType<VectorMemoryIndex["size"]>>().returns(0);
}

describe("local vector memory optional fields", () => {
  it("omits undefined fields when upserting documents", async () => {
    const index = new FakeVectorIndex();
    const stored: VectorMemoryDocument = {
      id: "doc-1",
      text: "Normalised",
      tags: [],
      metadata: {},
      provenance: [],
      createdAt: 1,
      updatedAt: 2,
      embedding: {},
      norm: 1,
      tokenCount: 1,
    };
    index.upsert.resolves(stored);

    const memory = new (LocalVectorMemory as unknown as { new (idx: VectorMemoryIndex): LocalVectorMemory })(index);
    const snapshots = await memory.upsert([{ text: "Normalised" }]);

    expect(index.upsert.callCount).to.equal(1);
    const payload = index.upsert.firstCall.args[0] as VectorDocumentInput;
    expect(payload).to.deep.equal({ text: "Normalised", provenance: [] });

    // Returned snapshots must clone mutable fields so callers cannot mutate the
    // stored representation and must avoid leaking `undefined` placeholders.
    expect(snapshots).to.deep.equal([
      {
        id: "doc-1",
        text: "Normalised",
        tags: [],
        metadata: {},
        provenance: [],
        createdAt: 1,
        updatedAt: 2,
        embedding: {},
        norm: 1,
        tokenCount: 1,
      },
    ]);
    expect(snapshots[0]?.metadata).to.not.equal(stored.metadata);
    expect(snapshots[0]?.provenance).to.not.equal(stored.provenance);
  });

  it("forwards defined overrides while keeping vector search options sparse", async () => {
    const index = new FakeVectorIndex();
    const stored: VectorMemoryDocument = {
      id: "doc-1",
      text: "Payload",
      tags: ["alpha", "beta"],
      metadata: { foo: "bar" },
      provenance: [{ sourceId: "kb", type: "file" }],
      createdAt: 10,
      updatedAt: 20,
      embedding: {},
      norm: 1,
      tokenCount: 2,
    };

    index.upsert.resolves(stored);
    index.search.callsFake((query: string, options) => {
      expect(query).to.equal("incident response");
      expect(options).to.deep.equal({ minScore: 0.3, limit: 5 });
      const hit: VectorMemorySearchHit = {
        document: stored,
        score: 0.6,
      };
      return [hit];
    });

    const memory = new (LocalVectorMemory as unknown as { new (idx: VectorMemoryIndex): LocalVectorMemory })(index);

    await memory.upsert([
      {
        id: "doc-1",
        text: "Payload",
        tags: ["Alpha", "", "beta"],
        metadata: { foo: "bar" },
        provenance: [{ sourceId: "kb", type: "file" }],
        createdAt: 10,
      },
    ]);

    const results = await memory.search("incident response", { minScore: 0.3, limit: 5 });
    expect(results).to.have.lengthOf(1);

    const document = results[0]?.document;
    expect(document?.metadata).to.deep.equal({ foo: "bar" });
    expect(document?.tags).to.deep.equal(["alpha", "beta"]);
    expect(document?.provenance).to.deep.equal([{ sourceId: "kb", type: "file" }]);

    // Mutating the returned snapshot must not alter the underlying index entry.
    document?.metadata && (document.metadata.foo = "baz");
    expect(stored.metadata.foo).to.equal("bar");
  });

  it("filters required tags locally without forwarding undefined vector options", async () => {
    const index = new FakeVectorIndex();
    const hit: VectorMemorySearchHit = {
      document: {
        id: "doc-1",
        text: "Escalate incidents quickly",
        tags: ["alpha", "beta"],
        metadata: {},
        provenance: [],
        createdAt: 0,
        updatedAt: 0,
        embedding: {},
        norm: 1,
        tokenCount: 3,
      },
      score: 0.8,
    };

    index.search.callsFake((query: string, options) => {
      expect(options).to.deep.equal({});
      return [hit];
    });

    const memory = new (LocalVectorMemory as unknown as { new (idx: VectorMemoryIndex): LocalVectorMemory })(index);
    const results = await memory.search("Escalate", { requiredTags: ["Alpha", ""] });

    expect(results).to.have.lengthOf(1);
    expect(results[0]?.matchedTags).to.deep.equal(["alpha"]);
  });
});
