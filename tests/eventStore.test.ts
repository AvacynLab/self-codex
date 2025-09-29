import { describe, it } from "mocha";
import { expect } from "chai";

import { EventStore, OrchestratorEvent } from "../src/eventStore.js";
import { StructuredLogger } from "../src/logger.js";

// Minimal logger used to observe debug messages without writing to stdout.
class StubLogger {
  public readonly entries: { level: string; message: string; payload?: unknown }[] = [];

  debug(message: string, payload?: unknown) {
    this.entries.push({ level: "debug", message, payload });
  }

  info(message: string, payload?: unknown) {
    this.entries.push({ level: "info", message, payload });
  }

  warn(message: string, payload?: unknown) {
    this.entries.push({ level: "warn", message, payload });
  }

  error(message: string, payload?: unknown) {
    this.entries.push({ level: "error", message, payload });
  }
}

const asStructuredLogger = (logger: StubLogger): StructuredLogger => logger as unknown as StructuredLogger;

describe("EventStore", () => {
  it("retains only the configured number of events globally and per job", () => {
    // Initialise with a low retention so the trimming logic is exercised.
    const store = new EventStore({ maxHistory: 2, logger: asStructuredLogger(new StubLogger()) });

    const first = store.emit({ kind: "INFO", jobId: "job_a" });
    const second = store.emit({ kind: "INFO", jobId: "job_a" });
    const third = store.emit({ kind: "INFO", jobId: "job_a" });

    expect(store.getEventCount()).to.equal(2);
    const events = store.getSnapshot();
    expect(events.map((event) => event.seq)).to.deep.equal([second.seq, third.seq]);
    expect(events.every((event) => event.seq !== first.seq)).to.equal(true);

    const perJob = store.listForJob("job_a");
    expect(perJob.map((event) => event.seq)).to.deep.equal([second.seq, third.seq]);
    expect(perJob).to.have.length(2);
    expect(perJob[0].seq).to.equal(second.seq);
  });

  it("filters events by job, child and minimum sequence", () => {
    // Populate with three events touching two jobs and different children.
    const store = new EventStore({ maxHistory: 10, logger: asStructuredLogger(new StubLogger()) });

    const first = store.emit({ kind: "INFO", jobId: "job_a" });
    const second = store.emit({ kind: "INFO", jobId: "job_b", childId: "child_b" });
    const third = store.emit({ kind: "WARN", jobId: "job_a", childId: "child_a" });

    const onlyJobA = store.list({ jobId: "job_a" });
    expect(onlyJobA.map((event) => event.seq)).to.deep.equal([first.seq, third.seq]);

    const onlyChild = store.list({ childId: "child_a" });
    expect(onlyChild).to.have.length(1);
    expect(onlyChild[0].childId).to.equal("child_a");

    const afterFirst = store.list({ minSeq: first.seq });
    expect(afterFirst.map((event) => event.seq)).to.deep.equal([second.seq, third.seq]);

    const afterSecond = store.list({ minSeq: second.seq });
    expect(afterSecond.map((event) => event.seq)).to.deep.equal([third.seq]);
  });

  it("updates the retention limit and logs the change", () => {
    // The stub logger captures the debug entry emitted by setMaxHistory.
    const logger = new StubLogger();
    const store = new EventStore({ maxHistory: 4, logger: asStructuredLogger(logger) });

    store.emit({ kind: "INFO", jobId: "job_a" });
    store.emit({ kind: "INFO", jobId: "job_a" });
    store.emit({ kind: "INFO", jobId: "job_b" });
    store.emit({ kind: "INFO", jobId: "job_b" });

    store.setMaxHistory(2);

    const snapshot = store.getSnapshot();
    expect(snapshot).to.have.length(2);
    expect(snapshot.every((event: OrchestratorEvent) => event.seq > 2)).to.equal(true);

    const debugEntry = logger.entries.find((entry) => entry.message === "event_history_limit_updated");
    expect(debugEntry).to.not.be.undefined;
    expect((debugEntry?.payload as { limit: number }).limit).to.equal(2);
  });
});
