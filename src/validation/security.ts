import { writeFile } from "node:fs/promises";
import { join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  performHttpCheck,
  toJsonlLine,
  type HttpCheckRequestSnapshot,
  type HttpCheckSnapshot,
  type HttpEnvironmentSummary,
  writeJsonFile,
} from "./runSetup.js";

/** JSONL artefacts associated with the Stage 11 security validation workflow. */
export const SECURITY_JSONL_FILES = {
  inputs: "inputs/11_security.jsonl",
  outputs: "outputs/11_security.jsonl",
  events: "events/11_security.jsonl",
  log: "logs/security_http.json",
} as const;

/** Context forwarded to parameter factories when building dynamic requests. */
export interface SecurityCallContext {
  readonly environment: HttpEnvironmentSummary;
  readonly previousCalls: readonly SecurityCallOutcome[];
}

/** Function signature used to lazily build JSON-RPC params. */
export type SecurityParamsFactory = (context: SecurityCallContext) => unknown;

/** Captures additional metadata when probing log redaction behaviour. */
export interface SecurityRedactionProbe {
  readonly secret: string;
  readonly description?: string;
}

/** Metadata attached to calls asserting filesystem/path confinement. */
export interface SecurityPathProbe {
  readonly attemptedPath: string;
  readonly description?: string;
}

/**
 * Specification of a JSON-RPC call executed during the security workflow.
 * The interface mirrors previous stages so operators can easily customise the
 * call plan without touching the runner internals.
 */
export interface SecurityCallSpec {
  readonly scenario: string;
  readonly name: string;
  readonly method: string;
  readonly params?: unknown | SecurityParamsFactory;
  readonly headers?: Record<string, string>;
  readonly requireAuth?: boolean;
  readonly captureEvents?: boolean;
  readonly expectedStatus?: number;
  readonly notes?: string;
  readonly redactionProbe?: SecurityRedactionProbe;
  readonly unauthorizedProbe?: boolean;
  readonly pathProbe?: SecurityPathProbe;
}

/** Representation of a call after parameter factories resolved to JSON values. */
export type ExecutedSecurityCall = Omit<SecurityCallSpec, "params"> & {
  readonly params?: unknown;
};

/** Outcome persisted for each JSON-RPC call executed during the workflow. */
export interface SecurityCallOutcome {
  readonly call: ExecutedSecurityCall;
  readonly check: HttpCheckSnapshot;
  readonly events: unknown[];
}

/** Options accepted by {@link runSecurityPhase}. */
export interface SecurityPhaseOptions {
  readonly calls?: SecurityCallSpec[];
  readonly defaults?: DefaultSecurityOptions;
}

/** Optional knobs exposed when generating the default Stage 11 call plan. */
export interface DefaultSecurityOptions {
  readonly unauthorizedMethod?: string;
  readonly redactionTool?: string;
  readonly secretText?: string;
  readonly pathTool?: string;
  readonly pathAttempt?: string;
  readonly pathArguments?: Record<string, unknown>;
}

/** Result returned by {@link runSecurityPhase}. */
export interface SecurityPhaseResult {
  readonly outcomes: readonly SecurityCallOutcome[];
  readonly summary: SecuritySummary;
  readonly summaryPath: string;
}

/** Summary document persisted in `report/security_summary.json`. */
export interface SecuritySummary {
  readonly artefacts: {
    readonly inputsJsonl: string;
    readonly outputsJsonl: string;
    readonly eventsJsonl: string;
    readonly httpSnapshotLog: string;
  };
  readonly checks: readonly {
    readonly scenario: string;
    readonly name: string;
    readonly method: string;
    readonly status: number;
    readonly statusText: string;
    readonly expectedStatus?: number;
    readonly requireAuth: boolean;
    readonly notes?: string;
  }[];
  readonly redaction?: {
    readonly secret: string;
    readonly description?: string;
    readonly calls: readonly {
      readonly scenario: string;
      readonly name: string;
      readonly leakedInResponse: boolean;
      readonly leakedInEvents: boolean;
    }[];
  };
  readonly unauthorized?: {
    readonly calls: readonly {
      readonly scenario: string;
      readonly name: string;
      readonly status: number;
      readonly success: boolean;
    }[];
  };
  readonly pathValidation?: {
    readonly calls: readonly {
      readonly scenario: string;
      readonly name: string;
      readonly attemptedPath: string;
      readonly status: number;
      readonly description?: string;
    }[];
  };
}

/** Relative filename of the summary persisted under the `report/` directory. */
const SECURITY_SUMMARY_FILENAME = "security_summary.json";

/** Default JSON-RPC identifier prefix used to ease correlation in artefacts. */
const SECURITY_ID_PREFIX = "security";

/** Optional overrides used to inject test doubles in unit tests. */
export interface SecurityPhaseOverrides {
  readonly httpCheck?: (
    name: string,
    request: HttpCheckRequestSnapshot,
  ) => Promise<HttpCheckSnapshot>;
}

/** Builds the default call plan mandated by Stage 11 of the playbook. */
export function buildDefaultSecurityCalls(
  options: DefaultSecurityOptions = {},
): SecurityCallSpec[] {
  const secretText = options.secretText ?? "SECRET-TOKEN-123";
  const pathAttempt = options.pathAttempt ?? "../../etc/passwd";
  const basePathArguments = options.pathArguments ?? { path: pathAttempt, contents: "validation" };

  return [
    {
      scenario: "auth",
      name: "without_token",
      method: options.unauthorizedMethod ?? "mcp_info",
      requireAuth: false,
      unauthorizedProbe: true,
      expectedStatus: 401,
      notes: "Confirms the server rejects unauthenticated calls.",
    },
    {
      scenario: "redaction",
      name: "masked_secret",
      method: "tools/call",
      params: {
        name: options.redactionTool ?? "echo",
        arguments: { text: `probe:${secretText}` },
      },
      redactionProbe: {
        secret: secretText,
        description: "Ensure MCP_LOG_REDACT hides sensitive substrings in logs.",
      },
      notes: "Injects a synthetic secret in the payload to audit log redaction.",
    },
    {
      scenario: "filesystem",
      name: "escape_attempt",
      method: "tools/call",
      params: {
        name: options.pathTool ?? "fs/write",
        arguments: basePathArguments,
      },
      pathProbe: {
        attemptedPath: pathAttempt,
        description: "Server should refuse writing outside the validation run directory.",
      },
      notes: "Attempts to write outside the run folder to verify sandboxing.",
    },
  ];
}

/** Extracts emitted events from JSON-RPC envelopes when present. */
function extractEvents(body: unknown): unknown[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const envelope = body as Record<string, unknown>;
  const result = envelope.result;
  if (!result || typeof result !== "object") {
    return [];
  }
  const events = (result as Record<string, unknown>).events;
  if (Array.isArray(events)) {
    return events;
  }
  return [];
}

/** Appends captured events to the security-specific `.jsonl` artefact. */
async function appendSecurityEvents(
  runRoot: string,
  call: ExecutedSecurityCall,
  events: readonly unknown[],
): Promise<void> {
  if (!events.length) {
    return;
  }

  const capturedAt = new Date().toISOString();
  const lines = events
    .map((event, index) =>
      toJsonlLine({
        scenario: call.scenario,
        name: call.name,
        index,
        capturedAt,
        event,
      }),
    )
    .join("");

  await writeFile(join(runRoot, SECURITY_JSONL_FILES.events), lines, {
    encoding: "utf8",
    flag: "a",
  });
}

/**
 * Persists the request/response artefacts for a security call. The helper keeps
 * a dedicated JSONL log so operators can quickly review the payloads.
 */
async function appendSecurityCallArtefacts(
  runRoot: string,
  call: ExecutedSecurityCall,
  check: HttpCheckSnapshot,
): Promise<void> {
  const inputEntry = toJsonlLine({
    scenario: call.scenario,
    name: call.name,
    method: call.method,
    requireAuth: call.requireAuth !== false,
    params: call.params,
    startedAt: check.startedAt,
  });
  const outputEntry = toJsonlLine({
    scenario: call.scenario,
    name: call.name,
    method: call.method,
    status: check.response.status,
    statusText: check.response.statusText,
    expectedStatus: call.expectedStatus,
    endedAt: new Date(Date.parse(check.startedAt) + check.durationMs).toISOString(),
    body: check.response.body,
  });
  const logEntry = `${JSON.stringify(
    {
      scenario: call.scenario,
      name: call.name,
      method: call.method,
      request: check.request,
      response: check.response,
      durationMs: check.durationMs,
    },
    null,
    2,
  )}\n`;

  await Promise.all([
    writeFile(join(runRoot, SECURITY_JSONL_FILES.inputs), inputEntry, {
      encoding: "utf8",
      flag: "a",
    }),
    writeFile(join(runRoot, SECURITY_JSONL_FILES.outputs), outputEntry, {
      encoding: "utf8",
      flag: "a",
    }),
    writeFile(join(runRoot, SECURITY_JSONL_FILES.log), logEntry, {
      encoding: "utf8",
      flag: "a",
    }),
  ]);
}

/** Utility detecting whether a secret string leaked in a JSON payload. */
function payloadContainsSecret(payload: unknown, secret: string): boolean {
  if (!secret) {
    return false;
  }
  try {
    const serialised = JSON.stringify(payload);
    return serialised.includes(secret);
  } catch (error) {
    return false;
  }
}

/** Builds the Stage 11 summary persisted for operator review. */
function buildSecuritySummary(outcomes: readonly SecurityCallOutcome[]): SecuritySummary {
  const checks = outcomes.map((outcome) => ({
    scenario: outcome.call.scenario,
    name: outcome.call.name,
    method: outcome.call.method,
    status: outcome.check.response.status,
    statusText: outcome.check.response.statusText,
    requireAuth: outcome.call.requireAuth !== false,
    ...(outcome.call.expectedStatus !== undefined
      ? { expectedStatus: outcome.call.expectedStatus }
      : {}),
    ...(outcome.call.notes !== undefined ? { notes: outcome.call.notes } : {}),
  }));

  const redactionCalls = outcomes.filter((outcome) => outcome.call.redactionProbe);
  const redactionSecret = redactionCalls[0]?.call.redactionProbe?.secret ?? "";
  const redactionDescription = redactionCalls[0]?.call.redactionProbe?.description;
  const unauthorizedCalls = outcomes.filter((outcome) => outcome.call.unauthorizedProbe);
  const pathCalls = outcomes.filter((outcome) => outcome.call.pathProbe);

  const redactionSummary: SecuritySummary["redaction"] | undefined = redactionCalls.length
    ? {
        secret: redactionSecret,
        ...(redactionDescription !== undefined ? { description: redactionDescription } : {}),
        calls: redactionCalls.map((outcome) => ({
          scenario: outcome.call.scenario,
          name: outcome.call.name,
          leakedInResponse: payloadContainsSecret(outcome.check.response.body, redactionSecret),
          leakedInEvents: outcome.events.some((event) => payloadContainsSecret(event, redactionSecret)),
        })),
      }
    : undefined;

  const unauthorizedSummary: SecuritySummary["unauthorized"] | undefined = unauthorizedCalls.length
    ? {
        calls: unauthorizedCalls.map((outcome) => ({
          scenario: outcome.call.scenario,
          name: outcome.call.name,
          status: outcome.check.response.status,
          success:
            outcome.check.response.status === 401 || outcome.check.response.status === 403,
        })),
      }
    : undefined;

  const pathSummary: SecuritySummary["pathValidation"] | undefined = pathCalls.length
    ? {
        calls: pathCalls.map((outcome) => ({
          scenario: outcome.call.scenario,
          name: outcome.call.name,
          attemptedPath: outcome.call.pathProbe?.attemptedPath ?? "",
          status: outcome.check.response.status,
          ...(outcome.call.pathProbe?.description !== undefined
            ? { description: outcome.call.pathProbe.description }
            : {}),
        })),
      }
    : undefined;

  return {
    artefacts: {
      inputsJsonl: SECURITY_JSONL_FILES.inputs,
      outputsJsonl: SECURITY_JSONL_FILES.outputs,
      eventsJsonl: SECURITY_JSONL_FILES.events,
      httpSnapshotLog: SECURITY_JSONL_FILES.log,
    },
    checks,
    ...(redactionSummary ? { redaction: redactionSummary } : {}),
    ...(unauthorizedSummary ? { unauthorized: unauthorizedSummary } : {}),
    ...(pathSummary ? { pathValidation: pathSummary } : {}),
  };
}

/** Persists the Stage 11 summary into the validation run folder. */
async function persistSecuritySummary(runRoot: string, summary: SecuritySummary): Promise<string> {
  const summaryPath = join(runRoot, "report", SECURITY_SUMMARY_FILENAME);
  await writeJsonFile(summaryPath, summary);
  return summaryPath;
}

/** Builds a deterministic JSON-RPC identifier for Stage 11 calls. */
function buildJsonRpcId(index: number, call: SecurityCallSpec): string {
  return `${SECURITY_ID_PREFIX}-${index.toString().padStart(3, "0")}-${call.scenario}-${call.name}`;
}

/**
 * Executes the Stage 11 security workflow. The helper captures every HTTP
 * snapshot alongside an actionable summary so operators can review unauthorised
 * attempts, redaction guarantees, and filesystem confinement probes.
 */
export async function runSecurityPhase(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  options: SecurityPhaseOptions = {},
  overrides: SecurityPhaseOverrides = {},
): Promise<SecurityPhaseResult> {
  if (!runRoot) {
    throw new Error("runSecurityPhase requires a run root directory");
  }
  if (!environment || !environment.baseUrl) {
    throw new Error("runSecurityPhase requires a valid HTTP environment");
  }

  const httpCheck = overrides.httpCheck ?? performHttpCheck;
  const callPlan = options.calls ?? buildDefaultSecurityCalls(options.defaults);

  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (environment.token) {
    baseHeaders.authorization = `Bearer ${environment.token}`;
  }

  const outcomes: SecurityCallOutcome[] = [];

  for (let index = 0; index < callPlan.length; index += 1) {
    const spec = callPlan[index];
    const params = typeof spec.params === "function"
      ? (spec.params as SecurityParamsFactory)({ environment, previousCalls: outcomes })
      : spec.params;

    const headers: Record<string, string> = { ...baseHeaders };
    if (spec.requireAuth === false) {
      delete headers.authorization;
    }
    if (spec.headers) {
      for (const [key, value] of Object.entries(spec.headers)) {
        headers[key.toLowerCase()] = value;
      }
    }

    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: buildJsonRpcId(index, spec),
      method: spec.method,
    };
    if (params !== undefined) {
      body.params = params;
    }

    const request: HttpCheckRequestSnapshot = {
      method: "POST",
      url: environment.baseUrl,
      headers,
      body,
    };

    const check = await httpCheck(`${spec.scenario}:${spec.name}`, request);

    const executedCall: ExecutedSecurityCall = {
      scenario: spec.scenario,
      name: spec.name,
      method: spec.method,
      // Optional call metadata is only forwarded when populated so enabling
      // `exactOptionalPropertyTypes` does not flag these assignments.
      ...(params !== undefined ? { params } : {}),
      ...(spec.headers ? { headers: spec.headers } : {}),
      ...(spec.requireAuth !== undefined ? { requireAuth: spec.requireAuth } : {}),
      ...(spec.captureEvents !== undefined ? { captureEvents: spec.captureEvents } : {}),
      ...(spec.expectedStatus !== undefined ? { expectedStatus: spec.expectedStatus } : {}),
      ...(spec.notes !== undefined ? { notes: spec.notes } : {}),
      ...(spec.redactionProbe ? { redactionProbe: spec.redactionProbe } : {}),
      ...(spec.unauthorizedProbe !== undefined
        ? { unauthorizedProbe: spec.unauthorizedProbe }
        : {}),
      ...(spec.pathProbe ? { pathProbe: spec.pathProbe } : {}),
    };

    await appendSecurityCallArtefacts(runRoot, executedCall, check);

    const events = spec.captureEvents === false ? [] : extractEvents(check.response.body);
    await appendSecurityEvents(runRoot, executedCall, events);

    const outcome: SecurityCallOutcome = { call: executedCall, check, events };
    outcomes.push(outcome);
  }

  validateSecurityExpectations(outcomes);

  const summary = buildSecuritySummary(outcomes);
  const summaryPath = await persistSecuritySummary(runRoot, summary);

  return { outcomes, summary, summaryPath };
}

/**
 * Ensures the Stage 11 workflow exercised authentication, redaction and
 * filesystem confinement correctly. The validator inspects the captured
 * responses/events and surfaces actionable guidance when invariants are
 * violated.
 */
function validateSecurityExpectations(outcomes: readonly SecurityCallOutcome[]): void {
  if (!outcomes.length) {
    throw new Error("Stage 11 requiert au moins un appel pour valider la sécurité.");
  }

  const unauthorizedOutcomes = outcomes.filter((outcome) => outcome.call.unauthorizedProbe);
  if (!unauthorizedOutcomes.length) {
    throw new Error(
      "Stage 11 doit inclure une requête sans jeton pour vérifier la réponse 401/403 du serveur.",
    );
  }
  for (const outcome of unauthorizedOutcomes) {
    const status = outcome.check.response.status;
    if (status !== 401 && status !== 403) {
      throw new Error(
        `Stage 11 attendait un statut 401/403 pour l'appel sans authentification mais a reçu ${status}.`,
      );
    }
    const expected = outcome.call.expectedStatus;
    if (
      typeof expected === "number" &&
      status !== expected &&
      !(expected === 401 && status === 403)
    ) {
      throw new Error(
        `Stage 11 a reçu ${status} alors que ${expected} était attendu pour l'appel non authentifié.`,
      );
    }
  }

  const authorisedSuccess = outcomes.some(
    (outcome) =>
      outcome.call.requireAuth !== false &&
      outcome.check.response.status >= 200 &&
      outcome.check.response.status < 300,
  );
  if (!authorisedSuccess) {
    throw new Error(
      "Stage 11 doit confirmer qu'au moins un appel authentifié renvoie un statut 2xx.",
    );
  }

  const redactionOutcomes = outcomes.filter((outcome) => outcome.call.redactionProbe);
  if (!redactionOutcomes.length) {
    throw new Error(
      "Stage 11 requiert un test de redaction pour vérifier l'absence de secret dans les réponses et événements.",
    );
  }
  for (const outcome of redactionOutcomes) {
    const secret = outcome.call.redactionProbe?.secret ?? "";
    if (!secret) {
      throw new Error(
        "Stage 11 nécessite un secret synthétique non vide pour valider la redaction des journaux.",
      );
    }
    const leakedInResponse = payloadContainsSecret(outcome.check.response.body, secret);
    const leakedInEvents = outcome.events.some((event) => payloadContainsSecret(event, secret));
    if (leakedInResponse || leakedInEvents) {
      throw new Error(
        "Stage 11 a détecté le secret synthétique dans la réponse ou les événements. Active MCP_LOG_REDACT ou corrige l'outil cible.",
      );
    }
  }

  const pathOutcomes = outcomes.filter((outcome) => outcome.call.pathProbe);
  if (!pathOutcomes.length) {
    throw new Error(
      "Stage 11 doit inclure une tentative de sortie de bac à sable (path probe) pour vérifier le rejet serveur.",
    );
  }
  for (const outcome of pathOutcomes) {
    if (outcome.check.response.status < 400) {
      throw new Error(
        `Stage 11 attendait un rejet (>=400) pour la tentative d'écriture ${outcome.call.pathProbe?.attemptedPath ?? ""}.`,
      );
    }
  }
}
