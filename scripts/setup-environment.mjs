#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectRoot = dirname(fileURLToPath(new URL("../", import.meta.url)));
const execFileAsync = (cmd, args) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(cmd, args, { stdio: "inherit", cwd: projectRoot });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
const hasLockFile =
  existsSync(join(projectRoot, "package-lock.json")) ||
  existsSync(join(projectRoot, "npm-shrinkwrap.json"));

const installArgs = hasLockFile ? ["ci"] : ["install"];

console.log(`[setup] Installing dependencies via npm ${installArgs.join(" ")}`);
await execFileAsync("npm", installArgs);

console.log("[setup] Building TypeScript sources");
await execFileAsync("npm", ["run", "build"]);

const configDir = resolve(process.env.HOME ?? "", ".codex");
mkdirSync(configDir, { recursive: true });

const serverPath = join(projectRoot, "dist", "server.js");
const tomlPath = join(configDir, "config.toml");
const tomlContent = `[[servers]]
name = "self-fork"
command = "node"
args = ["${serverPath.replace(/\\/g, "\\\\")}"]
transport = "stdio"
# Pour exposer HTTP, utilisez l'adaptateur mcp-proxy et le script npm run start:http.
`;

writeFileSync(tomlPath, tomlContent, "utf8");
console.log(`[setup] Configuration Codex écrite dans ${tomlPath}`);
