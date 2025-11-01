import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Description of a static document served by the smoke fixture. */
interface FixtureDocument {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly html: string;
}

/** Pre-rendered HTML documents ingested during the smoke validation. */
const FIXTURE_DOCUMENTS: readonly FixtureDocument[] = [
  {
    slug: "retrieval-augmented-generation.html",
    title: "Retrieval augmented generation primer",
    summary: "Overview of how retrieval augmented generation enriches LLM answers.",
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Retrieval augmented generation primer</title>
  </head>
  <body>
    <article>
      <h1>Retrieval augmented generation primer</h1>
      <p id="intro">Retrieval augmented generation (RAG) combines search with large language models.</p>
      <p>Relevant documents are fetched first so the model can ground its response on factual evidence.</p>
      <p>This smoke fixture keeps the content short so extraction completes quickly during CI runs.</p>
    </article>
  </body>
</html>`,
  },
  {
    slug: "python-dataclasses-overview.html",
    title: "Python dataclasses tutorial excerpt",
    summary: "Quick reminder covering dataclass features such as default factories.",
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Python dataclasses tutorial excerpt</title>
  </head>
  <body>
    <article>
      <h1>Python dataclasses tutorial excerpt</h1>
      <p>Dataclasses remove boilerplate by generating __init__ and __repr__ automatically.</p>
      <p class="tip">Default factories can be used to compute field values lazily.</p>
    </article>
  </body>
</html>`,
  },
];

/** Lightweight robots policy keeping the smoke crawler unrestricted. */
const ROBOTS_TXT = "User-agent: *\nAllow: /\n";

/** JSON structure returned by the stubbed Searx endpoint. */
interface FixtureSearchResponse {
  readonly query: string;
  readonly results: ReadonlyArray<Record<string, unknown>>;
}

/** Public contract returned by {@link createSearchSmokeFixture}. */
export interface SearchSmokeFixture {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * Builds the JSON payload returned by the `/search` endpoint.  The response mirrors the
 * subset of the SearxNG contract relied upon by {@link SearxClient}, keeping the shape minimal
 * while still exercising the downloader, unstructured extractor and ingestion layers.
 */
export function buildFixtureSearchResponse(baseUrl: string, query: string): FixtureSearchResponse {
  const results = FIXTURE_DOCUMENTS.map((document, index) => ({
    url: `${baseUrl}/docs/${document.slug}`,
    title: document.title,
    content: document.summary,
    engines: ["fixture"],
    categories: ["general"],
    score: 1 - index * 0.1,
    mimetype: "text/html",
  }));
  return { query, results };
}

/** Handles HTTP requests routed to the smoke fixture server. */
function handleRequest(
  baseUrlRef: () => string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (!request.url) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("missing url");
    return;
  }

  let target: URL;
  try {
    const base = baseUrlRef();
    target = new URL(request.url, base.length > 0 ? base : "http://127.0.0.1");
  } catch (error) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end(`invalid url: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (target.pathname === "/robots.txt") {
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(ROBOTS_TXT).toString(),
    });
    response.end(ROBOTS_TXT);
    return;
  }

  if (target.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (target.pathname === "/search") {
    const format = target.searchParams.get("format");
    if (format && format.toLowerCase() !== "json") {
      response.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "unsupported format" }));
      return;
    }
    const payload = buildFixtureSearchResponse(baseUrlRef(), target.searchParams.get("q") ?? "");
    const body = JSON.stringify(payload);
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body).toString(),
    });
    response.end(body);
    return;
  }

  if (target.pathname.startsWith("/docs/")) {
    const slug = target.pathname.replace("/docs/", "");
    const document = FIXTURE_DOCUMENTS.find((entry) => entry.slug === slug);
    if (!document) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("document not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
    response.end(document.html);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}

/** Spawns the HTTP fixture server bound to the loopback interface. */
export async function createSearchSmokeFixture(): Promise<SearchSmokeFixture> {
  let baseUrl = "";
  const server = createServer((request, response) => handleRequest(() => baseUrl, request, response));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    throw new Error("search smoke fixture failed to bind to an ephemeral port");
  }
  baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

  return {
    baseUrl,
    async close(): Promise<void> {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export const __testing = {
  FIXTURE_DOCUMENTS,
  ROBOTS_TXT,
};
