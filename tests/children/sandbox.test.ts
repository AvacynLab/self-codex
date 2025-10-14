import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it } from "mocha";

import { prepareChildSandbox } from "../../src/children/sandbox.js";
import { childWorkspacePath, ensureDirectory } from "../../src/paths.js";
import type { ProcessEnv } from "../../src/nodePrimitives.js";

/** Utility creating a deterministic child root for the sandbox tests. */
async function createSandboxRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "sandbox-test-"));
}

describe("child sandbox", () => {
  it("enforces memory ceilings and sanitises the environment", async () => {
    const root = await createSandboxRoot();
    const baseEnv: ProcessEnv = {
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: "--enable-source-maps",
      SECRET_TOKEN: "should_be_removed",
    } as ProcessEnv;

    const prepared = await prepareChildSandbox({
      childId: "child-sandbox-1",
      childrenRoot: root,
      baseEnv,
      request: { profile: "strict" },
      defaults: { allowEnv: ["PATH"] },
      memoryLimitMb: 128,
    });

    assert.equal(prepared.profile, "strict");
    assert.equal(prepared.env.SECRET_TOKEN, undefined);
    assert.equal(prepared.env.MCP_CHILD_ID, "child-sandbox-1");
    assert.equal(prepared.metadata.max_old_space_mb, 128);

    const workdir = childWorkspacePath(root, "child-sandbox-1");
    assert.equal(prepared.env.HOME, workdir);
    assert.equal(prepared.env.TMPDIR, childWorkspacePath(root, "child-sandbox-1", "tmp"));

    const nodeOptions = prepared.env.NODE_OPTIONS ?? "";
    const tokens = nodeOptions.split(/\s+/).filter(Boolean);
    assert.ok(tokens.includes("--no-addons"), "should disable native addons");
    assert.ok(tokens.includes("--frozen-intrinsics"), "should freeze intrinsics");
    assert.ok(tokens.includes("--disable-proto=throw"), "should disable __proto__ access");
    assert.ok(tokens.includes("--enable-source-maps"), "should preserve source-map flag");
    assert.ok(
      tokens.includes("--max-old-space-size=128"),
      "should enforce the requested memory ceiling",
    );
  });

  it("denies access to network modules under the strict profile", async () => {
    const root = await createSandboxRoot();
    const childId = "child-sandbox-net";
    const prepared = await prepareChildSandbox({
      childId,
      childrenRoot: root,
      baseEnv: { PATH: process.env.PATH ?? "" } as ProcessEnv,
      request: { profile: "strict" },
      defaults: {},
      memoryLimitMb: 256,
    });

    await ensureDirectory(root, childId, "scripts");
    const scriptPath = childWorkspacePath(root, childId, "scripts", "net-denied.cjs");
    await writeFile(
      scriptPath,
      "try { require('node:http'); } catch (error) { console.error(error.code || error.message); throw error; }",
      "utf8",
    );

    const execution = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd: childWorkspacePath(root, childId),
        env: prepared.env,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        resolve({ code, stderr });
      });
    });

    assert.notEqual(execution.code, 0, "network access should fail under the strict profile");
    assert.match(
      execution.stderr,
      /ERR_SANDBOX_DENIED/,
      "denied network modules should surface a dedicated error code",
    );
  });

  it("allows explicit environment opt-ins", async () => {
    const root = await createSandboxRoot();
    const baseEnv: ProcessEnv = {
      PATH: process.env.PATH ?? "",
      ALLOWED_SECRET: "42",
    } as ProcessEnv;

    const prepared = await prepareChildSandbox({
      childId: "child-sandbox-allow",
      childrenRoot: root,
      baseEnv,
      request: { profile: "standard", allowEnv: ["ALLOWED_SECRET"] },
      defaults: {},
      memoryLimitMb: null,
    });

    assert.equal(prepared.profile, "standard");
    assert.equal(prepared.env.ALLOWED_SECRET, "42");
    assert.ok(
      prepared.metadata.allowed_env.includes("ALLOWED_SECRET"),
      "metadata should record explicit environment allowances",
    );
  });
});
