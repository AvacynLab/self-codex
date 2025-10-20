import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { ChildSupervisor } from "../src/children/supervisor.js";
import { StructuredLogger } from "../src/logger.js";
import { handleChildSpawnCodex } from "../src/tools/childTools.js";
import type { ChildToolContext } from "../src/tools/childTools.js";
import { IdempotencyRegistry } from "../src/infra/idempotency.js";

describe("child_spawn_codex HTTP descriptor", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let childrenRoot: string;
  let supervisor: ChildSupervisor;

  beforeEach(async () => {
    for (const key of [
      "MCP_HTTP_STATELESS",
      "MCP_HTTP_HOST",
      "MCP_HTTP_PORT",
      "MCP_HTTP_PATH",
      "MCP_HTTP_TOKEN",
    ]) {
      originalEnv[key] = process.env[key];
    }
    process.env.MCP_HTTP_STATELESS = "yes";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = "8123";
    process.env.MCP_HTTP_PATH = "/mcp";
    process.env.MCP_HTTP_TOKEN = "test-token";

    childrenRoot = await mkdtemp(join(tmpdir(), "http-child-"));
    supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultEnv: process.env,
    });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await supervisor.disposeAll();
    await rm(childrenRoot, { recursive: true, force: true });
  });

  it("registers a logical child that reuses the HTTP endpoint", async () => {
    const context: ChildToolContext = {
      supervisor,
      logger: new StructuredLogger(),
      idempotency: new IdempotencyRegistry(),
    };

    const result = await handleChildSpawnCodex(context, {
      prompt: { system: "You route JSON-RPC calls." },
      limits: { wallMs: 1000 },
      role: "http-child",
    });

    expect(result.idempotent).to.equal(false);
    expect(result.endpoint).to.not.equal(null);
    const endpoint = result.endpoint!;
    expect(endpoint.url).to.equal("http://127.0.0.1:8123/mcp");
    expect(endpoint.headers).to.include({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer test-token",
    });
    expect(endpoint.headers["x-child-id"]).to.equal(result.child_id);
    expect(endpoint.headers).to.have.property("x-child-limits");

    const snapshot = supervisor.childrenIndex.getChild(result.child_id);
    expect(snapshot).to.not.equal(undefined);
    expect(snapshot?.role).to.equal("http-child");
    const metadata = snapshot?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.transport).to.equal("http");
    expect((metadata?.endpoint as { url?: string } | undefined)?.url).to.equal(endpoint.url);
    expect(result.runtime_status.command).to.equal("http-loopback");
    expect(result.runtime_status.pid).to.equal(-1);

    supervisor.gc(result.child_id);
  });

  it("normalises the HTTP descriptor when overrides contain whitespace", async () => {
    process.env.MCP_HTTP_STATELESS = "true";
    process.env.MCP_HTTP_HOST = "   ";
    process.env.MCP_HTTP_PORT = "not-a-number";
    process.env.MCP_HTTP_PATH = "child-endpoint";
    delete process.env.MCP_HTTP_TOKEN;

    const context: ChildToolContext = {
      supervisor,
      logger: new StructuredLogger(),
      idempotency: new IdempotencyRegistry(),
    };

    const result = await handleChildSpawnCodex(context, {
      prompt: { system: "Bridge requests." },
      limits: null,
    });

    expect(result.endpoint).to.not.equal(null);
    const endpoint = result.endpoint!;
    expect(endpoint.url).to.equal("http://127.0.0.1:8765/child-endpoint");
    expect(endpoint.headers.authorization).to.equal(undefined);
    expect(endpoint.headers.accept).to.equal("application/json");
    expect(endpoint.headers["content-type"]).to.equal("application/json");

    supervisor.gc(result.child_id);
  });
});
