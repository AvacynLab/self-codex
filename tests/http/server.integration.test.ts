import { after, before, describe, it } from "mocha";
import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { EventStore } from "../../src/eventStore.js";
import { server as mcpServer } from "../../src/server.js";

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

/**
 * Full-stack HTTP transport checks that exercise the real MCP server while
 * capturing structured access logs.  The suite ensures both successful and
 * rejected JSON-RPC requests surface the expected status codes and emit
 * `HTTP_ACCESS` events so operators can trace activity back to remote callers.
 */
describe("http server integration", function () {
  this.timeout(15000);

  let handle: HttpServerHandle | null = null;
  let baseUrl: string;
  let eventStore: EventStore;
  const logger = new StructuredLogger();
  let tokenSnapshot: string | undefined;
  let noAuthSnapshot: string | undefined;

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard && offlineGuard !== "loopback-only") {
      this.skip();
    }

    tokenSnapshot = process.env.MCP_HTTP_TOKEN;
    noAuthSnapshot = process.env.MCP_HTTP_ALLOW_NOAUTH;
    delete process.env.MCP_HTTP_TOKEN;
    process.env.MCP_HTTP_ALLOW_NOAUTH = "1";

    eventStore = new EventStore({ maxHistory: 32 });

    handle = await startHttpServer(
      mcpServer,
      {
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        enableJson: true,
        stateless: true,
      },
      logger,
      { eventStore },
    );
    baseUrl = `http://127.0.0.1:${handle.port}/mcp`;
  });

  after(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    if (tokenSnapshot === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = tokenSnapshot;
    }
    if (noAuthSnapshot === undefined) {
      delete process.env.MCP_HTTP_ALLOW_NOAUTH;
    } else {
      process.env.MCP_HTTP_ALLOW_NOAUTH = noAuthSnapshot;
    }
  });

  async function waitForAccessEvents(expected: number): Promise<ReturnType<EventStore["getEventsByKind"]>> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const events = eventStore.getEventsByKind("HTTP_ACCESS");
      if (events.length >= expected) {
        return events;
      }
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${expected} HTTP access events`);
  }

  async function postJson(body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as JsonRpcSuccess;
    return { response, json };
  }

  it("logs HTTP_ACCESS events for successful JSON-RPC calls", async () => {
    if (!handle) {
      throw new Error("HTTP server not started");
    }

    const beforeEvents = eventStore.getEventsByKind("HTTP_ACCESS").length;
    const { response, json } = await postJson({
      jsonrpc: "2.0",
      id: "mcp-info-ok",
      method: "mcp_info",
      params: {},
    });

    expect(response.status).to.equal(200);
    expect(json.result, "mcp_info should respond with a result").to.be.an("object");

    const events = await waitForAccessEvents(beforeEvents + 1);
    const last = events[events.length - 1];
    expect(last.kind).to.equal("HTTP_ACCESS");
    expect(last.payload).to.include({ route: "/mcp", method: "POST", status: 200 });
    expect(last.payload?.latency_ms, "latency must be recorded").to.be.a("number");
  });

  it("records structured logs for rejected JSON payloads", async () => {
    if (!handle) {
      throw new Error("HTTP server not started");
    }

    const beforeEvents = eventStore.getEventsByKind("HTTP_ACCESS").length;
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{",
    });
    const json = (await response.json()) as JsonRpcSuccess;

    expect(response.status).to.equal(400);
    expect(json.error?.message).to.equal("Parse error");
    expect(json.error?.code).to.equal(-32700);

    const events = await waitForAccessEvents(beforeEvents + 1);
    const last = events[events.length - 1];
    expect(last.payload).to.include({ route: "/mcp", method: "POST", status: 400 });
  });
});
