/**
 * Optional-field regressions for the dashboard client logging helpers. The
 * scenarios confirm payloads never leak `undefined` values which keeps the
 * server compatible with `exactOptionalPropertyTypes` once the flag becomes
 * mandatory.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { buildDashboardClientLogPayload } from "../../src/monitor/dashboard.js";

describe("monitor/dashboard optional fields", () => {
  it("omits undefined metadata when the client omits headers", () => {
    const payload = buildDashboardClientLogPayload(
      {
        headers: {},
        socket: {},
      },
      { event: "client_error" },
    );

    expect(payload.event).to.equal("client_error");
    expect(payload.userAgent).to.equal(null);
    expect(payload.remoteAddress).to.equal(null);
    expect(payload.context).to.equal(null);
  });

  it("preserves declared headers and structured context", () => {
    const payload = buildDashboardClientLogPayload(
      {
        headers: { "user-agent": "Dashboard/1.0" },
        socket: { remoteAddress: "192.0.2.5" },
      },
      { event: "client_warn", context: { message: "network hiccup" } },
    );

    expect(payload.userAgent).to.equal("Dashboard/1.0");
    expect(payload.remoteAddress).to.equal("192.0.2.5");
    expect(payload.context).to.deep.equal({ message: "network hiccup" });
  });

  it("drops array-based headers that Node surfaces for multi-valued agents", () => {
    const payload = buildDashboardClientLogPayload(
      {
        headers: { "user-agent": ["Dash/2.0", "Duplicate"] },
        socket: { remoteAddress: undefined },
      },
      { event: "client_info", context: undefined },
    );

    expect(payload.userAgent).to.equal(null);
    expect(payload.remoteAddress).to.equal(null);
    expect(payload.context).to.equal(null);
  });
});
