import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChildSupervisor } from "../src/childSupervisor.js";

const crashyRunnerPath = fileURLToPath(new URL("./fixtures/crashy-runner.js", import.meta.url));

/**
 * Chaos-style regression ensuring a crashing child process is surfaced as an
 * error while the supervisor keeps accepting new children afterwards. The
 * scenario mirrors the "Robustesse" checklist entry from the brief where a
 * worker may disappear mid-plan and the orchestrator must collect outputs,
 * expose telemetry, and continue execution with a fresh child.
 */
describe("robustness: child crash recovery", () => {
  it("records crash metadata and allows spawning a replacement", async function () {
    this.timeout(10_000);

    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-crash-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [crashyRunnerPath],
      idleTimeoutMs: 150,
      idleCheckIntervalMs: 30,
    });

    try {
      const crashingChild = await supervisor.createChild({
        metadata: { scenario: "crash-recovery" },
      });
      expect(crashingChild.readyMessage).to.not.equal(null);

      // Trigger the crash path with a deterministic exit code and label so the
      // assertions can check the propagated metadata precisely.
      const sendResult = await supervisor.send(crashingChild.childId, {
        type: "explode",
        exitCode: 9,
        reason: "unit-test-crash",
      });
      expect(sendResult.messageId).to.include(crashingChild.childId);

      const exit = await supervisor.waitForExit(crashingChild.childId, 2_000);
      expect(exit.code).to.equal(9);
      expect(exit.signal).to.equal(null);
      expect(exit.forced).to.equal(false);

      const crashSnapshot = supervisor.childrenIndex.getChild(crashingChild.childId);
      expect(crashSnapshot).to.not.equal(undefined);
      expect(crashSnapshot?.state).to.equal("error");
      expect(crashSnapshot?.exitCode).to.equal(9);
      expect(crashSnapshot?.forcedTermination).to.equal(false);

      // Collect outputs even after the crash to mimic the post-mortem routine
      // executed by the orchestrator when gathering logs for operators.
      const outputs = await supervisor.collect(crashingChild.childId);
      const fatalMessage = outputs.messages.find((message) => {
        const parsed = message.parsed as { type?: string; reason?: string } | null;
        return parsed?.type === "fatal";
      });
      expect(fatalMessage).to.not.equal(undefined);
      expect(fatalMessage?.parsed).to.include({ type: "fatal", reason: "unit-test-crash" });

      // Spawn a fresh child without clearing the crashed entry to ensure the
      // supervisor still counts capacity correctly under stress.
      const replacement = await supervisor.createChild({
        metadata: { scenario: "replacement" },
      });
      expect(replacement.childId).to.not.equal(crashingChild.childId);
      expect(replacement.readyMessage).to.not.equal(null);

      await supervisor.cancel(replacement.childId, { signal: "SIGINT", timeoutMs: 500 });
      await supervisor.waitForExit(replacement.childId, 2_000);
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
