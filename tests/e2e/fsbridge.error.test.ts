import { after, afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createFsBridgeHarness,
  disposeFsBridgeHarness,
  waitForJsonFile,
  type FsBridgeHarness,
} from "./fsbridge.test-harness.js";

describe("fs bridge error propagation", () => {
  let harness: FsBridgeHarness;

  beforeEach(async () => {
    harness = await createFsBridgeHarness();
  });

  afterEach(async () => {
    await harness.bridge.stopFsBridgeWatcher();
  });

  after(async () => {
    await disposeFsBridgeHarness();
  });

  it("routes JSON-RPC failures to the error channel", async () => {
    const requestPath = join(harness.requestsDir, "req-unknown.json");
    await writeFile(
      requestPath,
      JSON.stringify({ jsonrpc: "2.0", id: "unknown", method: "nonexistent" }),
      "utf8",
    );

    await harness.bridge.startFsBridgeWatcher();

    const errorPath = await waitForJsonFile(harness.errorsDir);
    const payload = JSON.parse(await readFile(errorPath, "utf8")) as {
      jsonrpc: string;
      id: string;
      error?: { code?: number; message?: string };
    };

    expect(payload.jsonrpc).to.equal("2.0");
    expect(payload.id).to.equal("unknown");
    expect(payload.error?.code).to.equal(-32000);
    expect(payload.error?.message).to.be.a("string");
    expect(await readdir(harness.requestsDir)).to.be.empty;
  });
});
