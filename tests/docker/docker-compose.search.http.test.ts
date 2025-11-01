import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it } from "mocha";
import { expect } from "chai";
import { parse } from "yaml";

/**
 * Guards against regressions where the orchestrator container starts without
 * the HTTP transport enabled. The search smoke tests rely on `/healthz` to
 * determine readiness, therefore the Compose manifest must invoke the server
 * with the appropriate CLI flags.
 */
describe("docker/docker-compose.search.yml (orchestrator HTTP command)", () => {
  it("starts the orchestrator with HTTP enabled", () => {
    const manifestPath = join("docker", "docker-compose.search.yml");
    const yamlContent = readFileSync(manifestPath, "utf8");
    const manifest = parse(yamlContent) as { services?: Record<string, unknown> };
    const server = manifest.services?.server as { command?: unknown } | undefined;
    const command = Array.isArray(server?.command) ? (server?.command as string[]) : [];

    expect(command, "server.command must list CLI arguments").to.be.an("array").that.is.not.empty;
    expect(command).to.include("--http");
    expect(command).to.include("--http-host");
    expect(command).to.include("--http-port");
    expect(command).to.include("--http-path");
  });
});
