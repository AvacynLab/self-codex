import { describe, it } from "mocha";
import { expect } from "chai";

/**
 * These tests validate the helper powering `npm run test:e2e:http`.  By keeping
 * the assertions close to the script we guarantee CI maintains the guard flag
 * required for HTTP suites and that extra Mocha arguments are forwarded without
 * alteration.
 */
describe("scripts/run-http-e2e", () => {
  it("forces the loopback guard and exposes the mocha invocation", async () => {
    const { createHttpE2ERunner } = await import("../scripts/run-http-e2e.mjs");
    const invocation = createHttpE2ERunner();

    expect(invocation.command).to.equal(process.execPath);
    expect(invocation.args).to.include("tests/e2e/**/*.test.ts");
    expect(invocation.env).to.have.property("MCP_TEST_ALLOW_LOOPBACK", "yes");
    expect(
      Object.values(invocation.env).every((value) => value !== undefined),
      "env clone should not expose undefined values",
    ).to.equal(true);
  });

  it("forwards additional mocha flags verbatim", async () => {
    const { createHttpE2ERunner } = await import("../scripts/run-http-e2e.mjs");
    const invocation = createHttpE2ERunner(["--grep", "http"]);

    expect(invocation.args.slice(-2)).to.deep.equal(["--grep", "http"]);
  });
});
