import { mkdtemp, access, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { expect } from "chai";
import sinon from "sinon";

import {
  ensureValidationRuntime,
  probeSearx,
  probeUnstructured,
  validateSearchEnvironment,
  verifyHttpHealth,
} from "../../src/validationRun/runtime";

async function directoryExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch (error) {
    return false;
  }
}

describe("validation runtime helpers", () => {
  describe("ensureValidationRuntime", () => {
    it("creates the validation layout and children directory", async () => {
      const sandbox = await mkdtemp(path.join(tmpdir(), "validation-runtime-"));
      const context = await ensureValidationRuntime({ root: sandbox, createChildrenDir: true });

      expect(context.layout.root).to.equal(path.resolve(sandbox));
      expect(await directoryExists(context.layout.logsDir)).to.equal(true);
      expect(await directoryExists(context.layout.runsDir)).to.equal(true);
      expect(await directoryExists(context.layout.snapshotsDir)).to.equal(true);
      expect(await directoryExists(context.layout.reportsDir)).to.equal(true);
      expect(context.env.MCP_RUNS_ROOT).to.equal(context.layout.root);
      expect(context.env.MCP_LOG_FILE).to.equal(path.join(context.layout.logsDir, "self-codex.log"));
      expect(context.childrenDir).to.be.a("string");
      expect(await directoryExists(context.childrenDir!)).to.equal(true);

      await rm(sandbox, { recursive: true, force: true });
      if (context.childrenDir) {
        await rm(context.childrenDir, { recursive: true, force: true });
      }
    });
  });

  describe("validateSearchEnvironment", () => {
    it("flags missing and invalid keys", () => {
      const result = validateSearchEnvironment({
        SEARCH_SEARX_BASE_URL: "http://searx:8080",
        SEARCH_SEARX_API_PATH: "/search",
        SEARCH_SEARX_TIMEOUT_MS: "not-a-number",
        SEARCH_SEARX_ENGINES: "bing",
        SEARCH_SEARX_CATEGORIES: "general",
        UNSTRUCTURED_BASE_URL: "http://unstructured:8000",
        UNSTRUCTURED_TIMEOUT_MS: "30000",
        UNSTRUCTURED_STRATEGY: "hi_res",
        SEARCH_FETCH_TIMEOUT_MS: "20000",
        SEARCH_FETCH_MAX_BYTES: "-1",
        SEARCH_FETCH_UA: "CodexSearchBot/1.0",
        SEARCH_INJECT_GRAPH: "false",
        SEARCH_INJECT_VECTOR: "true",
      });

      expect(result.ok).to.equal(false);
      expect(result.invalidNumericKeys.map((entry) => entry.key)).to.have.members([
        "SEARCH_SEARX_TIMEOUT_MS",
        "SEARCH_FETCH_MAX_BYTES",
      ]);
      expect(result.expectedTrueKeys.map((entry) => entry.key)).to.include("SEARCH_INJECT_GRAPH");
    });

    it("accepts a valid environment", () => {
      const result = validateSearchEnvironment({
        SEARCH_SEARX_BASE_URL: "http://searx:8080",
        SEARCH_SEARX_API_PATH: "/search",
        SEARCH_SEARX_TIMEOUT_MS: "15000",
        SEARCH_SEARX_ENGINES: "bing,ddg",
        SEARCH_SEARX_CATEGORIES: "general,news",
        UNSTRUCTURED_BASE_URL: "http://unstructured:8000",
        UNSTRUCTURED_TIMEOUT_MS: "30000",
        UNSTRUCTURED_STRATEGY: "hi_res",
        SEARCH_FETCH_TIMEOUT_MS: "20000",
        SEARCH_FETCH_MAX_BYTES: "15000000",
        SEARCH_FETCH_UA: "CodexSearchBot/1.0",
        SEARCH_INJECT_GRAPH: "true",
        SEARCH_INJECT_VECTOR: "true",
        SEARCH_FETCH_RESPECT_ROBOTS: "1",
        SEARCH_PARALLEL_FETCH: "4",
        SEARCH_PARALLEL_EXTRACT: "2",
        SEARCH_MAX_RESULTS: "12",
      });

      expect(result.ok).to.equal(true);
      expect(result.recommendations).to.be.empty;
    });
  });

  describe("HTTP probes", () => {
    afterEach(() => {
      sinon.restore();
    });

    it("verifies HTTP health successfully", async () => {
      const fetchImpl: typeof fetch = sinon.stub().resolves(createResponse(200, true));
      const result = await verifyHttpHealth("http://127.0.0.1:8765/mcp/health", {
        expectStatus: 200,
        fetchImpl,
      });

      expect(result.ok).to.equal(true);
      expect(result.statusCode).to.equal(200);
      expect((fetchImpl as unknown as sinon.SinonStub).calledOnce).to.equal(true);
    });

    it("surfaces HTTP health failures", async () => {
      const fetchImpl: typeof fetch = sinon.stub().resolves(createResponse(503, false, "down"));
      const result = await verifyHttpHealth("http://127.0.0.1:8765/mcp/health", {
        expectStatus: 200,
        fetchImpl,
      });

      expect(result.ok).to.equal(false);
      expect(result.statusCode).to.equal(503);
      expect(result.snippet).to.equal("down");
    });

    it("probes Searx and Unstructured endpoints", async () => {
      const searxCalls: string[] = [];
      const searxFetch: typeof fetch = async (input) => {
        searxCalls.push(String(input));
        return createResponse(200, true, JSON.stringify({ results: [] }));
      };

      const unstructuredCalls: string[] = [];
      const unstructuredFetch: typeof fetch = async (input) => {
        unstructuredCalls.push(String(input));
        return createResponse(200, true, JSON.stringify({ status: "ok" }));
      };

      const searxResult = await probeSearx("http://searx:8080", "/search", { fetchImpl: searxFetch });
      const unstructuredResult = await probeUnstructured("http://unstructured:8000", { fetchImpl: unstructuredFetch });

      expect(searxResult.ok).to.equal(true);
      expect(unstructuredResult.ok).to.equal(true);
      expect(searxCalls[0]).to.match(/http:\/\/searx:8080\/search\?q=codex_validation_probe&format=json/);
      expect(unstructuredCalls[0]).to.equal("http://unstructured:8000/health");
    });
  });
});

function createResponse(status: number, ok: boolean, body = ""): Awaited<ReturnType<typeof fetch>> {
  return {
    status,
    ok,
    async text() {
      return body;
    },
  } as Awaited<ReturnType<typeof fetch>>;
}
