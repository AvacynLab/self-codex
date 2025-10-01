import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { server, graphState } from "../src/server.js";

/**
 * Integration test ensuring manual `child_create` calls produce the same graph
 * artefacts (job + child nodes) as planner-orchestrated runs. This keeps the
 * dashboard consistent when operators spawn ad-hoc clones for troubleshooting.
 */
const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));

describe("child_create graph integration", () => {
  it("materialises manual children inside GraphState", async () => {
    const existingChildIds = new Set(graphState.listChildSnapshots().map((child) => child.id));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "manual-child-graph-test", version: "1.0.0-test" });

    await server.close().catch(() => {
      // The shared server may already be disconnected. Swallow the error to keep the test idempotent.
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    let createdChildId: string | null = null;

    try {
      const response = await client.callTool({
        name: "child_create",
        arguments: {
          command: process.execPath,
          args: [mockRunnerPath, "--role", "friendly"],
          metadata: {
            job_id: "adhoc-experiment",
            name: "Manual Friendly Runner",
            goal: "explorer integration",
          },
          wait_for_ready: true,
          ready_type: "ready",
          ready_timeout_ms: 1_500,
        },
      });

      expect(response.isError ?? false).to.equal(false, "child_create should succeed");

      const payload = response.structuredContent as {
        child_id: string;
        runtime_status: { command: string };
        index_snapshot: { state: string };
      };

      createdChildId = payload.child_id;
      expect(existingChildIds.has(createdChildId)).to.equal(false, "graph must register a new child");

      const snapshot = graphState.getChild(createdChildId);
      expect(snapshot, "GraphState should expose the spawned child").to.not.be.undefined;
      expect(snapshot?.jobId, "child must be attached to a job").to.not.equal("");

      const job = snapshot ? graphState.getJob(snapshot.jobId) : undefined;
      expect(job, "job snapshot must exist").to.not.be.undefined;
      expect(job?.id.startsWith("manual-")).to.equal(true, "job identifier should reflect manual origin");
      expect(job?.goal).to.equal("explorer integration");

      expect(snapshot?.name).to.equal("Manual Friendly Runner");
      expect(snapshot?.state).to.equal(payload.index_snapshot.state);
      expect(snapshot?.runtime).to.equal(path.basename(payload.runtime_status.command));
    } finally {
      if (createdChildId) {
        await client
          .callTool({ name: "child_kill", arguments: { child_id: createdChildId } })
          .catch(() => {});
        await client
          .callTool({ name: "child_gc", arguments: { child_id: createdChildId } })
          .catch(() => {});
      }

      await client.close();
      await server.close();
    }
  });
});
