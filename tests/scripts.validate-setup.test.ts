import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

/**
 * Validate that `scripts/validate-setup.mjs` emits the expected artefacts when
 * operating in deterministic fixture mode.  The script should generate a
 * timestamped directory with logs, reports, and HTTP probe archives mirroring
 * the manual verification steps required by checklist section A.
 */
describe("validate-setup utility", function () {
  this.timeout(10_000);

  it("creates setup validation fixtures in test mode", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "validate-setup-"));
    const fakeHome = await mkdtemp(join(tmpdir(), "validate-home-"));
    try {
      const scriptPath = resolve("scripts/validate-setup.mjs");
      const child = spawn(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          CODEX_VALIDATE_SETUP_TEST: "1",
          VALIDATE_SETUP_ROOT: sandbox,
          HOME: fakeHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const [exitCode] = await once(child, "exit");
      expect(exitCode, "validate-setup exit code").to.equal(0);

      const entries = await readdir(sandbox);
      const runFolder = entries.find((entry) => entry.startsWith("setup_"));
      expect(runFolder, "setup directory").to.not.equal(undefined);
      const runRoot = join(sandbox, runFolder ?? "");

      const logStats = await stat(join(runRoot, "logs"));
      const reportStats = await stat(join(runRoot, "report"));
      const artifactsStats = await stat(join(runRoot, "artifacts"));
      expect(logStats.isDirectory(), "logs directory").to.equal(true);
      expect(reportStats.isDirectory(), "report directory").to.equal(true);
      expect(artifactsStats.isDirectory(), "artifacts directory").to.equal(true);

      const summaryRaw = await readFile(join(runRoot, "report/summary.json"), "utf8");
      const summaryMarkdown = await readFile(join(runRoot, "report/summary.md"), "utf8");
      const setupLog = await readFile(join(runRoot, "logs/setup.log"), "utf8");
      const probeAuthorized = await readFile(
        join(runRoot, "artifacts/http/probe-authorized.json"),
        "utf8",
      );
      const probeUnauthorized = await readFile(
        join(runRoot, "artifacts/http/probe-unauthorized.json"),
        "utf8",
      );
      const stdioSnapshot = await readFile(join(runRoot, "artifacts/stdio-config.toml"), "utf8");

      const summary = JSON.parse(summaryRaw) as {
        testMode?: boolean;
        setup: { exitCode: number; durationMs: number };
        http: { authorized: { status: number }; unauthorized: { status: number } };
        stdio: { matches: boolean };
      };

      expect(summary.testMode, "summary testMode flag").to.equal(true);
      expect(summary.setup.exitCode, "setup exit code").to.equal(0);
      expect(summary.http.authorized.status, "authorized status").to.equal(200);
      expect(summary.http.unauthorized.status, "unauthorized status").to.equal(401);
      expect(summary.stdio.matches, "stdio matches flag").to.equal(true);

      expect(summaryMarkdown, "summary markdown header").to.include("# Setup validation report");
      expect(setupLog.trim().length, "setup log contents").to.be.greaterThan(0);
      expect(JSON.parse(probeAuthorized), "authorized probe payload").to.be.an("object");
      expect(JSON.parse(probeUnauthorized), "unauthorized probe payload").to.be.an("object");
      expect(stdioSnapshot.trim().length, "stdio snapshot contents").to.be.greaterThan(0);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
