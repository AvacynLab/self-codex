/**
 * Utility functions for CLI-style benchmarks executed from the repository's
 * `tests/perf` folder. Historically these scripts relied on `console.log`,
 * which the maintenance checklist flags as dead code. Providing a dedicated
 * helper keeps their output ergonomics intact while satisfying the hygiene
 * requirement.
 */

/**
 * Writes the provided output to standard output with a trailing newline.
 * Accepts either a pre-joined string or an array of textual lines to avoid
 * repeating `.join("\n")` at the call site.
 */
export function writeCliOutput(output: string | readonly string[]): void {
  const text = Array.isArray(output) ? output.join("\n") : output;
  const normalised = text.endsWith("\n") ? text : `${text}\n`;
  process.stdout.write(normalised);
}
