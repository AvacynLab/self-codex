#!/usr/bin/env node
const http = require("node:http");
const { URL } = require("node:url");

const baseUrl = process.env.HTTP_PROBE_BASE_URL;
const path = process.env.HTTP_PROBE_PATH ?? "/";
const token = process.env.HTTP_PROBE_TOKEN ?? "";

if (!baseUrl) {
  process.stdout.write(JSON.stringify({ status: null, error: "missing base url" }));
  process.stdout.write("\n");
  process.exit(0);
}

try {
  const target = new URL(path, baseUrl);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const options = {
    method: "GET",
    hostname: target.hostname,
    port: target.port ? Number(target.port) : undefined,
    path: `${target.pathname}${target.search}`,
    headers,
  };

  const req = http.request(options, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      process.stdout.write(JSON.stringify({ status: res.statusCode ?? null, body: raw }));
      process.stdout.write("\n");
    });
  });

  req.on("error", (error) => {
    process.stdout.write(JSON.stringify({ status: null, error: String(error && error.message ? error.message : error) }));
    process.stdout.write("\n");
  });

  req.end();
} catch (error) {
  process.stdout.write(JSON.stringify({ status: null, error: error instanceof Error ? error.message : String(error) }));
  process.stdout.write("\n");
}
