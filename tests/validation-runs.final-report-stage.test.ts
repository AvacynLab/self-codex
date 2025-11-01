import { describe, it } from "mocha";
import { expect } from "chai";

import { __testing } from "../validation_run/archives/20251007T184620Z/lib/finalReport.js";

/**
 * Regression coverage verifying the sample final report harness rethrows
 * filesystem errors without introducing `cause: undefined` placeholders.
 */
describe("validation runs final report stage helpers", () => {
  it("preserves the original cause when wrapping filesystem errors", () => {
    const underlying = new Error("permission denied");

    expect(() => __testing.rethrowReadJsonError("/tmp/report.json", underlying))
      .to.throw(Error)
      .that.satisfies((wrapped: Error & { cause?: unknown }) => {
        expect(wrapped.cause).to.equal(underlying);
        expect(wrapped.message).to.contain("permission denied");
        return true;
      });
  });

  it("omits synthetic causes when the thrown value is not an Error", () => {
    try {
      __testing.rethrowReadJsonError("/tmp/report.json", "fatal: broken pipe");
      expect.fail("Expected the helper to rethrow");
    } catch (error) {
      const wrapped = error as Error & { cause?: unknown };
      expect(wrapped).to.be.instanceOf(Error);
      expect(wrapped.message).to.contain("fatal: broken pipe");
      expect("cause" in wrapped ? wrapped.cause : undefined).to.equal(undefined);
    }
  });
});
