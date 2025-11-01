import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testing as e2eTesting } from "../scripts/run-search-e2e.ts";

const { persistE2EArtefacts } = e2eTesting;

describe("scripts/run-search-e2e", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (folder) => {
        await rm(folder, { recursive: true, force: true });
      }),
    );
  });

  it("persists the complete artefact bundle for the e2e scenario", async () => {
    const baseRoot = await mkdtemp(join(tmpdir(), "search-e2e-artifacts-"));
    tempRoots.push(baseRoot);

    const startedAt = 1_000;
    const finishedAt = 1_250;
    const composeFile = "/tmp/docker-compose.search.yml";
    const mochaArgs = ["--reporter", "tap", "tests/e2e/search/search_run.e2e.test.ts"] as const;

    await persistE2EArtefacts({
      startedAt,
      finishedAt,
      mochaArgs,
      composeFile,
      validationRootOverride: baseRoot,
    });

    const logsDir = join(baseRoot, "logs");
    const runsDir = join(baseRoot, "runs");
    const scenarioRoot = join(runsDir, "S91_search_e2e");

    await assertDirectoryExists(logsDir);
    await assertDirectoryExists(runsDir);
    await assertDirectoryExists(scenarioRoot);

    const input = JSON.parse(await readFile(join(scenarioRoot, "input.json"), "utf8"));
    expect(input).to.deep.equal({
      mochaArgs: Array.from(mochaArgs),
      composeFile,
    });

    const response = JSON.parse(await readFile(join(scenarioRoot, "response.json"), "utf8"));
    expect(response).to.deep.equal({ ok: true, tookMs: finishedAt - startedAt });

    const events = await readFile(join(scenarioRoot, "events.ndjson"), "utf8");
    expect(events).to.equal("");

    const timings = JSON.parse(await readFile(join(scenarioRoot, "timings.json"), "utf8"));
    expect(timings).to.deep.equal({
      jobId: "search-e2e",
      startedAt,
      completedAt: finishedAt,
      tookMs: finishedAt - startedAt,
      eventCount: 0,
    });

    const errors = JSON.parse(await readFile(join(scenarioRoot, "errors.json"), "utf8"));
    expect(errors).to.deep.equal([]);

    const kgChanges = await readFile(join(scenarioRoot, "kg_changes.ndjson"), "utf8");
    expect(kgChanges).to.equal("");

    const vectorUpserts = JSON.parse(await readFile(join(scenarioRoot, "vector_upserts.json"), "utf8"));
    expect(vectorUpserts).to.deep.equal([]);

    const serverLog = await readFile(join(scenarioRoot, "server.log"), "utf8");
    expect(serverLog).to.include("S91_search_e2e");
    expect(serverLog.endsWith("\n")).to.equal(true);
  });
});

async function assertDirectoryExists(target: string): Promise<void> {
  const stats = await stat(target);
  expect(stats.isDirectory()).to.equal(true, `expected directory at ${target}`);
}
