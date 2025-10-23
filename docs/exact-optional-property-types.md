# Guide `exactOptionalPropertyTypes`

Ce document résume les conventions internes pour maintenir le dépôt compatible
avec `"exactOptionalPropertyTypes": true`. Toute contribution doit respecter
ces règles afin d'éviter la réintroduction de champs `undefined` dans les
artefacts, les logs ou les réponses MCP.

## Principes généraux

- **Proscrire l'écriture explicite de `undefined`.** Utiliser des helpers pour
  omettre les clés optionnelles plutôt que de les définir à `undefined`.
- **Préférer `null` lorsqu'une clé doit être présente mais sans valeur.** Les
  résumés et télémétries utilisent des sentinelles `null` pour conserver la
  structure sans violer les propriétés optionnelles strictes.
- **Isoler les conversions.** Rassembler les normalisations dans des helpers
  dédiés (`sanitize*`, `normalise*`) afin de partager les invariants et de les
  couvrir facilement avec des tests ciblés.

## Helpers de sanitisation

| Helper | Module | Rôle | Tests associés |
| --- | --- | --- | --- |
| `omitUndefinedEntries` | `src/utils/object.ts` | Supprime les clés dont la valeur est `undefined` dans un objet plat. | `tests/utils/object.test.ts` |
| `omitUndefinedDeep` | `src/utils/object.ts` | Version récursive couvrant tableaux et objets imbriqués. | `tests/utils/object.test.ts` |
| `coerceNullToUndefined` | `src/utils/object.ts` | Convertit `null` en `undefined` pour permettre l'omission conditionnelle. | `tests/validation/plans.test.ts`, `tests/validation/knowledge.test.ts` |
| `cloneDefinedEnv` | `scripts/lib/env-helpers.mjs` | Clone `process.env` en excluant les entrées indéfinies avant de lancer un script. | `tests/scripts.env-helpers.test.ts` |

**Conseil** : importer ces helpers plutôt que de recréer des filtres locaux.
Ils encapsulent la logique commune et possèdent déjà une couverture exhaustive.

## Stratégies par domaine

### Validation & rapports

- Centraliser la sanitisation des résumés dans des helpers (`responseSummary.ts`,
  `buildMissingModuleErrorOptions`, etc.).
- Vérifier les artefacts JSONL via des tests Mocha ciblés (`tests/validation/**/*.test.ts`).
- Lorsque de nouvelles étapes sont ajoutées, étendre `tests/scripts.validation-stage-env.test.ts`
  pour s'assurer que les wrappers CLI clonent l'environnement correctement.

### Orchestrateur & runtime

- Les événements doivent passer par `omitUndefinedEntries` avant la publication.
- Les contextes propagés aux outils (enfants, graphes, planification) doivent
  être normalisés via les helpers existants (`normalisePlanEventScope`,
  `normaliseGraphEventPayload`, `normaliseTransportTag`, etc.).
- Ajouter des assertions `assertNoUndefinedValues` dans les tests d'intégration
  (`tests/orchestrator/runtime.*.optional-fields.test.ts`).

### Scripts & CLI

- Toujours cloner `process.env` via `cloneDefinedEnv` ou `prepare*CliInvocation`.
- Documenter les nouvelles options dans `docs/` et créer des tests dédiés dans
  `tests/scripts.*.test.ts` pour refuser les placeholders `undefined`.

### Graph Forge & projets annexes

- Utiliser les sanitiseurs communs exposés par `graph-forge/src/cli.ts` pour les
  nouveaux handlers MCP.
- Cibler `npm run test:graph-forge` dans les PRs qui touchent le module afin de
  maintenir la couverture optionnelle.

## Pipeline de vérification recommandé

1. `npm run build`
2. `npm run typecheck -- --pretty false --noEmit`
3. `npm run test`

Ces commandes doivent rester vertes avant tout commit. En cas d'échec,
prioriser la résolution des diagnostics stricts puis re-lancer la suite.

## Modèle de test

Lorsqu'un nouveau module sérialise du JSON (artefacts, responses, SSE, etc.) :

1. **Introduire un helper de sanitisation** exporté pour les tests (préfixe
   `__testing` si nécessaire).
2. **Ajouter un test unitaire** qui passe un payload contenant des valeurs
   `undefined`/`null` et vérifie que le résultat ne les conserve pas.
3. **Étendre un test d'intégration** (MCP, CLI, scripts) pour couvrir le chemin
   complet.

Ce triptyque garantit qu'aucune régression ne passe inaperçue lors de la
prochaine exécution du pipeline strict.

## Ressources complémentaires

- `AGENTS.md` répertorie l'historique détaillé des assainissements et la
  checklist restante.
- Les suites `tests/validation/**/*.test.ts` et `tests/orchestrator/**/*.test.ts`
  fournissent des exemples concrets de régimes de tests alignés sur ces règles.

