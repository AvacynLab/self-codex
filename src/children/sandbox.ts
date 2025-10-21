import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ProcessEnv } from "../nodePrimitives.js";
import { childWorkspacePath, ensureDirectory } from "../paths.js";

/**
 * Canonical list of sandbox profile identifiers accepted by the orchestrator.
 * The union is exported to keep the rest of the codebase strongly typed while
 * still allowing the profile name to travel over the wire as a plain string.
 */
export const CHILD_SANDBOX_PROFILES = ["strict", "standard", "permissive"] as const;

/** Enumerates the supported sandbox profiles. */
export type ChildSandboxProfileName = (typeof CHILD_SANDBOX_PROFILES)[number];

/**
 * Options accepted when the supervisor initialises a sandboxed child. They are
 * derived from the caller intent (RPC payload) and the global supervisor
 * defaults. The helper is intentionally permissive – validation happens inside
 * {@link prepareChildSandbox} so we can reuse the sanitisation logic across
 * server- and test-side call sites.
 */
export interface ChildSandboxRequest {
  /** Preferred profile. Defaults to the supervisor configuration when omitted. */
  profile?: ChildSandboxProfileName | string | null;
  /**
   * Additional environment variables inherited from the supervisor defaults.
   * Only names composed of `[A-Za-z_][A-Za-z0-9_]*` survive the sanitisation
   * step to avoid shell metacharacters.
   */
  allowEnv?: readonly string[] | null;
  /** Explicit environment variables injected inside the sandbox. */
  env?: ProcessEnv | null;
  /**
   * Whether the caller explicitly opts into inheriting the supervisor default
   * environment. When omitted, the decision falls back to the profile policy.
   */
  inheritDefaultEnv?: boolean | null;
}

/**
 * Supervisor-level defaults applied when a spawn request does not specify a
 * profile or extra environment allowances.
 */
export interface ChildSandboxSupervisorOptions {
  /** Default profile enforced for new children. */
  defaultProfile?: ChildSandboxProfileName | string | null;
  /** Additional environment variables implicitly allowed for every child. */
  allowEnv?: readonly string[] | null;
}

/** Metadata surfaced to manifests and logs about the active sandbox. */
export interface ChildSandboxMetadata {
  profile: ChildSandboxProfileName;
  allowed_env: string[];
  deny_network: boolean;
  hooks_path: string | null;
  max_old_space_mb: number | null;
}

/** Result returned by {@link prepareChildSandbox}. */
export interface PreparedChildSandbox {
  profile: ChildSandboxProfileName;
  env: ProcessEnv;
  metadata: ChildSandboxMetadata;
}

/** Internal structure describing the baseline behaviour of a profile. */
interface SandboxProfilePreset {
  /** Canonical identifier of the profile. */
  name: ChildSandboxProfileName;
  /**
   * Environment variable names always propagated when present in the base
   * environment. Values are copied verbatim after string coercion.
   */
  allowedVariables: readonly string[];
  /**
   * Environment variable prefixes whose matching keys are automatically
   * whitelisted. This makes it easy to expose `MCP_*` or provider-specific
   * credentials without enumerating every single key.
   */
  allowedPrefixes: readonly string[];
  /** Default memory ceiling expressed in megabytes. */
  defaultMemoryMb: number;
  /** Whether the sandbox enforces a network denial hook. */
  denyNetwork: boolean;
  /**
   * Whether the profile inherits the default environment when the caller does
   * not explicitly opt out. Strict profiles default to `false` to provide the
   * tightest sandbox by default.
   */
  inheritDefaultEnvByDefault: boolean;
  /** Whether the profile inherits existing NODE_OPTIONS entries by default. */
  inheritNodeOptions: boolean;
  /**
   * When true all environment variables are passed through. Reserved for the
   * permissive profile that intentionally trades safety for compatibility.
   */
  allowAllEnv?: boolean;
}

/** Shared constants injected in every sandbox regardless of the profile. */
const REQUIRED_NODE_OPTIONS = [
  "--enable-source-maps",
  "--no-addons",
  "--frozen-intrinsics",
  "--disable-proto=throw",
];

/** Node builtins denied when the sandbox forbids network access. */
const NETWORK_DENY_BUILTINS = [
  "node:net",
  "node:dgram",
  "node:http",
  "node:https",
  "node:tls",
  "node:dns",
];

/** Predefined behaviour for each sandbox profile. */
const PROFILE_PRESETS: Record<ChildSandboxProfileName, SandboxProfilePreset> = {
  strict: {
    name: "strict",
    allowedVariables: [
      "PATH",
      "LANG",
      "LC_ALL",
      "TZ",
      "TERM",
      "COLORTERM",
      "LOGNAME",
      "USER",
      "LD_LIBRARY_PATH",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ],
    allowedPrefixes: ["MCP_"],
    defaultMemoryMb: 512,
    denyNetwork: true,
    inheritDefaultEnvByDefault: false,
    inheritNodeOptions: false,
  },
  standard: {
    name: "standard",
    allowedVariables: [
      "PATH",
      "LANG",
      "LC_ALL",
      "TZ",
      "TERM",
      "COLORTERM",
      "LOGNAME",
      "USER",
      "LD_LIBRARY_PATH",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_ENV",
      "NODE_PATH",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "AWS_REGION",
      "AWS_PROFILE",
      "AWS_DEFAULT_REGION",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "COHERE_API_KEY",
      "NVIDIA_API_KEY",
      "HF_API_TOKEN",
      "DATABASE_URL",
      "REDIS_URL",
      "PGHOST",
      "PGUSER",
      "PGPASSWORD",
      "PGDATABASE",
      "PGPORT",
      "REDIS_PASSWORD",
    ],
    allowedPrefixes: ["MCP_", "npm_config_", "npm_"],
    defaultMemoryMb: 2048,
    denyNetwork: true,
    inheritDefaultEnvByDefault: true,
    inheritNodeOptions: true,
  },
  permissive: {
    name: "permissive",
    allowedVariables: [],
    allowedPrefixes: [],
    defaultMemoryMb: 4096,
    denyNetwork: false,
    inheritDefaultEnvByDefault: true,
    inheritNodeOptions: true,
    allowAllEnv: true,
  },
};

/**
 * Normalises an environment variable name and ensures it only contains safe
 * characters. Invalid identifiers are dropped so the allow-lists can be stored
 * directly inside manifests without risking shell injection.
 */
function normaliseEnvKey(candidate: string | null | undefined): string | null {
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Tokenises NODE_OPTIONS while preserving the original order. */
function tokenizeNodeOptions(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/** Deduplicates options while preserving the first occurrence. */
function mergeNodeOptions(base: string[], additions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const token of base) {
    if (!token) {
      continue;
    }
    if (token.startsWith("--max-old-space-size")) {
      // Ignore memory ceilings coming from the inherited environment.
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    result.push(token);
  }

  for (const token of additions) {
    if (!token) {
      continue;
    }
    if (token.startsWith("--max-old-space-size")) {
      for (let index = result.length - 1; index >= 0; index -= 1) {
        if (result[index]!.startsWith("--max-old-space-size")) {
          result.splice(index, 1);
        }
      }
    } else if (seen.has(token)) {
      continue;
    }
    result.push(token);
    seen.add(token);
  }

  return result;
}

/**
 * Computes the canonical profile name after validating the caller input. When
 * the value is unknown the fallback profile is returned.
 */
export function normaliseSandboxProfile(
  value: string | null | undefined,
  fallback: ChildSandboxProfileName,
): ChildSandboxProfileName {
  if (!value) {
    return fallback;
  }
  const lowered = value.toLowerCase();
  for (const profile of CHILD_SANDBOX_PROFILES) {
    if (profile === lowered) {
      return profile;
    }
  }
  return fallback;
}

interface PrepareSandboxOptions {
  childId: string;
  childrenRoot: string;
  baseEnv: ProcessEnv;
  request: ChildSandboxRequest | null | undefined;
  defaults: ChildSandboxSupervisorOptions | null | undefined;
  memoryLimitMb: number | null;
}

/**
 * Materialises the sandbox configuration for a child before it is spawned. The
 * helper prepares the workspace (tmp folder + network hook), sanitises the
 * environment according to the selected profile and returns the metadata that
 * should be persisted alongside the runtime manifest.
 */
export async function prepareChildSandbox(options: PrepareSandboxOptions): Promise<PreparedChildSandbox> {
  const defaults = options.defaults ?? {};
  const defaultProfileName = normaliseSandboxProfile(defaults.defaultProfile ?? null, "standard");
  const requestedProfile = normaliseSandboxProfile(options.request?.profile ?? null, defaultProfileName);
  const preset = PROFILE_PRESETS[requestedProfile];

  const allowList = new Set<string>();
  const allowPrefixes = new Set<string>(preset.allowedPrefixes);

  for (const key of preset.allowedVariables) {
    const normalised = normaliseEnvKey(key);
    if (normalised) {
      allowList.add(normalised);
    }
  }

  const defaultAllow = defaults.allowEnv ?? [];
  for (const key of defaultAllow) {
    const normalised = normaliseEnvKey(key);
    if (normalised) {
      allowList.add(normalised);
    }
  }

  const requestAllow = options.request?.allowEnv ?? [];
  for (const key of requestAllow) {
    const normalised = normaliseEnvKey(key);
    if (normalised) {
      allowList.add(normalised);
    }
  }

  const baseEnv = options.baseEnv ?? {};
  const inheritDefaultEnv =
    typeof options.request?.inheritDefaultEnv === "boolean"
      ? options.request?.inheritDefaultEnv
      : preset.inheritDefaultEnvByDefault;

  const env: ProcessEnv = {};

  if (preset.allowAllEnv && inheritDefaultEnv) {
    for (const [key, value] of Object.entries(baseEnv)) {
      if (typeof value === "undefined") {
        continue;
      }
      env[key] = String(value);
    }
  } else if (inheritDefaultEnv) {
    for (const [key, value] of Object.entries(baseEnv)) {
      if (typeof value === "undefined") {
        continue;
      }
      const normalisedKey = normaliseEnvKey(key);
      if (!normalisedKey) {
        continue;
      }
      if (allowList.has(normalisedKey)) {
        env[normalisedKey] = String(value);
        continue;
      }
      for (const prefix of allowPrefixes) {
        if (normalisedKey.startsWith(prefix)) {
          env[normalisedKey] = String(value);
          break;
        }
      }
    }
  }

  const childRoot = childWorkspacePath(options.childrenRoot, options.childId);
  await ensureDirectory(options.childrenRoot, options.childId);
  const tmpDir = await ensureDirectory(options.childrenRoot, options.childId, "tmp");
  const sandboxDir = await ensureDirectory(options.childrenRoot, options.childId, "sandbox");

  env.HOME = childRoot;
  env.PWD = childRoot;
  env.TMP = tmpDir;
  env.TMPDIR = tmpDir;
  env.MCP_CHILD_ID = options.childId;
  env.MCP_CHILD_WORKDIR = childRoot;
  env.MCP_CHILD_SANDBOX_PROFILE = requestedProfile;

  const requestEnv = options.request?.env ?? null;
  if (requestEnv) {
    for (const [key, value] of Object.entries(requestEnv)) {
      const normalisedKey = normaliseEnvKey(key);
      if (!normalisedKey || typeof value === "undefined") {
        continue;
      }
      env[normalisedKey] = String(value);
      allowList.add(normalisedKey);
    }
  }

  const baseNodeOptions = tokenizeNodeOptions(
    preset.inheritNodeOptions && inheritDefaultEnv ? baseEnv.NODE_OPTIONS : env.NODE_OPTIONS,
  );

  const memoryCeiling = (() => {
    if (typeof options.memoryLimitMb === "number" && Number.isFinite(options.memoryLimitMb)) {
      return Math.max(16, Math.trunc(options.memoryLimitMb));
    }
    return preset.defaultMemoryMb;
  })();

  const additions: string[] = [];
  additions.push(`--max-old-space-size=${memoryCeiling}`);
  additions.push(...REQUIRED_NODE_OPTIONS);

  let hooksPath: string | null = null;
  if (preset.denyNetwork) {
    hooksPath = path.join(sandboxDir, "network-hooks.mjs");
    const denyListLiteral = JSON.stringify(NETWORK_DENY_BUILTINS);
    const hookSource = `import Module from "node:module";\n` +
      `const denied = new Set(${denyListLiteral});\n` +
      `const originalLoad = Module._load;\n` +
      `Module._load = function patchedLoad(request, parent, isMain) {\n` +
      `  const normalised = request.startsWith("node:") ? request : \`node:\${request}\`;\n` +
      `  if (denied.has(normalised)) {\n` +
      `    const error = new Error(\`Access to \${normalised} denied by sandbox\`);\n` +
      `    error.name = "SandboxNetworkDeniedError";\n` +
      `    // Expose a stable code so tests and logs can detect the failure.\n` +
      `    error.code = "ERR_SANDBOX_DENIED";\n` +
      `    throw error;\n` +
      `  }\n` +
      `  return originalLoad.apply(this, arguments);\n` +
      `};\n` +
      `const ModuleProto = Module.Module.prototype;\n` +
      `if (ModuleProto && typeof ModuleProto.import === "function") {\n` +
      `  const originalImport = ModuleProto.import;\n` +
      `  ModuleProto.import = function patchedImport(specifier, options) {\n` +
      `    const normalised = specifier.startsWith("node:") ? specifier : \`node:\${specifier}\`;\n` +
      `    if (denied.has(normalised)) {\n` +
      `      const error = new Error(\`Access to \${normalised} denied by sandbox\`);\n` +
      `      error.name = "SandboxNetworkDeniedError";\n` +
      `      error.code = "ERR_SANDBOX_DENIED";\n` +
      `      return Promise.reject(error);\n` +
      `    }\n` +
      `    return originalImport.call(this, specifier, options);\n` +
      `  };\n` +
      `}\n` +
      `if (typeof globalThis.fetch === "function") {\n` +
      `  const denyFetch = () => {\n` +
      `    const error = new Error("fetch denied by sandbox");\n` +
      `    error.name = "SandboxNetworkDeniedError";\n` +
      `    error.code = "ERR_SANDBOX_DENIED";\n` +
      `    return Promise.reject(error);\n` +
      `  };\n` +
      `  Object.defineProperty(globalThis, "fetch", { value: denyFetch, writable: false, configurable: false });\n` +
      `}\n`;
    await writeFile(hooksPath, hookSource, "utf8");
    const hookUrl = pathToFileURL(hooksPath).href;
    additions.push(`--import=${hookUrl}`);
  }

  env.NODE_OPTIONS = mergeNodeOptions(baseNodeOptions, additions).join(" ");

  const allowedEnvList = Array.from(allowList).sort();

  return {
    profile: requestedProfile,
    env,
    metadata: {
      profile: requestedProfile,
      allowed_env: allowedEnvList,
      deny_network: preset.denyNetwork,
      hooks_path: hooksPath,
      max_old_space_mb: memoryCeiling,
    },
  };
}
