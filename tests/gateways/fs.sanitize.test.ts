import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { expect } from "chai";

import { ArtifactPathTraversalError, safePath } from "../../src/gateways/fsArtifacts.js";

/**
 * Unit tests covering the filesystem gateway helpers dedicated to artifact
 * persistence. The suite focuses on the sanitisation guarantees provided by
 * {@link safePath} so higher level facades can rely on deterministic and secure
 * behaviour when persisting user supplied paths.
 */
describe("gateways/fsArtifacts.safePath", () => {
  async function createSandbox(): Promise<string> {
    return mkdtemp(join(tmpdir(), "fs-artifacts-"));
  }

  it("replaces forbidden characters with underscores", async () => {
    const root = await createSandbox();
    const sanitized = safePath(root, "reports/<draft>:\"?*.txt");

    expect(sanitized.startsWith(root + sep) || sanitized === root).to.equal(
      true,
      "resolved path must stay within the sandbox",
    );

    const segments = relative(root, sanitized).split(sep);
    expect(segments[0]).to.equal("reports");
    const fileName = segments[segments.length - 1];
    expect(fileName).to.match(/^_draft.*\.txt$/);
    expect(/[<>:"|?*\x00-\x1F]/.test(fileName)).to.equal(false);
  });

  it("rejects attempts to traverse outside the sandbox", async () => {
    const root = await createSandbox();

    expect(() => safePath(root, "../escape.txt")).to.throw(ArtifactPathTraversalError);
  });

  it("normalises dot segments without breaking legitimate subdirectories", async () => {
    const root = await createSandbox();
    const sanitized = safePath(root, "logs/../logs/session/./latest.log");

    expect(relative(root, sanitized).split(sep)).to.deep.equal([
      "logs",
      "session",
      "latest.log",
    ]);
  });
});
