import { expect } from "chai";

import "./tinyldStub.js";

import { collectMethodMetrics } from "../../../src/infra/tracing.js";
import {
  SearchMetricsRecorder,
  type OperationMetricSnapshot,
} from "../../../src/search/metrics.js";

describe("search/metrics", () => {
  it("records latency samples and counters for successes and failures", async () => {
    let tick = 0;
    const metrics = new SearchMetricsRecorder({ now: () => (tick += 5) });

    const before = new Map(collectMethodMetrics().map((entry) => [entry.method, entry]));

    const result = await metrics.measure("searxQuery", async () => "ok");
    expect(result).to.equal("ok");

    await metrics
      .measure("fetchUrl", async () => {
        throw new Error("network boom");
      })
      .then(() => {
        throw new Error("expected rejection");
      })
      .catch((error) => {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal("network boom");
      });

    const snapshot = metrics.snapshot();
    const searxCounters = findOperation(snapshot.operations, "searxQuery");
    expect(searxCounters.success).to.equal(1);
    expect(searxCounters.failure).to.equal(0);

    const fetchCounters = findOperation(snapshot.operations, "fetchUrl");
    expect(fetchCounters.success).to.equal(0);
    expect(fetchCounters.failure).to.equal(1);

    const after = collectMethodMetrics();
    const searxMetric = after.find((entry) => entry.method === "search.searxQuery");
    const fetchMetric = after.find((entry) => entry.method === "search.fetchUrl");

    const previousSearxCount = before.get("search.searxQuery")?.count ?? 0;
    const previousFetchErrors = before.get("search.fetchUrl")?.errorCount ?? 0;

    expect((searxMetric?.count ?? 0) - previousSearxCount).to.equal(1);
    expect((fetchMetric?.errorCount ?? 0) - previousFetchErrors).to.equal(1);
  });
});

function findOperation(entries: readonly OperationMetricSnapshot[], operation: OperationMetricSnapshot["operation"]): OperationMetricSnapshot {
  const match = entries.find((entry) => entry.operation === operation);
  expect(match, `missing operation ${operation}`).to.not.equal(undefined);
  return match as OperationMetricSnapshot;
}
