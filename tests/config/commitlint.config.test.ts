import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "mocha";
import { expect } from "chai";

/**
 * Loading the Commitlint config inside a test helps catch syntax errors early
 * and ensures the rule customisations stay aligned with the repository policy.
 */
describe("commitlint configuration", () => {
  it("extends the conventional preset with the curated type list", async () => {
    const configModuleUrl = pathToFileURL(resolve(process.cwd(), "commitlint.config.cjs"));
    const moduleExports = await import(configModuleUrl.href);
    expect(moduleExports).to.have.property("default");

    const config = (moduleExports.default ?? moduleExports) as {
      extends?: string[];
      rules?: Record<string, unknown>;
    };

    expect(config.extends).to.deep.equal(["@commitlint/config-conventional"]);
    expect(config.rules).to.have.property("type-enum");
    const typeRule = config.rules?.["type-enum"] as unknown[];
    expect(typeRule?.[0]).to.equal(2);
    expect(typeRule?.[1]).to.equal("always");
    expect(typeRule?.[2]).to.deep.equal([
      "build",
      "chore",
      "ci",
      "docs",
      "feat",
      "fix",
      "perf",
      "refactor",
      "revert",
      "style",
      "test"
    ]);
  });
});
