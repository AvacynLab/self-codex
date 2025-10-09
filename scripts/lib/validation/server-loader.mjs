"use strict";

/**
 * Helper responsible for locating the compiled server module at runtime.
 *
 * The validation harness primarily runs within the TypeScript-aware test
 * runner (`node --import tsx`).  In that environment we can import the source
 * module directly from `src/server.ts` using the historical
 * `../src/server.js` specifier.  Production executions however invoke the
 * script via plain Node.js which only has access to the transpiled JavaScript
 * artefacts under `dist/`.
 *
 * This loader transparently resolves both scenarios by attempting the source
 * module first (unless the caller explicitly requests the compiled variant)
 * and falling back to the bundled output when necessary.  The implementation
 * keeps a cache so downstream helpers always share the same module instance.
 */

const SOURCE_SPECIFIER = new URL("../../../src/server.js", import.meta.url);
const DIST_SPECIFIER = new URL("../../../dist/server.js", import.meta.url);

let cachedModule = null;
let cachedInfo = null;
let cachedPromise = null;

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

function buildCandidateList() {
  const forceDist = process.env.CODEX_VALIDATION_FORCE_DIST === "1";
  const forceSrc = process.env.CODEX_VALIDATION_FORCE_SRC === "1";
  /** @type {Array<{ label:"src"|"dist"; url:URL }>} */
  const candidates = [];

  if (!forceDist) {
    candidates.push({ label: "src", url: SOURCE_SPECIFIER });
  }
  if (!forceSrc) {
    candidates.push({ label: "dist", url: DIST_SPECIFIER });
  }

  if (candidates.length === 0) {
    // Both variants were explicitly disabled; default to the compiled output
    // to keep production workflows functional.
    candidates.push({ label: "dist", url: DIST_SPECIFIER });
  }

  return candidates;
}

/**
 * Dynamically loads the orchestrator server module.  The function remembers
 * the resolved module so subsequent calls reuse the same instance.
 *
 * @returns {Promise<any>} the resolved server module.
 */
export async function loadServerModule() {
  if (cachedModule) {
    return cachedModule;
  }
  if (cachedPromise) {
    return cachedPromise;
  }

  cachedPromise = (async () => {
    const errors = [];
    for (const candidate of buildCandidateList()) {
      try {
        const module = await import(candidate.url.href);
        cachedModule = module;
        cachedInfo = { source: candidate.label, url: candidate.url.href };
        return module;
      } catch (error) {
        if (isModuleNotFound(error)) {
          errors.push(error);
          continue;
        }
        throw error;
      }
    }

    const lastError = errors.at(-1);
    const attempted = buildCandidateList().map((entry) => entry.url.href).join(", ");
    const failure = new Error(
      `Unable to locate the server module. Attempted: ${attempted}`,
      { cause: lastError },
    );
    throw failure;
  })();

  return cachedPromise;
}

/**
 * @returns {{source:"src"|"dist"; url:string}|null} metadata describing the
 *          loaded module, primarily exposed for regression tests.
 */
export function getLoadedServerModuleInfo() {
  return cachedInfo;
}

/**
 * Resets the cached module so tests can exercise multiple resolution paths.
 */
export function resetServerModuleCacheForTests() {
  cachedModule = null;
  cachedInfo = null;
  cachedPromise = null;
}
