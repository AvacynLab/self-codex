import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { writeCliOutput } from "./cliOutput.js";

describe("helpers/cliOutput", () => {
  const originalWrite = process.stdout.write;

  afterEach(() => {
    process.stdout.write = originalWrite;
    sinon.restore();
  });

  it("writes joined lines with a trailing newline", () => {
    const writeSpy = sinon.spy();
    process.stdout.write = writeSpy as unknown as typeof process.stdout.write;

    writeCliOutput(["first", "second"]);

    expect(writeSpy.callCount).to.equal(1);
    expect(writeSpy.firstCall.args[0]).to.equal("first\nsecond\n");
  });

  it("preserves an existing trailing newline", () => {
    const writeSpy = sinon.spy();
    process.stdout.write = writeSpy as unknown as typeof process.stdout.write;

    writeCliOutput("already formatted\n");

    expect(writeSpy.callCount).to.equal(1);
    expect(writeSpy.firstCall.args[0]).to.equal("already formatted\n");
  });
});
