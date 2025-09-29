import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  readArtifact,
  writeArtifact,
  listArtifacts,
} from "../src/artifacts.js";
import { PathResolutionError } from "../src/paths.js";

describe("artifacts", () => {
  it("writes, reads and records manifest metadata", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "artifacts-"));

    try {
      const manifest = await writeArtifact({
        childrenRoot,
        childId: "child-a",
        relativePath: "out/result.txt",
        data: "hello",
        mimeType: "text/plain",
      });

      expect(manifest.path).to.equal(path.join("out", "result.txt"));
      expect(manifest.size).to.equal(5);
      expect(manifest.mimeType).to.equal("text/plain");

      const expectedHash = createHash("sha256").update("hello").digest("hex");
      expect(manifest.sha256).to.equal(expectedHash);

      const contents = await readArtifact({
        childrenRoot,
        childId: "child-a",
        relativePath: "out/result.txt",
        encoding: "utf8",
      });

      expect(contents).to.equal("hello");
    } finally {
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("prevents writing artifacts outside of the child workspace", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "artifacts-"));

    try {
      let error: unknown;
      try {
        await writeArtifact({
          childrenRoot,
          childId: "child-a",
          relativePath: "../secret.txt",
          data: "forbidden",
          mimeType: "text/plain",
        });
      } catch (err) {
        error = err;
      }

      expect(error).to.be.instanceOf(PathResolutionError);
    } finally {
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("lists artifacts recursively", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "artifacts-"));

    try {
      await writeArtifact({
        childrenRoot,
        childId: "child-a",
        relativePath: "logs/a.txt",
        data: "a",
        mimeType: "text/plain",
      });
      await writeArtifact({
        childrenRoot,
        childId: "child-a",
        relativePath: "logs/deep/b.txt",
        data: "bb",
        mimeType: "text/plain",
      });

      const manifests = await listArtifacts(childrenRoot, "child-a");
      expect(manifests.map((entry) => entry.path)).to.deep.equal([
        path.join("logs", "a.txt"),
        path.join("logs", "deep", "b.txt"),
      ]);
    } finally {
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
