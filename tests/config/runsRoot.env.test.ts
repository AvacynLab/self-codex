import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";

import { __pathInternals } from "../../src/paths.js";
import { __walInternals } from "../../src/state/wal.js";
import { __snapshotInternals } from "../../src/state/snapshot.js";
import { prepareHttpRuntime, __httpBootstrapInternals } from "../../src/http/bootstrap.js";
import { __registryInternals } from "../../src/mcp/registry.js";
import { StructuredLogger } from "../../src/logger.js";
import { EventStore } from "../../src/eventStore.js";
import type { HttpRuntimeOptions } from "../../src/serverOptions.js";

const ORIGINAL_RUNS_ROOT = process.env.MCP_RUNS_ROOT;
const ORIGINAL_CHILDREN_ROOT = process.env.MCP_CHILDREN_ROOT;

afterEach(() => {
  if (ORIGINAL_RUNS_ROOT === undefined) {
    delete process.env.MCP_RUNS_ROOT;
  } else {
    process.env.MCP_RUNS_ROOT = ORIGINAL_RUNS_ROOT;
  }

  if (ORIGINAL_CHILDREN_ROOT === undefined) {
    delete process.env.MCP_CHILDREN_ROOT;
  } else {
    process.env.MCP_CHILDREN_ROOT = ORIGINAL_CHILDREN_ROOT;
  }
});

describe("runs root environment overrides", () => {
  it("trims MCP_RUNS_ROOT for generic path helpers", () => {
    process.env.MCP_RUNS_ROOT = "  ./custom-runs  ";

    const resolved = __pathInternals.getRunsRoot();
    expect(resolved).to.equal(path.resolve(process.cwd(), "./custom-runs"));
  });

  it("ignores blank MCP_CHILDREN_ROOT overrides", () => {
    process.env.MCP_CHILDREN_ROOT = "   ";

    const resolved = __pathInternals.getChildrenRoot();
    expect(resolved).to.equal(path.resolve(process.cwd(), "children"));
  });

  it("applies trimmed MCP_RUNS_ROOT for WAL persistence", () => {
    process.env.MCP_RUNS_ROOT = " runs-history ";

    const resolved = __walInternals.resolveRunsRoot();
    expect(resolved).to.equal(path.resolve(process.cwd(), "runs-history"));
  });

  it("applies trimmed MCP_RUNS_ROOT for snapshot directories", () => {
    process.env.MCP_RUNS_ROOT = " snapshots ";

    const resolved = __snapshotInternals.resolveRunsRoot();
    expect(resolved).to.equal(path.resolve(process.cwd(), "snapshots"));
  });

  it("propagates trimmed MCP_RUNS_ROOT through HTTP bootstrap", async () => {
    process.env.MCP_RUNS_ROOT = "  http-state  ";

    const logger = new StructuredLogger({ onEntry: () => undefined });
    const eventStore = new EventStore({ maxHistory: 8, logger });
    const options: HttpRuntimeOptions = {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      enableJson: true,
      stateless: false,
    };

    const prepared = await prepareHttpRuntime({ options, logger, eventStore });
    expect(prepared.runsRoot).to.equal(path.resolve(process.cwd(), "http-state"));

    // Ensure the default resolver remains deterministic for callers passing overrides directly.
    const direct = __httpBootstrapInternals.defaultResolveRunsRoot(process.cwd(), " ./explicit ");
    expect(direct).to.equal(path.resolve(process.cwd(), " ./explicit "));
  });

  it("uses trimmed MCP_RUNS_ROOT inside the tool registry", () => {
    process.env.MCP_RUNS_ROOT = " registry ";

    const resolved = __registryInternals.resolveRunsRoot();
    expect(resolved).to.equal(path.resolve(process.cwd(), "registry"));
  });
});
