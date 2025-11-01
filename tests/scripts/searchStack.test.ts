import { EventEmitter } from "node:events";

import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import {
  createSearchStackManager,
  resolveStackLifecyclePolicy,
} from "../../scripts/lib/searchStack.js";

/** Utility creating a fake child process emitting the provided events. */
function createFakeChild({
  closeCode = 0,
  emitError = false,
  errorCode,
}: {
  closeCode?: number;
  emitError?: boolean;
  errorCode?: string;
}): EventEmitter {
  const child = new EventEmitter();
  if (emitError) {
    const error = new Error("spawn failure") as NodeJS.ErrnoException;
    if (errorCode) {
      error.code = errorCode;
    }
    setImmediate(() => {
      child.emit("error", error);
      child.emit("close", closeCode);
    });
  } else {
    setImmediate(() => {
      child.emit("close", closeCode);
    });
  }
  return child;
}

/** Unit tests covering the Docker orchestration helpers. */
describe("scripts/lib/searchStack", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("runs commands and resolves on zero exit code", async () => {
    const spawnStub = sinon.stub().callsFake(() => createFakeChild({ closeCode: 0 }));
    const manager = createSearchStackManager({ spawn: spawnStub });
    const code = await manager.runCommand("echo", ["ok"]);
    expect(code).to.equal(0);
    sinon.assert.calledOnce(spawnStub);
  });

  it("throws when the command exits with a non-zero code", async () => {
    const spawnStub = sinon.stub().callsFake(() => createFakeChild({ closeCode: 2 }));
    const manager = createSearchStackManager({ spawn: spawnStub });
    let error: unknown;
    try {
      await manager.runCommand("docker", ["ps"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain("exited with code 2");
  });

  it("detects docker availability based on the spawn exit code", async () => {
    const spawnStub = sinon.stub();
    spawnStub.onCall(0).returns(createFakeChild({ closeCode: 0 }));
    const manager = createSearchStackManager({ spawn: spawnStub });
    const ok = await manager.isDockerAvailable();
    expect(ok).to.equal(true);
  });

  it("reports docker as unavailable when the binary cannot be spawned", async () => {
    const spawnStub = sinon.stub().returns(createFakeChild({ closeCode: 1, emitError: true, errorCode: "ENOENT" }));
    const manager = createSearchStackManager({ spawn: spawnStub });
    const ok = await manager.isDockerAvailable();
    expect(ok).to.equal(false);
  });

  it("waits for services and retries when fetch fails", async () => {
    let attempts = 0;
    const fetchStub = sinon.stub().callsFake(async () => {
      attempts += 1;
      if (attempts < 3) {
        return { ok: false, status: 503 } as Response;
      }
      return { ok: true, status: 200 } as Response;
    });
    const delayStub = sinon.stub().resolves();
    const manager = createSearchStackManager({ fetchImpl: fetchStub, delay: delayStub });
    await manager.waitForService("http://service.test/healthz", { intervalMs: 1, timeoutMs: 50 });
    expect(attempts).to.equal(3);
    sinon.assert.calledTwice(delayStub);
  });

  it("treats accepted status codes as success when waiting for a service", async () => {
    const fetchStub = sinon.stub().resolves({ ok: false, status: 422 } as Response);
    const manager = createSearchStackManager({ fetchImpl: fetchStub });
    await manager.waitForService("http://service.test/legacy", {
      acceptStatus: (status) => status === 422,
    });
    sinon.assert.calledOnce(fetchStub);
  });

  it("coerces string status codes before evaluating accepted statuses", async () => {
    const fetchStub = sinon
      .stub()
      .resolves({ ok: false, status: "422" } as unknown as Response);
    const manager = createSearchStackManager({ fetchImpl: fetchStub });
    await manager.waitForService("http://service.test/legacy", {
      acceptStatus: (status) => status === 422,
    });
    sinon.assert.calledOnce(fetchStub);
  });

  it("waits for Searx even when the landing page answers with 4xx", async () => {
    // SearxNG can purposely reply with 4xx codes (e.g. 403) on the landing page
    // when the instance is not meant to be public. The readiness helper should
    // still accept those responses so CI does not block on a healthy container.
    const fetchStub = sinon.stub().resolves({ ok: false, status: 403 } as Response);
    const manager = createSearchStackManager({ fetchImpl: fetchStub });
    await manager.waitForSearxReady();
    sinon.assert.calledOnce(fetchStub);
    const [url, requestInit] = fetchStub.getCall(0).args as [string, RequestInit];
    expect(url).to.equal("http://127.0.0.1:8080/healthz");
    expect(requestInit?.headers).to.deep.equal({
      "X-Forwarded-For": "127.0.0.1",
      "X-Real-IP": "127.0.0.1",
    });
  });

  it("probes loopback variants until one responds", async () => {
    const delayStub = sinon.stub().resolves();
    const attempts: string[] = [];
    const fetchStub = sinon.stub().callsFake(async (url: string, init: RequestInit) => {
      attempts.push(url);
      expect(init?.headers).to.deep.equal({
        "X-Forwarded-For": "127.0.0.1",
        "X-Real-IP": "127.0.0.1",
      });
      if (url.startsWith("http://[::1]")) {
        return { ok: false, status: 403 } as Response;
      }
      throw new TypeError("fetch failed");
    });
    const manager = createSearchStackManager({ fetchImpl: fetchStub, delay: delayStub });
    await manager.waitForSearxReady();
    expect(attempts).to.deep.equal([
      "http://127.0.0.1:8080/healthz",
      "http://127.0.0.1:8080/",
      "http://localhost:8080/healthz",
      "http://localhost:8080/",
      "http://[::1]:8080/healthz",
    ]);
    sinon.assert.callCount(delayStub, 4);
  });

  it("brings up and tears down the docker stack with the compose file", async () => {
    const spawnStub = sinon.stub().callsFake(() => createFakeChild({ closeCode: 0 }));
    const composeFile = "/tmp/compose.yml";
    const manager = createSearchStackManager({ spawn: spawnStub, composeFile });
    await manager.bringUpStack();
    await manager.tearDownStack();
    sinon.assert.calledWithExactly(
      spawnStub.getCall(0),
      "docker",
      ["compose", "-f", composeFile, "up", "-d", "--wait"],
      sinon.match.object,
    );
    sinon.assert.calledWithExactly(
      spawnStub.getCall(1),
      "docker",
      ["compose", "-f", composeFile, "down", "-v"],
      sinon.match.object,
    );
  });

  it("defaults to bringing the stack up and down when reuse is disabled", () => {
    const policy = resolveStackLifecyclePolicy({});
    expect(policy).to.deep.equal({ shouldBringUp: true, shouldTearDown: true });
  });

  it("skips bring up and tear down when SEARCH_STACK_REUSE requests reuse", () => {
    const policy = resolveStackLifecyclePolicy({ SEARCH_STACK_REUSE: "1" });
    expect(policy).to.deep.equal({ shouldBringUp: false, shouldTearDown: false });
  });

  it("treats textual reuse flags as valid opt-ins", () => {
    const policy = resolveStackLifecyclePolicy({ SEARCH_STACK_REUSE: "TrUe" });
    expect(policy).to.deep.equal({ shouldBringUp: false, shouldTearDown: false });
  });
});
