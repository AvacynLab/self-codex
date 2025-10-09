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
    process.env.CODEX_NODE_VERSION_OVERRIDE = "20.10.0";
    delete (globalThis as any).CODEX_SCRIPT_COMMANDS;
    delete (globalThis as any).CODEX_SCRIPT_ENV;
    delete (globalThis as any).CODEX_SCRIPT_CONFIG;
    delete (globalThis as any).CODEX_SCRIPT_BACKGROUND;
    delete (globalThis as any).CODEX_SCRIPT_SUMMARY;
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
    delete process.env.CODEX_NODE_VERSION_OVERRIDE;
    delete (globalThis as any).CODEX_SCRIPT_COMMANDS;
    delete (globalThis as any).CODEX_SCRIPT_ENV;
    delete (globalThis as any).CODEX_SCRIPT_CONFIG;
    delete (globalThis as any).CODEX_SCRIPT_BACKGROUND;
    delete (globalThis as any).CODEX_SCRIPT_SUMMARY;
  });

  it("produces the expected TOML configuration and background orchestration", async () => {
    // Dynamic import ensures the script picks up the freshly configured env.
    const module = await import("../scripts/setup-environment.mjs");
    await module.runSetupEnvironment();

    const config = (globalThis as any).CODEX_SCRIPT_CONFIG as string;
    expect(config, "config should be captured during dry-run").to.be.a("string");
    expect(config).to.include("[mcp_servers.self-codex-stdio]");
    expect(config).to.include("enabled = false");
    expect(config).to.include("[mcp_servers.self-codex-http]");
    expect(config).to.include("enabled = true");
    expect(config).to.include("host = \"0.0.0.0\"");
    expect(config).to.include("port = 8080");
    expect(config).to.include("path = \"/bridge\"");
    expect(config).to.include("token = \"secret-token\"");
    expect(config).to.include("MCP_HTTP_ENABLE = \"1\"");

    const envSnapshot = (globalThis as any).CODEX_SCRIPT_ENV;
    expect(envSnapshot.httpEnable).to.equal(true);
    expect(envSnapshot.httpHost).to.equal("0.0.0.0");
    expect(envSnapshot.fsBridgeDir).to.be.a("string").and.to.include(".codex");
    expect(envSnapshot.startMcpBg).to.equal(true);

    const actions = ((globalThis as any).CODEX_SCRIPT_BACKGROUND ?? []) as Array<Record<string, unknown>>;
    expect(actions.some((item) => item.action === "spawn-attempt" && item.label === "http")).to.equal(true);
    expect(actions.some((item) => item.action === "spawn-attempt" && item.label === "fsbridge")).to.equal(true);
    expect(actions.some((item) => item.action === "ensure-dir" && String(item.path).endsWith("errors"))).to.equal(true);
    expect(
      actions
        .filter((item) => item.action === "spawn-attempt")
        .every((item) => typeof item.nodeOptions === "string" && item.nodeOptions.includes("--enable-source-maps")),
    ).to.equal(true);

    const summary = (globalThis as any).CODEX_SCRIPT_SUMMARY;
    expect(summary).to.equal("HTTP OK + FS-Bridge actif");

    const commands = ((globalThis as any).CODEX_SCRIPT_COMMANDS ?? []) as Array<{ nodeOptions?: string }>;
    expect(commands.length).to.be.greaterThan(0);
    expect(commands.every((entry) => entry.nodeOptions?.includes("--enable-source-maps"))).to.equal(true);
  });
});
