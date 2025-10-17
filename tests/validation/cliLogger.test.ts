import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { createCliStructuredLogger } from "../../src/validation/cliLogger.js";

/** Unit coverage for the validation CLI structured logging bridge. */
describe("createCliStructuredLogger", () => {
  let stdoutStub: sinon.SinonStub;

  beforeEach(() => {
    stdoutStub = sinon.stub(process.stdout, "write");
  });

  afterEach(() => {
    stdoutStub.restore();
  });

  it("mirrors console.log calls as structured info entries", async () => {
    const bridge = createCliStructuredLogger("plan_stage");

    bridge.console.log("summary", { ok: true });
    await bridge.logger.flush();

    expect(bridge.entries).to.deep.equal([
      {
        stage: "plan_stage",
        level: "info",
        text: "summary { ok: true }",
        raw: ["summary", { ok: true }],
      },
    ]);

    expect(stdoutStub.callCount).to.equal(1);
    const [payload] = stdoutStub.getCall(0).args;
    const parsed = JSON.parse(String(payload));
    expect(parsed.message).to.equal("validation_cli_console");
    expect(parsed.payload).to.deep.equal({ stage: "plan_stage", text: "summary { ok: true }" });
  });

  it("uses warning severity for console.warn entries", async () => {
    const bridge = createCliStructuredLogger("robustness_stage");

    bridge.console.warn("Artifacts missing");
    await bridge.logger.flush();

    expect(bridge.entries[0]?.level).to.equal("warn");
    const [payload] = stdoutStub.getCall(0).args;
    const parsed = JSON.parse(String(payload));
    expect(parsed.level).to.equal("warn");
  });

  it("records errors with descriptive text", async () => {
    const bridge = createCliStructuredLogger("security_stage");

    bridge.console.error("Failed", new Error("network"));
    await bridge.logger.flush();

    expect(bridge.entries[0]?.text).to.contain("Failed");
    const [payload] = stdoutStub.getCall(0).args;
    const parsed = JSON.parse(String(payload));
    expect(parsed.level).to.equal("error");
    expect(parsed.payload.text).to.contain("network");
  });
});
