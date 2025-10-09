import { after, afterEach, before, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createFsBridgeHarness,
  disposeFsBridgeHarness,
  waitForJsonFile,
  type FsBridgeHarness,
} from "./fsbridge.test-harness.js";
import { configureRuntimeFeatures, getRuntimeFeatures } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

describe("fs bridge mcp_info round-trip", () => {
  let harness: FsBridgeHarness;
  let originalFeatures: FeatureToggles;

  before(async () => {
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableMcpIntrospection: true });
  });

  beforeEach(async () => {
    harness = await createFsBridgeHarness();
  });

  afterEach(async () => {
    await harness.bridge.stopFsBridgeWatcher();
  });

  after(async () => {
    await disposeFsBridgeHarness();
    configureRuntimeFeatures(originalFeatures);
  });

  it("returns the MCP runtime descriptor", async () => {
    const requestPath = join(harness.requestsDir, "req-mcp-info.json");
    await writeFile(
      requestPath,
      JSON.stringify({ jsonrpc: "2.0", id: "mcp-info", method: "mcp_info" }),
      "utf8",
    );

    await harness.bridge.startFsBridgeWatcher();

    const responsePath = await waitForJsonFile(harness.responsesDir);
    const response = JSON.parse(await readFile(responsePath, "utf8")) as {
      jsonrpc: string;
      id: string;
      result?: { server?: { name?: string } };
    };

    expect(response.jsonrpc).to.equal("2.0");
    expect(response.id).to.equal("mcp-info");
    const descriptor = response.result as
      | { server?: { name?: string } }
      | { error?: string; tool?: string }
      | undefined;
    if (descriptor?.server?.name) {
      expect(descriptor.server.name).to.be.a("string");
    } else {
      expect(descriptor).to.include({ error: "MCP_INTROSPECTION_DISABLED", tool: "mcp_info" });
    }
    expect(await readdir(harness.requestsDir)).to.be.empty;
  });
});
