# Validation run artefact recorder

Ce guide décrit comment persister proprement les artefacts générés lors d’un
scénario E2E dans le dossier `validation_run/`. Il complète les workflows
introduits dans les documents `validation-run-layout.md`,
`validation-run-snapshots.md` (capturés automatiquement) et
`validation-run-runtime.md` (contrôle des dépendances).

## API TypeScript

La fonction `recordScenarioRun` du module
`src/validationRun/artefacts.ts` prend en charge l’écriture atomique des
fichiers attendus par la checklist :

```ts
import { recordScenarioRun } from "../src/validationRun/artefacts";

await recordScenarioRun(1, {
  response: orchestratorResponse,
  events: eventStoreWindow,
  timings: timingMetrics,
  errors: classifiedErrors,
  kgChanges: kgDiffEntries,
  vectorUpserts: vectorSummaries,
  serverLog: serverLogExcerpt,
});
```

La fonction :

1. Initialise ou réutilise la structure `validation_run/runs/SXX_*` en
   s’appuyant sur `initialiseScenarioRun`.
2. Sérialise les payloads JSON avec un formatage cohérent (indentation `2`).
3. Gère automatiquement le format NDJSON pour `events.ndjson` et
   `kg_changes.ndjson`.
4. Normalise l’extrait du `server.log` (ajout d’une fin de ligne).

Tous les champs sont optionnels. Les appels successifs ré-écrivent les mêmes
fichiers, ce qui garantit l’idempotence des reruns.

### Extraits `server.log`

Le module `src/validationRun/logs.ts` fournit la fonction
`extractServerLogExcerpt` qui lit `validation_run/logs/self-codex.log`, repère
le `jobId` du scénario et retourne un bloc de 5 à 10 lignes autour des entrées
pertinentes. Les scripts d’exécution (`validation:scenario:run`) appellent ce
helper automatiquement et injectent l’extrait dans `recordScenarioRun`, ce qui
permet de satisfaire le point 5 de la checklist (« Sauvegarder 5–10 lignes de
`self-codex.log` autour des timecodes du run ») sans manipulation manuelle.

Lorsque le journal principal est absent (serveur non démarré), la fonction
retourne `null` et laisse l’audit mettre en évidence l’artefact manquant.

### Schéma des timings

Le type `ScenarioTimingReport` exige un bloc de métriques pour chacune des
phases listées dans la checklist :

```ts
interface ScenarioTimingReport {
  searxQuery: { p50: number; p95: number; p99: number };
  fetchUrl: { p50: number; p95: number; p99: number };
  extractWithUnstructured: { p50: number; p95: number; p99: number };
  ingestToGraph: { p50: number; p95: number; p99: number };
  ingestToVector: { p50: number; p95: number; p99: number };
  tookMs: number;
  documentsIngested: number;
  errors: Record<string, number>;
}
```

La granularité correspond à celle attendue pour `timings.json` (section 5 de la
checklist).

## Workflow recommandé

1. Exécuter `npm run validation:runtime` afin de vérifier l’environnement.
2. Lancer le scénario via l’outil MCP ou la stack existante.
3. Exporter les traces (EventStore, KG, vecteurs, logs).
4. Utiliser `recordScenarioRun` (via un petit script interne ou directement dans
   un REPL `tsx`) pour pousser les artefacts dans `validation_run/runs/SXX_*`.
5. Commiter le résultat une fois les dix scénarios complétés.

Les tests unitaires associés (`tests/unit/validationRun.artefacts.test.ts`)
garantissent la sérialisation correcte des formats attendus.

