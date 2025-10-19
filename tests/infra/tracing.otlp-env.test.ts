import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { __tracingInternals } from "../../src/infra/tracing.js";

describe("OTLP environment configuration", () => {
  const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const originalHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;

  beforeEach(() => {
    __tracingInternals.configureOtlp(null);
  });

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    }
    if (originalHeaders === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    } else {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = originalHeaders;
    }
    __tracingInternals.configureOtlp(null);
  });

  it("returns null when the endpoint is not configured", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;

    const config = __tracingInternals.reloadOtlpConfigFromEnv();
    expect(config).to.equal(null);
  });

  it("parses the endpoint and normalises headers", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp.example/v1";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = " Authorization = Bearer token , X-Trace=abc123 ";

    const config = __tracingInternals.reloadOtlpConfigFromEnv();
    expect(config).to.not.equal(null);
    expect(config).to.deep.equal({
      endpoint: "https://otlp.example/v1",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
        "x-trace": "abc123",
      },
    });
  });
});
