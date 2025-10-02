import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ChildSupervisor,
  ChildLimitExceededError,
} from "../src/childSupervisor.js";
import { handleChildCreate } from "../src/tools/childTools.js";
import type { ChildToolContext } from "../src/tools/childTools.js";
import { StructuredLogger } from "../src/logger.js";
import {
  configureChildSafetyLimits,
  getChildSafetyLimits,
} from "../src/server.js";

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));

function createSupervisorOptions(childrenRoot: string, overrides: { maxChildren: number; memoryLimitMb: number; cpuPercent: number }) {
  return {
    childrenRoot,
    defaultCommand: process.execPath,
    defaultArgs: [mockRunnerPath],
    defaultEnv: process.env,
    safety: {
      maxChildren: overrides.maxChildren,
      memoryLimitMb: overrides.memoryLimitMb,
      cpuPercent: overrides.cpuPercent,
    },
  } as const;
}

describe("operational safety limits", function () {
  this.timeout(10_000);
  let originalSafety = getChildSafetyLimits();

  beforeEach(() => {
    originalSafety = getChildSafetyLimits();
  });

  afterEach(() => {
    configureChildSafetyLimits(originalSafety);
  });

  it("refuse de dépasser le nombre maximal d'enfants actifs", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "safety-max-"));
    const supervisor = new ChildSupervisor(
      createSupervisorOptions(childrenRoot, { maxChildren: 1, memoryLimitMb: 64, cpuPercent: 50 }),
    );

    try {
      // First child fits under the safety cap.
      await supervisor.createChild();

      let error: unknown = null;
      try {
        // Second spawn attempt should exceed the configured maximum.
        await supervisor.createChild();
      } catch (err) {
        error = err;
      }

      expect(error).to.be.instanceOf(ChildLimitExceededError);
      if (error instanceof ChildLimitExceededError) {
        expect(error.maxChildren).to.equal(1);
        expect(error.activeChildren).to.equal(1);
      }
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("annote le manifeste avec les limites mémoire et CPU configurées", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "safety-manifest-"));
    const supervisor = new ChildSupervisor(
      createSupervisorOptions(childrenRoot, { maxChildren: 2, memoryLimitMb: 128, cpuPercent: 60 }),
    );

    try {
      // The manifest should mirror the configured ceilings so monitoring tools
      // can reason about the expected footprint of the child.
      const created = await supervisor.createChild();
      const manifestRaw = await readFile(created.runtime.manifestPath, "utf8");
      const manifest = JSON.parse(manifestRaw) as { limits?: Record<string, unknown> };
      expect(manifest.limits).to.deep.include({ memory_mb: 128, cpu_percent: 60 });
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("expose des garde-fous reconfigurables côté serveur", async () => {
    const logger = new StructuredLogger();
    const original = getChildSafetyLimits();
    const next = {
      maxChildren: original.maxChildren + 1,
      memoryLimitMb: original.memoryLimitMb + 128,
      cpuPercent: Math.max(10, original.cpuPercent - 20),
    };

    // Reconfigure the global safety guardrails to ensure the helpers expose
    // the freshly applied values to downstream tooling.
    configureChildSafetyLimits(next);

    expect(getChildSafetyLimits()).to.deep.equal(next);

    const toolRoot = await mkdtemp(path.join(tmpdir(), "safety-tool-"));
    const supervisor = new ChildSupervisor(createSupervisorOptions(toolRoot, next));
    const context: ChildToolContext = { supervisor, logger };

    try {
      const first = await handleChildCreate(context, { wait_for_ready: false });
      expect(first.child_id).to.be.a("string");
    } finally {
      await supervisor.disposeAll();
      await rm(toolRoot, { recursive: true, force: true });
    }
  });
});
