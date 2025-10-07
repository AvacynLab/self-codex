import { describe, it } from "mocha";
import { expect } from "chai";

import { EventBus } from "../src/events/bus.js";

describe("event bus backpressure", () => {
  it("drops informational history entries before warnings and errors", () => {
    const bus = new EventBus({ historyLimit: 3 });

    bus.publish({ cat: "graph", level: "info", msg: "info-1" });
    bus.publish({ cat: "graph", level: "warn", msg: "warn-1" });
    bus.publish({ cat: "graph", level: "info", msg: "info-2" });
    bus.publish({ cat: "graph", level: "error", msg: "error-1" });

    const history = bus.list();
    expect(history.map((event) => event.msg)).to.deep.equal(["warn-1", "info-2", "error-1"]);
    expect(history.every((event) => event.level !== "info" || event.msg !== "info-1")).to.equal(true);
  });

  it("applies the same pressure policy to live stream buffers", async () => {
    const bus = new EventBus({ historyLimit: 10, streamBufferSize: 3 });
    const stream = bus.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    bus.publish({ cat: "graph", level: "info", msg: "info-1" });
    bus.publish({ cat: "graph", level: "warn", msg: "warn-1" });
    bus.publish({ cat: "graph", level: "info", msg: "info-2" });
    bus.publish({ cat: "graph", level: "error", msg: "error-1" });

    const buffered: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { value } = await iterator.next();
      buffered.push(value.msg);
    }

    expect(buffered).to.deep.equal(["warn-1", "info-2", "error-1"]);
    stream.close();
  });
});
