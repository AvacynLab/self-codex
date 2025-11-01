import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  persistSearchScenarioArtefacts,
  readJsonArtefact,
  readNdjsonArtefact,
  type SearchScenarioArtefactBundle,
} from "../../scripts/lib/searchArtifacts.js";
import { type ValidationScenarioDefinition } from "../../src/validationRun/scenario.js";

const TEMP_PREFIX = join(tmpdir(), "search-artifacts-test-");

describe("scripts/lib/searchArtifacts", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (folder) => {
        await rm(folder, { recursive: true, force: true });
      }),
    );
  });

  it("persists the complete artefact bundle under validation_run", async () => {
    const root = await mkdtemp(TEMP_PREFIX);
    tempRoots.push(root);

    const scenario: ValidationScenarioDefinition = {
      id: 42,
      label: "Test scenario",
      slugHint: "unit_test",
      description: "Ensures artefact helper writes every file.",
      input: { foo: "bar" },
    };

    const bundle: SearchScenarioArtefactBundle = {
      input: { probe: "smoke" },
      response: { ok: true, jobId: "job-test" },
      events: [{ seq: 1, ts: 10, kind: "search:job_started" }],
      timings: { tookMs: 120, jobId: "job-test" },
      errors: [],
      kgChanges: [{ subject: "s", predicate: "p", object: "o" }],
      vectorUpserts: [{ id: "chunk-1", token_count: 5 }],
      serverLog: "log line\n",
    };

    const runPaths = await persistSearchScenarioArtefacts(bundle, {
      scenario,
      baseRoot: root,
    });

    await assertFileExists(runPaths.input);
    await assertFileExists(runPaths.response);
    await assertFileExists(runPaths.events);
    await assertFileExists(runPaths.timings);
    await assertFileExists(runPaths.errors);
    await assertFileExists(runPaths.kgChanges);
    await assertFileExists(runPaths.vectorUpserts);
    await assertFileExists(runPaths.serverLog);

    const input = (await readJsonArtefact(runPaths.input)) as Record<string, unknown>;
    expect(input).to.deep.equal(bundle.input);

    const response = (await readJsonArtefact(runPaths.response)) as Record<string, unknown>;
    expect(response).to.deep.equal(bundle.response);

    const events = await readNdjsonArtefact(runPaths.events);
    expect(events).to.deep.equal(bundle.events);

    const timings = (await readJsonArtefact(runPaths.timings)) as Record<string, unknown>;
    expect(timings).to.deep.equal(bundle.timings);

    const errors = (await readJsonArtefact(runPaths.errors)) as unknown[];
    expect(errors).to.deep.equal(bundle.errors);

    const kgChanges = await readNdjsonArtefact(runPaths.kgChanges);
    expect(kgChanges).to.deep.equal(bundle.kgChanges);

    const vectorUpserts = (await readJsonArtefact(runPaths.vectorUpserts)) as unknown[];
    expect(vectorUpserts).to.deep.equal(bundle.vectorUpserts);

    const serverLog = await readFile(runPaths.serverLog, "utf8");
    expect(serverLog).to.equal(bundle.serverLog);
  });
});

async function assertFileExists(filePath: string): Promise<void> {
  const stats = await stat(filePath);
  expect(stats.isFile()).to.equal(true, `expected file at ${filePath}`);
}
