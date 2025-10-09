import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Mirrors the integration coverage for the environment setup script but
 * targets the maintenance workflow (rebuild + restart + healthcheck). Running
 * the script in dry-run mode allows us to assert on the orchestrated side
 * effects without touching the working tree.
 */
describe("maintenance script", () => {
  beforeEach(() => {
    process.env.CODEX_SCRIPT_TEST = "1";
    process.env.CODEX_SCRIPT_DRY_RUN = "1";
    process.env.MCP_HTTP_ENABLE = "1";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = "8765";
    process.env.MCP_HTTP_PATH = "/mcp";
    process.env.MCP_HTTP_JSON = "on";
    process.env.MCP_HTTP_STATELESS = "yes";
    process.env.MCP_HTTP_TOKEN = "";
    process.env.MCP_FS_IPC_DIR = "~/.codex/ipc-tests";
    process.env.CODEX_NODE_VERSION_OVERRIDE = "20.10.0";
    const projectRoot = process.cwd();
    writeFileSync(join(projectRoot, ".mcp_http.pid"), "1234\n", "utf8");
    writeFileSync(join(projectRoot, ".mcp_fsbridge.pid"), "5678\n", "utf8");
    delete (globalThis as any).CODEX_MAINTENANCE_COMMANDS;
    delete (globalThis as any).CODEX_MAINTENANCE_ENV;
    delete (globalThis as any).CODEX_MAINTENANCE_ACTIONS;
    delete (globalThis as any).CODEX_MAINTENANCE_STATUS;
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
    delete process.env.MCP_FS_IPC_DIR;
    delete process.env.CODEX_NODE_VERSION_OVERRIDE;
    const projectRoot = process.cwd();
    if (existsSync(join(projectRoot, ".mcp_http.pid"))) {
      unlinkSync(join(projectRoot, ".mcp_http.pid"));
    }
    if (existsSync(join(projectRoot, ".mcp_fsbridge.pid"))) {
      unlinkSync(join(projectRoot, ".mcp_fsbridge.pid"));
    }
    delete (globalThis as any).CODEX_MAINTENANCE_COMMANDS;
    delete (globalThis as any).CODEX_MAINTENANCE_ENV;
    delete (globalThis as any).CODEX_MAINTENANCE_ACTIONS;
    delete (globalThis as any).CODEX_MAINTENANCE_STATUS;
  });

  it("rebuilds and restarts transports in dry-run mode", async () => {
    const module = await import("../scripts/maintenance.mjs");
    await module.runMaintenance();

    const commands = (globalThis as any).CODEX_MAINTENANCE_COMMANDS as Array<{ command: string; args: string[] }>;
    const npmCommands = commands.filter((entry) => entry.command === "npm");
    expect(npmCommands.some((entry) => entry.args?.[0] === "ci" || entry.args?.[0] === "install")).to.equal(true);
    expect(npmCommands.some((entry) => entry.args?.[0] === "install" && entry.args?.[1] === "@types/node@latest")).to.equal(true);
    expect(npmCommands.some((entry) => entry.args?.[0] === "run" && entry.args?.[1] === "build")).to.equal(true);

    const actions = ((globalThis as any).CODEX_MAINTENANCE_ACTIONS ?? []) as Array<Record<string, unknown>>;
    expect(actions.some((item) => item.action === "kill" && item.label === "http")).to.equal(true);
    expect(actions.some((item) => item.action === "spawn-attempt" && item.label === "http")).to.equal(true);
    expect(actions.some((item) => item.action === "spawn-attempt" && item.label === "fsbridge")).to.equal(true);
    expect(
      actions
        .filter((item) => item.action === "spawn-attempt")
        .every((item) => typeof item.nodeOptions === "string" && item.nodeOptions.includes("--enable-source-maps")),
    ).to.equal(true);

    const status = (globalThis as any).CODEX_MAINTENANCE_STATUS;
    expect(status).to.equal("HTTP OK");

    expect(
      npmCommands.every((entry) => entry.nodeOptions?.includes("--enable-source-maps")),
    ).to.equal(true);
  });
});
