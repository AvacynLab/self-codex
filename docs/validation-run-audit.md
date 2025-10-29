# Audit des artefacts de validation

Ce guide explique comment utiliser le script d'audit pour vérifier que chaque
scénario possède les artefacts attendus, que les métriques de performance sont
complètes et qu'aucun secret n'est accidentellement exposé dans les journaux.

## Objectifs

- Valider la présence des huit fichiers mandatés (`input.json`, `events.ndjson`,
  etc.) pour chaque dossier `validation_run/runs/S0X_*`.
- Contrôler la structure de `timings.json` (p50/p95/p99, compteurs, latences).
- Scanner `events.ndjson`, `server.log` et `validation_run/reports/summary.json`
  pour détecter des chaînes de type `MCP_HTTP_TOKEN`, Bearer token, `apiKey`,
  etc.

## Pré-requis

1. Initialiser l'arborescence via `npm run validation:scenarios` (si ce n'est
   pas déjà fait).
2. Enregistrer les artefacts d'un scénario avec `recordScenarioRun` (ou via vos
   scripts internes) afin que `timings.json`, `errors.json`, `events.ndjson`,
   etc. contiennent des données réelles.

## Exécution

```bash
npm run validation:audit
```

- Les scénarios valides affichent `✔ S0X_slug → artefacts complets`.
- Les scénarios incomplets listent les fichiers manquants ou les champs absents
  dans `timings.json`.
- Toute correspondance suspecte est résumée sous `⚠ Secrets potentiels`.

Le script renvoie un code de sortie non nul en présence d'un problème, ce qui
permet de l'intégrer facilement dans un pipeline CI/CD.

## Résolution des alertes

1. **Fichiers manquants** : relancer l'extraction du scénario concerné et
   republier les artefacts via `recordScenarioRun`.
2. **Timings incomplets** : vérifier que le collecteur a bien écrit les
   latences `p50/p95/p99` ainsi que `tookMs`, `documentsIngested` et `errors`.
3. **Secrets potentiels** : inspecter manuellement le fichier mentionné et
   supprimer (ou anonymiser) la valeur avant de republier l'artefact.

Une fois les corrections appliquées, relancez `npm run validation:audit` jusqu'à
ce que tous les scénarios soient marqués comme conformes et qu'aucune alerte de
secret ne subsiste.
