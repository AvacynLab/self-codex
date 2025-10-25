import { expect } from "chai";

import {
  buildToolErrorResult,
  buildToolResponse,
  buildToolSuccessResult,
} from "../../src/tools/shared.js";

/**
 * Regression tests for the shared MCP tool envelope helpers. The suite ensures the
 * helpers keep emitting consistent structures (`isError`, textual content and
 * structured payload references) so façade handlers never regress subtly when
 * formatting responses.
 */
describe("tools/shared MCP envelope helpers", () => {
  it("returns a success envelope with a single text chunk and shared structured payload", () => {
    const structured = {
      ok: true,
      summary: "succès",
      details: {
        job_id: "job-tools-success",
        child_id: "child-alpha",
      },
    } as const;
    const text = "{\n  \"tool\": \"example\",\n  \"ok\": true\n}";

    const result = buildToolSuccessResult(text, structured);

    // Successful helpers must explicitly mark the envelope as non-errored so
    // downstream tests can assert `isError === false` uniformly.
    expect(result.isError).to.equal(false);
    // The textual channel must contain exactly one chunk with the provided payload.
    expect(result.content).to.have.lengthOf(1);
    expect(result.content[0]).to.deep.equal({ type: "text", text });
    // The structured payload should be forwarded by reference to avoid hidden clones.
    expect(result.structuredContent).to.equal(structured);
  });

  it("returns an error envelope when the operation fails", () => {
    const structured = {
      ok: false,
      summary: "échec",
      details: {
        reason: "invalid_input",
        retryable: false,
      },
    } as const;
    const text = "{\n  \"tool\": \"example\",\n  \"ok\": false\n}";

    const result = buildToolErrorResult(text, structured);

    // Error helpers must flag the envelope as an error so caller retries remain deterministic.
    expect(result.isError).to.equal(true);
    expect(result.content).to.have.lengthOf(1);
    expect(result.content[0]).to.deep.equal({ type: "text", text });
    expect(result.structuredContent).to.equal(structured);
  });

  it("allows the low-level builder to propagate explicit error states", () => {
    const structured = {
      ok: true,
      details: { note: "custom" },
    } as const;

    const success = buildToolResponse({
      text: "payload",
      structured,
      isError: false,
    });
    expect(success.isError).to.equal(false);

    const failure = buildToolResponse({
      text: "payload",
      structured,
      isError: true,
    });
    expect(failure.isError).to.equal(true);
    // Regardless of the branch, the textual content must stay consistent.
    expect(success.content[0]).to.deep.equal({ type: "text", text: "payload" });
    expect(failure.content[0]).to.deep.equal({ type: "text", text: "payload" });
  });
});
