import { expect } from "chai";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { StructuredLogger } from "../../../src/logger.js";
import { createSearchStatusHandler, SEARCH_STATUS_TOOL_NAME } from "../../../src/tools/search_status.js";

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("search_status tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("search_status tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("search.status facade", () => {
  it("returns a not-implemented payload", async () => {
    const logger = new StructuredLogger();
    const handler = createSearchStatusHandler({ logger });
    const extras = createRequestExtras("req-search-status");

    const result = await runWithRpcTrace(
      { method: `tools/${SEARCH_STATUS_TOOL_NAME}`, traceId: "trace-search-status", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId }, () =>
          handler(
            {
              job_id: "job-unknown",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(false);
    expect(structured.ok).to.equal(false);
    expect(structured.code).to.equal("not_implemented");
    expect(structured.message).to.be.a("string").and.to.have.length.greaterThan(0);
  });
});
