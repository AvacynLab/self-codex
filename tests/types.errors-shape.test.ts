import { describe, it } from "mocha";
import { expect } from "chai";

import { ERROR_CATALOG, ERROR_CODES, fail } from "../src/types.js";

describe("types error catalogue", () => {
  it("exposes the mandated error families", () => {
    const families = Object.keys(ERROR_CATALOG);
    expect(families).to.include.members([
      "MCP",
      "RES",
      "EVT",
      "CANCEL",
      "BULK",
      "TX",
      "LOCK",
      "PATCH",
      "PLAN",
      "CHILD",
      "VALUES",
      "ASSIST",
    ]);
  });

  it("keeps codes aligned with their family prefix", () => {
    for (const [family, codes] of Object.entries(ERROR_CATALOG)) {
      for (const code of Object.values(codes)) {
        expect(code.startsWith(`E-${family}-`)).to.equal(
          true,
          `${code} should start with E-${family}-`,
        );
      }
    }
  });

  it("flattens the catalogue without losing any entry", () => {
    const catalogCodes = new Set(
      Object.values(ERROR_CATALOG).flatMap((family) => Object.values(family)),
    );
    const flattenedCodes = new Set(Object.values(ERROR_CODES));

    expect(Object.isFrozen(ERROR_CODES)).to.be.true;
    expect(flattenedCodes.size).to.equal(catalogCodes.size);
    for (const code of catalogCodes) {
      expect(flattenedCodes.has(code)).to.equal(true, `${code} missing from flattened map`);
    }
  });

  it("provides a helper to build canonical failures", () => {
    const withoutHint = fail(ERROR_CATALOG.PLAN.STATE, "illegal transition");
    expect(withoutHint).to.deep.equal({
      ok: false,
      code: ERROR_CATALOG.PLAN.STATE,
      message: "illegal transition",
    });

    const withHint = fail(ERROR_CATALOG.CANCEL.NOT_FOUND, "unknown opId", "verify opId via events_subscribe");
    expect(withHint).to.deep.equal({
      ok: false,
      code: ERROR_CATALOG.CANCEL.NOT_FOUND,
      message: "unknown opId",
      hint: "verify opId via events_subscribe",
    });
  });
});
