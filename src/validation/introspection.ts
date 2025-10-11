import { writeFile } from "node:fs/promises";
import { join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  appendHttpCheckArtefactsToFiles,
  performHttpCheck,
  toJsonlLine,
  type HttpCheckSnapshot,
  type HttpEnvironmentSummary,
  type HttpCheckArtefactTargets,
} from "./runSetup.js";

/** JSONL targets dedicated to the introspection phase (section 1 of the playbook). */
export const INTROSPECTION_JSONL_FILES = {
  inputs: "inputs/01_introspection.jsonl",
  outputs: "outputs/01_introspection.jsonl",
  events: "events/01_bus.jsonl",
  log: "logs/introspection_http.json",
} as const;

const INTROSPECTION_TARGETS: HttpCheckArtefactTargets = {
  inputs: INTROSPECTION_JSONL_FILES.inputs,
  outputs: INTROSPECTION_JSONL_FILES.outputs,
};

/**
 * Specification of a JSON-RPC call that should be executed during the
 * introspection phase.  The helper remains generic so future agents can extend
 * the list without modifying the runner logic.
 */
export interface JsonRpcCallSpec {
  /** Friendly identifier used when persisting artefacts. */
  name: string;
  /** JSON-RPC method to invoke against the MCP server. */
  method: string;
  /** Optional params object forwarded as-is to the server. */
  params?: unknown;
}

/** Default set of JSON-RPC calls required to satisfy section 1 of the playbook. */
export const DEFAULT_INTROSPECTION_CALLS: JsonRpcCallSpec[] = [
  { name: "mcp_info", method: "mcp/info" },
  { name: "mcp_capabilities", method: "mcp/capabilities" },
  { name: "tools_list", method: "tools/list" },
  { name: "resources_list", method: "resources/list" },
  { name: "events_subscribe", method: "events/subscribe" },
];

/** Captures the outcome of a JSON-RPC call along with the raw HTTP snapshot. */
export interface JsonRpcCallOutcome {
  /** Specification executed by the runner. */
  call: JsonRpcCallSpec;
  /** HTTP artefacts (status, headers, parsed body). */
  check: HttpCheckSnapshot;
}

/** Extracts emitted events from the JSON-RPC response payload. */
function extractEventsFromResponse(body: unknown): unknown[] {
  if (!body || typeof body !== "object") {
    return [];
  }

  const envelope = body as Record<string, unknown>;
  const result = envelope.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object") {
    return [];
  }

  const events = result.events;
  if (Array.isArray(events)) {
    return events;
  }

  return [];
}

/** Appends the captured events to the phase-specific `.jsonl` file. */
async function appendEvents(runRoot: string, source: string, events: unknown[]): Promise<void> {
  if (!events.length) {
    return;
  }

  const capturedAt = new Date().toISOString();
  const payload = events
    .map((event) => toJsonlLine({ source, capturedAt, event }))
    .join("");

  await writeFile(join(runRoot, INTROSPECTION_JSONL_FILES.events), payload, { encoding: "utf8", flag: "a" });
}

/**
 * Executes the introspection calls sequentially and persists artefacts under
 * `runs/validation_…/`.  The helper uses the same JSONL layout as the
 * preflight so the generated files remain uniform across phases.
 */
export async function runIntrospectionPhase(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  calls: JsonRpcCallSpec[] = DEFAULT_INTROSPECTION_CALLS,
): Promise<JsonRpcCallOutcome[]> {
  if (!runRoot) {
    throw new Error("runIntrospectionPhase requires a run root directory");
  }

  if (!environment || !environment.baseUrl) {
    throw new Error("runIntrospectionPhase requires a valid HTTP environment");
  }

  const authorization = environment.token ? `Bearer ${environment.token}` : undefined;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (authorization) {
    headers.authorization = authorization;
  }

  const outcomes: JsonRpcCallOutcome[] = [];

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const requestBody: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: `introspection_${index}_${call.name}`,
      method: call.method,
    };

    if (call.params !== undefined) {
      requestBody.params = call.params;
    }

    const snapshot = await performHttpCheck(call.name, {
      method: "POST",
      url: environment.baseUrl,
      headers,
      body: requestBody,
    });

    await appendHttpCheckArtefactsToFiles(runRoot, INTROSPECTION_TARGETS, snapshot, INTROSPECTION_JSONL_FILES.log);
    const events = extractEventsFromResponse(snapshot.response.body);
    await appendEvents(runRoot, call.name, events);

    outcomes.push({ call, check: snapshot });
  }

  return outcomes;
}
