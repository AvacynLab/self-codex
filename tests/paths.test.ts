import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PathResolutionError,
  childWorkspacePath,
  ensureDirectory,
  ensureParentDirectory,
  resolveWithin,
} from "../src/paths.js";

describe("paths", () => {
  it("resolves paths relative to the child workspace", () => {
    const root = "/tmp/workspace";
    const resolved = resolveWithin(root, "child", "outbox", "artifact.txt");
    expect(resolved).to.equal(path.resolve(root, "child", "outbox", "artifact.txt"));
  });

  it("rejects attempts to escape the sandbox", () => {
    const root = "/tmp/workspace";
    expect(() => resolveWithin(root, "..", "outside.txt")).to.throw(PathResolutionError);
  });

  it("refuses child identifiers that attempt traversal", () => {
    const root = "/tmp/workspace";

    // `childWorkspacePath` funnels all resolutions through `resolveWithin`
    // which needs to hard reject directory climbing attempts so a malicious
    // child cannot target sibling workspaces.
    expect(() => childWorkspacePath(root, "../escape", "logs")).to.throw(PathResolutionError);
  });

  it("creates nested directories when ensuring a path", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "paths-test-"));

    try {
      const ensured = await ensureDirectory(base, "child_a", "logs");
      const stats = await stat(ensured);
      expect(stats.isDirectory()).to.equal(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("ensures the parent directory for a file path", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "paths-test-"));
    const filePath = path.join(base, "child_a", "outbox", "result.txt");

    try {
      await ensureParentDirectory(filePath);
      const stats = await stat(path.dirname(filePath));
      expect(stats.isDirectory()).to.equal(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("builds the canonical workspace path for a child", () => {
    const childrenRoot = "/var/tmp/run";
    const location = childWorkspacePath(childrenRoot, "child-b", "outbox");
    expect(location).to.equal(path.resolve(childrenRoot, "child-b", "outbox"));
  });
});
