import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { expect } from "chai";

import {
  captureValidationSnapshots,
  maskEnvValue,
  readResponseBody,
  buildUrl,
} from "../../src/validationRun/snapshots.js";

describe("validationRun/snapshots", () => {
  describe("maskEnvValue", () => {
    it("keeps non-sensitive values intact", () => {
      expect(maskEnvValue("SEARCH_SEARX_BASE_URL", "http://searx")).to.equal("http://searx");
    });

    it("masks secrets while keeping their length", () => {
      expect(maskEnvValue("MCP_HTTP_TOKEN", "abcdef1234567890")).to.equal("abc…90 <redacted 16 chars>");
    });

    it("fully redacts short secrets", () => {
      expect(maskEnvValue("SEARCH_API_KEY", "short")).to.equal("<redacted>");
    });
  });

  describe("buildUrl", () => {
    it("normalises paths and query parameters", () => {
      const url = buildUrl("http://example", "search", { q: "test", format: "json" });
      expect(url.toString()).to.equal("http://example/search?q=test&format=json");
    });
  });

  describe("readResponseBody", () => {
    it("truncates long payloads", async () => {
      const response = new Response("x".repeat(600));
      const content = await readResponseBody(response, 500);
      expect(content).to.match(/\[truncated 100 chars]$/);
      expect(content.length).to.be.lessThan(560);
    });
  });

  describe("captureValidationSnapshots", () => {
    const sandboxRoot = path.join(tmpdir(), "validation-snapshots-test");
    const allocations: string[] = [];

    async function createSandbox(): Promise<string> {
      const directory = await mkdtemp(`${sandboxRoot}-`);
      allocations.push(directory);
      return directory;
    }

    afterEach(async () => {
      while (allocations.length > 0) {
        const directory = allocations.pop();
        if (!directory) {
          break;
        }
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("writes every snapshot artefact", async () => {
      const workdir = await createSandbox();
      const validationRoot = path.join(workdir, "validation_run");

      const env = {
        MCP_RUNS_ROOT: validationRoot,
        MCP_HTTP_TOKEN: "secret-token-value",
        SEARCH_SEARX_BASE_URL: "http://searx.local",
        SEARCH_SEARX_API_PATH: "/search",
        UNSTRUCTURED_BASE_URL: "http://unstructured.local",
      } as NodeJS.ProcessEnv;

      const execStub = async (file: string): Promise<{ stdout: string; stderr: string }> => {
        if (file === "npm") {
          return { stdout: "9.0.0\n", stderr: "" };
        }
        if (file === "git") {
          return { stdout: "abc123\n", stderr: "" };
        }
        throw new Error(`unexpected command: ${file}`);
      };

      const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
        const url = input.toString();
        if (url.includes("searx")) {
          return new Response("{\"status\":\"ok\"}", { status: 200, statusText: "OK" });
        }
        return new Response("pong", { status: 200, statusText: "OK" });
      };

      const result = await captureValidationSnapshots({
        baseRoot: validationRoot,
        env,
        execFile: execStub,
        fetchImpl,
      });

      const envContent = await readFile(result.env, "utf8");
      expect(envContent).to.include("MCP_HTTP_TOKEN=sec…ue <redacted 18 chars>");
      expect(envContent).to.include("MCP_LOG_FILE=");
      expect(envContent.trim().split("\n")).to.satisfy((lines: string[]) =>
        lines.some((line) => line.startsWith("SEARCH_SEARX_BASE_URL")),
      );

      const versionsContent = await readFile(result.versions, "utf8");
      expect(versionsContent).to.include("node:");
      expect(versionsContent).to.include("npm: 9.0.0");

      const gitContent = await readFile(result.git, "utf8");
      expect(gitContent.trim()).to.equal("abc123");

      const searxProbe = await readFile(result.searxProbe, "utf8");
      expect(searxProbe).to.include("status: 200 OK");
      expect(searxProbe).to.include("{\"status\":\"ok\"}");

      const unstructuredProbe = await readFile(result.unstructuredProbe, "utf8");
      expect(unstructuredProbe).to.include("status: 200 OK");
      expect(unstructuredProbe).to.include("pong");
    });

    it("records failures gracefully", async () => {
      const workdir = await createSandbox();
      const validationRoot = path.join(workdir, "validation_run");

      const env = {
        MCP_RUNS_ROOT: validationRoot,
        SEARCH_SEARX_BASE_URL: "http://bad-host",
        UNSTRUCTURED_BASE_URL: "http://bad-host",
      } as NodeJS.ProcessEnv;

      const execStub = async (file: string): Promise<{ stdout: string; stderr: string }> => {
        if (file === "npm") {
          throw new Error("npm missing");
        }
        throw new Error(`unknown command: ${file}`);
      };

      const fetchImpl = async (): Promise<Response> => {
        throw new Error("network offline");
      };

      const result = await captureValidationSnapshots({
        baseRoot: validationRoot,
        env,
        execFile: execStub,
        fetchImpl,
      });

      const versionsContent = await readFile(result.versions, "utf8");
      expect(versionsContent).to.match(/npm: npm missing/);

      const gitContent = await readFile(result.git, "utf8");
      expect(gitContent).to.include("N/A");

      const searxProbe = await readFile(result.searxProbe, "utf8");
      expect(searxProbe).to.include("probe failed: network offline");

      const unstructuredProbe = await readFile(result.unstructuredProbe, "utf8");
      expect(unstructuredProbe).to.include("probe failed: network offline");
    });

    it("annotates recommended environment overrides when values differ", async () => {
      const workdir = await createSandbox();
      const validationRoot = path.join(workdir, "validation_run");

      const env = {
        MCP_RUNS_ROOT: path.join(workdir, "legacy_runs"),
      } as NodeJS.ProcessEnv;

      const execStub = async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: "10.0.0\n", stderr: "" });

      const fetchImpl = async (): Promise<Response> => new Response("pong", { status: 200, statusText: "OK" });

      const result = await captureValidationSnapshots({
        baseRoot: validationRoot,
        env,
        execFile: execStub,
        fetchImpl,
      });

      const envContent = await readFile(result.env, "utf8");
      expect(envContent).to.include("MCP_RUNS_ROOT=" + env.MCP_RUNS_ROOT);
      expect(envContent).to.match(/# recommended MCP_RUNS_ROOT=/);
    });
  });
});
