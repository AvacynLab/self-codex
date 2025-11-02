import { type SpawnOptions } from "node:child_process";
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

  it("executes the Searx readiness probe inside the container", async () => {
    const spawnStub = sinon.stub().returns(createFakeChild({ closeCode: 0 }));
    const manager = createSearchStackManager({ spawn: spawnStub });
    await manager.waitForSearxReady();
    sinon.assert.calledOnce(spawnStub);
    const [command, args, options] = spawnStub.getCall(0).args as [string, string[], SpawnOptions];
    expect(command).to.equal("docker");
    expect(args.slice(0, 7)).to.deep.equal([
      "compose",
      "-f",
      manager.composeFile,
      "exec",
      "-T",
      "searxng",
      "python3",
    ]);
    expect(args[7]).to.equal("-c");
    expect(args[8]).to.contain("X-Forwarded-For");
    expect(options).to.include({ stdio: "pipe" });
  });

  it("retries the container probe until it succeeds", async () => {
    const spawnStub = sinon.stub();
    spawnStub.onCall(0).returns(createFakeChild({ closeCode: 1 }));
    spawnStub.onCall(1).returns(createFakeChild({ closeCode: 0 }));
    const delayStub = sinon.stub().resolves();
    const manager = createSearchStackManager({ spawn: spawnStub, delay: delayStub });
    await manager.waitForSearxReady();
    sinon.assert.calledTwice(spawnStub);
    sinon.assert.calledOnce(delayStub);
  });

  it("executes the Unstructured readiness probe inside the container", async () => {
    const spawnStub = sinon.stub().returns(createFakeChild({ closeCode: 0 }));
    const manager = createSearchStackManager({ spawn: spawnStub });
    await manager.waitForUnstructuredReady();
    sinon.assert.calledOnce(spawnStub);
    const [command, args, options] = spawnStub.getCall(0).args as [string, string[], SpawnOptions];
    expect(command).to.equal("docker");
    expect(args.slice(0, 7)).to.deep.equal([
      "compose",
      "-f",
      manager.composeFile,
      "exec",
      "-T",
      "unstructured",
      "sh",
    ]);
    expect(args[7]).to.equal("-c");
    expect(args[8]).to.include("general/v0/general");
    expect(options).to.include({ stdio: "pipe" });
  });

  it("retries the Unstructured probe until it succeeds", async () => {
    const spawnStub = sinon.stub();
    spawnStub.onCall(0).returns(createFakeChild({ closeCode: 1 }));
    spawnStub.onCall(1).returns(createFakeChild({ closeCode: 0 }));
    const delayStub = sinon.stub().resolves();
    const manager = createSearchStackManager({ spawn: spawnStub, delay: delayStub });
    await manager.waitForUnstructuredReady();
    sinon.assert.calledTwice(spawnStub);
    sinon.assert.calledOnce(delayStub);
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

  it("brings the stack up but skips tear down when reuse retention is enabled", () => {
    const policy = resolveStackLifecyclePolicy({ SEARCH_STACK_REUSE: "1" });
    expect(policy).to.deep.equal({ shouldBringUp: true, shouldTearDown: false });
  });

  it("recognises textual retention flags", () => {
    const policy = resolveStackLifecyclePolicy({ SEARCH_STACK_REUSE: "Hold" });
    expect(policy).to.deep.equal({ shouldBringUp: true, shouldTearDown: false });
  });

  it("normalises boolean-like retention tokens", () => {
    const policy = resolveStackLifecyclePolicy({ SEARCH_STACK_REUSE: "TrUe" });
    expect(policy).to.deep.equal({ shouldBringUp: true, shouldTearDown: false });
  });

  it("skips orchestration entirely when SEARCH_STACK_REUSE asks for external management", () => {
    const policy = resolveStackLifecyclePolicy({ SEARCH_STACK_REUSE: "external" });
    expect(policy).to.deep.equal({ shouldBringUp: false, shouldTearDown: false });
  });
});
