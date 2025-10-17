/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * The implementation follows the standard dynamic-programming recurrence while
 * operating on UTF-16 code units. This matches the behaviour previously
 * provided by the `fastest-levenshtein` dependency without pulling an external
 * module at runtime, which keeps the retrieval pipeline reliable in minimal
 * environments (e.g. CI jobs that omit optional packages).
 *
 * The helper keeps two rows of the edit-distance matrix in memory at any time,
 * yielding an O(|a| * |b|) algorithm with O(|b|) additional space.
 */
export function levenshteinDistance(a: string, b: string): number {
  // Fast-path equal strings to avoid the dynamic-programming work entirely.
  if (a === b) {
    return 0;
  }

  // If one side is empty, the distance reduces to the length of the other
  // string because only insertions (or deletions) are required.
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  // Allocate the working rows for the DP matrix. Using typed arrays keeps the
  // memory footprint compact and avoids per-iteration allocations.
  let previousRow = new Uint16Array(b.length + 1);
  let currentRow = new Uint16Array(b.length + 1);

  for (let column = 0; column <= b.length; column += 1) {
    previousRow[column] = column;
  }

  for (let row = 1; row <= a.length; row += 1) {
    currentRow[0] = row;
    const charCodeA = a.charCodeAt(row - 1);

    for (let column = 1; column <= b.length; column += 1) {
      const charCodeB = b.charCodeAt(column - 1);
      const substitutionCost = charCodeA === charCodeB ? 0 : 1;

      // Compute the three candidate costs: insertion, deletion, substitution.
      const insertionCost = currentRow[column - 1] + 1;
      const deletionCost = previousRow[column] + 1;
      const substitution = previousRow[column - 1] + substitutionCost;

      currentRow[column] = Math.min(insertionCost, deletionCost, substitution);
    }

    // Swap the buffers so the freshly-computed row becomes the baseline for the
    // next iteration. Copying would be more expensive than swapping references.
    const nextPrevious = currentRow;
    currentRow = previousRow;
    previousRow = nextPrevious;
  }

  return previousRow[b.length];
}
