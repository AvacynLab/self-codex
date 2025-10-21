import { strict as assert } from "node:assert";

import { omitUndefinedEntries } from "../../src/utils/object.js";

describe("utils/object", () => {
  describe("omitUndefinedEntries", () => {
    it("drops undefined fields while keeping other falsy values", () => {
      const compacted = omitUndefinedEntries({
        defined: "value",
        missing: undefined,
        zero: 0,
        emptyString: "",
        explicitNull: null,
      });

      assert.deepEqual(compacted, {
        defined: "value",
        zero: 0,
        emptyString: "",
        explicitNull: null,
      });
    });

    it("handles nested objects by preserving their references", () => {
      const nested = { inner: { flag: true } };
      const compacted = omitUndefinedEntries({
        nested,
        other: undefined,
      });

      assert.deepEqual(compacted, { nested });
      assert.strictEqual(compacted.nested, nested);
    });
  });
});
