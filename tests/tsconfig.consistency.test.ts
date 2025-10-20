import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// But du test : valider que les tsconfig du dépôt respectent les paramètres
// imposés par le brief (module ESNext + résolution Bundler + types node) et que
// la config dérivée via `tsc --showConfig` reflète exactement ces attentes.
// Cette vérification nous protège contre une régression accidentelle qui
// repasserait en CommonJS, NodeNext ou qui omettrait les types Node sur un build
// CI.
// Variables principales :
// - rootConfig : contenu JSON du tsconfig racine.
// - showConfig : résultat normalisé renvoyé par le compilateur.
// - graphForgeConfig : configuration spécifique au sous-projet graph-forge.

describe("tsconfig consistency", () => {
  /**
   * Parcours récursif des répertoires de tests pour détecter les suites encore
   * stockées en `.test.js`.  Nous conservons un accumulateur afin de pouvoir
   * afficher toutes les occurrences dans l'assertion finale (et pas uniquement
   * la première).
   */
  function collectLegacyJsTests(rootDir: string, legacyPaths: string[]): void {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        collectLegacyJsTests(resolve(rootDir, entry.name), legacyPaths);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".test.js")) {
        legacyPaths.push(resolve(rootDir, entry.name));
      }
    }
  }

  it("expose the mandated ESNext options in the root config", () => {
    const rootConfigPath = resolve(process.cwd(), "tsconfig.json");
    const rootConfig = JSON.parse(readFileSync(rootConfigPath, "utf8"));

    assert.equal(rootConfig.compilerOptions?.module, "ESNext", "module must stay on ESNext");
    assert.equal(
      rootConfig.compilerOptions?.moduleResolution,
      "Bundler",
      "moduleResolution must stay on Bundler",
    );
    assert.equal(
      rootConfig.compilerOptions?.target,
      "ES2022",
      "target must remain aligned with the runtime level mandated by the checklist",
    );
    assert.equal(
      rootConfig.compilerOptions?.rootDir,
      "src",
      "rootDir must keep the build scoped to src/",
    );
    assert.equal(
      rootConfig.compilerOptions?.outDir,
      "dist",
      "outDir must continue emitting compiled assets into dist/",
    );
    assert.equal(rootConfig.compilerOptions?.strict, true, "strict mode must stay enabled");
    assert.equal(
      rootConfig.compilerOptions?.esModuleInterop,
      true,
      "esModuleInterop must stay on to simplify default import interop",
    );
    assert.equal(
      rootConfig.compilerOptions?.skipLibCheck,
      true,
      "skipLibCheck must stay enabled to keep CI builds fast",
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
      rootConfig.include,
      ["src/**/*.ts"],
      "include must only reference TypeScript sources under src/",
    );
    assert.deepEqual(
      rootConfig.exclude,
      ["tests", "**/*.test.*", "**/*.spec.*", "dist", "node_modules"],
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

    assert.equal(options.module?.toLowerCase(), "esnext", "resolved module must stay ESNext");
    assert.equal(
      options.moduleResolution?.toLowerCase(),
      "bundler",
      "resolved moduleResolution must stay Bundler",
    );
    assert.deepEqual(options.lib, ["es2022"], "resolved lib must stay ES2022");
    assert.deepEqual(options.types, ["node"], "resolved types must keep node declarations");
    assert.deepEqual(
      showConfig.exclude,
      ["tests", "**/*.test.*", "**/*.spec.*", "dist", "node_modules"],
      "exclude is preserved",
    );
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
    assert.equal(
      graphForgeConfig.compilerOptions?.rootDir,
      "./src",
      "graph-forge must restrict compilation to its local src directory",
    );
    assert.equal(
      graphForgeConfig.compilerOptions?.outDir,
      "./dist",
      "graph-forge must emit build output inside graph-forge/dist",
    );
    assert.deepEqual(
      graphForgeConfig.include,
      ["src/**/*.ts"],
      "graph-forge must compile only TypeScript sources from its vendored subtree",
    );
    assert.deepEqual(
      [...(graphForgeConfig.exclude ?? [])].sort(),
      ["dist", "examples", "test"],
      "graph-forge must ignore build outputs, examples, and vendored tests during compilation",
    );
  });

  it("extends the root config for test type-checking without emitting artifacts", () => {
    // But du test : garantir que tsconfig.tests.json reste aligné avec le
    // tsconfig racine tout en activant uniquement la vérification de types.
    // Variables clés :
    // - testsConfigPath : chemin vers la configuration dédiée aux tests.
    // - testsConfig : contenu JSON parsé de la configuration.
    const testsConfigPath = resolve(process.cwd(), "tsconfig.tests.json");
    const testsConfig = JSON.parse(readFileSync(testsConfigPath, "utf8"));

    assert.equal(
      testsConfig.extends,
      "./tsconfig.json",
      "tsconfig.tests.json must inherit compiler options from the root config",
    );
    assert.equal(
      testsConfig.compilerOptions?.noEmit,
      true,
      "tsconfig.tests.json must disable emit to avoid polluting the workspace",
    );
    assert.equal(
      testsConfig.compilerOptions?.rootDir,
      ".",
      "tsconfig.tests.json must set rootDir to the repo root for path resolution",
    );
    const expectedIncludeGlobs = ["tests/**/*.ts", "tests/**/*.d.ts", "src/**/*.ts"];
    assert.deepEqual(
      testsConfig.include,
      expectedIncludeGlobs,
      "tsconfig.tests.json must type-check test sources, ambient declarations, and production sources",
    );
  });

  it("keeps every test suite migrated to TypeScript", () => {
    // But : garantir que plus aucun test `.test.js` ne subsiste dans le dépôt.
    // Variables :
    // - searchTargets : couples label/path examinés.
    // - offenders : chemins collectés avec l'extension interdite.
    const searchTargets = [
      // Les suites officielles résident désormais sous tests/graph-forge/ et
      // sont donc couvertes par le répertoire racine `tests`.
      { label: "tests", path: resolve(process.cwd(), "tests") },
      // Nous conservons néanmoins une garde sur l'ancien répertoire pour
      // détecter la réintroduction accidentelle de fichiers JS.
      { label: "graph-forge/test", path: resolve(process.cwd(), "graph-forge/test") },
    ];
    const offenders: string[] = [];

    for (const target of searchTargets) {
      if (!existsSync(target.path)) {
        continue;
      }
      collectLegacyJsTests(target.path, offenders);
    }

    assert.deepEqual(
      offenders,
      [],
      `legacy JavaScript test files detected: ${offenders.map((file) => file.replace(process.cwd() + "/", "")).join(", ")}`,
    );
  });
});
