import { describe, it } from "mocha";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
// The dashboard regression test has been migrated to TypeScript.  Keep this
// hygiene guard aligned with the current file extension so we keep checking the
// actual suite that exercises the dashboard.
const DASHBOARD_TEST_PATH = join(CURRENT_DIR, "monitor.dashboard.test.ts");

/**
 * Ensures no Unicode line or paragraph separators are present in the dashboard
 * test source.  Esbuild treats U+2028/U+2029 as line terminators, so keeping
 * them out of the TypeScript file prevents the "Expected ';' but found ':'"
 * transform failure seen in CI when malicious telemetry fixtures accidentally
 * inlined those code points.
 */
describe("hygiene/dashboard unicode separators", () => {
  it("does not contain U+2028 or U+2029 in monitor.dashboard.test.ts", () => {
    const contents = readFileSync(DASHBOARD_TEST_PATH, "utf8");
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);

    expect(contents.includes(lineSeparator)).to.equal(
      false,
      "monitor.dashboard.test.ts should not contain the Unicode LINE SEPARATOR (U+2028)",
    );

    expect(contents.includes(paragraphSeparator)).to.equal(
      false,
      "monitor.dashboard.test.ts should not contain the Unicode PARAGRAPH SEPARATOR (U+2029)",
    );
  });
});
