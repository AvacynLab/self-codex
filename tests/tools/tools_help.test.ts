import { expect } from "chai";
import { z } from "zod";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import type { ToolManifest } from "../../src/mcp/registry.js";
import { StructuredLogger } from "../../src/logger.js";
import { createToolsHelpHandler, type ToolsHelpRegistryView } from "../../src/tools/tools_help.js";

type Extras = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Creates a minimal request context satisfying the MCP handler contract. Tests
 * do not rely on notifications or nested requests so the helpers throw when
 * invoked to surface unexpected behaviours.
 */
function createExtras(requestId: string): Extras {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected during tools_help tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected during tools_help tests");
    },
  } as Extras;
}

/** Builds a deterministic registry view exposing the provided manifests. */
function createRegistryView(
  manifests: ToolManifest[],
  schemas: Record<string, z.ZodObject<any> | undefined>,
): ToolsHelpRegistryView {
  const indexed = new Map(manifests.map((manifest) => [manifest.name, manifest] as const));
  return {
    list: () => manifests,
    listVisible: () => manifests,
    describe: (name) => {
      const manifest = indexed.get(name);
      if (!manifest) {
        return undefined;
      }
      return { manifest, inputSchema: schemas[name] };
    },
  };
}

describe("tools_help facade", () => {
  it("embeds schema-driven examples and error hints for discovery", async () => {
    const nowIso = new Date("2025-01-01T00:00:00Z").toISOString();
    const manifest: ToolManifest = {
      name: "artifact_search",
      title: "Recherche d'artefacts",
      description: "Permet de retrouver des artefacts enregistrés",
      kind: "dynamic",
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      category: "artifact",
      tags: ["facade", "discovery"],
      hidden: false,
      budgets: { time_ms: 4_000, tool_calls: 1, bytes_out: 24_576 },
    };
    const schema = z
      .object({
        query: z.string().min(3),
        tags: z.array(z.enum(["plan", "artifact"])).min(1),
        limit: z.number().int().min(1).max(5).optional(),
      })
      .strict();
    const registry = createRegistryView([manifest], { [manifest.name]: schema });
    const logger = new StructuredLogger();
    const handler = createToolsHelpHandler({ registry, logger });
    const result = await handler({}, createExtras("req-tools-help-1"));

    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.summary).to.equal("1 outil correspondant");

    const [tool] = structured.details.tools as Array<Record<string, any>>;
    expect(tool.name).to.equal("artifact_search");
    expect(tool.example).to.be.an("object");
    expect(tool.example.query).to.be.a("string").with.length.greaterThanOrEqual(3);
    expect(tool.example.tags).to.deep.equal(["plan"]);
    expect(tool.example).to.not.have.property("limit");
    expect(() => schema.parse(tool.example)).to.not.throw();

    expect(tool.common_errors).to.be.an("array").that.is.not.empty;
    expect(tool.common_errors).to.satisfy((errors: string[]) =>
      errors.some((entry) => entry.includes('"payload.query"') && entry.includes("requis")),
    );
    expect(tool.common_errors).to.satisfy((errors: string[]) =>
      errors.some((entry) => entry.includes("payload.tags") && entry.includes("élément")),
    );
  });

  it("gracefully omits examples when no schema is registered", async () => {
    const nowIso = new Date("2025-01-01T00:00:00Z").toISOString();
    const manifest: ToolManifest = {
      name: "runtime_observe",
      title: "Observer le runtime",
      description: "Diffuse les événements runtime récents",
      kind: "dynamic",
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      category: "runtime",
      tags: ["facade"],
      hidden: false,
      budgets: { time_ms: 1_000, tool_calls: 1, bytes_out: 12_288 },
    };
    const registry = createRegistryView([manifest], { runtime_observe: undefined });
    const logger = new StructuredLogger();
    const handler = createToolsHelpHandler({ registry, logger });

    const result = await handler({}, createExtras("req-tools-help-2"));
    const structured = result.structuredContent as Record<string, any>;
    const [tool] = structured.details.tools as Array<Record<string, any>>;
    expect(tool.name).to.equal("runtime_observe");
    expect(tool).to.not.have.property("example");
    expect(tool).to.not.have.property("common_errors");
  });
});
