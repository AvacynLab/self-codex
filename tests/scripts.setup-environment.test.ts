import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";

/**
 * The setup script drives most of the reproducibility guarantees documented in
 * AGENTS.md. These integration-style tests exercise the dry-run mode to ensure
 * the script keeps emitting the expected TOML configuration and background
 * process orchestration without mutating the working tree during CI runs.
 */
describe("setup environment script", () => {
  beforeEach(() => {
    process.env.CODEX_SCRIPT_TEST = "1";
    process.env.CODEX_SCRIPT_DRY_RUN = "1";
    process.env.MCP_HTTP_ENABLE = "1";
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    process.env.MCP_HTTP_PORT = "8080";
    process.env.MCP_HTTP_PATH = "/bridge";
    process.env.MCP_HTTP_JSON = "json";
    process.env.MCP_HTTP_STATELESS = "no";
    process.env.MCP_HTTP_TOKEN = "secret-token";
    process.env.START_MCP_BG = "1";
    process.env.MCP_FS_IPC_DIR = "~/.codex/ipc-tests";
    process.env.SEARCH_SEARX_BASE_URL = "http://localhost:8888";
    process.env.UNSTRUCTURED_BASE_URL = "http://localhost:9999";
    process.env.CODEX_NODE_VERSION_OVERRIDE = "20.10.0";
    delete globalThis.CODEX_SCRIPT_COMMANDS;
    delete globalThis.CODEX_SCRIPT_ENV;
    delete globalThis.CODEX_SCRIPT_CONFIG;
    delete globalThis.CODEX_SCRIPT_BACKGROUND;
    delete globalThis.CODEX_SCRIPT_SUMMARY;
    delete globalThis.CODEX_SCRIPT_RUNTIME;
    delete process.env.MCP_LOG_FILE;
    delete process.env.MCP_RUNS_ROOT;
  });

  afterEach(() => {
    delete process.env.CODEX_SCRIPT_TEST;
    delete process.env.CODEX_SCRIPT_DRY_RUN;
    delete process.env.MCP_HTTP_ENABLE;
    delete process.env.MCP_HTTP_HOST;
    delete process.env.MCP_HTTP_PORT;
    delete process.env.MCP_HTTP_PATH;
    delete process.env.MCP_HTTP_JSON;
    delete process.env.MCP_HTTP_STATELESS;
    delete process.env.MCP_HTTP_TOKEN;
    delete process.env.START_MCP_BG;
    delete process.env.MCP_FS_IPC_DIR;
    delete process.env.SEARCH_SEARX_BASE_URL;
    delete process.env.UNSTRUCTURED_BASE_URL;
    delete process.env.CODEX_NODE_VERSION_OVERRIDE;
    delete globalThis.CODEX_SCRIPT_COMMANDS;
    delete globalThis.CODEX_SCRIPT_ENV;
    delete globalThis.CODEX_SCRIPT_CONFIG;
    delete globalThis.CODEX_SCRIPT_BACKGROUND;
    delete globalThis.CODEX_SCRIPT_SUMMARY;
    delete globalThis.CODEX_SCRIPT_RUNTIME;
    delete process.env.MCP_LOG_FILE;
    delete process.env.MCP_RUNS_ROOT;
  });

  it("produces the expected TOML configuration and background orchestration", async () => {
    // Dynamic import ensures the script picks up the freshly configured env.
    const module = await import("../scripts/setup-environment.mjs");
    await module.runSetupEnvironment();

    const config = globalThis.CODEX_SCRIPT_CONFIG;
    expect(config, "config should be captured during dry-run").to.be.a("string");
    if (!config) {
      throw new Error("setup script did not capture the TOML configuration");
    }
    expect(config).to.include("[mcp_servers.self-codex-stdio]");
    expect(config).to.include("enabled = false");
    expect(config).to.include("[mcp_servers.self-codex-http]");
    expect(config).to.include("enabled = true");
    expect(config).to.include("host = \"0.0.0.0\"");
    expect(config).to.include("port = 8080");
    expect(config).to.include("path = \"/bridge\"");
    expect(config).to.include("token = \"secret-token\"");
    expect(config).to.include("MCP_HTTP_ENABLE = \"1\"");

    const envSnapshot = globalThis.CODEX_SCRIPT_ENV;
    expect(envSnapshot, "environment snapshot should be captured during dry-run").to.not.equal(undefined);
    if (!envSnapshot) {
      throw new Error("missing environment snapshot for setup script");
    }
    expect(envSnapshot.httpEnable).to.equal(true);
    expect(envSnapshot.httpHost).to.equal("0.0.0.0");
    expect(envSnapshot.fsBridgeDir).to.be.a("string").and.to.include(".codex");
    expect(envSnapshot.startMcpBg).to.equal(true);

    const actions = globalThis.CODEX_SCRIPT_BACKGROUND ?? [];
    expect(actions.some((item) => item.action === "spawn-attempt" && item.label === "http")).to.equal(true);
    expect(actions.some((item) => item.action === "spawn-attempt" && item.label === "fsbridge")).to.equal(true);
    expect(actions.some((item) => item.action === "ensure-dir" && String(item.path).endsWith("errors"))).to.equal(true);
    expect(
      actions
        .filter((item) => item.action === "spawn-attempt")
        .every((item) => typeof item.nodeOptions === "string" && item.nodeOptions.includes("--enable-source-maps")),
    ).to.equal(true);

    const summary = globalThis.CODEX_SCRIPT_SUMMARY;
    expect(summary).to.equal("HTTP OK + FS-Bridge actif");

    const commands = globalThis.CODEX_SCRIPT_COMMANDS ?? [];
    expect(commands.length).to.be.greaterThan(0);
    expect(commands.every((entry) => entry.nodeOptions?.includes("--enable-source-maps"))).to.equal(true);

    const runtime = globalThis.CODEX_SCRIPT_RUNTIME;
    expect(runtime, "runtime snapshot should be captured").to.not.equal(undefined);
    if (!runtime) {
      throw new Error("runtime snapshot missing");
    }
    expect(runtime.validationRunRoot).to.be.a("string").and.to.match(/validation_run$/);
    expect(runtime.validationRunLogs).to.be.a("string").and.to.match(/validation_run[\\/]+logs$/);
    expect(runtime.childrenRoot).to.be.a("string").and.to.match(/children$/);
    expect(runtime.runsRoot).to.equal(runtime.validationRunRoot);
    expect(runtime.logFile).to.equal(runtime.validationRunLogs + "/self-codex.log");
    expect(process.env.MCP_LOG_FILE).to.equal(runtime.logFile);
    expect(process.env.MCP_RUNS_ROOT).to.equal(runtime.runsRoot);

    expect(
      actions.some((item) => item.action === "ensure-dir" && /validation_run/.test(String(item.path))),
    ).to.equal(true);
    expect(actions.some((item) => item.action === "ensure-log-file")).to.equal(true);
    expect(actions.some((item) => item.action === "set-env" && item.key === "MCP_LOG_FILE")).to.equal(true);
    expect(actions.some((item) => item.action === "set-env" && item.key === "MCP_RUNS_ROOT")).to.equal(true);
  });

  it("warns when service endpoints are missing", async () => {
    delete process.env.SEARCH_SEARX_BASE_URL;
    delete process.env.UNSTRUCTURED_BASE_URL;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message, ...args) => {
      warnings.push([message, ...args].join(" "));
    };
    try {
      const module = await import("../scripts/setup-environment.mjs");
      await module.runSetupEnvironment();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).to.be.greaterThan(0);
    expect(warnings.some((entry) => entry.includes("SEARCH_SEARX_BASE_URL"))).to.equal(true);
    expect(warnings.some((entry) => entry.includes("UNSTRUCTURED_BASE_URL"))).to.equal(true);
    const actions = globalThis.CODEX_SCRIPT_BACKGROUND ?? [];
    expect(actions.some((item) => item.action === "warn" && item.keys?.includes("SEARCH_SEARX_BASE_URL"))).to.equal(true);
  });
});
