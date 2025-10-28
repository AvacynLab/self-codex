# Génération des rapports de validation

Ce guide décrit comment produire les livrables demandés dans la section 8 de la
checklist (`summary.json` et `REPORT.md`). Les utilitaires présentés ici
s'appuient sur les modules `validationRun/*` pour agréger les métriques collectées
par scénario.

## Pré-requis

1. Avoir exécuté les scénarios E2E et consigné les artefacts obligatoires via
   `npm run validation:scenarios` puis les enregistrements (`recordScenarioRun`).
2. Disposer des timings (p50/p95/p99), erreurs, événements, upserts vecteurs et
   journaux pour chaque scénario dans `validation_run/runs/SXX_*`.

## Générer le résumé JSON et le rapport Markdown

```bash
npm run validation:report
```

La commande :

- consolide les artefacts de `validation_run/runs/` ;
- évalue les critères d'acceptation quand les données sont disponibles ;
- écrit `validation_run/reports/summary.json` avec les métriques agrégées ;
- écrit `validation_run/reports/REPORT.md` pour une lecture rapide (intègre un
  tableau récapitulatif, l'état des critères, la synthèse thématique et des
  observations par scénario).

Chaque exécution est idempotente : les fichiers sont régénérés à partir des
artefacts courants. Les sections « À vérifier » signalent explicitement les
points qui nécessitent encore une validation manuelle (analyses
qualitatives complémentaires, corrélations métier, etc.). Les critères
Extraction (ratio de segments uniques) et Langue sont désormais calculés
automatiquement dès que `vector_chunks.json` et `documents_summary.json` sont
présents ; en leur absence, le rapport signale explicitement les artefacts
manquants. Le critère d'idempotence
est évalué automatiquement via
`compareScenarioIdempotence` et le CLI `npm run validation:idempotence` (voir
[`docs/validation-run-idempotence.md`](./validation-run-idempotence.md)).

## Structure du `summary.json`

- `generatedAt` : horodatage ISO de la génération.
- `scenarios[]` : métriques individuelles (docs ingérés, erreurs classées,
  compteurs d'événements/KG/vecteurs, notes sur les fichiers manquants).
- `totals` : agrégats globaux (documents, événements, diffs KG, upserts
  vecteurs, erreurs) complétés par :
  - `totals.topDomains[]` : top 10 des domaines (hostname) rencontrés dans les
    documents ingérés, avec le volume et le pourcentage associé ;
  - `totals.contentTypes[]` : répartition des types MIME détectés (avec une
    catégorie `unknown` lorsque l'information manque).
- `acceptance` : verdicts pour chacun des critères de la section 6 de la
  checklist (`pass`, `fail`, `unknown`).

## Intégration dans le workflow de validation

1. Après avoir collecté les artefacts d'un scénario, exécuter
   `npm run validation:report` pour mettre à jour les livrables.
2. Vérifier les notes signalant des fichiers manquants ou vides, puis exécuter
   `npm run validation:idempotence` pour confirmer l'absence de doublons entre
   `S01` et `S05`.
3. Examiner la synthèse thématique générée automatiquement :
   - la section **Forces** met en avant les critères validés et les scénarios
     sans erreur ;
   - **Faiblesses** et **Recommandations** pointent les artefacts manquants ou
     les critères non conclus ;
   - **Décisions** propose un verdict global (bloquant, conditionnel,
     recommandé) accompagné des agrégats clés ;
   - **État des critères d'acceptation** détaille, scénario par scénario, le
     statut (✅/⚠️/❌) et le motif associé.
4. Compléter manuellement les vérifications qui restent à l'état « À vérifier »
   puis enrichir `REPORT.md` si des éléments supplémentaires doivent être
   consignés (ex. décision finale, validations humaines spécifiques).

## Tests

Les tests unitaires `tests/unit/validationRun.reports.test.ts` couvrent :

- la génération du résumé à partir d'artefacts synthétiques ;
- l'évaluation des critères de performance et de robustesse ;
- la sérialisation Markdown (tableaux et sections détaillées).

Exécuter l'ensemble :

```bash
node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/validationRun.reports.test.ts
```

Cette suite garantit que les rapports restent cohérents au fil des évolutions.
