import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { snapshotList, snapshotLoad, snapshotTake } from "../../src/state/snapshot.js";

/**
 * Regression tests ensuring snapshot persistence cannot escape the configured
 * runs root even when callers provide malicious-looking identifiers.
 */
describe("snapshot sanitisation", () => {
  it("routes snapshot namespaces and ids through safePath", async () => {
    const runsRoot = await mkdtemp(path.join(tmpdir(), "snapshot-sanitize-"));
    try {
      const record = await snapshotTake(
        "../escape<namespace>",
        { status: "ok" },
        { runsRoot, label: "label:?*unsafe" },
      );

      expect(record.path.startsWith(runsRoot)).to.equal(true);
      expect(record.path).to.not.include("..");
      expect(record.path).to.not.match(/[<>:"|?*]/);

      const listed = await snapshotList("../escape<namespace>", { runsRoot });
      expect(listed).to.have.lengthOf(1);
      expect(listed[0].path.startsWith(runsRoot)).to.equal(true);
      expect(listed[0].path).to.not.include("..");
      expect(listed[0].path).to.not.match(/[<>:"|?*]/);

      const loaded = await snapshotLoad<{ status: string }>(
        "../escape<namespace>",
        record.id,
        { runsRoot },
      );
      expect(loaded.state.status).to.equal("ok");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});
