import { describe, it } from "mocha";
import { expect } from "chai";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from "../src/server.js";

/**
 * Integration coverage ensuring `events_subscribe` derives a stable `kind` value even when
 * bridge publishers omit the metadata. Stigmergy change events intentionally leave the field
 * undefined so the fallback to the category (STIGMERGY) can be asserted here.
 */
describe("events subscribe kind fallback", () => {
  it("derives uppercase kinds when bridge events omit explicit metadata", async () => {
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-kind-fallback-test", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableEventsBus: true,
        enableStigmergy: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "kind-fallback" } });
      childSupervisor.childrenIndex.restore({});

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      const markResponse = await client.callTool({
        name: "stig_mark",
        arguments: { node_id: "node-kind", type: "load", intensity: 2 },
      });
      expect(markResponse.isError ?? false).to.equal(false);

      const eventsResponse = await client.callTool({
        name: "events_subscribe",
        arguments: { cats: ["stigmergy"], from_seq: cursor, format: "jsonlines" },
      });
      expect(eventsResponse.isError ?? false).to.equal(false);

      const structured = eventsResponse.structuredContent as {
        events: Array<{ kind: string; msg: string; data: Record<string, unknown> | null }>;
      };

      const changeEvent = structured.events.find((event) => event.msg === "stigmergy_change");
      expect(changeEvent, "stigmergy change event should be published").to.not.equal(undefined);
      expect(changeEvent?.kind).to.equal("STIGMERGY");
      const payload = (changeEvent?.data ?? {}) as { nodeId?: string | null; type?: string | null };
      expect(payload.nodeId).to.equal("node-kind");
      expect(payload.type).to.equal("load");

      const decayResponse = await client.callTool({
        name: "stig_decay",
        arguments: { half_life_ms: 1 },
      });
      expect(decayResponse.isError ?? false).to.equal(false);
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      childSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
