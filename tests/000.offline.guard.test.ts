/**
 * Offline guard ensuring that the test suite never performs real network
 * operations. We patch the low level networking primitives so any accidental
 * socket connection or DNS resolution fails fast with a descriptive error.
 */
import { describe, it, before } from "mocha";
import { expect } from "chai";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type NetModule = typeof import("node:net");
type HttpModule = typeof import("node:http");
type HttpsModule = typeof import("node:https");
type DnsModule = typeof import("node:dns");

describe("offline guard", () => {
  before(() => {
    const offlineError = new Error(
      "Network access is disabled inside the orchestrator test suite.",
    );

    const net = require("node:net") as NetModule;
    const http = require("node:http") as HttpModule;
    const https = require("node:https") as HttpsModule;
    const dns = require("node:dns") as DnsModule;

    const blockRequest = ((..._args: Parameters<HttpModule["request"]>) => {
      throw offlineError;
    }) as unknown as HttpModule["request"];

    const blockGet = ((..._args: Parameters<HttpModule["get"]>) => {
      throw offlineError;
    }) as unknown as HttpModule["get"];

    const offlineSocketConnect = function thisShouldNeverConnect(
      this: typeof net.Socket.prototype,
      ..._args: any[]
    ): never {
      throw offlineError;
    };
    net.Socket.prototype.connect =
      offlineSocketConnect as typeof net.Socket.prototype.connect;

    http.request = blockRequest;
    http.get = blockGet;
    https.request = blockRequest as unknown as HttpsModule["request"];
    https.get = blockGet as unknown as HttpsModule["get"];

    const blockLookup = ((..._args: Parameters<DnsModule["lookup"]>) => {
      throw offlineError;
    }) as unknown as DnsModule["lookup"];
    dns.lookup = blockLookup;

    if (dns.promises) {
      dns.promises.lookup = (async (
        ..._args: Parameters<typeof dns.promises.lookup>
      ) => {
        throw offlineError;
      }) as typeof dns.promises.lookup;
    }

    Object.defineProperty(globalThis, "__OFFLINE_TEST_GUARD__", {
      value: offlineError.message,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  });

  it("refuse toute tentative de connexion sortante", () => {
    const net = require("node:net") as NetModule;
    const dns = require("node:dns") as DnsModule;

    expect(() => net.connect({ host: "example.com", port: 80 })).to.throw(
      "Network access is disabled inside the orchestrator test suite.",
    );

    expect(() => dns.lookup("example.com", () => undefined)).to.throw(
      "Network access is disabled inside the orchestrator test suite.",
    );

    expect(globalThis).to.have.property(
      "__OFFLINE_TEST_GUARD__",
      "Network access is disabled inside the orchestrator test suite.",
    );
  });
});

