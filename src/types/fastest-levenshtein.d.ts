/**
 * Minimal type declaration for the `fastest-levenshtein` package used when
 * computing fuzzy lexical scores inside the retriever. The library ships
 * without TypeScript definitions so we expose the `distance` helper leveraged
 * by the orchestrator.
 */
declare module "fastest-levenshtein" {
  export function distance(left: string, right: string): number;
}
