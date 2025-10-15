import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractSubgraphToFile } from "../src/graph/subgraphExtract.js";
import { SUBGRAPH_REGISTRY_KEY } from "../src/graph/subgraphRegistry.js";
import type { GraphDescriptorPayload } from "../src/tools/graphTools.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "subgraph-extract-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("graph subgraph extract", () => {
  it("serialises subgraph descriptors into a versioned run directory", async () => {
    await withTempDir(async (root) => {
      const graph: GraphDescriptorPayload = {
        name: "pipeline",
        nodes: [
          { id: "alpha", attributes: { kind: "task" } },
          { id: "beta", attributes: { kind: "subgraph", ref: "analysis" } },
          { id: "omega", attributes: { kind: "task" } },
        ],
        edges: [],
        metadata: {
          [SUBGRAPH_REGISTRY_KEY]: JSON.stringify({
            analysis: {
              graph: { id: "analysis", nodes: [], edges: [] },
              entryPoints: ["start"],
              exitPoints: ["finish"],
            },
          }),
        },
        graph_id: "pipeline",
        graph_version: 2,
      };

      const times = [1000, 2000];
      let cursor = 0;
      const originalNow = Date.now;
      Date.now = () => times[Math.min(cursor++, times.length - 1)];
      try {
        const first = await extractSubgraphToFile({
          graph,
          nodeId: "beta",
          runId: "run-alpha",
          childrenRoot: root,
        });
        expect(first.version).to.equal(1);
        expect(first.subgraphRef).to.equal("analysis");
        expect(first.extractedAt).to.equal(1000);
        const firstPayload = JSON.parse(await readFile(first.absolutePath, "utf8"));
        expect(firstPayload.version).to.equal(1);
        expect(firstPayload.subgraph_ref).to.equal("analysis");
        expect(firstPayload.graph_id).to.equal("pipeline");

        const second = await extractSubgraphToFile({
          graph,
          nodeId: "beta",
          runId: "run-alpha",
          childrenRoot: root,
        });
        expect(second.version).to.equal(2);
        expect(second.extractedAt).to.equal(2000);
        expect(path.dirname(second.absolutePath)).to.equal(path.dirname(first.absolutePath));
      } finally {
        Date.now = originalNow;
      }
    });
  });

  it("sanitises descriptor paths when references contain unsafe characters", async () => {
    await withTempDir(async (root) => {
      const graph: GraphDescriptorPayload = {
        name: "pipeline",
        nodes: [
          { id: "alpha", attributes: { kind: "task" } },
          { id: "beta", attributes: { kind: "subgraph", ref: "../analysis<danger>" } },
        ],
        edges: [],
        metadata: {
          [SUBGRAPH_REGISTRY_KEY]: JSON.stringify({
            "../analysis<danger>": { graph: { id: "analysis", nodes: [], edges: [] } },
          }),
        },
      };

      const result = await extractSubgraphToFile({
        graph,
        nodeId: "beta",
        runId: "run-sanitize",
        childrenRoot: root,
      });

      expect(result.absolutePath.startsWith(root)).to.equal(true);
      expect(result.absolutePath).to.not.include("..");
      expect(result.relativePath).to.not.include("..");
      expect(result.relativePath).to.not.include("<");
      expect(result.relativePath).to.match(/analysis-danger\.v001\.json$/);
    });
  });

  it("rejects graphs missing the referenced descriptor", async () => {
    await withTempDir(async (root) => {
      const graph: GraphDescriptorPayload = {
        name: "incomplete",
        nodes: [
          { id: "alpha", attributes: { kind: "subgraph", ref: "missing" } },
        ],
        edges: [],
        metadata: {},
      };

      let error: Error | null = null;
      try {
        await extractSubgraphToFile({
          graph,
          nodeId: "alpha",
          runId: "run-beta",
          childrenRoot: root,
        });
      } catch (err) {
        error = err as Error;
      }
      expect(error).to.not.equal(null);
      expect(error?.message).to.match(/missing/i);
    });
  });
});
