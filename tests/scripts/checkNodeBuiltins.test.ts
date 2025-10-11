import { describe, it } from "mocha";
import { expect } from "chai";

import { findInvalidBuiltinImports } from "../../scripts/checkNodeBuiltins";

/**
 * Unit tests covering the Node builtin import lint helper. The scenarios ensure both valid imports
 * (using the `node:` prefix) and invalid imports (omitting the prefix) are detected correctly.
 */
describe("findInvalidBuiltinImports", () => {
  it("flags bare builtin imports", () => {
    const diagnostics = findInvalidBuiltinImports(
      "/tmp/example.ts",
      "import { readFile } from \"fs\";\nexport const noop = () => readFile;\n"
    );

    expect(diagnostics).to.have.lengthOf(1);
    expect(diagnostics[0]).to.include({ moduleName: "fs", line: 1 });
    expect(diagnostics[0].column).to.be.greaterThan(0);
  });

  it("accepts imports using the node prefix", () => {
    const diagnostics = findInvalidBuiltinImports(
      "/tmp/example.ts",
      "import { readFile } from \"node:fs\";\nexport const noop = () => readFile;\n"
    );

    expect(diagnostics).to.have.lengthOf(0);
  });

  it("handles require calls", () => {
    const diagnostics = findInvalidBuiltinImports(
      "/tmp/example.ts",
      "const http = require(\"http\");\nexport const noop = () => http;\n"
    );

    expect(diagnostics).to.have.lengthOf(1);
    expect(diagnostics[0]).to.include({ moduleName: "http", line: 1 });
    expect(diagnostics[0].column).to.be.greaterThan(0);
  });

  it("handles dynamic import expressions", () => {
    const diagnostics = findInvalidBuiltinImports(
      "/tmp/example.ts",
      "async function load() { return import(\"url\"); }\nexport const noop = load;\n"
    );

    expect(diagnostics).to.have.lengthOf(1);
    expect(diagnostics[0]).to.include({ moduleName: "url", line: 1 });
    expect(diagnostics[0].column).to.be.greaterThan(0);
  });
});
