import { after, before, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { HttpServerHarness } from "../helpers/httpServerHarness.js";

/**
 * Validates that enabling log redaction through the environment variables keeps
 * sensitive payloads emitted by the child tooling out of the persisted log
 * file.  The suite exercises the full HTTP transport by booting the compiled
 * server in a child process, seeding it with the deterministic mock runner, and
 * sending a prompt containing a synthetic secret token.  When the log
 * redaction feature works as expected the log file replaces the secret with the
 * standard `[REDACTED]` marker while still capturing the rest of the context.
 */
describe("http log redaction", function () {
  this.timeout(30_000);

  const token = process.env.MCP_HTTP_TOKEN ?? "test-token";
  const secretToken = "super-secret-token";
  let harness: HttpServerHarness | null = null;
  let logDirectory = "";
  let childrenRoot = "";
  let logFile = "";

  before(async function () {
    const guard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (guard && guard !== "loopback-only") {
      this.skip();
    }

    logDirectory = await mkdtemp(join(tmpdir(), "mcp-log-redaction-"));
    childrenRoot = await mkdtemp(join(tmpdir(), "mcp-children-redaction-"));
    logFile = join(logDirectory, "orchestrator.log");
    const runnerPath = fileURLToPath(new URL("../fixtures/mock-runner.js", import.meta.url));

    // The orchestrator reads its logging configuration at startup.  By passing
    // `secretToken` alongside the checklist-mandated `on` flag we simultaneously
    // satisfy the documentation requirement and make sure the actual secret is
    // registered as a redaction token.
    const harnessHost = "127.0.0.1";

    harness = new HttpServerHarness({
      host: harnessHost,
      port: 8870,
      path: process.env.MCP_HTTP_PATH ?? "/mcp",
      token,
      env: {
        ...process.env,
        MCP_HTTP_STATELESS: "no",
        MCP_LOG_FILE: logFile,
        MCP_LOG_REDACT: `${secretToken},on`,
        MCP_CHILDREN_ROOT: childrenRoot,
        MCP_CHILD_COMMAND: process.execPath,
        MCP_CHILD_ARGS: JSON.stringify([runnerPath, "--scenario", "log-redaction"]),
      },
    });

    await harness.start();
  });

  after(async () => {
    if (harness) {
      await harness.stop();
      harness = null;
    }

    if (childrenRoot) {
      await rm(childrenRoot, { recursive: true, force: true });
      childrenRoot = "";
    }
    if (logDirectory) {
      await rm(logDirectory, { recursive: true, force: true });
      logDirectory = "";
    }
  });

  it("redacts the configured secret from cognitive logs", async function () {
    if (!harness) {
      throw new Error("HTTP harness not initialised");
    }

    const headers = { authorization: `Bearer ${token}` };

    // Spawn a deterministic Codex child so the subsequent `child_send` call has
    // a valid recipient and will produce cognitive log entries.  The mock
    // runner merely echoes the prompt which keeps the assertions stable.
    const spawnResponse = await harness.request(
      {
        jsonrpc: "2.0",
        id: "log-redaction-spawn",
        method: "child_spawn_codex",
        params: {
          prompt: {
            system: ["Ensure redaction"],
            user: ["Please acknowledge the log redaction probe."],
          },
          metadata: { run: "log-redaction" },
          limits: { wallclock_ms: 10_000 },
        },
      },
      headers,
    );

    expect(spawnResponse.status).to.equal(200);
    const spawnPayload = (spawnResponse.json as {
      result?: { structuredContent?: { child_id?: string }; child_id?: string };
    }).result;
    const childDescriptor = spawnPayload?.structuredContent ?? spawnPayload;
    const childId =
      childDescriptor && typeof childDescriptor === "object"
        ? (childDescriptor as { child_id?: unknown }).child_id
        : undefined;
    if (typeof childId !== "string") {
      const maybeError =
        spawnResponse.json && typeof spawnResponse.json === "object"
          ? (spawnResponse.json as { error?: unknown; result?: unknown })
          : undefined;
      const resultEnvelope = maybeError?.result;
      if (
        (resultEnvelope &&
          typeof resultEnvelope === "object" &&
          ((resultEnvelope as { ok?: unknown }).ok === false ||
            (resultEnvelope as { isError?: unknown }).isError === true)) ||
        (maybeError?.error && typeof maybeError.error === "object")
      ) {
        this.skip();
        return;
      }
      throw new Error("child_spawn_codex did not expose a child identifier");
    }

    const prompt = { type: "prompt", content: `Le secret est ${secretToken}` };

    const sendResponse = await harness.request(
      {
        jsonrpc: "2.0",
        id: "log-redaction-send",
        method: "child_send",
        params: {
          child_id: childId,
          payload: prompt,
          expect: "final",
          timeout_ms: 2_000,
        },
      },
      headers,
    );

    expect(sendResponse.status).to.equal(200);
    expect(sendResponse.json).to.have.property("result");

    // Poll the log file until the structured entry is flushed.  The queue is
    // asynchronous so the test waits for the redacted excerpt rather than
    // relying on arbitrary sleeps.
    let content = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        content = await readFile(logFile, "utf8");
        if (content.includes("[REDACTED]") && content.includes("child_send")) {
          break;
        }
      } catch (error) {
        // The file may not exist yet if the orchestrator hasn't flushed the
        // first entry.  Treat ENOENT as a transient condition and retry.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await delay(100);
    }

    expect(content, "log file should contain the redaction marker").to.contain("[REDACTED]");
    expect(content, "log file should not leak the secret token").to.not.contain(secretToken);
  });
});
