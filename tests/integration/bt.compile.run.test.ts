import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from "../../src/server.js";

/**
 * Integration coverage validating the Behaviour Tree compile/run endpoints surface deterministic
 * error codes when callers provide malformed payloads. The tests intentionally trigger validation
 * failures so downstream automation can rely on the documented `E-BT-INVALID` family.
 */
describe("behaviour tree compile & run integration", () => {
  let baselineGraphSnapshot: ReturnType<typeof graphState.serialize>;
  let baselineChildrenSnapshot: ReturnType<typeof childProcessSupervisor.childrenIndex.serialize>;
  let baselineFeatures: ReturnType<typeof getRuntimeFeatures>;

  beforeEach(() => {
    baselineGraphSnapshot = graphState.serialize();
    baselineChildrenSnapshot = childProcessSupervisor.childrenIndex.serialize();
    baselineFeatures = getRuntimeFeatures();
  });

  afterEach(async () => {
    configureRuntimeFeatures(baselineFeatures);
    graphState.resetFromSnapshot(baselineGraphSnapshot);
    childProcessSupervisor.childrenIndex.restore(baselineChildrenSnapshot);
    await server.close().catch(() => {});
  });

  it("rejects hierarchical graphs missing Behaviour Tree attributes", async function () {
    this.timeout(5000);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bt-compile-invalid", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    configureRuntimeFeatures({ ...baselineFeatures, enableBT: true });

    const response = await client.callTool({
      name: "plan_compile_bt",
      arguments: {
        graph: {
          id: "invalid-graph",
          nodes: [
            {
              id: "task",
              kind: "task",
              label: "Task",
              attributes: {},
            },
          ],
          edges: [],
        },
      },
    });

    expect(response.isError ?? false).to.equal(true);
    const errorPayload = JSON.parse(response.content?.[0]?.text ?? "{}");
    expect(errorPayload.error).to.equal("E-BT-INVALID");

    await client.close().catch(() => {});
  });

  it("surfaces typed errors when plan_run_bt encounters unknown tools", async function () {
    this.timeout(5000);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bt-run-invalid", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    configureRuntimeFeatures({
      ...baselineFeatures,
      enableBT: true,
      enablePlanLifecycle: true,
    });

    const response = await client.callTool({
      name: "plan_run_bt",
      arguments: {
        tree: {
          id: "unknown-tool", // matches the Behaviour Tree identifier to simplify assertions
          root: { type: "task", id: "missing", node_id: "missing", tool: "missing_tool" },
        },
      },
    });

    expect(response.isError ?? false).to.equal(true);
    const errorPayload = JSON.parse(response.content?.[0]?.text ?? "{}");
    expect(errorPayload.error).to.equal("E-BT-INVALID");
    expect(errorPayload.message).to.contain("missing_tool");

    await client.close().catch(() => {});
  });
});
