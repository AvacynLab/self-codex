import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { append, resolveOplogPath } from "../../src/graph/oplog.js";

/** Utility generating a deterministic timestamp in UTC. */
function utcTimestamp(year: number, monthZeroBased: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, monthZeroBased, day, hour, minute, 0, 0);
}

describe("graph operation log", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcp-oplog-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes entries to the expected JSONL file", async () => {
    const ts = utcTimestamp(2025, 0, 2, 10, 45);
    await append({ kind: "tx_begin", graph_id: "graph-A", owner: null }, "tx-123", ts, { rootDir: root });

    const file = resolveOplogPath(ts, root);
    const contents = await readFile(file, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).to.have.length(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).to.deep.include({ ts, tx_id: "tx-123" });
    expect(entry.op.kind).to.equal("tx_begin");
    expect(entry.op.graph_id).to.equal("graph-A");
  });

  it("partitions entries by day", async () => {
    const first = utcTimestamp(2024, 11, 31, 23, 59);
    const second = utcTimestamp(2025, 0, 1, 0, 1);
    await append({ kind: "tx_commit", graph_id: "graph-B", version: 4 }, "tx-1", first, { rootDir: root });
    await append({ kind: "tx_commit", graph_id: "graph-B", version: 5 }, "tx-2", second, { rootDir: root });

    const files = await readdir(root);
    expect(files.map((file) => basename(file))).to.have.members(["20241231.log", "20250101.log"]);
  });
});
