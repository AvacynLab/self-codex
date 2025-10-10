"use strict";

/**
 * Preflight validation stage responsible for exercising the HTTP transport
 * before the main MCP tool campaign begins. The stage ensures the configured
 * endpoint requires authentication, persists the probing requests/responses in
 * the validation artefact folders, and captures a context snapshot consumed by
 * later reporting tasks.
 */
import { createHash, randomUUID } from "node:crypto";

import { loadServerModule } from "../server-loader.mjs";

const DEFAULT_PHASE_ID = "phase-00-preflight";
const JSON_HEADERS = Object.freeze({
  "content-type": "application/json",
  accept: "application/json",
});

let httpServerModulePromise = null;
let loggerModulePromise = null;

function isModuleNotFound(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = /** @type {{ code?: string }} */ (error).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  const message = typeof error.message === "string" ? error.message : "";
  return message.includes("Cannot find module");
}

async function loadHttpServerModule() {
  if (httpServerModulePromise) {
    return httpServerModulePromise;
  }
  const candidates = [
    new URL("../../../../src/httpServer.js", import.meta.url),
    new URL("../../../../dist/httpServer.js", import.meta.url),
  ];
  httpServerModulePromise = (async () => {
    let lastError = null;
    for (const specifier of candidates) {
      try {
        return await import(specifier.href);
      } catch (error) {
        if (isModuleNotFound(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw new Error("Unable to locate the HTTP server module", { cause: lastError ?? undefined });
  })();
  return httpServerModulePromise;
}

async function loadLoggerModule() {
  if (loggerModulePromise) {
    return loggerModulePromise;
  }
  const candidates = [
    new URL("../../../../src/logger.js", import.meta.url),
    new URL("../../../../dist/logger.js", import.meta.url),
  ];
  loggerModulePromise = (async () => {
    let lastError = null;
    for (const specifier of candidates) {
      try {
        return await import(specifier.href);
      } catch (error) {
        if (isModuleNotFound(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw new Error("Unable to locate the logger module", { cause: lastError ?? undefined });
  })();
  return loggerModulePromise;
}

function ensureFetchImplementation(fetchImpl) {
  if (typeof fetchImpl === "function") {
    return fetchImpl;
  }
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error("The runtime does not expose a fetch implementation suitable for HTTP probes");
}

function normalisePath(pathname) {
  const trimmed = (pathname ?? "/mcp").trim();
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/${trimmed}`;
}

function parsePort(rawPort) {
  if (typeof rawPort !== "string" || rawPort.trim().length === 0) {
    return 0;
  }
  const parsed = Number.parseInt(rawPort.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function headersToObject(headers) {
  const result = {};
  if (!headers || typeof headers.forEach !== "function") {
    return result;
  }
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return { raw: "", parsed: null };
  }
  try {
    return { raw: text, parsed: JSON.parse(text) };
  } catch {
    return { raw: text, parsed: null };
  }
}

function maskToken(token) {
  if (!token) {
    return null;
  }
  if (token.length <= 8) {
    return `${token.slice(0, 2)}***${token.slice(-2)}`;
  }
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

function fingerprintToken(token) {
  if (!token) {
    return null;
  }
  const hash = createHash("sha256");
  hash.update(token);
  return hash.digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function buildProbePayload(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "mcp_info",
    params: {},
  };
}

function buildPhaseFilenames(phaseId) {
  const sanitized = String(phaseId ?? DEFAULT_PHASE_ID).replace(/[^a-zA-Z0-9_-]/g, "-");
  return {
    requests: `${sanitized}-requests.jsonl`,
    responses: `${sanitized}-responses.jsonl`,
    report: `step00-preflight.json`,
    context: `context.json`,
  };
}

/**
 * Executes the preflight HTTP validation stage.
 *
 * @param {{
 *   context: import("../run-context.mjs").RunContext,
 *   recorder: import("../artifact-recorder.mjs").ArtifactRecorder,
 *   logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void },
 *   phaseId?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ phaseId: string, summary: Record<string, unknown>, calls: Array<never> }>}
 */
export async function runPreflightStage(options) {
  const {
    context,
    recorder,
    logger = console,
    phaseId = DEFAULT_PHASE_ID,
    fetchImpl,
  } = options;

  const fetchFn = ensureFetchImplementation(fetchImpl);
  const filenames = buildPhaseFilenames(phaseId);

  await recorder.appendLogEntry({
    level: "info",
    message: "stage_started",
    phaseId,
    details: { stage: "preflight", phase_id: phaseId },
  });

  const host = (process.env.MCP_HTTP_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const requestedPort = parsePort(process.env.MCP_HTTP_PORT ?? "0");
  const path = normalisePath(process.env.MCP_HTTP_PATH ?? "/mcp");
  const tokenFromEnv = process.env.MCP_HTTP_TOKEN ?? "";
  const offlineGuardMessage = typeof globalThis.__OFFLINE_TEST_GUARD__ === "string"
    ? globalThis.__OFFLINE_TEST_GUARD__
    : null;
  const offlineMode = Boolean(offlineGuardMessage);
  const tokenGenerated = !tokenFromEnv && !offlineMode;
  const token = tokenFromEnv || (offlineMode ? "" : randomUUID());
  const tokenSource = tokenFromEnv ? "environment" : offlineMode ? "skipped" : "generated";
  const tokenFingerprint = fingerprintToken(token);
  const tokenPreview = maskToken(token);
  const previousToken = process.env.MCP_HTTP_TOKEN;
  let tokenRestored = false;

  if (tokenGenerated) {
    process.env.MCP_HTTP_TOKEN = token;
  }
  const startedAt = nowIso();
  let handle = null;
  let contextPath = null;
  let requestsPath = null;
  let responsesPath = null;
  let reportPath = null;

  const contextDocumentBase = {
    recordedAt: startedAt,
    target: {
      host,
      requestedPort,
      path,
    },
    headers: {
      authorization: tokenPreview ? `Bearer ${tokenPreview}` : null,
    },
    token: {
      source: tokenSource,
      fingerprint: tokenFingerprint,
    },
  };

  if (offlineMode) {
    const contextDocument = {
      ...contextDocumentBase,
      target: {
        ...contextDocumentBase.target,
        actualPort: null,
        baseUrl: null,
      },
      offline: {
        reason: offlineGuardMessage,
      },
    };

    contextPath = await recorder.recordJsonDocument({
      directory: "report",
      filename: filenames.context,
      payload: contextDocument,
      phaseId,
      metadata: { artifact: "session_context" },
    });

    requestsPath = await recorder.appendJsonlArtifact({
      directory: "inputs",
      filename: filenames.requests,
      payload: {
        timestamp: nowIso(),
        skipped: true,
        reason: offlineGuardMessage,
        expectation: { status: 401 },
      },
      phaseId,
      metadata: { channel: "http_requests" },
    });

    responsesPath = await recorder.appendJsonlArtifact({
      directory: "outputs",
      filename: filenames.responses,
      payload: {
        timestamp: nowIso(),
        skipped: true,
        reason: offlineGuardMessage,
        expectation: { status: 401 },
      },
      phaseId,
      metadata: { channel: "http_responses" },
    });

    requestsPath = await recorder.appendJsonlArtifact({
      directory: "inputs",
      filename: filenames.requests,
      payload: {
        timestamp: nowIso(),
        skipped: true,
        reason: offlineGuardMessage,
        expectation: { status: 200 },
      },
      phaseId,
      metadata: { channel: "http_requests" },
    });

    responsesPath = await recorder.appendJsonlArtifact({
      directory: "outputs",
      filename: filenames.responses,
      payload: {
        timestamp: nowIso(),
        skipped: true,
        reason: offlineGuardMessage,
        expectation: { status: 200 },
      },
      phaseId,
      metadata: { channel: "http_responses" },
    });

    await recorder.appendPhaseEvent({
      phaseId,
      event: {
        kind: "http_probe",
        probe: "unauthorised",
        skipped: true,
        reason: offlineGuardMessage,
      },
    });

    await recorder.appendPhaseEvent({
      phaseId,
      event: {
        kind: "http_probe",
        probe: "authorised",
        skipped: true,
        reason: offlineGuardMessage,
      },
    });

    const summary = {
      target: {
        host,
        requestedPort,
        actualPort: null,
        path,
        baseUrl: null,
      },
      checks: {
        unauthorised: {
          expected: 401,
          status: null,
          ok: false,
          skipped: true,
          reason: offlineGuardMessage,
        },
        authorised: {
          expected: 200,
          status: null,
          ok: false,
          skipped: true,
          reason: offlineGuardMessage,
        },
      },
      token: {
        source: tokenSource,
        fingerprint: tokenFingerprint,
      },
      offline: {
        reason: offlineGuardMessage,
      },
      events: {
        baseline: { count: 0 },
        followUp: { count: 0 },
      },
      artifacts: {
        contextPath,
        requestsPath,
        responsesPath,
      },
    };

    reportPath = await recorder.recordJsonDocument({
      directory: "report",
      filename: filenames.report,
      payload: summary,
      phaseId,
      metadata: { artifact: "stage_report" },
    });

    await recorder.appendLogEntry({
      level: "warn",
      message: "stage_skipped",
      phaseId,
      details: {
        stage: "preflight",
        reason: offlineGuardMessage,
        phase_id: phaseId,
        report_path: reportPath,
        context_path: contextPath,
      },
    });

    return {
      phaseId,
      summary: { ...summary, reportPath },
      calls: [],
    };
  }

  const { server, configureRuntimeFeatures, getRuntimeFeatures } = await loadServerModule();
  const httpModule = await loadHttpServerModule();
  const loggerModule = await loadLoggerModule();
  const { StructuredLogger } = loggerModule;

  const runtimeFeatures = getRuntimeFeatures();
  configureRuntimeFeatures({ ...runtimeFeatures, enableMcpIntrospection: true });

  const structuredLogger = new StructuredLogger();

  try {
    handle = await httpModule.startHttpServer(
      server,
      {
        host,
        port: requestedPort,
        path,
        enableJson: true,
        stateless: true,
      },
      structuredLogger,
    );

    const actualPort = handle.port;
    const baseUrl = `http://${host}:${actualPort}${path}`;

    const contextDocument = {
      ...contextDocumentBase,
      target: {
        host,
        requestedPort,
        actualPort,
        path,
        baseUrl,
      },
    };

    contextPath = await recorder.recordJsonDocument({
      directory: "report",
      filename: filenames.context,
      payload: contextDocument,
      phaseId,
      metadata: { artifact: "session_context" },
    });

    const unauthorizedPayload = buildProbePayload("preflight-unauthorised");
    const authorizedPayload = buildProbePayload("preflight-authorised");

    const requestHeaders = { ...JSON_HEADERS };
    const authHeaders = { ...JSON_HEADERS, authorization: `Bearer ${token}` };

    requestsPath = await recorder.appendJsonlArtifact({
      directory: "inputs",
      filename: filenames.requests,
      payload: {
        timestamp: nowIso(),
        method: "POST",
        url: baseUrl,
        headers: requestHeaders,
        body: unauthorizedPayload,
        expectation: { status: 401 },
      },
      phaseId,
      metadata: { channel: "http_requests" },
    });

    const unauthorisedResponse = await fetchFn(baseUrl, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(unauthorizedPayload),
    });
    const unauthorisedBody = await readResponseBody(unauthorisedResponse);

    responsesPath = await recorder.appendJsonlArtifact({
      directory: "outputs",
      filename: filenames.responses,
      payload: {
        timestamp: nowIso(),
        status: unauthorisedResponse.status,
        ok: unauthorisedResponse.ok,
        headers: headersToObject(unauthorisedResponse.headers),
        body: unauthorisedBody.parsed ?? unauthorisedBody.raw,
        expectation: { status: 401 },
      },
      phaseId,
      metadata: { channel: "http_responses" },
    });

    await recorder.appendPhaseEvent({
      phaseId,
      event: {
        kind: "http_probe",
        probe: "unauthorised",
        status: unauthorisedResponse.status,
        ok: unauthorisedResponse.status === 401,
      },
    });

    requestsPath = await recorder.appendJsonlArtifact({
      directory: "inputs",
      filename: filenames.requests,
      payload: {
        timestamp: nowIso(),
        method: "POST",
        url: baseUrl,
        headers: authHeaders,
        body: authorizedPayload,
        expectation: { status: 200 },
      },
      phaseId,
      metadata: { channel: "http_requests" },
    });

    const authorisedResponse = await fetchFn(baseUrl, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(authorizedPayload),
    });
    const authorisedBody = await readResponseBody(authorisedResponse);

    responsesPath = await recorder.appendJsonlArtifact({
      directory: "outputs",
      filename: filenames.responses,
      payload: {
        timestamp: nowIso(),
        status: authorisedResponse.status,
        ok: authorisedResponse.ok,
        headers: headersToObject(authorisedResponse.headers),
        body: authorisedBody.parsed ?? authorisedBody.raw,
        expectation: { status: 200 },
      },
      phaseId,
      metadata: { channel: "http_responses" },
    });

    await recorder.appendPhaseEvent({
      phaseId,
      event: {
        kind: "http_probe",
        probe: "authorised",
        status: authorisedResponse.status,
        ok: authorisedResponse.status === 200,
      },
    });

    const summary = {
      target: {
        host,
        requestedPort,
        actualPort,
        path,
        baseUrl,
      },
      checks: {
        unauthorised: {
          expected: 401,
          status: unauthorisedResponse.status,
          ok: unauthorisedResponse.status === 401,
        },
        authorised: {
          expected: 200,
          status: authorisedResponse.status,
          ok: authorisedResponse.status === 200,
        },
      },
      token: {
        source: tokenSource,
        fingerprint: tokenFingerprint,
      },
      events: {
        baseline: { count: unauthorisedResponse.status === 401 ? 1 : 0 },
        followUp: { count: authorisedResponse.status === 200 ? 1 : 0 },
      },
      artifacts: {
        contextPath,
        requestsPath,
        responsesPath,
      },
    };

    reportPath = await recorder.recordJsonDocument({
      directory: "report",
      filename: filenames.report,
      payload: summary,
      phaseId,
      metadata: { artifact: "stage_report" },
    });

    await recorder.appendLogEntry({
      level: summary.checks.unauthorised.ok && summary.checks.authorised.ok ? "info" : "warn",
      message: "stage_completed",
      phaseId,
      details: {
        stage: "preflight",
        phase_id: phaseId,
        report_path: reportPath,
        context_path: contextPath,
        target: summary.target,
        checks: summary.checks,
      },
    });

    return {
      phaseId,
      summary: { ...summary, reportPath },
      calls: [],
    };
  } catch (error) {
    logger?.error?.("preflight_stage_failed", error);
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    configureRuntimeFeatures(runtimeFeatures);
    if (!tokenFromEnv) {
      if (previousToken) {
        process.env.MCP_HTTP_TOKEN = previousToken;
      } else {
        delete process.env.MCP_HTTP_TOKEN;
      }
      tokenRestored = true;
    }
    if (!tokenRestored && previousToken !== undefined) {
      process.env.MCP_HTTP_TOKEN = previousToken;
    }
  }
}
