import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectHttpEnvironment,
  ensureRunStructure,
  type HttpCheckRequestSnapshot,
  type HttpCheckSnapshot,
} from "../../src/validation/runSetup.js";
import {
  SECURITY_JSONL_FILES,
  buildDefaultSecurityCalls,
  runSecurityPhase,
} from "../../src/validation/security.js";

/** Helper capturing rejection expectations without chai-as-promised. */
async function expectSecurityFailure(action: () => Promise<unknown>, messageFragment: string): Promise<void> {
  try {
    await action();
    expect.fail("Stage 11 validation devait échouer");
  } catch (error) {
    expect((error as Error).message).to.contain(messageFragment);
  }
}

/**
 * Unit tests covering the Stage 11 security validation workflow. The suite
 * focuses on deterministic artefact generation so operators can quickly
 * audit the redaction, authentication, and filesystem probes.
 */
describe("security validation", () => {
  let workingDir: string;
  let runRoot: string;
  const environment = collectHttpEnvironment({
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: "9001",
    MCP_HTTP_PATH: "/mcp",
    MCP_HTTP_TOKEN: "token",
  } as NodeJS.ProcessEnv);

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-security-"));
    runRoot = await ensureRunStructure(workingDir, "validation_test");
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("executes the default call plan and surfaces redaction insights", async () => {
    const requests: HttpCheckRequestSnapshot[] = [];
    const responses = [
      {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", error: { code: 401, message: "missing token" } },
      },
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          result: { ok: true, events: [{ type: "log", message: "probe:[redacted]" }] },
        },
      },
      {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", error: { code: 403, message: "path rejected" } },
      },
    ];

    let callIndex = 0;
    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => {
      requests.push(request);
      const response = responses[callIndex];
      const snapshot: HttpCheckSnapshot = {
        name,
        startedAt: new Date(2024, 0, 1, 0, 0, callIndex).toISOString(),
        durationMs: 20 + callIndex,
        request,
        response,
      };
      callIndex += 1;
      return snapshot;
    };

    const result = await runSecurityPhase(runRoot, environment, {}, { httpCheck });

    expect(result.outcomes).to.have.lengthOf(3);
    expect(requests[0]?.headers.authorization).to.be.undefined;
    expect(requests[1]?.headers.authorization).to.equal("Bearer token");

    const inputsContent = await readFile(join(runRoot, SECURITY_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(runRoot, SECURITY_JSONL_FILES.outputs), "utf8");
    const eventsContent = await readFile(join(runRoot, SECURITY_JSONL_FILES.events), "utf8");

    const inputLines = inputsContent.trim().split("\n");
    const outputLines = outputsContent.trim().split("\n");
    expect(inputLines).to.have.lengthOf(3);
    expect(outputLines).to.have.lengthOf(3);
    expect(eventsContent).to.contain("probe:[redacted]");
    expect(eventsContent).not.to.contain("SECRET-TOKEN-123");

    expect(result.summaryPath).to.equal(join(runRoot, "report", "security_summary.json"));
    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.redaction.secret).to.equal("SECRET-TOKEN-123");
    expect(summaryDocument.redaction.calls[0].leakedInResponse).to.equal(false);
    expect(summaryDocument.redaction.calls[0].leakedInEvents).to.equal(false);
    expect(summaryDocument.unauthorized.calls[0].status).to.equal(401);
    expect(summaryDocument.pathValidation.calls[0].attemptedPath).to.equal("../../etc/passwd");
  });

  it("exposes knobs to customise the default call plan", () => {
    const calls = buildDefaultSecurityCalls({
      secretText: "custom-secret",
      unauthorizedMethod: "mcp/custom-info",
      redactionTool: "custom-echo",
      pathTool: "fs/custom-write",
      pathAttempt: "../escape.txt",
    });

    expect(calls[0]?.method).to.equal("mcp/custom-info");
    expect(calls[1]?.params).to.deep.equal({
      name: "custom-echo",
      arguments: { text: "probe:custom-secret" },
    });
    expect(calls[2]?.pathProbe?.attemptedPath).to.equal("../escape.txt");
  });

  it("fails when the unauthorized probe is accepted", async () => {
    const responses = [
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", result: { ok: true } },
      },
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", result: { ok: true } },
      },
      {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", error: { code: 403, message: "path rejected" } },
      },
    ];

    let callIndex = 0;
    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => {
      const snapshot: HttpCheckSnapshot = {
        name,
        startedAt: new Date(2024, 0, 2, 0, 0, callIndex).toISOString(),
        durationMs: 15 + callIndex,
        request,
        response: responses[callIndex]!,
      };
      callIndex += 1;
      return snapshot;
    };

    await expectSecurityFailure(
      () => runSecurityPhase(runRoot, environment, {}, { httpCheck }),
      "401/403",
    );
  });

  it("fails when the synthetic secret leaks in responses or events", async () => {
    const responses = [
      {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", error: { code: 401, message: "missing token" } },
      },
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          result: { ok: true, events: [{ type: "log", message: "probe:SECRET-TOKEN-123" }] },
        },
      },
      {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", error: { code: 403, message: "path rejected" } },
      },
    ];

    let callIndex = 0;
    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => {
      const snapshot: HttpCheckSnapshot = {
        name,
        startedAt: new Date(2024, 0, 2, 1, 0, callIndex).toISOString(),
        durationMs: 25 + callIndex,
        request,
        response: responses[callIndex]!,
      };
      callIndex += 1;
      return snapshot;
    };

    await expectSecurityFailure(
      () => runSecurityPhase(runRoot, environment, {}, { httpCheck }),
      "secret synthétique",
    );
  });

  it("fails when the filesystem probe is not rejected", async () => {
    const responses = [
      {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", error: { code: 401, message: "missing token" } },
      },
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", result: { ok: true } },
      },
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", result: { ok: true } },
      },
    ];

    let callIndex = 0;
    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => {
      const snapshot: HttpCheckSnapshot = {
        name,
        startedAt: new Date(2024, 0, 2, 2, 0, callIndex).toISOString(),
        durationMs: 35 + callIndex,
        request,
        response: responses[callIndex]!,
      };
      callIndex += 1;
      return snapshot;
    };

    await expectSecurityFailure(
      () => runSecurityPhase(runRoot, environment, {}, { httpCheck }),
      "rejet (>=400)",
    );
  });
});
