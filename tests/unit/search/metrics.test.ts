import { expect } from "chai";

import "./tinyldStub.js";

import { collectMethodMetrics } from "../../../src/infra/tracing.js";
import {
  SearchMetricsRecorder,
  type OperationLatencyBucketsSnapshot,
  type OperationMetricSnapshot,
} from "../../../src/search/metrics.js";

describe("search/metrics", () => {
  it("records latency samples and counters for successes and failures", async () => {
    let tick = 0;
    const metrics = new SearchMetricsRecorder({ now: () => (tick += 5) });

    const searxLabel = "search.searxQuery.content:application_json.domain:search.example.test";
    const fetchLabel = "search.fetchUrl.content:text_html.domain:docs.example.com";
    const fallbackLabel = "search.extractWithUnstructured.content:unknown.domain:unknown";
    const before = new Map(collectMethodMetrics().map((entry) => [entry.method, entry]));

    const result = await metrics.measure(
      "searxQuery",
      async () => "ok",
      undefined,
      { domain: "https://search.example.test/api", contentType: "application/json; charset=utf-8" },
    );
    expect(result).to.equal("ok");

    await metrics
      .measure(
        "fetchUrl",
        async () => {
          throw new Error("network boom");
        },
        () => "E_NETWORK",
        { domain: "docs.example.com/path", contentType: "text/html" },
      )
      .then(() => {
        throw new Error("expected rejection");
      })
      .catch((error) => {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal("network boom");
      });

    await metrics.measure("extractWithUnstructured", async () => "noop");

    const snapshot = metrics.snapshot();
    const searxCounters = findOperation(snapshot.operations, "searxQuery");
    expect(searxCounters.success).to.equal(1);
    expect(searxCounters.failure).to.equal(0);

    const fetchCounters = findOperation(snapshot.operations, "fetchUrl");
    expect(fetchCounters.success).to.equal(0);
    expect(fetchCounters.failure).to.equal(1);

    const searxBuckets = findLatencyBuckets(snapshot.latencyBuckets, "searxQuery");
    expect(bucketCount(searxBuckets, "le_00050ms")).to.equal(1);

    const fetchBuckets = findLatencyBuckets(snapshot.latencyBuckets, "fetchUrl");
    expect(bucketCount(fetchBuckets, "le_00050ms")).to.equal(1);

    const extractBuckets = findLatencyBuckets(snapshot.latencyBuckets, "extractWithUnstructured");
    expect(bucketCount(extractBuckets, "le_00050ms")).to.equal(1);

    const after = collectMethodMetrics();
    const searxMetric = after.find((entry) => entry.method === searxLabel);
    const fetchMetric = after.find((entry) => entry.method === fetchLabel);
    const extractMetric = after.find((entry) => entry.method === fallbackLabel);

    const previousSearxCount = before.get(searxLabel)?.count ?? 0;
    const previousFetchErrors = before.get(fetchLabel)?.errorCount ?? 0;
    const previousExtractCount = before.get(fallbackLabel)?.count ?? 0;

    expect((searxMetric?.count ?? 0) - previousSearxCount).to.equal(1);
    expect((fetchMetric?.errorCount ?? 0) - previousFetchErrors).to.equal(1);
    expect((extractMetric?.count ?? 0) - previousExtractCount).to.equal(1);
  });
});

function findOperation(entries: readonly OperationMetricSnapshot[], operation: OperationMetricSnapshot["operation"]): OperationMetricSnapshot {
  const match = entries.find((entry) => entry.operation === operation);
  expect(match, `missing operation ${operation}`).to.not.equal(undefined);
  return match as OperationMetricSnapshot;
}

function findLatencyBuckets(
  entries: readonly OperationLatencyBucketsSnapshot[],
  operation: OperationLatencyBucketsSnapshot["operation"],
): OperationLatencyBucketsSnapshot {
  const match = entries.find((entry) => entry.operation === operation);
  expect(match, `missing latency buckets for ${operation}`).to.not.equal(undefined);
  return match as OperationLatencyBucketsSnapshot;
}

function bucketCount(buckets: OperationLatencyBucketsSnapshot, bucket: string): number {
  const entry = buckets.buckets.find((candidate) => candidate.bucket === bucket);
  expect(entry, `missing bucket ${bucket}`).to.not.equal(undefined);
  return (entry as typeof entry & { count: number }).count;
}
