import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// But du test : garantir que tous les imports des modules Node internes utilisent le préfixe `node:`.
// Explication : on scanne récursivement les fichiers TypeScript de src/ et on cherche des patterns "from \"fs\"" sans préfixe.
// Variables principales :
// - patterns : expressions régulières ciblant les modules Node critiques.
// - files : accumulation des fichiers visités.
// - offenders : liste structurée des fichiers qui violent la règle pour faciliter le débogage.
function scanFile(content: string): string[] {
  const patterns = [
    /from\s+"crypto"/g,
    /from\s+"fs\/promises"/g,
    /from\s+"fs"/g,
    /from\s+"http"/g,
    /from\s+"url"/g,
    /from\s+"events"/g,
    /from\s+"assert"/g,
    /from\s+"util"/g,
    /from\s+"timers(\/promises)?"/g
  ];
  const hits: string[] = [];
  for (const rx of patterns) {
    if (rx.test(content)) {
      hits.push(rx.source);
    }
  }
  return hits;
}

describe("imports node: prefix", () => {
  it("no non-prefixed core imports", () => {
    const root = join(process.cwd(), "src");
    const files: string[] = [];

    // Parcours DFS du dossier src/ pour répertorier tous les fichiers .ts.
    const walk = (p: string): void => {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        const full = join(p, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          files.push(full);
        }
      }
    };
    walk(root);

    const offenders: Array<{ file: string; hits: string[] }> = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const found = scanFile(content);
      if (found.length > 0) {
        offenders.push({ file, hits: found });
      }
    }

    assert.equal(
      offenders.length,
      0,
      "Found non-prefixed core imports: " + JSON.stringify(offenders, null, 2)
    );
  });
});
