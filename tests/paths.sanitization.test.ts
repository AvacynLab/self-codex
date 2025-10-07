import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";

import {
  PathResolutionError,
  resolveChildDir,
  resolveRunDir,
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
    expect(sanitized).to.equal("run__.._weird_name_");
  });

  it("forbids directory traversal attempts when joining", () => {
    expect(() => safeJoin("/tmp/base", "..", "escape"))
      .to.throw(PathResolutionError)
      .with.property("attemptedPath");
  });

  it("normalises intermediate segments when joining", () => {
    const joined = safeJoin("/tmp/base", " child ", "logs", "file.txt");
    expect(joined).to.equal(path.resolve("/tmp/base", "child", "logs", "file.txt"));
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
});
