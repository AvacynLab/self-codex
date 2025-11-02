import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildFixtureExtractionElements,
  buildFixtureSearchResponse,
  createFixtureUnstructuredFetch,
  createSearchSmokeFixture,
  __testing,
} from "../../scripts/lib/searchSmokeFixture.js";

const execFileAsync = promisify(execFile);

describe("search smoke fixture server", () => {
  const fixtures: Array<Awaited<ReturnType<typeof createSearchSmokeFixture>>> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (!fixture) {
        continue;
      }
      await fixture.close();
    }
  });

  it("builds deterministic search responses", () => {
    const snapshot = buildFixtureSearchResponse("http://127.0.0.1:9999", "demo query");
    expect(snapshot.query).to.equal("demo query");
    expect(snapshot.results).to.have.length.greaterThan(0);
    for (const result of snapshot.results) {
      expect(result).to.have.property("url").that.matches(/^http:\/\/127\.0\.0\.1:9999\//);
      expect(result).to.have.property("title").that.is.a("string");
      expect(result).to.have.property("content").that.is.a("string");
      expect(result).to.have.property("mimetype", "text/html");
    }
  });

  it("serves search results and documents over HTTP", async () => {
    const fixture = await createSearchSmokeFixture();
    fixtures.push(fixture);

    const script = [
      "(async () => {",
      "  const base = process.env.FIXTURE_BASE_URL;",
      "  const searchRes = await fetch(`${base}/search?q=smoke&format=json`);",
      "  if (!searchRes.ok) {",
      "    throw new Error(`search status ${searchRes.status}`);",
      "  }",
      "  const payload = await searchRes.json();",
      "  if (!Array.isArray(payload.results) || payload.results.length === 0) {",
      "    throw new Error('missing results');",
      "  }",
      "  const first = payload.results[0];",
      "  const docRes = await fetch(first.url);",
      "  if (!docRes.ok) {",
      "    throw new Error(`doc status ${docRes.status}`);",
      "  }",
      "  const html = await docRes.text();",
      "  console.log(JSON.stringify({ count: payload.results.length, snippet: first.content, htmlLength: html.length }));",
      "})();",
    ].join("\n");

    const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
      env: { ...process.env, FIXTURE_BASE_URL: fixture.baseUrl },
    });
    const parsed = JSON.parse(stdout.trim()) as { count: number; snippet: string; htmlLength: number };
    expect(parsed.count).to.be.greaterThan(0);
    expect(parsed.snippet).to.be.a("string").and.to.have.length.greaterThan(0);
    expect(parsed.htmlLength).to.be.greaterThan(100);
  });

  it("exposes a permissive robots policy", async () => {
    const fixture = await createSearchSmokeFixture();
    fixtures.push(fixture);
    const robotsScript = [
      "(async () => {",
      "  const base = process.env.FIXTURE_BASE_URL;",
      "  const res = await fetch(`${base}/robots.txt`);",
      "  console.log(await res.text());",
      "})();",
    ].join("\n");
    const { stdout } = await execFileAsync(process.execPath, ["-e", robotsScript], {
      env: { ...process.env, FIXTURE_BASE_URL: fixture.baseUrl },
    });
    expect(stdout.trim()).to.equal(__testing.ROBOTS_TXT.trim());
  });

  it("returns static extraction payloads for known documents", () => {
    for (const document of __testing.FIXTURE_DOCUMENTS) {
      const elements = buildFixtureExtractionElements(document.slug);
      expect(elements, `missing extraction for ${document.slug}`).to.not.be.null;
      expect(elements).to.be.an("array").with.length.greaterThan(0);
      for (const element of elements ?? []) {
        expect(element).to.have.property("type").that.is.a("string");
      }
    }
  });

  it("serves unstructured-style responses through the custom fetch helper", async () => {
    const fixture = await createSearchSmokeFixture();
    fixtures.push(fixture);
    const fetchImpl = createFixtureUnstructuredFetch(fixture.baseUrl);
    const form = new FormData();
    const slug = __testing.FIXTURE_DOCUMENTS[0]?.slug ?? "retrieval-augmented-generation.html";
    form.append("files", new Blob(["<html></html>"], { type: "text/html" }), slug);
    form.append("strategy", "fast");

    const response = await fetchImpl(new URL("/general/v0/general", fixture.baseUrl), {
      method: "POST",
      body: form,
    });

    expect(response.ok).to.be.true;
    const payload = (await response.json()) as Array<Record<string, unknown>>;
    expect(payload).to.be.an("array").with.length.greaterThan(0);
    expect(payload[0]).to.have.property("type");
  });
});
