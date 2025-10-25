/**
 * Table-driven tests covering the environment parsing helpers. They exercise
 * boolean, numeric and enum coercions to guarantee the new shared module
 * mirrors the historical behaviour while handling edge cases consistently.
 */
import { afterEach, describe, it } from "mocha";
import { expect } from "chai";

import {
  readBool,
  readOptionalBool,
  readInt,
  readOptionalInt,
  readNumber,
  readOptionalNumber,
  readOptionalEnum,
  readEnum,
  readString,
  readOptionalString,
} from "../../src/config/env.js";

type EnvSnapshot = Record<string, string | undefined>;

const trackedKeys = [
  "TEST_BOOL",
  "TEST_NUMBER",
  "TEST_INT",
  "TEST_ENUM",
  "TEST_STRING",
] as const;

/** Stores the original environment variables so each test can restore them. */
const originalEnv: EnvSnapshot = {};

function setEnv(name: (typeof trackedKeys)[number], value: string | undefined): void {
  if (!(name in originalEnv)) {
    originalEnv[name] = process.env[name];
  }

  if (typeof value === "string") {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }
}

describe("config/env helpers", () => {
  afterEach(() => {
    for (const key of trackedKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key] as string;
      }
      delete originalEnv[key];
    }
  });

  it("interprets boolean flags case-insensitively", () => {
    setEnv("TEST_BOOL", "YES");
    expect(readBool("TEST_BOOL", false)).to.equal(true);

    setEnv("TEST_BOOL", "off");
    expect(readOptionalBool("TEST_BOOL")).to.equal(false);

    setEnv("TEST_BOOL", "  ");
    expect(readOptionalBool("TEST_BOOL")).to.equal(undefined);
  });

  it("falls back to defaults when booleans are ambiguous", () => {
    setEnv("TEST_BOOL", "maybe");
    expect(readBool("TEST_BOOL", true)).to.equal(true);
    expect(readOptionalBool("TEST_BOOL")).to.equal(undefined);
  });

  it("parses floating point numbers and enforces bounds", () => {
    setEnv("TEST_NUMBER", "12.75");
    expect(readNumber("TEST_NUMBER", 0)).to.equal(12.75);

    setEnv("TEST_NUMBER", "-5");
    expect(readOptionalNumber("TEST_NUMBER", { min: -10, max: 10 })).to.equal(-5);

    setEnv("TEST_NUMBER", "not-a-number");
    expect(readOptionalNumber("TEST_NUMBER")).to.equal(undefined);
  });

  it("rejects infinite literals so callers fall back to defaults", () => {
    // Operators occasionally attempt to disable limits by setting the variable
    // to "Infinity". The helpers deliberately treat that value as invalid to
    // avoid leaking infinities into rate limit calculations.
    setEnv("TEST_NUMBER", "Infinity");
    expect(readOptionalNumber("TEST_NUMBER")).to.equal(undefined);

    setEnv("TEST_NUMBER", "-Infinity");
    expect(readNumber("TEST_NUMBER", 13)).to.equal(13);
  });

  it("reads integers while filtering floats and out-of-range values", () => {
    setEnv("TEST_INT", "42");
    expect(readInt("TEST_INT", 0)).to.equal(42);

    setEnv("TEST_INT", "13.37");
    expect(readOptionalInt("TEST_INT")).to.equal(undefined);

    setEnv("TEST_INT", "5");
    expect(readOptionalInt("TEST_INT", { min: 10 })).to.equal(undefined);

    // Values beyond Number.MAX_SAFE_INTEGER would previously slip through due to
    // string parsing; confirm the helper now rejects them to avoid precision
    // loss.
    setEnv("TEST_INT", String(Number.MAX_SAFE_INTEGER + 10));
    expect(readOptionalInt("TEST_INT")).to.equal(undefined);
  });

  it("accepts enum values using case-insensitive matching", () => {
    setEnv("TEST_ENUM", "BETA");
    expect(readEnum("TEST_ENUM", ["alpha", "beta", "gamma"] as const, "alpha")).to.equal("beta");

    setEnv("TEST_ENUM", "unknown");
    expect(readEnum("TEST_ENUM", ["alpha", "beta"] as const, "alpha")).to.equal("alpha");
  });

  it("returns undefined for optional enums when unset or invalid", () => {
    delete process.env.TEST_ENUM;
    expect(readOptionalEnum("TEST_ENUM", ["north", "south"] as const)).to.equal(undefined);

    setEnv("TEST_ENUM", "south");
    expect(readOptionalEnum("TEST_ENUM", ["north", "south"] as const)).to.equal("south");

    setEnv("TEST_ENUM", "  NORTH  ");
    expect(readOptionalEnum("TEST_ENUM", ["north", "south"] as const)).to.equal("north");

    setEnv("TEST_ENUM", "sideways");
    expect(readOptionalEnum("TEST_ENUM", ["north", "south"] as const)).to.equal(undefined);
  });

  it("trims strings and treats blanks as unset", () => {
    setEnv("TEST_STRING", "  custom-value  ");
    expect(readString("TEST_STRING", "fallback")).to.equal("custom-value");

    setEnv("TEST_STRING", "   ");
    expect(readOptionalString("TEST_STRING")).to.equal(undefined);

    delete process.env.TEST_STRING;
    expect(readString("TEST_STRING", "fallback")).to.equal("fallback");
  });

  it("optionally preserves explicit empty strings when requested", () => {
    setEnv("TEST_STRING", "   ");
    expect(readOptionalString("TEST_STRING", { allowEmpty: true })).to.equal("");

    expect(readString("TEST_STRING", "default", { allowEmpty: true })).to.equal("");

    delete process.env.TEST_STRING;
    expect(readString("TEST_STRING", "default", { allowEmpty: true })).to.equal("default");
  });
});
