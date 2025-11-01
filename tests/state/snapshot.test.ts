import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { snapshotList, snapshotLoad, snapshotTake } from "../../src/state/snapshot.js";

/** Creates a disposable runs directory unique to the current test. */
async function createRunsRoot(): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), "snapshot-test-"));
  return path.join(base, "validation_run");
}

describe("state/snapshot", () => {
  it("persists, lists and loads incremental snapshots", async () => {
    const runsRoot = await createRunsRoot();
    const timestamps = [
      new Date("2024-05-01T10:00:00.000Z"),
      new Date("2024-05-01T12:00:00.000Z"),
    ];
    let pointer = 0;
    const clock = () => {
      const current = timestamps[pointer] ?? timestamps[timestamps.length - 1];
      pointer += 1;
      return current;
    };

    const first = await snapshotTake(
      "graph",
      { nodes: 5, edges: 8 },
      { runsRoot, clock, metadata: { generation: 1 }, label: "baseline" },
    );
    const second = await snapshotTake(
      "graph",
      { nodes: 7, edges: 9 },
      { runsRoot, clock, metadata: { generation: 2 } },
    );

    const listed = await snapshotList("graph", { runsRoot });
    expect(listed.map((entry) => entry.id)).to.deep.equal([second.id, first.id]);
    expect(listed[0].metadata).to.deep.equal({ generation: 2 });

    const loadedFirst = await snapshotLoad<typeof first.state>("graph", first.id, { runsRoot });
    expect(loadedFirst.state).to.deep.equal({ nodes: 5, edges: 8 });
    expect(loadedFirst.metadata).to.deep.equal({ generation: 1 });
    expect(loadedFirst.path.endsWith(`${first.id}.json`)).to.equal(true);

    await rm(path.dirname(first.path), { recursive: true, force: true });
  });

  it("throws when requesting missing snapshots", async () => {
    const runsRoot = await createRunsRoot();
    try {
      await snapshotLoad("graph", "missing", { runsRoot });
      throw new Error("expected snapshotLoad to throw for missing identifier");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).to.match(/snapshot missing is not available/);
    }
  });
});
