/**
 * Unit tests covering the hardened token comparison helper. The checks focus on
 * verifying the rejection paths alongside the happy path to ensure callers can
 * safely rely on the constant-time primitive when enforcing the HTTP bearer
 * token.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { tokenOk } from "../../src/http/auth.js";

describe("http auth token", () => {
  it("accepts matching tokens", () => {
    const result = tokenOk("abc123", "abc123");
    expect(result, "matching tokens should validate").to.equal(true);
  });

  it("rejects missing tokens", () => {
    const result = tokenOk(undefined, "expected");
    expect(result, "missing header must fail").to.equal(false);
  });

  it("rejects tokens with different length despite common prefix", () => {
    const result = tokenOk("secret", "secret-extended");
    expect(result, "length mismatch must fail").to.equal(false);
  });

  it("rejects tokens with same length but different content", () => {
    const result = tokenOk("abcdef", "abcdeg");
    expect(result, "different payloads must fail").to.equal(false);
  });
});
