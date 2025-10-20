/**
 * Focused unit tests for {@link parseRedactionDirectives}. While the integration
 * suite covers end-to-end log redaction behaviours, these checks lock down the
 * parsing edge cases so that future refactors cannot regress the semantics of
 * the environment variable contract operators rely on.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { parseRedactionDirectives } from "../../src/logger.js";

describe("logger redaction directives", () => {
  it("enables redaction when directives are omitted", () => {
    expect(parseRedactionDirectives(undefined)).to.deep.equal({ enabled: true, tokens: [] });
    expect(parseRedactionDirectives("   ")).to.deep.equal({ enabled: false, tokens: [] });
  });

  it("treats empty directives as an explicit opt-out", () => {
    expect(parseRedactionDirectives(", , ")).to.deep.equal({ enabled: false, tokens: [] });
  });

  it("enables redaction automatically when only tokens are provided", () => {
    const result = parseRedactionDirectives("sk-test,   sk-live");
    expect(result.enabled).to.equal(true);
    expect(result.tokens).to.deep.equal(["sk-test", "sk-live"]);
  });

  it("honours explicit disable directives even when tokens are present", () => {
    const result = parseRedactionDirectives("off,sk-prod,disabled");
    expect(result.enabled).to.equal(false);
    expect(result.tokens).to.deep.equal(["sk-prod"]);
  });

  it("deduplicates tokens while preserving insertion order", () => {
    const result = parseRedactionDirectives("on,sk-prod,sk-prod,sk-ci");
    expect(result.enabled).to.equal(true);
    expect(result.tokens).to.deep.equal(["sk-prod", "sk-ci"]);
  });

  it("recognises alternate enable synonyms", () => {
    const result = parseRedactionDirectives("enabled, secret-prefix");
    expect(result.enabled).to.equal(true);
    expect(result.tokens).to.deep.equal(["secret-prefix"]);
  });
});
