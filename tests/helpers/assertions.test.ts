import { expect } from "chai";

import type { BlackboardEntrySnapshot } from "../../src/coord/blackboard.js";
import type { EventEnvelope } from "../../src/events/bus.js";

import {
  assertArray,
  assertNumber,
  assertPlainObject,
  assertString,
  expectEventPayload,
  hasEventPayload,
} from "./assertions.js";

describe("helpers/assertions", () => {
  it("guards plain objects before dereferencing", () => {
    expect(() => assertPlainObject({ key: "value" }, "payload"), "plain object should pass").to.not.throw();
    expect(() => assertPlainObject(Object.create(null), "proto-less"), "proto-less objects should pass").to.not.throw();
    expect(() => assertPlainObject([], "array payload"), "arrays should be rejected").to.throw();
    expect(() => assertPlainObject(null, "null payload"), "null should be rejected").to.throw();
  });

  it("validates primitive assertions", () => {
    expect(() => assertArray<number>([1, 2, 3], "numbers"), "numeric array should pass").to.not.throw();
    expect(() => assertArray("oops", "string payload"), "non array should be rejected").to.throw();

    expect(() => assertString("value", "string payload"), "strings should pass").to.not.throw();
    expect(() => assertString(42, "number payload"), "non string should be rejected").to.throw();

    expect(() => assertNumber(1.5, "numeric payload"), "numbers should pass").to.not.throw();
    expect(() => assertNumber("1.5", "string payload"), "non number should be rejected").to.throw();
  });

  it("extracts typed event payloads", () => {
    const entry: BlackboardEntrySnapshot = {
      key: "knowledge-base",
      value: { answer: 42 },
      tags: ["memory"],
      createdAt: 100,
      updatedAt: 200,
      expiresAt: null,
      version: 3,
    };

    const envelope: EventEnvelope<"bb_set"> = {
      seq: 1,
      ts: 1234,
      cat: "bb",
      level: "info",
      jobId: "job-1",
      runId: "run-1",
      opId: "op-1",
      graphId: "graph-1",
      nodeId: "node-1",
      childId: "child-1",
      component: "blackboard",
      stage: "mutation",
      elapsedMs: null,
      kind: "BB_EVENT",
      msg: "bb_set",
      data: {
        kind: "set",
        key: entry.key,
        version: entry.version,
        timestamp: entry.updatedAt,
        reason: null,
        entry,
        previous: null,
      },
    };

    expect(hasEventPayload(envelope, "bb_set"), "bb_set payload should be detected").to.equal(true);
    expect(hasEventPayload(envelope, "bb_delete"), "other messages should not match").to.equal(false);

    const payload = expectEventPayload(envelope, "bb_set");
    expect(payload.kind).to.equal("set");
    expect(payload.entry?.key).to.equal("knowledge-base");

    expect(() => expectEventPayload(envelope, "bb_delete"), "mismatched messages should throw").to.throw();
  });
});
