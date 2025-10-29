import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { recordScenarioRun } from "../../src/validationRun/artefacts.js";
import { compareScenarioIdempotence } from "../../src/validationRun/idempotence.js";
import { ensureValidationRunLayout } from "../../src/validationRun/layout.js";

/**
 * Unit tests for the idempotence comparison helper. The suite operates on a
 * temporary validation directory to keep the fixtures close to the on-disk
 * structure manipulated by the CLI.
 */
describe("validationRun/idempotence", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (folder) => {
        await rm(folder, { recursive: true, force: true });
      }),
    );
  });

  it("returns pass when S01 and S05 expose identical docIds and events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-idempotence-pass-"));
    tempRoots.push(root);
    const layout = await ensureValidationRunLayout(root);

    const response = {
      documents: [
        { id: "doc-1", url: "https://example.com/a" },
        { id: "doc-2", url: "https://example.com/b" },
      ],
    };
    const events = [
      { kind: "search:doc_ingested", payload: { doc_id: "doc-1" } },
      { kind: "search:doc_ingested", payload: { doc_id: "doc-2" } },
    ];

    await recordScenarioRun(1, { response, events }, { layout });
    await recordScenarioRun(5, { response, events }, { layout });

    const comparison = await compareScenarioIdempotence({ layout });

    expect(comparison.status).to.equal("pass");
    expect(comparison.documentDiff.baseOnly).to.deep.equal([]);
    expect(comparison.documentDiff.rerunOnly).to.deep.equal([]);
    expect(comparison.eventDiff.baseOnly).to.deep.equal([]);
    expect(comparison.eventDiff.rerunOnly).to.deep.equal([]);
    expect(comparison.base.documentDuplicates).to.deep.equal([]);
    expect(comparison.rerun.documentDuplicates).to.deep.equal([]);
  });

  it("returns fail when the rerun introduces a new docId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-idempotence-fail-"));
    tempRoots.push(root);
    const layout = await ensureValidationRunLayout(root);

    const baseResponse = {
      documents: [
        { id: "doc-1", url: "https://example.com/a" },
      ],
    };
    const rerunResponse = {
      documents: [
        { id: "doc-1", url: "https://example.com/a" },
        { id: "doc-3", url: "https://example.com/c" },
      ],
    };

    await recordScenarioRun(1, {
      response: baseResponse,
      events: [{ kind: "search:doc_ingested", payload: { doc_id: "doc-1" } }],
    }, { layout });

    await recordScenarioRun(5, {
      response: rerunResponse,
      events: [
        { kind: "search:doc_ingested", payload: { doc_id: "doc-1" } },
        { kind: "search:doc_ingested", payload: { doc_id: "doc-3" } },
      ],
    }, { layout });

    const comparison = await compareScenarioIdempotence({ layout });

    expect(comparison.status).to.equal("fail");
    expect(comparison.documentDiff.rerunOnly).to.deep.equal(["doc-3"]);
    expect(comparison.eventDiff.rerunOnly).to.deep.equal(["doc-3"]);
  });

  it("returns unknown when artefacts are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-idempotence-unknown-"));
    tempRoots.push(root);
    const layout = await ensureValidationRunLayout(root);

    await recordScenarioRun(1, {
      response: { documents: [{ id: "doc-1", url: "https://example.com" }] },
      events: [{ kind: "search:doc_ingested", payload: { doc_id: "doc-1" } }],
    }, { layout });

    const comparison = await compareScenarioIdempotence({ layout });

    expect(comparison.status).to.equal("unknown");
    expect(comparison.notes.some((note) => note.includes("response.json"))).to.equal(true);
  });
});
