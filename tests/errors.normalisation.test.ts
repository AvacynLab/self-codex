import { describe, it } from "mocha";
import { expect } from "chai";
import { z } from "zod";

import {
  ERROR_TEXT_MAX_LENGTH,
  fail,
  normaliseErrorHint,
  normaliseErrorMessage,
} from "../src/types.js";
import { normaliseToolError } from "../src/server/toolErrors.js";

/**
 * Unit tests covering the error message and hint normalisation logic. Keeping the
 * assertions explicit helps prevent regressions whenever new error helpers are
 * added or existing ones evolve to cover additional use cases.
 */
describe("error normalisation helpers", () => {
  it("collapses whitespace and enforces the maximum length on messages", () => {
    const messy = "  multi\nline\tmessage   with   spacing   issues  ";
    expect(normaliseErrorMessage(messy)).to.equal("multi line message with spacing issues");

    const oversized = "X".repeat(ERROR_TEXT_MAX_LENGTH + 12);
    const truncated = normaliseErrorMessage(oversized);
    expect(truncated.length).to.equal(ERROR_TEXT_MAX_LENGTH);
    expect(truncated.endsWith("…")).to.equal(true);
  });

  it("drops empty hints and trims or truncates longer ones", () => {
    expect(normaliseErrorHint("   ")).to.equal(undefined);
    expect(normaliseErrorHint("   retry   later  ")).to.equal("retry later");

    const longHint = "R".repeat(ERROR_TEXT_MAX_LENGTH + 5);
    const truncated = normaliseErrorHint(longHint);
    expect(truncated).to.not.equal(undefined);
    expect(truncated!.length).to.equal(ERROR_TEXT_MAX_LENGTH);
    expect(truncated!.endsWith("…")).to.equal(true);
  });

  it("ensures fail() responses use the normalised message and hint", () => {
    const longMessage = "Unexpected failure due to downstream issue".repeat(5);
    const result = fail("E-GRAPH-UNEXPECTED", `${longMessage}\n`, "  consult logs for details   ");
    expect(result.message.length).to.equal(ERROR_TEXT_MAX_LENGTH);
    expect(result.message.endsWith("…")).to.equal(true);
    expect(result.hint).to.equal("consult logs for details");
  });

  it("normalises arbitrary thrown errors including validation failures", () => {
    const parseResult = z.object({ id: z.string().uuid() }).safeParse({ id: "not-a-uuid" });
    if (parseResult.success) {
      throw new Error("expected validation to fail so the error normaliser is exercised");
    }
    const zodError = parseResult.error;

    const validation = normaliseToolError(zodError, {
      defaultCode: "E-GENERIC",
      invalidInputCode: "E-GENERIC-INVALID",
    });
    expect(validation.code).to.equal("E-GENERIC-INVALID");
    expect(validation.hint).to.equal("invalid_input");
    expect(validation.message.length).to.be.at.most(ERROR_TEXT_MAX_LENGTH);

    const blankError = normaliseToolError(new Error("   \n\t"), {
      defaultCode: "E-GENERIC",
    });
    expect(blankError.message).to.equal("unexpected error");
  });
});
