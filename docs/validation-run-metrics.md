# Validation metrics aggregation

La section 5 de la checklist impose la production d'un `timings.json` complet
pour chaque scénario, incluant les latences p50/p95/p99, le temps total
(`tookMs`), le nombre de documents ingérés et la répartition des erreurs.
Le module `src/validationRun/metrics.ts` automatise cette agrégation à partir
des traces JSON générées pendant les runs.

## API TypeScript

```ts
import {
  computeScenarioTimingReportFromEvents,
  computeScenarioTimingReportFromFile,
} from "../src/validationRun/metrics";

const events = await loadEvents();
const { report, notes } = computeScenarioTimingReportFromEvents(events);
```

Les fonctions exposées fournissent également un tableau de `notes` listant les
anomalies détectées (champs manquants, valeurs invalides, parse errors NDJSON).
Les opérateurs peuvent ainsi corriger les artefacts avant de valider la run.

### Extraction flexible

Par défaut, les extracteurs supposent un schéma relativement plat :

- `stage`: nom de la phase (`searxQuery`, `fetchUrl`, ...).
- `durationMs`: durée de l'action courante.
- `tookMs`: durée globale du scénario.
- `docId` ou `documentId`: identifiant de document ingéré.
- `documentsIngested`: compteur supplémentaire (optionnel).
- `category`: classification de l'erreur.

L'API accepte toutefois des overrides (`stageExtractor`, `durationExtractor`,
`stageMap`, etc.) afin de s'adapter aux payloads plus riches (objets imbriqués,
renommage côté orchestrateur, etc.).

### Construction du rapport

`buildScenarioTimingReport(samples)` convertit les échantillons bruts en
`ScenarioTimingReport` prêt à être sérialisé. Les percentiles sont calculés via
interpolation linéaire afin de conserver un comportement stable quelles que
soient les tailles d'échantillons. Les phases sans métriques produisent des
buckets vides (`0 ms`) accompagnés d'une note de diagnostic.

## CLI dédiée

Le script `npm run validation:metrics -- <SXX>` parcourt automatiquement
`validation_run/runs/SXX_*/events.ndjson`, calcule les métriques et met à jour
`timings.json` via `recordScenarioRun`. Un chemin alternatif peut être fourni via
`--events=/chemin/custom.ndjson` lorsque l'artefact est stocké ailleurs.

La commande affiche ensuite un résumé (`tookMs`, nombre de documents,
répartition des erreurs) et liste les notes éventuelles pour faciliter le
triage.

## Export JSON pour dashboards

Le même script génère désormais automatiquement un export JSON dédié aux
tableaux de bord sous `validation_run/metrics/<slug>_dashboard.json`. Le
payload reprend :

- l'identité du scénario (id, slug, libellé) ;
- l'horodatage de génération ;
- les latences p50/p95/p99 pour chaque phase ;
- `tookMs`, le nombre de documents ingérés et la répartition des erreurs.

Ce fichier alimente les vues analytics (Grafana/Metabase, etc.) sans nécessiter
de parsing supplémentaire de `timings.json`. Les fonctions
`buildScenarioDashboardExport` et `writeScenarioDashboardExport` du module
`metrics.ts` peuvent être réutilisées pour publier ces données vers d'autres
targets si besoin.

## Workflow recommandé

1. Après chaque scénario, exporter la fenêtre d'événements au format NDJSON.
2. Exécuter `npm run validation:metrics -- S0X` pour générer/mettre à jour
   `timings.json`.
3. Vérifier les notes éventuelles et ajuster l'extraction si nécessaire
   (override des extracteurs ou correction des artefacts sources).
4. Utiliser `recordScenarioRun` si des ajustements manuels restent requis.
5. Regénérer le rapport global via `npm run validation:report` puis auditer avec
   `npm run validation:audit`.

Les tests unitaires `tests/unit/validationRun.metrics.test.ts` couvrent la
conversion des événements en échantillons, le calcul des percentiles et les
stratégies d'agrégation (`max`, `median`, `p95`).
