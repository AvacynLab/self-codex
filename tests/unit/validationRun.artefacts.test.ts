import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { expect } from "chai";

import { ensureValidationRunLayout } from "../../src/validationRun/layout.js";
import {
  recordScenarioRun,
  type ScenarioArtefactPayload,
  type ScenarioTimingReport,
} from "../../src/validationRun/artefacts.js";

describe("validationRun/artefacts", () => {
  const tmpRoot = path.join(process.cwd(), "tmp", "artefacts-test");

  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    const layout = await ensureValidationRunLayout(tmpRoot);
    await recordScenarioRun(1, {}, { layout });
  });

  it("writes JSON artefacts with pretty formatting", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    const payload: ScenarioArtefactPayload = {
      response: { status: "ok", tookMs: 1234 },
      errors: [
        {
          category: "network_error",
          message: "timeout",
          url: "https://example.com/a",
        },
      ],
      vectorUpserts: [
        { id: "doc-1", vectors: 4 },
        { id: "doc-2", vectors: 2 },
      ],
    };

    const paths = await recordScenarioRun(1, payload, { layout });

    expect(await readFile(paths.response, "utf8")).to.equal(
      `${JSON.stringify(payload.response, null, 2)}\n`,
    );
    expect(await readFile(paths.errors, "utf8")).to.equal(
      `${JSON.stringify(payload.errors, null, 2)}\n`,
    );
    expect(await readFile(paths.vectorUpserts, "utf8")).to.equal(
      `${JSON.stringify(payload.vectorUpserts, null, 2)}\n`,
    );
  });

  it("serialises events and KG changes to NDJSON", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    const events = [
      { type: "start", timestamp: 1 },
      { type: "end", timestamp: 2 },
    ];
    const kgChanges = [
      { action: "upsert", subject: "a" },
      { action: "upsert", subject: "b" },
    ];

    const paths = await recordScenarioRun(
      2,
      { events, kgChanges },
      { layout },
    );

    const eventsContent = await readFile(paths.events, "utf8");
    expect(eventsContent).to.equal(
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    const kgContent = await readFile(paths.kgChanges, "utf8");
    expect(kgContent).to.equal(
      `${kgChanges.map((change) => JSON.stringify(change)).join("\n")}\n`,
    );
  });

  it("writes timing metrics using the dedicated schema", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    const timings: ScenarioTimingReport = {
      searxQuery: { p50: 10, p95: 120, p99: 180 },
      fetchUrl: { p50: 80, p95: 150, p99: 400 },
      extractWithUnstructured: { p50: 120, p95: 320, p99: 480 },
      ingestToGraph: { p50: 30, p95: 55, p99: 70 },
      ingestToVector: { p50: 45, p95: 95, p99: 140 },
      tookMs: 1234,
      documentsIngested: 8,
      errors: { network_error: 1, robots_denied: 0 },
    };

    const paths = await recordScenarioRun(3, { timings }, { layout });
    expect(await readFile(paths.timings, "utf8")).to.equal(
      `${JSON.stringify(timings, null, 2)}\n`,
    );
  });

  it("normalises the server log payload", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    const serverLogLines = ["[10:00] start", "[10:05] done"];

    const paths = await recordScenarioRun(4, { serverLog: serverLogLines }, { layout });
    expect(await readFile(paths.serverLog, "utf8")).to.equal(
      `${serverLogLines.join("\n")}\n`,
    );

    const singleLinePaths = await recordScenarioRun(
      4,
      { serverLog: "[10:05] done" },
      { layout },
    );
    expect(await readFile(singleLinePaths.serverLog, "utf8")).to.equal("[10:05] done\n");
  });

  it("rejects unknown scenario identifiers", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    try {
      await recordScenarioRun(999, {}, { layout });
      expect.fail("expected recordScenarioRun to throw");
    } catch (error) {
      expect((error as Error).message).to.equal("Unknown validation scenario id: 999");
    }
  });
});

