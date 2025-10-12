import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

// But : garantir que le script de diagnostic `scripts/verify-env.mjs` reste
// fiable et qu'il expose toutes les métriques attendues pour la CI.
// Explications : on exécute le script via `node`, on parse le JSON retourné,
// puis on compare chaque champ avec la réalité du workspace (présence du
// lockfile, de tsconfig, des binaires TypeScript/tsx, etc.).

function runVerifyEnvScript() {
  const scriptPath = resolve(process.cwd(), "scripts", "verify-env.mjs");
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(process.execPath, [scriptPath], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const output = [stdout, stderr].filter(Boolean).join("\n");
        rejectPromise(new Error(`verify-env script failed: ${output}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

describe("scripts/verify-env.mjs", () => {
  it("expose les indicateurs d'environnement attendus", async () => {
    const stdout = await runVerifyEnvScript();
    const payload = JSON.parse(stdout);

    assert.equal(typeof payload.node, "string", "le champ node doit contenir la version string");

    const versionMatch = /^v(\d+)\.(\d+)\.(\d+)/.exec(payload.node);
    assert.ok(versionMatch, `format de version inattendu: ${payload.node}`);
    const major = Number.parseInt(versionMatch[1], 10);
    const minor = Number.parseInt(versionMatch[2], 10);
    const patch = Number.parseInt(versionMatch[3], 10);

    assert.equal(payload.nodeMajor, major, "nodeMajor doit correspondre à la version major");
    assert.equal(payload.nodeMinor, minor, "nodeMinor doit correspondre à la version minor");
    assert.equal(payload.nodePatch, patch, "nodePatch doit correspondre à la version patch");
    assert.equal(payload.nodeSatisfiesMin, major >= 20, "nodeSatisfiesMin doit refléter la contrainte >= 20");

    assert.equal(payload.lockfile, existsSync(resolve("package-lock.json")), "lockfile doit refléter package-lock.json");
    assert.equal(payload.tsconfig, existsSync(resolve("tsconfig.json")), "tsconfig doit refléter tsconfig.json");
    assert.equal(payload.hasTypesNode, existsSync(resolve("node_modules", "@types", "node")), "hasTypesNode doit refléter node_modules/@types/node");
    assert.equal(payload.hasTSC, existsSync(resolve("node_modules", ".bin", "tsc")), "hasTSC doit refléter node_modules/.bin/tsc");
    assert.equal(payload.hasTSX, existsSync(resolve("node_modules", ".bin", "tsx")), "hasTSX doit refléter node_modules/.bin/tsx");

    if (payload.nodeSatisfiesMin === false) {
      assert.ok(typeof payload.warning === "string" && payload.warning.length > 0, "un avertissement textuel est attendu si nodeSatisfiesMin est faux");
    }
  });
});
