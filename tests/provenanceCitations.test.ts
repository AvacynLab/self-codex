import { describe, it } from "mocha";
import { expect } from "chai";

import type { OrchestratorEvent } from "../src/eventStore.js";
import { aggregateCitationsFromEvents } from "../src/provenance/citations.js";
import type { Provenance } from "../src/types/provenance.js";

function event(seq: number, provenance: Provenance[] | undefined): Pick<OrchestratorEvent, "seq" | "provenance"> {
  return {
    seq,
    provenance: provenance ? provenance.map((entry) => ({ ...entry })) : [],
  } as Pick<OrchestratorEvent, "seq" | "provenance">;
}

describe("aggregateCitationsFromEvents", () => {
  it("deduplicates sources while preferring the most confident span", () => {
    const events = [
      event(1, [
        { sourceId: "DocA", type: "file", confidence: 0.3 },
        { sourceId: "DocB", type: "url", confidence: 0.8, span: [10, 40] },
      ]),
      event(2, [
        { sourceId: "DocA", type: "file", confidence: 0.9, span: [5, 25] },
        { sourceId: "DocB", type: "url", confidence: 0.4, span: [0, 12] },
      ]),
      event(3, [
        { sourceId: "DocA", type: "file", span: [7, 20] },
        { sourceId: "DocC", type: "kg" },
      ]),
    ];

    const citations = aggregateCitationsFromEvents(events, { limit: 10 });
    expect(citations).to.deep.equal([
      { sourceId: "DocA", type: "file", confidence: 0.9, span: [5, 25] },
      { sourceId: "DocB", type: "url", confidence: 0.8, span: [10, 40] },
      { sourceId: "DocC", type: "kg" },
    ]);
  });

  it("respects the citation limit and sorts deterministically", () => {
    const events = [
      event(1, [
        { sourceId: "DocA", type: "file", confidence: 0.2 },
        { sourceId: "DocB", type: "url", confidence: 0.2 },
      ]),
      event(2, [
        { sourceId: "DocC", type: "file", confidence: 0.2 },
        { sourceId: "DocD", type: "url" },
      ]),
      event(3, [
        { sourceId: "DocE", type: "url", confidence: 0.6 },
      ]),
    ];

    const citations = aggregateCitationsFromEvents(events, { limit: 3 });
    expect(citations).to.deep.equal([
      { sourceId: "DocE", type: "url", confidence: 0.6 },
      { sourceId: "DocC", type: "file", confidence: 0.2 },
      { sourceId: "DocA", type: "file", confidence: 0.2 },
    ]);
  });

  it("returns an empty list when the limit is zero", () => {
    const events = [event(1, [{ sourceId: "DocA", type: "file", confidence: 0.2 }])];
    expect(aggregateCitationsFromEvents(events, { limit: 0 })).to.deep.equal([]);
  });

  it("does not retain references to the original provenance arrays", () => {
    const provenance = [{ sourceId: "DocA", type: "file", confidence: 0.7, span: [0, 10] as [number, number] }];
    const events = [event(42, provenance)];
    const citations = aggregateCitationsFromEvents(events, { limit: 5 });

    provenance[0]!.confidence = 0.1;
    provenance[0]!.span = [10, 20];

    expect(citations).to.deep.equal([{ sourceId: "DocA", type: "file", confidence: 0.7, span: [0, 10] }]);
  });
});
