import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { createStubChildSupervisor } from "./childSupervisor.js";

describe("createStubChildSupervisor", () => {
  it("provides deterministic defaults for read-only helpers", () => {
    const supervisor = createStubChildSupervisor();

    expect(supervisor.childrenIndex.list()).to.deep.equal([]);
    expect(supervisor.childrenIndex.getChild("missing-child")).to.equal(undefined);
    expect(supervisor.createChildId()).to.equal("child-stub");
    expect(supervisor.getAllowedTools("any-child")).to.deep.equal([]);
    expect(supervisor.getHttpEndpoint("any-child")).to.equal(null);
  });

  it("throws when lifecycle operations are not overridden", async () => {
    const supervisor = createStubChildSupervisor();

    const expectMissing = async (invoke: () => Promise<unknown>, method: string) => {
      try {
        await invoke();
        expect.fail(`${method} should throw when no override is provided`);
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal(
          `ChildSupervisorContract.${method} not implemented in test stub`,
        );
      }
    };

    await expectMissing(() => supervisor.createChild(), "createChild");
    await expectMissing(() => supervisor.attachChild("child"), "attachChild");
    await expectMissing(() => supervisor.setChildRole("child", "role"), "setChildRole");
    await expectMissing(() => supervisor.setChildLimits("child", null), "setChildLimits");
    await expectMissing(() => supervisor.send("child", { payload: true }), "send");
    await expectMissing(() => supervisor.waitForExit("child"), "waitForExit");
  });

  it("delegates to provided overrides", async () => {
    const attachChild = sinon.stub().resolves({ childId: "child-1" });
    const setChildRole = sinon.stub().resolves({ childId: "child-1", role: "scout" });
    const cancel = sinon.stub().resolves({ childId: "child-1", terminated: true });
    const getAllowedTools = sinon.stub().returns(["graph_snapshot"]);

    const supervisor = createStubChildSupervisor({
      attachChild,
      setChildRole,
      cancel,
      getAllowedTools,
    });

    expect(await supervisor.attachChild("child-1")).to.deep.equal({ childId: "child-1" });
    expect(await supervisor.setChildRole("child-1", "scout")).to.deep.equal({ childId: "child-1", role: "scout" });
    expect(await supervisor.cancel("child-1")).to.deep.equal({ childId: "child-1", terminated: true });
    expect(supervisor.getAllowedTools("child-1")).to.deep.equal(["graph_snapshot"]);

    expect(attachChild.calledOnceWithExactly("child-1")).to.equal(true);
    expect(setChildRole.calledOnceWithExactly("child-1", "scout")).to.equal(true);
    expect(cancel.calledOnceWithExactly("child-1")).to.equal(true);
    expect(getAllowedTools.calledOnceWithExactly("child-1")).to.equal(true);
  });

  it("executes provided collect override and forwards parameters", async () => {
    const collect = sinon.stub().resolves({ logs: [] });
    const supervisor = createStubChildSupervisor({ collect });

    const result = await supervisor.collect("child-42");
    expect(result).to.deep.equal({ logs: [] });
    expect(collect.calledOnceWithExactly("child-42")).to.equal(true);
  });

  it("supports overriding limit management and exit waits", async () => {
    // Verifies the helper forwards quota updates and exit waits to the custom implementation
    // without mutating the arguments provided by the suite under test.
    const setChildLimits = sinon.stub().resolves({ childId: "child-1", limits: { cpu: 2 } });
    const waitForExit = sinon.stub().resolves({ childId: "child-1", code: 0 });

    const supervisor = createStubChildSupervisor({ setChildLimits, waitForExit });

    expect(await supervisor.setChildLimits("child-1", { cpu: 2 })).to.deep.equal({
      childId: "child-1",
      limits: { cpu: 2 },
    });
    expect(await supervisor.waitForExit("child-1")).to.deep.equal({ childId: "child-1", code: 0 });

    expect(setChildLimits.calledOnceWithExactly("child-1", { cpu: 2 })).to.equal(true);
    expect(waitForExit.calledOnceWithExactly("child-1")).to.equal(true);
  });

  it("propagates failures from overridden operations", async () => {
    // Ensures overridden methods can signal bespoke failures and that the helper does not
    // mask or rewrite the resulting exception.
    const error = new Error("boom");
    const setChildLimits = sinon.stub().rejects(error);
    const supervisor = createStubChildSupervisor({ setChildLimits });

    try {
      await supervisor.setChildLimits("child-1", { cpu: 1 });
      expect.fail("setChildLimits override rejection should propagate");
    } catch (caught) {
      expect(caught).to.equal(error);
    }

    expect(setChildLimits.calledOnceWithExactly("child-1", { cpu: 1 })).to.equal(true);
  });
});
