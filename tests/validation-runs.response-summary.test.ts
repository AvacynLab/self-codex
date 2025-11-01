import { expect } from "chai";

import {
  buildTransportFailureSummary,
  parseToolResponseText,
  summariseToolResponse,
} from "../validation_run/archives/20251007T184620Z/lib/responseSummary.js";
import { McpToolCallError, type ToolCallRecord } from "../validation_run/archives/20251007T184620Z/lib/mcpSession.js";

/** Utility factory producing a minimal MCP tool response for the sample harness. */
function createResponse(
  overrides: Partial<ToolCallRecord["response"]>,
): ToolCallRecord["response"] {
  return {
    isError: false,
    content: [],
    structuredContent: undefined,
    ...overrides,
  } as ToolCallRecord["response"];
}

describe("validation runs response summary helpers", () => {
  it("omits the structured field when the response lacks structured content", () => {
    const response = createResponse({
      content: [{ type: "text", text: '{"result":"ok"}' }],
      structuredContent: undefined,
    });

    const summary = summariseToolResponse(response);

    expect(summary).to.include({ isError: false, errorCode: null, hint: null });
    expect(summary.parsedText).to.deep.equal({ result: "ok" });
    expect("structured" in summary).to.equal(false);
  });

  it("retains structured content when the MCP tool returns a JSON payload", () => {
    const response = createResponse({ structuredContent: { value: 42 } });

    const summary = summariseToolResponse(response);

    expect(summary.structured).to.deep.equal({ value: 42 });
    expect(summary.parsedText).to.equal(undefined);
  });

  it("falls back to the raw textual payload when JSON parsing fails", () => {
    const response = createResponse({ content: [{ type: "text", text: "plain text" }] });

    const parsed = parseToolResponseText(response);

    expect(parsed.parsed).to.equal("plain text");
    expect(parsed.errorCode).to.equal(null);
    expect(parsed.hint).to.equal(null);
  });

  it("builds transport failure summaries without structured placeholders", () => {
    const underlying = new Error("network unavailable");
    const error = new McpToolCallError("transport failed", {
      traceId: "trace-transport-1",
      toolName: "tools/example",
      durationMs: 123,
      artefacts: { inputPath: "/tmp/input.json", outputPath: "/tmp/output.json" },
      cause: underlying,
    });

    const summary = buildTransportFailureSummary(error);

    expect(summary).to.include({ isError: true, errorCode: "transport_failure", hint: null });
    expect(summary.parsedText).to.be.an("object").that.includes({ message: "network unavailable" });
    expect("structured" in summary).to.equal(false);
  });
});
