import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../../src/httpServer.js";
import {
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
  handleJsonRpc,
  routeJsonRpcRequest,
} from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";
import { StructuredLogger } from "../../src/logger.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "../helpers/http.js";

/**
 * Ensures the conversational child tools expose structured payloads. The e2e
 * suite exercises both the in-process JSON-RPC router and the HTTP fast-path so
 * regressions affecting either transport are caught.
 */
describe("child conversational tools", () => {
  const logger = new StructuredLogger();
  let originalFeatures: FeatureToggles;
  const originalEnv: Record<string, string | undefined> = {};

  before(() => {
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableChildOpsFine: true, enableEventsBus: true });

    originalEnv.MCP_HTTP_STATELESS = process.env.MCP_HTTP_STATELESS;
    // The CI environment does not ship an actual Codex child binary which means spawning a
    // process-backed runtime would block until the ready handshake times out.  Opting into the
    // HTTP loopback mode gives us a logical child whose pending payloads are still routed through
    // the full JSON-RPC stack without depending on an external executable.
    process.env.MCP_HTTP_STATELESS = "yes";
  });

  after(async () => {
    configureRuntimeFeatures(originalFeatures);
    process.env.MCP_HTTP_STATELESS = originalEnv.MCP_HTTP_STATELESS;
    await childProcessSupervisor.disposeAll();
  });

  afterEach(async () => {
    await childProcessSupervisor.disposeAll();
  });

  it("returns structured pending payloads for child_chat", async () => {
    configureRuntimeFeatures({
      ...getRuntimeFeatures(),
      enableChildOpsFine: true,
      enableEventsBus: true,
    });

    const spawn = (await routeJsonRpcRequest("child_spawn_codex", {
      prompt: { system: ["chat"] },
    })) as { child_id: string };

    const chatResult = (await routeJsonRpcRequest("child_chat", {
      child_id: spawn.child_id,
      content: "Ping",
    })) as { pending_id: string; child_id: string; role: string; content: string };

    expect(chatResult.pending_id).to.be.a("string").that.is.not.empty;
    expect(chatResult.child_id).to.equal(spawn.child_id);
    expect(chatResult.role).to.equal("user");
    expect(chatResult.content).to.equal("Ping");

    const httpRequest = createJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: "child-chat-http",
        method: "tools/call",
        params: { name: "child_chat", arguments: { child_id: spawn.child_id, content: "Pong" } },
      },
      {
        "content-type": "application/json",
        accept: "application/json",
      },
    );
    const httpResponse = new MemoryHttpResponse();

    const handled = await __httpServerInternals.tryHandleJsonRpc(
      httpRequest,
      httpResponse,
      logger,
      async (payload, context) => handleJsonRpc(payload, context),
    );

    expect(handled, "HTTP handler should accept child_chat").to.equal(true);
    const json = JSON.parse(httpResponse.body) as {
      result?: {
        structuredContent?: { pending_id?: string; child_id?: string; role?: string; content?: string };
        content?: Array<{ text?: string }>;
      };
    };

    expect(json.result?.structuredContent?.child_id).to.equal(spawn.child_id);
    expect(json.result?.structuredContent?.pending_id).to.be.a("string").that.is.not.empty;
    expect(json.result?.structuredContent?.content).to.equal("Pong");
    expect(json.result?.structuredContent?.role).to.equal("user");

    const textPayload = json.result?.content?.[0]?.text;
    expect(textPayload, "textual payload").to.be.a("string");
    const parsed = JSON.parse(textPayload!);
    expect(parsed).to.include({ child_id: spawn.child_id, content: "Pong", role: "user" });
    expect(parsed.pending_id).to.be.a("string").that.is.not.empty;
  });

  it("returns structured pending payloads for child_prompt", async () => {
    configureRuntimeFeatures({
      ...getRuntimeFeatures(),
      enableChildOpsFine: true,
      enableEventsBus: true,
    });

    const spawn = (await routeJsonRpcRequest("child_spawn_codex", {
      prompt: { system: ["prompt"] },
    })) as { child_id: string };

    const promptResult = (await routeJsonRpcRequest("child_prompt", {
      child_id: spawn.child_id,
      messages: [{ role: "user", content: "Hello" }],
    })) as { pending_id: string; child_id: string; appended: number };

    expect(promptResult.pending_id).to.be.a("string").that.is.not.empty;
    expect(promptResult.child_id).to.equal(spawn.child_id);
    expect(promptResult.appended).to.equal(1);

    const httpRequest = createJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: "child-prompt-http",
        method: "tools/call",
        params: {
          name: "child_prompt",
          arguments: { child_id: spawn.child_id, messages: [{ role: "user", content: "World" }] },
        },
      },
      {
        "content-type": "application/json",
        accept: "application/json",
      },
    );
    const httpResponse = new MemoryHttpResponse();

    const handled = await __httpServerInternals.tryHandleJsonRpc(
      httpRequest,
      httpResponse,
      logger,
      async (payload, context) => handleJsonRpc(payload, context),
    );

    expect(handled, "HTTP handler should accept child_prompt").to.equal(true);
    const json = JSON.parse(httpResponse.body) as {
      result?: {
        structuredContent?: { pending_id?: string; child_id?: string; appended?: number };
        content?: Array<{ text?: string }>;
      };
    };

    expect(json.result?.structuredContent?.child_id).to.equal(spawn.child_id);
    expect(json.result?.structuredContent?.pending_id).to.be.a("string").that.is.not.empty;
    expect(json.result?.structuredContent?.appended).to.equal(1);

    const textPayload = json.result?.content?.[0]?.text;
    expect(textPayload, "textual payload").to.be.a("string");
    const parsed = JSON.parse(textPayload!);
    expect(parsed).to.include({ child_id: spawn.child_id, appended: 1 });
    expect(parsed.pending_id).to.be.a("string").that.is.not.empty;
  });
});
