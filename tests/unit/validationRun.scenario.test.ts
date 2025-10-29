import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  formatScenarioSlug,
  initialiseScenarioRun,
  initialiseAllScenarios,
  initialiseScenarioRerun,
  VALIDATION_SCENARIOS,
  SCENARIO_ARTEFACT_FILENAMES,
  formatScenarioIterationSlug,
} from "../../src/validationRun/scenario.js";
import { ensureValidationRunLayout } from "../../src/validationRun/layout.js";

/**
 * Validates the scenario scaffolding helpers ensuring they respect the
 * conventions from the validation checklist. The tests operate on temporary
 * directories to avoid polluting the repository while still exercising the file
 * system side-effects that operators rely on.
 */
describe("validationRun/scenario", () => {
  const tempFolders: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempFolders.splice(0).map(async (folder) => {
        await rm(folder, { recursive: true, force: true });
      }),
    );
  });

  it("formats scenario slugs with zero padding and diacritic stripping", () => {
    const slug = formatScenarioSlug({ id: 4, label: "Multilingue (FR/EN)" });
    expect(slug).to.equal("S04_multilingue_fr_en");
  });

  it("formats scenario iteration slugs by sanitising the rerun label", () => {
    const slug = formatScenarioIterationSlug(
      { id: 1, label: "PDF scientifique", slugHint: "pdf_science" },
      "Rerun 01!",
    );
    expect(slug).to.equal("S01_pdf_science_rerun_01");
  });

  it("initialises a scenario directory with placeholders", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-run-scenario-"));
    tempFolders.push(root);
    const layout = await ensureValidationRunLayout(root);

    const scenario = VALIDATION_SCENARIOS[0];
    const run = await initialiseScenarioRun(scenario, { layout });

    expect(await readFile(run.input, "utf8")).to.equal(`${JSON.stringify(scenario.input, null, 2)}\n`);
    await assertFile(run.response, "{}\n");
    await assertFile(run.events, "");
    await assertFile(run.timings, "{}\n");
    await assertFile(run.errors, "[]\n");
    await assertFile(run.kgChanges, "");
    await assertFile(run.vectorUpserts, "[]\n");
    await assertFile(run.serverLog, "");
  });

  it("keeps existing input.json untouched unless overwrite is requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-run-scenario-overwrite-"));
    tempFolders.push(root);
    const layout = await ensureValidationRunLayout(root);

    const scenario = VALIDATION_SCENARIOS[1];
    const run = await initialiseScenarioRun(scenario, { layout });
    await readFile(run.input, "utf8");

    const customInput = { custom: "payload" };
    await initialiseScenarioRun({ ...scenario, input: customInput }, { layout });
    expect(await readFile(run.input, "utf8")).to.equal(`${JSON.stringify(scenario.input, null, 2)}\n`);

    await initialiseScenarioRun({ ...scenario, input: customInput }, { layout, overwriteInput: true });
    expect(await readFile(run.input, "utf8")).to.equal(`${JSON.stringify(customInput, null, 2)}\n`);
  });

  it("initialises all scenarios and returns the artefact paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-run-scenario-all-"));
    tempFolders.push(root);

    const runs = await initialiseAllScenarios({ baseRoot: root });
    expect(runs).to.have.lengthOf(VALIDATION_SCENARIOS.length);
    for (const run of runs) {
      await assertDirectory(run.root);
      for (const key of Object.values(SCENARIO_ARTEFACT_FILENAMES)) {
        const filePath = path.join(run.root, key);
        await assertFileExists(filePath);
      }
    }
  });

  it("initialises rerun directories and increments the suffix automatically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-run-scenario-rerun-"));
    tempFolders.push(root);
    const layout = await ensureValidationRunLayout(root);

    const scenario = VALIDATION_SCENARIOS[0];
    const rerun1 = await initialiseScenarioRerun(scenario, { layout });
    expect(path.basename(rerun1.root)).to.equal("S01_pdf_science_rerun1");
    await assertFile(rerun1.response, "{}\n");
    await assertFile(rerun1.events, "");

    const rerun2 = await initialiseScenarioRerun(scenario, { layout });
    expect(path.basename(rerun2.root)).to.equal("S01_pdf_science_rerun2");

    const rerunCustom = await initialiseScenarioRerun(VALIDATION_SCENARIOS[1], {
      layout,
      iteration: "Hotfix #1",
    });
    expect(path.basename(rerunCustom.root)).to.equal("S02_html_long_images_hotfix_1");
  });
});

async function assertFile(targetPath: string, expectedContent: string): Promise<void> {
  expect(await readFile(targetPath, "utf8")).to.equal(expectedContent);
}

async function assertDirectory(target: string): Promise<void> {
  const stats = await stat(target);
  expect(stats.isDirectory(), `expected ${target} to be a directory`).to.equal(true);
}

async function assertFileExists(target: string): Promise<void> {
  const stats = await stat(target);
  expect(stats.isFile(), `expected ${target} to be a file`).to.equal(true);
}
