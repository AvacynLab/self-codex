import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PersistentKnowledgeGraph } from "../../src/memory/kg.js";

/** Manual clock providing deterministic timestamps for knowledge snapshots. */
class ManualClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

describe("persistent knowledge graph", () => {
  let rootDir: string;
  let clock: ManualClock;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "kg-memory-"));
    clock = new ManualClock();
  });

  it("persists triples and restores them across instances", async () => {
    const persistence = await PersistentKnowledgeGraph.create({ directory: rootDir, now: () => clock.now() });

    const insert = await persistence.upsert({
      subject: "incident",
      predicate: "includes",
      object: "contain",
      source: "playbook",
      confidence: 0.9,
    });
    expect(insert.created).to.equal(true);

    const reload = await PersistentKnowledgeGraph.create({ directory: rootDir });
    const triples = reload.query({ subject: "incident", predicate: "includes" });
    expect(triples).to.have.length(1);
    expect(triples[0].object).to.equal("contain");
    expect(triples[0].confidence).to.equal(0.9);
  });

  it("increments revisions when upserting an existing triple", async () => {
    const persistence = await PersistentKnowledgeGraph.create({ directory: rootDir, now: () => clock.now() });

    await persistence.upsert({ subject: "plan", predicate: "includes", object: "design", confidence: 0.6 });
    clock.advance(50);
    const updated = await persistence.upsert({
      subject: "plan",
      predicate: "includes",
      object: "design",
      source: "library",
      confidence: 0.8,
    });
    expect(updated.created).to.equal(false);
    expect(updated.updated).to.equal(true);
    expect(updated.snapshot.revision).to.equal(1);
    expect(updated.snapshot.confidence).to.equal(0.8);

    const reload = await PersistentKnowledgeGraph.create({ directory: rootDir });
    const triples = reload.query({ subject: "plan", predicate: "includes" });
    expect(triples[0].revision).to.equal(1);
    expect(triples[0].source).to.equal("library");
  });
});
