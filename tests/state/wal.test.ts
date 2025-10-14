import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { appendWalEntry } from "../../src/state/wal.js";

/**
 * Builds a deterministic temporary directory rooted inside the system specific
 * temp folder. Tests remove the directory implicitly at process exit which
 * keeps the workspace tidy.
 */
async function createRunsRoot(): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), "wal-test-"));
  return path.join(base, "runs");
}

describe("state/wal", () => {
  it("appends entries with deterministic rotation and checksums", async () => {
    const runsRoot = await createRunsRoot();
    const timestamps = [
      new Date("2024-01-02T10:00:00.000Z"),
      new Date("2024-01-02T12:34:56.000Z"),
      new Date("2024-01-03T00:01:02.000Z"),
    ];
    let index = 0;
    const clock = () => {
      const current = timestamps[index] ?? timestamps[timestamps.length - 1];
      index += 1;
      return current;
    };

    await appendWalEntry(
      "graph",
      "tx_begin",
      { id: "tx-1", nodes: 3 },
      { runsRoot, clock },
    );
    await appendWalEntry(
      "graph",
      "tx_commit",
      { id: "tx-1", duration_ms: 42 },
      { runsRoot, clock },
    );
    await appendWalEntry(
      "graph",
      "tx_begin",
      { id: "tx-2" },
      { runsRoot, clock },
    );

    const dayOnePath = path.join(runsRoot, "wal", "graph", "2024-01-02.log");
    const dayTwoPath = path.join(runsRoot, "wal", "graph", "2024-01-03.log");
    const dayOneRaw = await readFile(dayOnePath, { encoding: "utf8" });
    const dayTwoRaw = await readFile(dayTwoPath, { encoding: "utf8" });

    const dayOneEntries = dayOneRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { ts: string; topic: string; event: string; payload: unknown; checksum: string });
    const dayTwoEntries = dayTwoRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { ts: string; topic: string; event: string; payload: unknown; checksum: string });

    expect(dayOneEntries).to.have.length(2);
    expect(dayTwoEntries).to.have.length(1);

    const [first, second] = dayOneEntries;
    expect(first.ts).to.equal("2024-01-02T10:00:00.000Z");
    expect(first.event).to.equal("tx_begin");
    expect(first.payload).to.deep.equal({ id: "tx-1", nodes: 3 });
    expect(first.topic).to.equal("graph");

    const checksumBase = JSON.stringify({
      ts: first.ts,
      topic: first.topic,
      event: first.event,
      payload: first.payload,
    });
    expect(first.checksum).to.equal(createHash("sha256").update(checksumBase).digest("hex"));

    expect(second.event).to.equal("tx_commit");
    expect(second.ts).to.equal("2024-01-02T12:34:56.000Z");

    const [third] = dayTwoEntries;
    expect(third.event).to.equal("tx_begin");
    expect(third.ts).to.equal("2024-01-03T00:01:02.000Z");
  });

  it("sanitises topics before writing to disk", async () => {
    const runsRoot = await createRunsRoot();
    await appendWalEntry("../graph events", "patched", { ok: true }, { runsRoot, clock: () => new Date("2024-05-01T00:00:00Z") });

    const safePath = path.join(runsRoot, "wal", "graph_events", "2024-05-01.log");
    const raw = await readFile(safePath, { encoding: "utf8" });
    const entry = JSON.parse(raw) as { topic: string };
    expect(entry.topic).to.equal("../graph events".trim());
  });
});
