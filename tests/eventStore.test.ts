import { describe, it } from "mocha";
import { expect } from "chai";

import { EventStore, OrchestratorEvent } from "../src/eventStore.js";
import { RecordingLogger } from "./helpers/recordingLogger.js";

describe("EventStore", () => {
  it("retains only the configured number of events globally and per job", () => {
    // Initialise with a low retention so the trimming logic is exercised.
    const store = new EventStore({ maxHistory: 2, logger: new RecordingLogger() });

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

  it("evicts the oldest entries in FIFO order when events interleave across jobs", () => {
    // The regression guard below ensures that trimming honours insertion order even
    // when multiple jobs contribute to the same EventStore window.
    const store = new EventStore({ maxHistory: 2, logger: new RecordingLogger() });

    const jobAFirst = store.emit({ kind: "INFO", jobId: "job_a" });
    const jobBOnly = store.emit({ kind: "INFO", jobId: "job_b" });
    const jobASecond = store.emit({ kind: "INFO", jobId: "job_a" });
    const jobAThird = store.emit({ kind: "INFO", jobId: "job_a" });

    const snapshot = store.getSnapshot();
    expect(snapshot.map((event) => event.seq)).to.deep.equal([jobASecond.seq, jobAThird.seq]);

    const jobAEvents = store.listForJob("job_a");
    expect(jobAEvents.map((event) => event.seq)).to.deep.equal([jobASecond.seq, jobAThird.seq]);

    const jobBEvents = store.listForJob("job_b");
    expect(jobBEvents).to.have.length(1);
    expect(jobBEvents[0].seq).to.equal(jobBOnly.seq);
  });

  it("filters events by job, child and minimum sequence", () => {
    // Populate with three events touching two jobs and different children.
    const store = new EventStore({ maxHistory: 10, logger: new RecordingLogger() });

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
    // The recording logger captures the debug entry emitted by setMaxHistory.
    const logger = new RecordingLogger();
    const store = new EventStore({ maxHistory: 4, logger });

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

  it("normalises provenance metadata when emitting events", () => {
    const store = new EventStore({ maxHistory: 4, logger: new RecordingLogger() });

    const emitted = store.emit({
      kind: "INFO",
      provenance: [
        { sourceId: " DocA ", type: "file", confidence: 0.4 },
        { sourceId: "DocA", type: "file", confidence: 0.9 },
        { sourceId: "Memory", type: "kg", span: [8, 2], confidence: -1 },
      ],
    });

    expect(emitted.provenance).to.deep.equal([
      { sourceId: "DocA", type: "file", confidence: 0.4 },
      { sourceId: "Memory", type: "kg", span: [2, 8], confidence: 0 },
    ]);
  });

  it("filters events by kind with pagination helpers", () => {
    const store = new EventStore({ maxHistory: 10, logger: new RecordingLogger() });

    const firstInfo = store.emit({ kind: "INFO", jobId: "job_a", childId: "child_shared" });
    const firstWarn = store.emit({ kind: "WARN", jobId: "job_a", childId: "child_warn" });
    const errorOtherJob = store.emit({ kind: "ERROR", jobId: "job_b" });
    const secondInfo = store.emit({ kind: "INFO", jobId: "job_a", childId: "child_shared" });
    const secondWarn = store.emit({ kind: "WARN", jobId: "job_a", childId: "child_warn" });

    const warnAndError = store.list({ kinds: ["WARN", "ERROR"] });
    expect(warnAndError.map((event) => event.seq)).to.deep.equal([
      firstWarn.seq,
      errorOtherJob.seq,
      secondWarn.seq,
    ]);

    const latestWarnOnly = store.list({ kinds: ["WARN"], reverse: true, limit: 1 });
    expect(latestWarnOnly).to.have.length(1);
    expect(latestWarnOnly[0].seq).to.equal(secondWarn.seq);

    const zeroLimit = store.list({ kinds: ["INFO"], limit: 0 });
    expect(zeroLimit).to.deep.equal([]);

    const jobWarns = store.listForJob("job_a", { kinds: ["WARN"], reverse: true });
    expect(jobWarns.map((event) => event.seq)).to.deep.equal([secondWarn.seq, firstWarn.seq]);

    const jobChildAfterFirst = store.listForJob("job_a", {
      childId: "child_shared",
      minSeq: firstInfo.seq,
    });
    expect(jobChildAfterFirst.map((event) => event.seq)).to.deep.equal([secondInfo.seq]);

    const legacyMinSeq = store.listForJob("job_a", firstInfo.seq);
    expect(legacyMinSeq.map((event) => event.seq)).to.deep.equal([
      firstWarn.seq,
      secondInfo.seq,
      secondWarn.seq,
    ]);

    const limitedDescending = store.listForJob("job_a", {
      kinds: ["INFO", "WARN"],
      reverse: true,
      limit: 2,
    });
    expect(limitedDescending.map((event) => event.seq)).to.deep.equal([secondWarn.seq, secondInfo.seq]);
  });

  it("émet un journal structuré pour chaque événement enregistré", () => {
    const logger = new RecordingLogger();
    const store = new EventStore({ maxHistory: 5, logger });

    const infoEvent = store.emit({
      kind: "INFO",
      level: "info",
      jobId: "job_a",
      payload: { status: "ok" },
    });
    const warnEvent = store.emit({ kind: "WARN", level: "warn", childId: "child_a" });
    const errorEvent = store.emit({ kind: "ERROR", level: "error" });

    const recordedEntries = logger.entries.filter((entry) => entry.message === "event_recorded");
    expect(recordedEntries).to.have.length(3);

    const infoLog = recordedEntries.find((entry) => entry.level === "info");
    expect(infoLog?.payload).to.deep.include({
      seq: infoEvent.seq,
      kind: "INFO",
      job_id: "job_a",
      level: "info",
      provenance_count: 0,
    });
    expect((infoLog?.payload as Record<string, unknown>).payload).to.deep.equal({ status: "ok" });

    const warnLog = recordedEntries.find((entry) => entry.level === "warn");
    expect(warnLog?.payload).to.deep.include({
      seq: warnEvent.seq,
      kind: "WARN",
      child_id: "child_a",
      level: "warn",
    });

    const errorLog = recordedEntries.find((entry) => entry.level === "error");
    expect(errorLog?.payload).to.deep.include({
      seq: errorEvent.seq,
      kind: "ERROR",
      level: "error",
    });
  });

  it("résume les charges utiles impossibles à sérialiser", () => {
    const logger = new RecordingLogger();
    const store = new EventStore({ maxHistory: 3, logger });

    const circular: { self?: unknown } = {};
    circular.self = circular;

    store.emit({ kind: "INFO", payload: circular });

    const summaryEntry = logger.entries.find(
      (entry) => entry.message === "event_recorded" && entry.level === "info",
    );
    expect(summaryEntry).to.not.be.undefined;
    expect(summaryEntry?.payload).to.have.property("payload_summary");
    expect((summaryEntry?.payload as { payload_summary: { summary: string } }).payload_summary.summary).to.equal(
      "payload_serialization_failed",
    );
  });

  it("journalise les évictions avec le scope concerné", () => {
    const logger = new RecordingLogger();
    const store = new EventStore({ maxHistory: 1, logger });

    const first = store.emit({ kind: "INFO", jobId: "job_a" });
    store.emit({ kind: "INFO", jobId: "job_a" });

    const evictionEntries = logger.entries.filter((entry) => entry.message === "event_evicted");
    expect(evictionEntries).to.have.length(3);

    const globalEviction = evictionEntries.find((entry) => (entry.payload as { scope: string }).scope === "global");
    expect(globalEviction?.payload).to.deep.include({
      scope: "global",
      seq: first.seq,
      job_id: "job_a",
      reason: "history_limit",
    });

    const jobEviction = evictionEntries.find((entry) => (entry.payload as { scope: string }).scope === "job");
    expect(jobEviction?.payload).to.deep.include({
      scope: "job",
      seq: first.seq,
      job_id: "job_a",
      reason: "history_limit",
    });

    const kindEviction = evictionEntries.find((entry) => (entry.payload as { scope: string }).scope === "kind");
    expect(kindEviction?.payload).to.deep.include({
      scope: "kind",
      seq: first.seq,
      kind: "INFO",
      reason: "history_limit",
    });
  });

  it("stabilise l'ordre des clés lors de la journalisation des charges utiles", () => {
    const logger = new RecordingLogger();
    const store = new EventStore({ maxHistory: 5, logger });

    // La payload possède un ordre arbitraire afin de vérifier que le log est trié.
    store.emit({
      kind: "INFO",
      payload: { zebra: 1, alpha: 2, middle: { beta: 2, alpha: 1 } },
    });

    const logged = logger.entries.find((entry) => entry.message === "event_recorded");
    expect(logged).to.not.be.undefined;

    const payload = (logged?.payload as { payload: Record<string, unknown> | undefined })?.payload;
    expect(payload).to.not.be.undefined;

    const keys = Object.keys(payload ?? {});
    expect(keys).to.deep.equal(["alpha", "middle", "zebra"]);

    const middle = (payload as Record<string, unknown>).middle as Record<string, unknown> | undefined;
    expect(middle).to.not.be.undefined;
    expect(Object.keys(middle ?? {})).to.deep.equal(["alpha", "beta"]);
  });
});
