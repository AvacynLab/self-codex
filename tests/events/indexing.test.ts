import { expect } from "chai";

import { EventStore } from "../../src/eventStore.js";
import { RecordingLogger } from "../helpers/recordingLogger.js";

describe("EventStore indexing", () => {
  it("maintient un historique borné pour chaque type d'événement", () => {
    const logger = new RecordingLogger();
    const store = new EventStore({ maxHistory: 2, logger });

    const firstInfo = store.emit({ kind: "INFO", jobId: "job_a" });
    const secondInfo = store.emit({ kind: "INFO", jobId: "job_b" });
    const warn = store.emit({ kind: "WARN", jobId: "job_b" });
    const thirdInfo = store.emit({ kind: "INFO", jobId: "job_c" });

    const infoEvents = store.getEventsByKind("INFO");
    expect(infoEvents.map((event) => event.seq)).to.deep.equal([secondInfo.seq, thirdInfo.seq]);

    // Vérifie que la copie renvoyée peut être manipulée sans toucher au store.
    infoEvents.pop();
    const untouched = store.getEventsByKind("INFO");
    expect(untouched.map((event) => event.seq)).to.deep.equal([secondInfo.seq, thirdInfo.seq]);

    const kindEvictions = logger.entries.filter(
      (entry) => entry.message === "event_evicted" && (entry.payload as { scope?: string }).scope === "kind",
    );
    expect(kindEvictions).to.have.length(1);
    expect((kindEvictions[0]?.payload as { seq: number; kind: string }).seq).to.equal(firstInfo.seq);
    expect((kindEvictions[0]?.payload as { kind: string }).kind).to.equal("INFO");

    const warnEvents = store.getEventsByKind("WARN");
    expect(warnEvents.map((event) => event.seq)).to.deep.equal([warn.seq]);
  });

  it("retrimme les index par type lorsque la rétention est réduite", () => {
    const logger = new RecordingLogger();
    const store = new EventStore({ maxHistory: 4, logger });

    const infoSeqs = [
      store.emit({ kind: "INFO" }).seq,
      store.emit({ kind: "INFO" }).seq,
      store.emit({ kind: "INFO" }).seq,
    ];
    const warnSeq = store.emit({ kind: "WARN" }).seq;

    store.setMaxHistory(2);

    const remainingInfo = store.getEventsByKind("INFO");
    expect(remainingInfo.map((event) => event.seq)).to.deep.equal(infoSeqs.slice(-2));

    const kindEvictions = logger.entries.filter(
      (entry) => entry.message === "event_evicted" && (entry.payload as { scope?: string }).scope === "kind",
    );
    expect(kindEvictions).to.not.be.empty;
    expect(kindEvictions.map((entry) => (entry.payload as { seq: number }).seq)).to.include(infoSeqs[0]!);

    const warnEvents = store.getEventsByKind("WARN");
    expect(warnEvents.map((event) => event.seq)).to.deep.equal([warnSeq]);
  });
});
