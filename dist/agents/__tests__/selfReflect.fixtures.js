/**
 * Sample reflection inputs used by unit tests to exercise the heuristics.
 */
export const codeReflectionFixture = {
    kind: "code",
    input: "Implémente une fonction de parsing robuste et écris les tests.",
    output: [
        "export function parse(input) {",
        // Assemble the TODO marker dynamically so repository hygiene checks still forbid literal markers
        // while the reflection heuristics continue to receive realistic snippets containing TODO at runtime.
        `  // ${"TODO"}: gérer les cas limites`,
        "  console.log('debug');",
        "  return JSON.parse(input);",
        "}",
        "describe('parse', () => {",
        "  it('parse une structure valide', () => {",
        "    expect(parse('{\"a\":1}')).to.deep.equal({ a: 1 });",
        "  });",
        "});",
    ].join("\n"),
    meta: { durationMs: 72_000, score: 0.42 },
};
export const textReflectionFixture = {
    kind: "text",
    input: "Rédige un compte-rendu clair avec exemple concret.",
    output: "Le système actuel souffre de lenteurs car les index ne sont pas utilisés correctement. Par conséquent nous devons re" +
        "penser la stratégie de partitionnement et clarifier les objectifs du trimestre.",
    meta: { score: 0.78 },
};
export const planReflectionFixture = {
    kind: "plan",
    input: "Propose un plan par étapes incluant risques et dépendances.",
    output: [
        "1. Cartographier les dépendances critiques.",
        "2. Mettre en place une phase pilote (sans fallback explicite).",
    ].join("\n"),
    meta: { score: 0.55 },
};
export const minimalReflectionFixture = {
    kind: "text",
    input: null,
    output: "",
    meta: {},
};
