import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  PathResolutionError,
  resolveWithin,
  resolveChildDir,
  resolveRunDir,
  resolveWorkspacePath,
  safeJoin,
  sanitizeFilename,
} from "../src/paths.js";

const ORIGINAL_RUNS_ROOT = process.env.MCP_RUNS_ROOT;
const ORIGINAL_CHILDREN_ROOT = process.env.MCP_CHILDREN_ROOT;

afterEach(() => {
  if (ORIGINAL_RUNS_ROOT === undefined) {
    delete process.env.MCP_RUNS_ROOT;
  } else {
    process.env.MCP_RUNS_ROOT = ORIGINAL_RUNS_ROOT;
  }

  if (ORIGINAL_CHILDREN_ROOT === undefined) {
    delete process.env.MCP_CHILDREN_ROOT;
  } else {
    process.env.MCP_CHILDREN_ROOT = ORIGINAL_CHILDREN_ROOT;
  }
});

describe("paths sanitization", () => {
  it("replaces unsafe characters in filenames", () => {
    const raw = "run:/../weird name?";
    const sanitized = sanitizeFilename(raw);
    expect(sanitized).to.equal("run_weird_name");
  });

  it("normalises unicode strings before sanitising", () => {
    const composed = "équipe";
    const decomposed = "e\u0301quipe";

    // The sanitiser should normalise to NFC which makes both inputs equivalent.
    expect(sanitizeFilename(decomposed)).to.equal(sanitizeFilename(composed));
    expect(sanitizeFilename(decomposed)).to.equal("équipe");
  });

  it("trims filenames that exceed the allowed length", () => {
    const veryLong = `${"a".repeat(140)}.json`;
    const sanitized = sanitizeFilename(veryLong);

    expect(sanitized.length).to.equal(120);
    expect(sanitized.startsWith("a".repeat(120))).to.be.true;
  });

  it("forbids directory traversal attempts when joining", () => {
    try {
      safeJoin("/tmp/base", "..", "escape");
      expect.fail("expected PathResolutionError to be thrown");
    } catch (error) {
      expect(error).to.be.instanceOf(PathResolutionError);
      const resolutionError = error as PathResolutionError;
      expect(resolutionError.code).to.equal("E-PATHS-ESCAPE");
      expect(resolutionError.hint).to.equal("keep paths within the configured base directory");
      expect(resolutionError.details).to.include({ segment: ".." });
      expect(resolutionError.attemptedPath).to.equal(path.resolve("/tmp/base", ".."));
      expect(resolutionError.rootDirectory).to.equal(path.resolve("/tmp/base"));
      expect(resolutionError.message).to.equal("path escapes base directory");
    }
  });

  it("surfaces relative diagnostics when resolveWithin escapes the sandbox", () => {
    const base = path.resolve("/tmp/base");
    const escape = path.resolve(base, "..", "outside");
    try {
      resolveWithin(base, "..", "outside");
      expect.fail("expected PathResolutionError to be thrown");
    } catch (error) {
      expect(error).to.be.instanceOf(PathResolutionError);
      const resolutionError = error as PathResolutionError;
      expect(resolutionError.code).to.equal("E-PATHS-ESCAPE");
      expect(resolutionError.details.relative).to.equal(path.relative(base, escape));
      expect(resolutionError.attemptedPath).to.equal(escape);
      expect(resolutionError.rootDirectory).to.equal(base);
    }
  });

  it("normalises intermediate segments when joining", () => {
    const joined = safeJoin("/tmp/base", " child ", "logs", "file.txt");
    expect(joined).to.equal(path.resolve("/tmp/base", "child", "logs", "file.txt"));
  });

  it("resolves workspace paths relative to the current working directory", () => {
    const resolved = resolveWorkspacePath("snapshots/graph.json");
    expect(resolved).to.equal(path.resolve(process.cwd(), "snapshots", "graph.json"));
  });

  it("rejects empty workspace paths", () => {
    expect(() => resolveWorkspacePath("   ")).to.throw(PathResolutionError).that.satisfies((error: unknown) => {
      const resolutionError = error as PathResolutionError;
      expect(resolutionError.code).to.equal("E-PATHS-ESCAPE");
      expect(resolutionError.message).to.equal("path must not be empty");
      return true;
    });
  });

  it("forbids traversal when resolving workspace paths", () => {
    expect(() => resolveWorkspacePath("../outside.txt")).to.throw(PathResolutionError).that.satisfies((error: unknown) => {
      const resolutionError = error as PathResolutionError;
      expect(resolutionError.code).to.equal("E-PATHS-ESCAPE");
      expect(resolutionError.details.segment).to.equal("..");
      return true;
    });
  });

  it("resolves run directories relative to the configured root", () => {
    process.env.MCP_RUNS_ROOT = "var/data/runs";
    const dir = resolveRunDir("run:42");
    expect(dir).to.equal(path.resolve(process.cwd(), "var/data/runs", "run_42"));
  });

  it("resolves child directories relative to the configured root", () => {
    process.env.MCP_CHILDREN_ROOT = "var/work/children";
    const dir = resolveChildDir("child-01");
    expect(dir).to.equal(path.resolve(process.cwd(), "var/work/children", "child-01"));
  });

  it("creates run and child directories when missing", async () => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "paths-test-"));
    process.env.MCP_RUNS_ROOT = path.join(sandboxRoot, "runs");
    process.env.MCP_CHILDREN_ROOT = path.join(sandboxRoot, "children");

    const runDir = resolveRunDir(`run-${randomUUID()}`);
    const childDir = resolveChildDir(`child-${randomUUID()}`);

    try {
      await access(runDir);
      await access(childDir);
    } finally {
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  });
});
