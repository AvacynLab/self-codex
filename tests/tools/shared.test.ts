import { describe, it } from "mocha";
import { expect } from "chai";

import { cloneDefinedRecord, formatBudgetUsage, withOptionalProperty } from "../../src/tools/shared.js";
import type { BudgetCharge } from "@modelcontextprotocol/sdk/types.js";

describe("tooling shared helpers", () => {
  it("returns an empty object when the optional value is undefined", () => {
    const payload = withOptionalProperty("label", undefined);
    expect(payload).to.deep.equal({});
    expect(Object.prototype.hasOwnProperty.call(payload, "label")).to.equal(false);
  });

  it("creates a record containing the provided key when the value is set", () => {
    const payload = withOptionalProperty("weight", 3);
    expect(payload).to.deep.equal({ weight: 3 });
  });

  it("clones defined records while preserving undefined inputs", () => {
    const source = { label: "lint", weight: 2 } as Record<string, unknown> | undefined;
    const clone = cloneDefinedRecord(source);
    expect(clone).to.not.equal(source);
    expect(clone).to.deep.equal(source);

    const undefinedClone = cloneDefinedRecord(undefined);
    expect(undefinedClone).to.equal(undefined);
  });

  it("performs shallow clones so nested references match historical behaviour", () => {
    const nested = { a: { count: 1 } };
    const clone = cloneDefinedRecord(nested);
    expect(clone).to.not.equal(nested);
    expect(clone?.a).to.equal(nested.a);
    if (clone) {
      clone.a.count = 2;
    }
    expect(nested.a.count).to.equal(2);
  });

  it("omits dimensions when the budget tracker did not consume them", () => {
    const usage = formatBudgetUsage(null);
    expect(usage).to.equal(undefined);

    const zeroUsage = formatBudgetUsage({
      timeMs: 0,
      tokens: 0,
      toolCalls: 0,
      bytesIn: 0,
      bytesOut: 0,
    } satisfies BudgetCharge);
    expect(zeroUsage).to.equal(undefined);
  });

  it("rounds non-zero dimensions and preserves snake_case keys", () => {
    const usage = formatBudgetUsage({
      timeMs: 12.4,
      tokens: 3.6,
      toolCalls: 1,
      bytesIn: 96.2,
      bytesOut: 41.8,
    } satisfies BudgetCharge);

    expect(usage).to.deep.equal({
      time_ms: 12,
      tokens: 4,
      tool_calls: 1,
      bytes_in: 96,
      bytes_out: 42,
    });
  });
});
