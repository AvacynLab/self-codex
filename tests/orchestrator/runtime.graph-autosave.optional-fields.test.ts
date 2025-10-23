import { beforeEach, afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { server, getGraphAutosaveStatusForTesting } from "../../src/server.js";

/**
 * Runtime assertion ensuring the autosave tool payload returned by the MCP layer does not leak
 * `undefined` placeholders once strict optional property checks are enabled.
 */
function assertNoUndefinedValues(record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    expect(value, `expected '${key}' to be defined`).to.not.equal(undefined);
  }
}

/**
 * Extracts and parses the JSON text payload emitted by a tool invocation result. The helper mirrors
 * the CLI helpers used in end-to-end tests while keeping this regression self-contained.
 */
function parseTextPayload(result: CallToolResult): Record<string, unknown> {
  const [firstEntry] = result.content ?? [];
  if (!firstEntry || firstEntry.type !== "text" || typeof firstEntry.text !== "string") {
    throw new Error("graph_state_autosave must return a textual JSON payload");
  }
  const parsed = JSON.parse(firstEntry.text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("graph_state_autosave payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "graph-autosave-optional-fields", version: "1.0.0-test" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close().catch(() => {});
  }
}

describe("graph_state_autosave optional fields", () => {
  let autosaveTarget: string | null = null;

  beforeEach(async () => {
    await server.close().catch(() => {});
    const status = getGraphAutosaveStatusForTesting();
    expect(status.path).to.equal(null);
    expect(status.timerActive).to.equal(false);
  });

  afterEach(async () => {
    const status = getGraphAutosaveStatusForTesting();
    if (status.timerActive) {
      await withClient(async (client) => {
        await client.callTool({ name: "graph_state_autosave", arguments: { action: "stop" } });
      });
    } else {
      await server.close().catch(() => {});
    }
    if (autosaveTarget) {
      await rm(autosaveTarget, { force: true }).catch(() => {});
      autosaveTarget = null;
    }
  });

  it("sanitises autosave start/stop payloads", async () => {
    await withClient(async (client) => {
      const autosavePath = path.join("tmp", `autosave-${randomUUID()}.json`);
      const startResult = await client.callTool({
        name: "graph_state_autosave",
        arguments: { action: "start", path: autosavePath, interval_ms: 1_500 },
      });

      expect(startResult.isError ?? false).to.equal(false);
      const startPayload = parseTextPayload(startResult);
      assertNoUndefinedValues(startPayload);
      expect(startPayload.status).to.equal("started");
      expect(startPayload.path).to.be.a("string");
      autosaveTarget = String(startPayload.path);
      expect(path.isAbsolute(autosaveTarget)).to.equal(true);
      expect(path.basename(autosaveTarget)).to.match(/^autosave-/);
      expect(startPayload.interval_ms).to.be.a("number").and.to.be.at.least(1_000);
      expect(startPayload.inactivity_threshold_ms).to.be.a("number");
      expect(startPayload.event_history_limit).to.be.a("number");

      const statusAfterStart = getGraphAutosaveStatusForTesting();
      expect(statusAfterStart.path).to.equal(autosaveTarget);
      expect(statusAfterStart.timerActive).to.equal(true);

      const stopResult = await client.callTool({
        name: "graph_state_autosave",
        arguments: { action: "stop" },
      });

      expect(stopResult.isError ?? false).to.equal(false);
      const stopPayload = parseTextPayload(stopResult);
      assertNoUndefinedValues(stopPayload);
      expect(stopPayload.status).to.equal("stopped");
      expect(stopPayload).to.not.have.property("path");
      expect(stopPayload).to.not.have.property("interval_ms");

      const statusAfterStop = getGraphAutosaveStatusForTesting();
      expect(statusAfterStop.path).to.equal(null);
      expect(statusAfterStop.timerActive).to.equal(false);
    });
  });
});
