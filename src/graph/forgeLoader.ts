/**
 * Graph Forge loader utilities.
 *
 * The helper exposed here ensures the expensive Graph Forge bundle is only
 * imported once per process while still providing a fallback to the TypeScript
 * sources when the compiled distribution is unavailable (for example in local
 * development environments). Keeping the logic centralised means every caller
 * benefits from the same caching semantics and diagnostics.
 */
let graphForgeModulePromise: Promise<GraphForgeExports> | null = null;

/** Tracks how many import attempts have been triggered. Exposed for tests. */
let graphForgeLoadAttempts = 0;

/**
 * Shape of the Graph Forge public API. The type mirrors the compiled bundle so
 * tools can rely on strongly typed exports without pulling the implementation
 * directly.
 */
export type GraphForgeExports = Record<string, unknown>;

/**
 * Lazily loads the Graph Forge module, caching the promise so subsequent calls
 * reuse the same instance. The fallback path mirrors the behaviour previously
 * inlined inside the server composition root.
 */
export async function loadGraphForge(): Promise<GraphForgeExports> {
  if (!graphForgeModulePromise) {
    graphForgeModulePromise = loadGraphForgeInternal();
  }
  return graphForgeModulePromise;
}

/** Preloads Graph Forge eagerly and surfaces any import errors to the caller. */
export async function preloadGraphForge(): Promise<void> {
  await loadGraphForge();
}

/**
 * Returns the number of times an import was attempted. Primarily useful for
 * asserting the caching guarantees in unit tests.
 */
export function getGraphForgeLoadAttemptCount(): number {
  return graphForgeLoadAttempts;
}

/**
 * Resets the module cache. The helper is intentionally scoped to tests so they
 * can exercise the loader in isolation without affecting production usage.
 */
export function __resetGraphForgeLoaderForTests(): void {
  graphForgeModulePromise = null;
  graphForgeLoadAttempts = 0;
}

/**
 * Performs the actual dynamic imports, attempting the compiled bundle first
 * before falling back to the TypeScript sources. Any failure is rethrown so the
 * readiness probe can surface meaningful diagnostics to operators.
 */
async function loadGraphForgeInternal(): Promise<GraphForgeExports> {
  graphForgeLoadAttempts += 1;
  const distUrl = new URL("../../graph-forge/dist/index.js", import.meta.url);
  try {
    return (await import(distUrl.href)) as GraphForgeExports;
  } catch (distError) {
    const srcUrl = new URL("../../graph-forge/src/index.ts", import.meta.url);
    try {
      return (await import(srcUrl.href)) as GraphForgeExports;
    } catch {
      throw distError;
    }
  }
}

