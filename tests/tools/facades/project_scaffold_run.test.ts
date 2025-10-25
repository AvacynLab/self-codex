import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect } from "chai";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { BudgetTracker } from "../../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { StructuredLogger, type LogEntry } from "../../../src/logger.js";
import { IdempotencyRegistry } from "../../../src/infra/idempotency.js";
import {
  PROJECT_SCAFFOLD_RUN_TOOL_NAME,
  createProjectScaffoldRunHandler,
} from "../../../src/tools/project_scaffold_run.js";

function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("project_scaffold_run tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("project_scaffold_run tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("project_scaffold_run facade", () => {
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (workspaceRoot) {
      await rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = undefined;
    }
  });

  it("prepares the validation run layout and returns the directories", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "project-scaffold-success-"));
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const idempotency = new IdempotencyRegistry();
    const handler = createProjectScaffoldRunHandler({
      logger,
      workspaceRoot,
      idempotency,
    });
    const extras = createRequestExtras("req-project-success");
    const budget = new BudgetTracker({ toolCalls: 2 });

    const result = await runWithRpcTrace(
      {
        method: `tools/${PROJECT_SCAFFOLD_RUN_TOOL_NAME}`,
        traceId: "trace-project-success",
        requestId: extras.requestId,
      },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ iso_date: "2025-10-14", create_gitkeep_files: true, metadata: { initiator: "test" } }, extras),
        ),
    );

    expect(result.isError).to.equal(false);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.run_id).to.equal("validation_2025-10-14");
    expect(structured.details.workspace_root).to.equal(workspaceRoot);
    expect(structured.details.idempotent).to.equal(false);
    expect(structured.details.directories.inputs).to.be.a("string");

    const directories = structured.details.directories as Record<string, string>;
    for (const path of Object.values(directories)) {
      const stats = await stat(path);
      expect(stats.isDirectory()).to.equal(true);
    }

    const gitkeepFiles = await readdir(directories.inputs);
    expect(gitkeepFiles).to.include(".gitkeep");

    const completionLog = entries.find((entry) => entry.message === "project_scaffold_run_completed");
    expect(completionLog?.request_id).to.equal("req-project-success");
    expect(completionLog?.payload?.run_id).to.equal("validation_2025-10-14");
  });

  it("replays the cached layout when the idempotency key matches", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "project-scaffold-idempotent-"));
    const logger = new StructuredLogger();
    const idempotency = new IdempotencyRegistry();
    const handler = createProjectScaffoldRunHandler({
      logger,
      workspaceRoot,
      idempotency,
    });
    const extras = createRequestExtras("req-project-idempotent");
    const budget = new BudgetTracker({ toolCalls: 4 });

    const first = await runWithRpcTrace(
      {
        method: `tools/${PROJECT_SCAFFOLD_RUN_TOOL_NAME}`,
        traceId: "trace-project-idempotent-1",
        requestId: extras.requestId,
      },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ idempotency_key: "scaffold-1" }, extras),
        ),
    );
    const firstStructured = first.structuredContent as Record<string, any>;
    expect(firstStructured.ok).to.equal(true);
    expect(firstStructured.details.idempotent).to.equal(false);

    const second = await runWithRpcTrace(
      {
        method: `tools/${PROJECT_SCAFFOLD_RUN_TOOL_NAME}`,
        traceId: "trace-project-idempotent-2",
        requestId: extras.requestId,
      },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ idempotency_key: "scaffold-1" }, extras),
        ),
    );
    const secondStructured = second.structuredContent as Record<string, any>;
    expect(secondStructured.ok).to.equal(true);
    expect(secondStructured.details.idempotent).to.equal(true);
  });

  it("returns structured diagnostics when the workspace escapes the sandbox", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "project-scaffold-invalid-"));
    const logger = new StructuredLogger();
    const handler = createProjectScaffoldRunHandler({
      logger,
      workspaceRoot,
    });
    const extras = createRequestExtras("req-project-invalid");
    const budget = new BudgetTracker({ toolCalls: 2 });

    const result = await runWithRpcTrace(
      {
        method: `tools/${PROJECT_SCAFFOLD_RUN_TOOL_NAME}`,
        traceId: "trace-project-invalid",
        requestId: extras.requestId,
      },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ workspace_root: "../outside" }, extras),
        ),
    );

    expect(result.isError).to.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.details.error.reason).to.equal("invalid_workspace");
    expect(structured.details.error.message).to.be.a("string");
  });

  it("reports a budget diagnostic when tool call credits are exhausted", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "project-scaffold-budget-"));
    const logger = new StructuredLogger();
    const handler = createProjectScaffoldRunHandler({
      logger,
      workspaceRoot,
    });
    const extras = createRequestExtras("req-project-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      {
        method: `tools/${PROJECT_SCAFFOLD_RUN_TOOL_NAME}`,
        traceId: "trace-project-budget",
        requestId: extras.requestId,
      },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler({}, extras)),
    );

    expect(result.isError).to.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.details.budget.reason).to.equal("budget_exhausted");
  });
});
