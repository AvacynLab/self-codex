import { expect } from "chai";
import sinon from "sinon";

import {
  VectorStoreIngestor,
  type StructuredDocument,
} from "../../../src/search/index.js";
import type {
  VectorMemory,
  VectorMemoryDocument,
  VectorMemoryUpsertInput,
} from "../../../src/memory/vectorMemory.js";
import type { EmbedTextOptions, EmbedTextResult } from "../../../src/memory/vector.js";

describe("search/ingest/toVectorStore", () => {
  afterEach(() => {
    sinon.restore();
  });

  function createMemory(): VectorMemory {
    const upsert = sinon.stub().callsFake(async (inputs: VectorMemoryUpsertInput[]) =>
      inputs.map((input, index) => createStoredChunk(input.id ?? `chunk-${index}`)),
    );
    return {
      upsert,
      search: sinon.stub().resolves([]),
      delete: sinon.stub().resolves(0),
      clear: sinon.stub().resolves(),
      size: () => 0,
    } as VectorMemory;
  }

  function createStoredChunk(id: string): VectorMemoryDocument {
    return {
      id,
      text: "chunk",
      tags: ["search"],
      metadata: {},
      provenance: [],
      createdAt: 0,
      updatedAt: 0,
      embedding: {},
      norm: 1,
      tokenCount: 4,
    };
  }

  it("builds chunk metadata and delegates to the vector memory", async () => {
    const document: StructuredDocument = {
      id: "doc-v1",
      url: "https://example.com/doc",
      title: "LLM search overview",
      language: "EN",
      description: "Overview of the ingestion pipeline",
      checksum: "deadbeef",
      mimeType: "text/html",
      size: 4096,
      fetchedAt: 1_700_000_123_000,
      segments: [
        {
          id: "seg-1",
          kind: "title",
          text: "LLM Search",
        },
        {
          id: "seg-2",
          kind: "paragraph",
          text: "The pipeline fetches documents and stores structured metadata.",
        },
        {
          id: "seg-3",
          kind: "paragraph",
          text: "Vector chunks are generated with provenance and chunk identifiers.",
        },
      ],
      provenance: {
        searxQuery: "llm search",
        engines: ["ddg"],
        categories: ["general"],
        position: 1,
        sourceUrl: "https://source.example/doc",
      },
    };

    const embedCalls: EmbedTextOptions[] = [];
    const embedStub = sinon.stub().callsFake((options: EmbedTextOptions): EmbedTextResult => {
      embedCalls.push(options);
      return {
        payload: {
          text: options.text,
          id: options.idHint,
          metadata: options.metadata,
          tags: options.tags,
          provenance: options.provenance,
          createdAt: options.createdAt,
        },
        embedding: {},
        norm: 1,
        tokenCount: options.text.split(/\s+/u).length,
      };
    });

    const memory = createMemory();
    const ingestor = new VectorStoreIngestor({ memory, embed: embedStub, maxTokensPerChunk: 20 });

    const result = await ingestor.ingest(document);

    expect(embedCalls.length).to.be.greaterThan(0);
    const firstCall = embedCalls[0];
    const metadata = firstCall.metadata as Record<string, unknown> | undefined;
    expect(metadata).to.not.equal(undefined);
    expect(metadata?.["document_id"]).to.equal("doc-v1");
    expect(metadata?.["document_url"]).to.equal("https://example.com/doc");
    expect(metadata?.["title"]).to.equal("LLM search overview");
    expect(metadata?.["language"]).to.equal("en");
    expect(metadata?.["fetched_at"]).to.equal(1_700_000_123_000);

    expect(firstCall.text.startsWith("LLM Search\n\nThe pipeline")).to.equal(true);

    sinon.assert.calledOnce(memory.upsert as sinon.SinonStub<[VectorMemoryUpsertInput[]], Promise<VectorMemoryDocument[]>>);
    const upsertArg = (memory.upsert as sinon.SinonStub<[VectorMemoryUpsertInput[]], Promise<VectorMemoryDocument[]>>).firstCall
      .args[0];
    expect(upsertArg).to.have.length(embedCalls.length);
    const upsertMetadata = upsertArg[0].metadata as Record<string, unknown> | undefined;
    expect(upsertMetadata?.["document_id"]).to.equal("doc-v1");

    expect(result.descriptors).to.have.length(embedCalls.length);
    expect(result.chunks).to.have.length(embedCalls.length);
  });

  it("falls back to description when segments are missing", async () => {
    const document: StructuredDocument = {
      id: "doc-empty",
      url: "https://example.com/empty",
      title: null,
      language: null,
      description: "Pipeline summary for ingestion",
      checksum: "cafe1234",
      mimeType: "text/plain",
      size: 512,
      fetchedAt: 1_700_000_555_000,
      segments: [],
      provenance: {
        searxQuery: "pipeline",
        engines: [],
        categories: [],
        position: null,
        sourceUrl: "https://source.example/empty",
      },
    };

    const embedStub = sinon.stub().callsFake((options: EmbedTextOptions): EmbedTextResult => ({
      payload: {
        text: options.text,
        id: options.idHint,
        metadata: options.metadata,
        tags: options.tags,
        provenance: options.provenance,
        createdAt: options.createdAt,
      },
      embedding: {},
      norm: 1,
      tokenCount: options.text.split(/\s+/u).length,
    }));

    const memory = createMemory();
    const ingestor = new VectorStoreIngestor({ memory, embed: embedStub, maxTokensPerChunk: 50 });

    await ingestor.ingest(document);

    sinon.assert.calledOnce(embedStub);
    sinon.assert.calledOnce(memory.upsert as sinon.SinonStub<[VectorMemoryUpsertInput[]], Promise<VectorMemoryDocument[]>>);
  });

  it("skips duplicate chunks generated back-to-back", async () => {
    const document: StructuredDocument = {
      id: "doc-dup",
      url: "https://example.com/doc-dup",
      title: "Duplicate",
      language: "en",
      description: null,
      checksum: "ff00",
      mimeType: "text/html",
      size: 2048,
      fetchedAt: 1_700_000_123_999,
      segments: [
        { id: "seg-1", kind: "paragraph", text: "Repeated chunk." },
        { id: "seg-2", kind: "paragraph", text: "Repeated chunk." },
        { id: "seg-3", kind: "paragraph", text: "Repeated chunk." },
      ],
      provenance: {
        searxQuery: "duplicate chunk",
        engines: ["ddg"],
        categories: ["general"],
        position: 1,
        sourceUrl: "https://source.example/doc-dup",
      },
    };

    const embedStub = sinon.stub().callsFake((options: EmbedTextOptions): EmbedTextResult => ({
      payload: {
        text: options.text,
        id: options.idHint,
        metadata: options.metadata,
        tags: options.tags,
        provenance: options.provenance,
        createdAt: options.createdAt,
      },
      embedding: {},
      norm: 1,
      tokenCount: options.text.split(/\s+/u).length,
    }));

    const memory = createMemory();
    const ingestor = new VectorStoreIngestor({ memory, embed: embedStub, maxTokensPerChunk: 40 });

    await ingestor.ingest(document);

    sinon.assert.calledOnce(embedStub);
    sinon.assert.calledOnce(memory.upsert as sinon.SinonStub<[VectorMemoryUpsertInput[]], Promise<VectorMemoryDocument[]>>);
  });
});
