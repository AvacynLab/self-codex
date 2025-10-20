import { loadGraphForge } from "../../src/graph/forgeLoader.js";

/** Cached promise re-used by every caller to avoid redundant imports. */
let graphForgePromise: Promise<Awaited<ReturnType<typeof loadGraphForge>>> | null = null;

/**
 * Lazily resolves the Graph Forge module while preserving its static typing.
 *
 * The shared helper ensures all Graph Forge tests exercise the same cached
 * module instance without resorting to `as unknown as` casts when destructuring
 * the exports. Keeping the loader in one place also makes it trivial to reset
 * the cache should a future test need to exercise failure paths explicitly.
 */
export async function getGraphForge(): Promise<Awaited<ReturnType<typeof loadGraphForge>>> {
  if (!graphForgePromise) {
    graphForgePromise = loadGraphForge();
  }
  return graphForgePromise;
}

/**
 * Resets the cached promise so tests can re-import the module when necessary.
 * This mirrors the `__resetGraphForgeLoaderForTests` hook but keeps the helper
 * encapsulated under the `tests/helpers` namespace.
 */
export function resetGraphForgeCache(): void {
  graphForgePromise = null;
}
