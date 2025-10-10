import { afterEach, before, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression tests for the bespoke helpers recently added to the
 * {@link ArtifactRecorder}. The suite focuses on the primitives used by the
 * preflight validation stage: standalone JSON document persistence and JSONL
 * append operations enriched with resource registry metadata.
 */
describe("validation artifact recorder helpers", () => {
  let runContextModule: typeof import("../../scripts/lib/validation/run-context.mjs");
  let recorderModule: typeof import("../../scripts/lib/validation/artifact-recorder.mjs");

  before(async () => {
    runContextModule = await import("../../scripts/lib/validation/run-context.mjs");
    recorderModule = await import("../../scripts/lib/validation/artifact-recorder.mjs");
  });

  describe("custom document and jsonl recording", () => {
    let workspaceRoot: string;
    const registeredArtifacts: Array<Record<string, unknown>> = [];

    beforeEach(async () => {
      workspaceRoot = await mkdtemp(join(tmpdir(), "codex-recorder-"));
      registeredArtifacts.length = 0;
    });

    afterEach(async () => {
      await rm(workspaceRoot, { recursive: true, force: true });
    });

    it("writes json documents and mirrors them in the registry", async () => {
      const context = await runContextModule.createRunContext({
        runId: "validation_2099-01-01",
        workspaceRoot,
      });

      const recorder = new recorderModule.ArtifactRecorder(context, {
        clock: () => new Date("2099-01-01T00:00:00.000Z"),
        resourceRegistry: {
          registerValidationArtifact(input: Record<string, unknown>) {
            registeredArtifacts.push(input);
            return `sc://validation/${String(input.name ?? "unknown")}`;
          },
        },
        logger: { warn() {} },
      });

      const payload = { kind: "context", host: "127.0.0.1" };
      const documentPath = await recorder.recordJsonDocument({
        directory: "report",
        filename: "context.json",
        payload,
        phaseId: "phase-00-preflight",
        metadata: { artifact: "session_context" },
      });

      const recorded = JSON.parse(await readFile(documentPath, "utf8")) as typeof payload;
      expect(recorded).to.deep.equal(payload);

      const registered = registeredArtifacts.at(-1);
      expect(registered).to.include({
        artifactType: "report",
        name: "context.json",
      });
      expect(registered?.metadata).to.include({ artifact: "session_context", role: "document" });
    });

    it("appends jsonl entries while tracking counters", async () => {
      const context = await runContextModule.createRunContext({
        runId: "validation_2099-01-02",
        workspaceRoot,
      });

      const recorder = new recorderModule.ArtifactRecorder(context, {
        clock: () => new Date("2099-01-02T00:00:00.000Z"),
        resourceRegistry: {
          registerValidationArtifact(input: Record<string, unknown>) {
            registeredArtifacts.push(input);
            return `sc://validation/${String(input.name ?? "unknown")}`;
          },
        },
        logger: { warn() {} },
      });

      const filename = "phase-00-preflight-requests.jsonl";
      const firstPath = await recorder.appendJsonlArtifact({
        directory: "inputs",
        filename,
        payload: { index: 1 },
        phaseId: "phase-00-preflight",
        metadata: { channel: "http_requests" },
      });
      const secondPath = await recorder.appendJsonlArtifact({
        directory: "inputs",
        filename,
        payload: { index: 2 },
        phaseId: "phase-00-preflight",
        metadata: { channel: "http_requests" },
      });

      expect(firstPath).to.equal(secondPath);
      const content = (await readFile(firstPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(content).to.deep.equal([{ index: 1 }, { index: 2 }]);

      const lastRegistered = registeredArtifacts.at(-1);
      expect(lastRegistered).to.include({
        artifactType: "inputs",
        name: filename,
      });
      expect(lastRegistered?.data).to.deep.include({ entry_count: 2 });
      expect(lastRegistered?.metadata).to.deep.include({ role: "jsonl", entry_count: 2, channel: "http_requests" });
    });

    it("allows overriding the resource payload for jsonl artefacts", async () => {
      const context = await runContextModule.createRunContext({
        runId: "validation_2099-01-03",
        workspaceRoot,
      });

      const recorder = new recorderModule.ArtifactRecorder(context, {
        clock: () => new Date("2099-01-03T00:00:00.000Z"),
        resourceRegistry: {
          registerValidationArtifact(input: Record<string, unknown>) {
            registeredArtifacts.push(input);
            return `sc://validation/${String(input.name ?? "unknown")}`;
          },
        },
        logger: { warn() {} },
      });

      await recorder.appendJsonlArtifact({
        directory: "events",
        filename: "phase-02-introspection.jsonl",
        payload: { sequence: 1, note: "probe" },
        phaseId: "phase-02-introspection",
        metadata: { channel: "introspection_bus" },
        resourceData: {
          entry_count: 1,
          events: [{ sequence: 1, note: "probe" }],
        },
      });

      const registered = registeredArtifacts.at(-1);
      expect(registered).to.include({ artifactType: "events", name: "phase-02-introspection.jsonl" });
      expect(registered?.data).to.deep.equal({ entry_count: 1, events: [{ sequence: 1, note: "probe" }] });
      expect(registered?.metadata).to.deep.include({ role: "jsonl", entry_count: 1, channel: "introspection_bus" });
    });
  });
});
