#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

console.log(`[maintenance] npm ${installArgs.join(" ")}`);
await execFileAsync("npm", installArgs);

if (existsSync(join(projectRoot, "dist"))) {
  console.log("[maintenance] Nettoyage de dist/ avant recompilation");
  rmSync(join(projectRoot, "dist"), { recursive: true, force: true });
}

console.log("[maintenance] Reconstruction du projet");
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
# Pour HTTP, préférez un adaptateur et le script npm run start:http.
`;

writeFileSync(tomlPath, tomlContent, "utf8");
console.log(`[maintenance] Configuration Codex rafraîchie (${tomlPath})`);
