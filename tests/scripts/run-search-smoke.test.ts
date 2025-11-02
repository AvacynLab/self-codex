import { describe, it } from "mocha";
import { expect } from "chai";

import { __testing } from "../../scripts/run-search-smoke.js";

describe("search smoke script configuration", () => {
  it("clears proxy variables so local fixtures stay reachable", () => {
    const overrides = __testing.BASE_ENV_OVERRIDES;
    expect(overrides).to.have.property("HTTP_PROXY", "");
    expect(overrides).to.have.property("http_proxy", "");
    expect(overrides).to.have.property("HTTPS_PROXY", "");
    expect(overrides).to.have.property("https_proxy", "");
  });

  it("adds loopback hosts to the no-proxy lists", () => {
    const overrides = __testing.BASE_ENV_OVERRIDES;
    const expectedHosts = ["127.0.0.1", "localhost", "::1"];
    for (const key of ["NO_PROXY", "no_proxy"]) {
      expect(overrides).to.have.property(key);
      const entries = overrides[key]
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      for (const host of expectedHosts) {
        expect(entries).to.include(host);
      }
    }
  });
});
