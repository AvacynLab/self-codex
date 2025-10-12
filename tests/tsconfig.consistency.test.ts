import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// But du test : valider que les tsconfig du dépôt respectent les paramètres
// imposés par le brief (NodeNext + types node) et que la config dérivée via
// `tsc --showConfig` reflète exactement ces attentes. Cette vérification nous
// protège contre une régression accidentelle qui repasserait en CommonJS ou qui
// omettrait les types Node sur un build CI.
// Variables principales :
// - rootConfig : contenu JSON du tsconfig racine.
// - showConfig : résultat normalisé renvoyé par le compilateur.
// - graphForgeConfig : configuration spécifique au sous-projet graph-forge.

describe("tsconfig consistency", () => {
  it("expose the mandated NodeNext options in the root config", () => {
    const rootConfigPath = resolve(process.cwd(), "tsconfig.json");
    const rootConfig = JSON.parse(readFileSync(rootConfigPath, "utf8"));

    assert.equal(rootConfig.compilerOptions?.module, "NodeNext", "module must stay on NodeNext");
    assert.equal(
      rootConfig.compilerOptions?.moduleResolution,
      "NodeNext",
      "moduleResolution must stay on NodeNext",
    );
    assert.deepEqual(
      rootConfig.compilerOptions?.lib,
      ["ES2022"],
      "lib must target ES2022 to match runtime capabilities",
    );
    assert.deepEqual(
      rootConfig.compilerOptions?.types,
      ["node"],
      "types must explicitly include the Node globals",
    );
    assert.deepEqual(
      rootConfig.exclude,
      ["dist", "node_modules", "tests"],
      "exclude must leave tests out of the compilation graph",
    );
  });

  it("matches the same invariants when resolved via tsc --showConfig", () => {
    const require = createRequire(import.meta.url);
    const tscPath = require.resolve("typescript/lib/tsc.js");
    const output = execFileSync(process.execPath, [tscPath, "--showConfig"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const showConfig = JSON.parse(output);
    const options = showConfig.compilerOptions ?? {};

    assert.equal(options.module?.toLowerCase(), "nodenext", "resolved module must stay NodeNext");
    assert.equal(
      options.moduleResolution?.toLowerCase(),
      "nodenext",
      "resolved moduleResolution must stay NodeNext",
    );
    assert.deepEqual(options.lib, ["es2022"], "resolved lib must stay ES2022");
    assert.deepEqual(options.types, ["node"], "resolved types must keep node declarations");
    assert.deepEqual(showConfig.exclude, ["dist", "node_modules", "tests"], "exclude is preserved");
  });

  it("keeps graph-forge extending the root config without declarations", () => {
    const graphForgeConfigPath = resolve(process.cwd(), "graph-forge/tsconfig.json");
    const graphForgeConfig = JSON.parse(readFileSync(graphForgeConfigPath, "utf8"));

    assert.equal(
      graphForgeConfig.extends,
      "../tsconfig.json",
      "graph-forge must inherit the root tsconfig to stay aligned",
    );
    assert.equal(
      graphForgeConfig.compilerOptions?.declaration,
      false,
      "graph-forge must not emit declaration files",
    );
  });
});
