/**
 * Behavioural tests covering the Tool-OS dynamic registry. The suite exercises
 * manual registrations, composite pipelines, manifest persistence and the reload
 * logic triggered when manifests change on disk.
 */
import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  McpServer,
  type CallToolResult,
  type RequestHandlerExtra,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { StructuredLogger } from "../../src/logger.js";
import {
  ToolRegistry,
  ToolRegistrationError,
  getRegisteredToolMap,
  type ToolInvocationExtra,
} from "../../src/mcp/registry.js";

function createExtra(): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId: "test-request",
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error("nested requests are not supported in tests");
    },
    requestInfo: undefined,
  };
}

async function invokeDirectTool(
  server: McpServer,
  tool: string,
  args: unknown,
  extra: ToolInvocationExtra,
): Promise<CallToolResult> {
  const registry = getRegisteredToolMap(server);
  if (!registry || !registry[tool]) {
    throw new Error(`tool ${tool} not registered`);
  }
  const entry = registry[tool];
  if (!entry.enabled) {
    throw new Error(`tool ${tool} disabled`);
  }
  if (entry.inputSchema) {
    const parsed = await entry.inputSchema.parseAsync(args ?? {});
    return await entry.callback(parsed, extra);
  }
  return await entry.callback(extra);
}

describe("mcp/tool registry", () => {
  let runsRoot: string;
  let server: McpServer;
  let registry: ToolRegistry;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), "tool-registry-"));
    server = new McpServer({ name: "registry-test", version: "1.0.0" });
    registry = await ToolRegistry.create({
      server,
      logger: new StructuredLogger(),
      runsRoot,
      clock: () => new Date("2025-01-01T00:00:00.000Z"),
      invokeTool: (name, args, extra) => invokeDirectTool(server, name, args, extra),
    });
  });

  afterEach(async () => {
    registry.close();
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("registers a dynamic tool and exposes its manifest", async () => {
    await registry.register(
      {
        name: "dynamic_echo",
        title: "Dynamic echo",
        description: "Echoes the provided payload.",
        kind: "dynamic",
        tags: ["test"],
        inputs: ["value"],
      },
      async (input) => {
        const payload = { echoed: (input as { value?: string | null })?.value ?? null };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      },
      { inputSchema: { value: z.string().optional() } },
    );

    const manifests = registry.list();
    expect(manifests, "manifest count").to.have.lengthOf(1);
    expect(manifests[0]?.name, "manifest name").to.equal("dynamic_echo");
    expect(manifests[0]?.createdAt, "created timestamp").to.equal("2025-01-01T00:00:00.000Z");

    const result = await registry.call("dynamic_echo", { value: "hello" }, createExtra());
    expect(result.structuredContent).to.deep.equal({ echoed: "hello" });
  });

  it("infers categories and defaults primitive tools to hidden", async () => {
    await registry.register(
      { name: "graph_mutate", title: "Graph mutate", kind: "dynamic" },
      async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }),
    );

    await registry.register(
      { name: "artifact_write_facade", title: "Artifact write facade", kind: "dynamic", tags: ["facade"] },
      async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }),
    );

    const manifests = registry.list();
    const graph = manifests.find((manifest) => manifest.name === "graph_mutate");
    const artifactFacade = manifests.find((manifest) => manifest.name === "artifact_write_facade");

    expect(graph?.category).to.equal("graph");
    expect(graph?.hidden).to.equal(true);
    expect(artifactFacade?.category).to.equal("artifact");
    expect(artifactFacade?.hidden).to.equal(false);
  });

  it("rejects duplicate registrations", async () => {
    await registry.register(
      { name: "duplicate_tool", title: "First", kind: "dynamic" },
      async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }),
    );

    try {
      await registry.register(
        { name: "duplicate_tool", title: "Second", kind: "dynamic" },
        async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }),
      );
      expect.fail("expected ToolRegistrationError");
    } catch (error) {
      expect(error).to.be.instanceOf(ToolRegistrationError);
    }
  });

  it("applies environment overrides to tool manifest budgets", async () => {
    const name = "override_budget_tool";
    const timeKey = "MCP_TOOLS_BUDGET_OVERRIDE_BUDGET_TOOL_TIME_MS";
    const toolCallsKey = "MCP_TOOLS_BUDGET_OVERRIDE_BUDGET_TOOL_TOOL_CALLS";
    const previousTime = process.env[timeKey];
    const previousCalls = process.env[toolCallsKey];
    process.env[timeKey] = "5000";
    process.env[toolCallsKey] = "0";

    try {
      const manifest = await registry.register(
        {
          name,
          title: "Override budgets",
          kind: "dynamic",
          tags: ["facade"],
          budgets: { time_ms: 1200, tool_calls: 1 },
        },
        async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }),
      );

      expect(manifest.budgets?.time_ms).to.equal(5000);
      expect(manifest.budgets?.tool_calls).to.equal(1);

      const listed = registry.list().find((entry) => entry.name === name);
      expect(listed?.budgets?.time_ms).to.equal(5000);
      expect(listed?.budgets?.tool_calls).to.equal(1);
    } finally {
      if (previousTime === undefined) {
        delete process.env[timeKey];
      } else {
        process.env[timeKey] = previousTime;
      }
      if (previousCalls === undefined) {
        delete process.env[toolCallsKey];
      } else {
        process.env[toolCallsKey] = previousCalls;
      }
    }
  });

  it("creates composite pipelines, persists manifests and executes sequentially", async () => {
    await registry.register(
      { name: "stage_one", title: "Stage one", kind: "dynamic" },
      async (input) => {
        const payload = { text: (input as { value?: string })?.value ?? "" };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      },
      { inputSchema: { value: z.string().optional() } },
    );

    await registry.register(
      { name: "stage_two", title: "Stage two", kind: "dynamic" },
      async (input) => {
        const previous = (input as { previous?: { text?: string }; suffix?: string }).previous ?? { text: "" };
        const payload = { combined: `${previous.text ?? ""}${(input as { suffix?: string }).suffix ?? ""}` };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      },
      { inputSchema: { suffix: z.string().optional(), previous: z.record(z.unknown()).optional() } },
    );

    const manifest = await registry.registerComposite({
      name: "pipeline_demo",
      title: "Pipeline demo",
      description: "Two-step pipeline for tests.",
      tags: ["demo"],
      steps: [
        { id: "first", tool: "stage_one", arguments: { value: "hello" } },
        { id: "second", tool: "stage_two", arguments: { suffix: "!" } },
      ],
    });

    const manifestPath = join(runsRoot, "tools", "manifests", "pipeline_demo.json");
    const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(persisted.name).to.equal("pipeline_demo");
    expect(manifest.steps).to.have.lengthOf(2);

    const result = await registry.call("pipeline_demo", {}, createExtra());
    expect(result.structuredContent).to.have.property("steps");
    const summary = result.structuredContent as { steps: Array<{ structured?: { combined?: string } }> };
    const final = summary.steps.at(-1)?.structured as { combined?: string } | undefined;
    expect(final?.combined).to.equal("hello!");
  });

  it("omits undefined composite step summaries", async () => {
    // Register a composite stage that intentionally omits structured payloads
    // so the registry can be asserted to drop undefined summaries.
    await registry.register(
      { name: "noop_stage", title: "Noop stage", kind: "dynamic" },
      async () => ({ structuredContent: null, isError: false }),
    );

    await registry.registerComposite({
      name: "noop_pipeline",
      title: "Noop pipeline",
      steps: [{ id: "noop", tool: "noop_stage" }],
    });

    const result = await registry.call("noop_pipeline", {}, createExtra());
    const summary = result.structuredContent as { steps: Array<Record<string, unknown>> };
    expect(summary.steps).to.have.lengthOf(1);
    const [step] = summary.steps;
    expect(Object.prototype.hasOwnProperty.call(step, "structured"), "structured should stay absent").to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(step, "content"), "content should stay absent").to.equal(false);
  });

  it("reloads persisted manifests from disk", async () => {
    await registry.register(
      { name: "base_tool", title: "Base", kind: "dynamic" },
      async (input) => ({
        content: [{ type: "text", text: JSON.stringify({ previous: input ?? null }) }],
        structuredContent: input,
      }),
      { inputSchema: { value: z.string().optional(), previous: z.record(z.unknown()).optional() } },
    );

    const manifestsDir = join(runsRoot, "tools", "manifests");
    await mkdir(manifestsDir, { recursive: true });
    await writeFile(
      join(manifestsDir, "external.json"),
      `${JSON.stringify(
        {
          name: "external_pipeline",
          title: "External pipeline",
          description: "Loaded from disk",
          version: 1,
          kind: "composite",
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
          steps: [{ id: "only", tool: "base_tool", arguments: { value: "disk" } }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await registry.reloadFromDisk();

    const manifests = registry.list();
    expect(manifests.some((manifest) => manifest.name === "external_pipeline")).to.equal(true);

    const result = await registry.call("external_pipeline", {}, createExtra());
    expect(result.structuredContent).to.have.property("steps");
  });
});

