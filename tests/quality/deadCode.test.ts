import { expect } from "chai";
import { join } from "node:path";
import { formatCoordinate, scanForDeadExports } from "../../src/quality/deadCode.js";

describe("scanForDeadExports", () => {
  const fixtureRoot = join("tests", "fixtures", "dead-code", "project-a");
  const tsconfigPath = join(fixtureRoot, "tsconfig.json");

  it("flags exports that are never referenced", () => {
    const result = scanForDeadExports({
      projectRoot: fixtureRoot,
      tsconfigPath,
    });

    const deadCoordinates = result.deadExports.map((entry) => formatCoordinate(entry.file, entry.exportName));

    expect(deadCoordinates).to.have.members([
      "src/unused.ts#unusedHelper",
      "src/unused.ts#unusedValue",
    ]);
  });

  it("supports ignoring entries via an allowlist", () => {
    const result = scanForDeadExports({
      projectRoot: fixtureRoot,
      tsconfigPath,
      allowlist: ["src/unused.ts#unusedHelper"],
    });

    const deadCoordinates = result.deadExports.map((entry) => formatCoordinate(entry.file, entry.exportName));

    expect(deadCoordinates).to.have.members([
      "src/unused.ts#unusedValue",
    ]);
  });
});
