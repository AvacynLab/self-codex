import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ChildSupervisor } from "../src/childSupervisor.js";
import {
  ChildAttachInputSchema,
  ChildSetLimitsInputSchema,
  ChildSetRoleInputSchema,
  ChildSpawnCodexInputSchema,
  ChildToolContext,
  handleChildAttach,
  handleChildSetLimits,
  handleChildSetRole,
  handleChildSpawnCodex,
} from "../src/tools/childTools.js";
import { StructuredLogger } from "../src/logger.js";
import { resolveFixture, runnerArgs } from "./helpers/childRunner.js";

const mockRunnerPath = resolveFixture(import.meta.url, "./fixtures/mock-runner.ts");
const mockRunnerArgs = (...extra: string[]): string[] => runnerArgs(mockRunnerPath, ...extra);

describe("child spawn/attach/limits tools", function () {
  this.timeout(15_000);

  it("spawns a codex child, updates role and limits, then refreshes the manifest", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-spawn-codex-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs("--role", "friendly"),
      idleTimeoutMs: 200,
      idleCheckIntervalMs: 40,
    });
    const logFile = path.join(childrenRoot, "spawn-tools.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger };

    try {
      const spawnInput = ChildSpawnCodexInputSchema.parse({
        role: "planner",
        prompt: { system: "Tu es un copilote.", user: ["Analyse le plan"] },
        limits: { tokens: 2048, wallclock_ms: 30_000 },
        model_hint: "gpt-test",
        idempotency_key: "spawn-1",
      });

      const spawned = await handleChildSpawnCodex(context, spawnInput);

      expect(spawned.op_id).to.be.a("string");
      expect(spawned.child_id).to.match(/^child-\d{13}-[a-f0-9]{6}$/);
      expect(spawned.role).to.equal("planner");
      expect(spawned.limits).to.deep.equal({ tokens: 2048, wallclock_ms: 30_000 });
      expect(spawned.idempotent).to.equal(false);
      expect(spawned.index_snapshot.role).to.equal("planner");
      expect(spawned.index_snapshot.limits).to.deep.equal({ tokens: 2048, wallclock_ms: 30_000 });

      const manifestRaw = await readFile(spawned.manifest_path, "utf8");
      const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
      const manifestMetadata = manifest.metadata as { op_id?: unknown } | undefined;
      const manifestOpId = (manifestMetadata?.op_id ?? (manifest as { op_id?: unknown }).op_id) as string | undefined;
      expect(manifestOpId).to.equal(spawned.op_id);
      expect(manifest.role).to.equal("planner");
      expect(manifest.limits).to.deep.equal({ tokens: 2048, wallclock_ms: 30_000 });
      expect(manifest.prompt).to.deep.equal(spawnInput.prompt);

      const roleUpdate = ChildSetRoleInputSchema.parse({
        child_id: spawned.child_id,
        role: "reviewer",
        manifest_extras: { updated_by: "test" },
      });
      const roleResult = await handleChildSetRole(context, roleUpdate);
      expect(roleResult.role).to.equal("reviewer");
      expect(roleResult.index_snapshot.role).to.equal("reviewer");

      const limitsUpdate = ChildSetLimitsInputSchema.parse({
        child_id: spawned.child_id,
        limits: { tokens: 1024 },
        manifest_extras: { note: "tight-budget" },
      });
      const limitsResult = await handleChildSetLimits(context, limitsUpdate);
      expect(limitsResult.limits).to.deep.equal({ tokens: 1024 });
      expect(limitsResult.index_snapshot.limits).to.deep.equal({ tokens: 1024 });

      const manifestAfterLimits = JSON.parse(await readFile(spawned.manifest_path, "utf8")) as Record<string, unknown>;
      expect(manifestAfterLimits.role).to.equal("reviewer");
      expect(manifestAfterLimits.limits).to.deep.equal({ tokens: 1024 });
      expect(manifestAfterLimits.updated_by).to.equal("test");
      expect(manifestAfterLimits.note).to.equal("tight-budget");

      const attachInput = ChildAttachInputSchema.parse({
        child_id: spawned.child_id,
        manifest_extras: { refresh: true },
      });
      const attachResult = await handleChildAttach(context, attachInput);
      expect(attachResult.attached_at).to.be.a("number");
      const manifestAfterAttach = JSON.parse(await readFile(spawned.manifest_path, "utf8")) as Record<string, unknown>;
      expect(manifestAfterAttach.refresh).to.equal(true);

      await supervisor.cancel(spawned.child_id, { signal: "SIGINT", timeoutMs: 200 });
      await supervisor.waitForExit(spawned.child_id, 1000);
    } finally {
      await supervisor.disposeAll();
      await logger.flush();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});

