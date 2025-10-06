import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  hashFile,
  readArtifact,
  scanArtifacts,
  writeArtifact,
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

      const manifestPath = path.join(childrenRoot, "child-a", "outbox", "manifest.json");
      const rawManifest = await readFile(manifestPath, "utf8");
      const parsedManifest = JSON.parse(rawManifest) as {
        version: number;
        entries: Array<{ path: string; size: number; mimeType: string; sha256: string }>;
      };

      expect(parsedManifest.version).to.equal(1);
      expect(parsedManifest.entries).to.deep.equal([
        {
          path: path.join("out", "result.txt"),
          size: 5,
          mimeType: "text/plain",
          sha256: manifest.sha256,
        },
      ]);
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

  it("rejects reading artifacts with sandbox escaping paths", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "artifacts-"));

    try {
      await writeArtifact({
        childrenRoot,
        childId: "child-a",
        relativePath: "reports/a.txt",
        data: "ok",
        mimeType: "text/plain",
      });

      let error: unknown;
      try {
        await readArtifact({
          childrenRoot,
          childId: "child-a",
          relativePath: "../sneaky.txt",
        });
      } catch (err) {
        error = err;
      }

      // The guard must mirror writeArtifact protections so a malicious caller
      // cannot exfiltrate data from neighbouring workspaces.
      expect(error).to.be.instanceOf(PathResolutionError);
    } finally {
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("scans artifacts recursively and refreshes the manifest", async () => {
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

      const manifests = await scanArtifacts(childrenRoot, "child-a");
      expect(manifests.map((entry) => entry.path)).to.deep.equal([
        path.join("logs", "a.txt"),
        path.join("logs", "deep", "b.txt"),
      ]);

      const outboxDir = path.join(childrenRoot, "child-a", "outbox");
      const manifestPath = path.join(outboxDir, "manifest.json");
      const before = JSON.parse(await readFile(manifestPath, "utf8")) as {
        entries: Array<{ path: string; sha256: string; size: number }>;
      };

      // Mutate one file to ensure `scanArtifacts` recomputes hashes and sizes.
      await writeFile(path.join(outboxDir, "logs", "deep", "b.txt"), "updated");

      const refreshed = await scanArtifacts(childrenRoot, "child-a");
      const updatedEntry = refreshed.find((item) => item.path === path.join("logs", "deep", "b.txt"));
      expect(updatedEntry?.size).to.equal("updated".length);
      expect(updatedEntry?.sha256).to.not.equal(before.entries.find((item) => item.path === path.join("logs", "deep", "b.txt"))?.sha256);
    } finally {
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("hashes files deterministically", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "artifacts-"));

    try {
      const outboxDir = path.join(childrenRoot, "child-a", "outbox");
      await mkdir(path.join(outboxDir, "tmp"), { recursive: true });
      const targetFile = path.join(outboxDir, "tmp", "data.bin");
      const payload = Buffer.alloc(1024, 0xab);
      await writeFile(targetFile, payload);

      const digest = await hashFile(targetFile);
      const expected = createHash("sha256").update(payload).digest("hex");
      expect(digest).to.equal(expected);
    } finally {
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("ignores symbolic links when scanning artifacts", async function () {
    if (process.platform === "win32") {
      // Creating symbolic links on Windows requires elevated privileges. Skipping avoids
      // spurious failures on developer workstations.
      this.skip();
    }

    const childrenRoot = await mkdtemp(path.join(tmpdir(), "artifacts-"));

    try {
      await writeArtifact({
        childrenRoot,
        childId: "child-a",
        relativePath: "reports/a.txt",
        data: "ok",
        mimeType: "text/plain",
      });

      const outsideFile = path.join(childrenRoot, "outside.txt");
      await writeFile(outsideFile, "external");

      const outboxDir = path.join(childrenRoot, "child-a", "outbox");
      await mkdir(path.join(outboxDir, "links"), { recursive: true });
      await symlink(outsideFile, path.join(outboxDir, "links", "external.txt"));

      const manifests = await scanArtifacts(childrenRoot, "child-a");
      const paths = manifests.map((entry) => entry.path);

      expect(paths).to.include(path.join("reports", "a.txt"));
      expect(paths).to.not.include(path.join("links", "external.txt"));
    } finally {
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
