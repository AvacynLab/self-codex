import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildSupervisor } from "../src/children/supervisor.js";
import { omitUndefinedEntries } from "../src/utils/object.js";

/**
 * Create an isolated children workspace so each test can spawn supervisors
 * without interfering with the global `children/` folder the runtime owns.
 */
function createChildrenRoot(): string {
  return mkdtempSync(join(tmpdir(), "child-supervisor-sandbox-"));
}

describe("child supervisor sandbox defaults", () => {
  it("omits undefined sandbox default profile", async () => {
    const root = createChildrenRoot();
    const sandboxOptions = {
      // The helper removes undefined values so the supervisor restores its
      // documented fallback `null` profile instead of forwarding `undefined`.
      ...omitUndefinedEntries({ defaultProfile: undefined }),
      allowEnv: [],
    } satisfies Record<string, unknown>;
    const supervisor = new ChildSupervisor({
      childrenRoot: root,
      defaultCommand: process.execPath,
      sandbox: sandboxOptions,
    });

    try {
      assert.strictEqual("defaultProfile" in sandboxOptions, false);
      const defaults = (supervisor as unknown as { sandboxDefaults: Record<string, unknown> }).sandboxDefaults;
      assert.deepEqual(defaults, { allowEnv: [], defaultProfile: null });
    } finally {
      await supervisor.disposeAll();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains explicit sandbox default profile", async () => {
    const root = createChildrenRoot();
    const supervisor = new ChildSupervisor({
      childrenRoot: root,
      defaultCommand: process.execPath,
      sandbox: { defaultProfile: "strict", allowEnv: [] },
    });

    try {
      // When the profile is provided explicitly the supervisor should forward
      // it unchanged to the internal defaults map.
      const defaults = (supervisor as unknown as { sandboxDefaults: Record<string, unknown> }).sandboxDefaults;
      assert.deepEqual(defaults, { defaultProfile: "strict", allowEnv: [] });
    } finally {
      await supervisor.disposeAll();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
