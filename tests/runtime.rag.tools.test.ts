import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from "../src/server.js";

/**
 * Integration coverage ensuring the RAG tools are exposed via MCP and operate
 * against the lazily initialised runtime memory/retriever stack.
 */
describe("runtime rag tools", () => {
  const ragMemoryDir = resolve(process.cwd(), "runs", "memory", "rag");
  let baselineFeatures = getRuntimeFeatures();

  beforeEach(() => {
    baselineFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({
      ...baselineFeatures,
      enableKnowledge: true,
      enableAssist: true,
      enableRag: true,
    });
  });

  afterEach(async () => {
    configureRuntimeFeatures(baselineFeatures);
    await server.close().catch(() => {});
    await rm(ragMemoryDir, { recursive: true, force: true });
  });

  it("registers rag_ingest and rag_query with working storage", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.close().catch(() => {});
    await server.connect(serverTransport);

    const client = new Client({ name: "runtime-rag-tools", version: "1.0.0-test" });
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools({});
      const names = new Set(listed.tools.map((tool) => tool.name));
      expect(names.has("rag_ingest"), "rag_ingest must be exposed").to.equal(true);
      expect(names.has("rag_query"), "rag_query must be exposed").to.equal(true);

      const now = Date.now();
      const uniqueTag = `runtime-rag-${now}`;
      const ingestResponse = await client.callTool({
        name: "rag_ingest",
        arguments: {
          documents: [
            {
              id: `runtime-rag-doc-${now}`,
              text: `Guide runtime RAG ${uniqueTag} pour valider l'exposition des outils.`,
              tags: [uniqueTag],
              provenance: [{ sourceId: "file://runtime-rag.md", type: "file" }],
            },
          ],
          chunk_size: 256,
          chunk_overlap: 32,
        },
      });

      expect(ingestResponse.isError ?? false).to.equal(false, "rag_ingest should succeed");
      const ingestStructured = ingestResponse.structuredContent as
        | { chunks: number; stored: Array<{ tags: string[] }> }
        | undefined;
      expect(ingestStructured?.chunks).to.be.greaterThan(0);

      const queryResponse = await client.callTool({
        name: "rag_query",
        arguments: {
          query: uniqueTag,
          limit: 3,
          min_score: 0.0,
          required_tags: [uniqueTag],
          include_metadata: false,
        },
      });

      expect(queryResponse.isError ?? false).to.equal(false, "rag_query should succeed");
      const queryStructured = queryResponse.structuredContent as
        | { hits: Array<{ tags: string[]; matched_tags: string[]; score: number }>; total: number }
        | undefined;
      expect(queryStructured?.total).to.be.greaterThan(0);
      const firstHit = queryStructured?.hits?.[0];
      expect(firstHit?.tags ?? []).to.include(uniqueTag);
      expect(firstHit?.matched_tags ?? []).to.include(uniqueTag);
      expect(firstHit?.score ?? 0).to.be.at.least(0);
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("renvoie une erreur explicite lorsque le flag RAG est désactivé", async () => {
    configureRuntimeFeatures({ ...baselineFeatures, enableKnowledge: true, enableRag: false });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.close().catch(() => {});
    await server.connect(serverTransport);

    const client = new Client({ name: "runtime-rag-tools", version: "1.0.0-test" });
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "rag_query",
        arguments: { query: "disabled", limit: 1 },
      });

      expect(response.isError).to.equal(true, "rag_query should be disabled when the flag is off");
      const payload = JSON.parse(response.content?.[0]?.text ?? "{}") as { error?: string };
      expect(payload.error).to.equal("RAG_DISABLED");
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
