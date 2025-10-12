/**
 * Offline guard ensuring that the test suite never performs real network
 * operations.  The Mocha bootstrap (`tests/setup.ts`) already installs
 * interceptors on the low-level networking primitives so we simply assert the
 * guard is active and rejects connections to non-loopback hosts.
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import { Socket } from "node:net";

import { isAllowedLoopback } from "./lib/networkGuard.js";

describe("offline guard", () => {
  it("refuse toute tentative de connexion sortante", () => {
    const socket = new Socket();
    try {
      expect(() =>
        socket.connect({ host: "example.com", port: 80 }),
      ).to.throw("network access via net.Socket#connect is disabled during tests");
    } finally {
      socket.destroy();
    }
  });

  it("expose un garde-fou global pour les tests hors ligne", async () => {
    const guard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    expect(guard).to.be.oneOf(["loopback-only", "network-blocked"]);

    if (typeof fetch === "function") {
      try {
        await fetch("http://example.com");
        expect.fail("fetch should be blocked for non-loopback destinations");
      } catch (error) {
        expect((error as Error).message).to.equal(
          "network access via fetch is disabled during tests",
        );
      }
    }
  });

  it("autorise les ports éphémères sur la boucle locale même lorsque MCP_TEST_ALLOWED_PORTS est défini", () => {
    const hosts = new Set(["127.0.0.1", "::1", "localhost"]);
    const restrictedPorts = new Set<number>([8765]);

    expect(
      isAllowedLoopback(
        { host: "127.0.0.1", port: 45000 },
        hosts,
        restrictedPorts,
        true,
      ),
    ).to.equal(true);

    expect(
      isAllowedLoopback(
        { host: "127.0.0.1", port: 45000 },
        hosts,
        restrictedPorts,
        false,
      ),
    ).to.equal(false);
  });
});

