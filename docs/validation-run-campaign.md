# Validation Campaign Orchestrator

Ce guide décrit l'utilisation de `npm run validation:campaign`, la commande qui
enchaîne automatiquement les étapes principales de la checklist : capture des
snapshots, préparation du runtime, compilation, exécution des scénarios, audit
et génération des rapports finaux. L'objectif est de fournir une expérience
opérateur "one-click" tout en conservant la granularité des scripts existants.

## Prérequis

- Les variables d'environnement Search/Unstructured doivent être renseignées
  avant d'exécuter la commande (voir `docs/validation-run-runtime.md`).
- `validation_run/` doit être accessible en écriture : la commande crée ou
  réutilise l'arborescence standard via `ensureValidationRunLayout`.
- Les dépendances Node doivent être disponibles. Le script déclenche `npm ci`
  + `npm run build` sauf si l'étape est explicitement ignorée.

## Commande principale

```bash
npm run validation:campaign
```

Par défaut, l'orchestrateur exécute toutes les étapes dans l'ordre suivant :

1. **Snapshots** – appel à `captureValidationSnapshots` (versions, git, env,
   probes HTTP).
2. **Build** – invocation de `runValidationBuild` (`npm ci --include=dev` puis
   `npm run build`).
3. **Runtime** – création des dossiers runtime et export des variables MCP via
   `ensureValidationRuntime`.
4. **Scénarios** – exécution séquentielle des 10 scénarios (`executeSearchScenario`)
   avec persistance des artefacts et extractions de `self-codex.log`.
5. **Rapports** – génération de `summary.json` et `REPORT.md` (`writeValidationReport`).
6. **Idempotence** – comparaison automatique S01/S05 (`compareScenarioIdempotence`).
7. **Audit** – vérification des artefacts, timings et secrets (`auditValidationRun`).
8. **Remédiation** – production de `remediation_plan.json` + `REMEDIATION_PLAN.md`
   (`writeRemediationPlan`).

Le résumé terminal liste l'état de chaque étape, les scénarios traités, les
notes de timings collectées et le statut global (succès/échec). En cas d'échec,
`npm run validation:campaign` renvoie un code de sortie non nul.

## Options utiles

La commande accepte plusieurs drapeaux pour cibler une portion du workflow :

- `--scenarios 1,5,10` : restreint l'exécution aux scénarios indiqués (IDs,
  `SXX` ou slug complet comme `S01_pdf_science`).
- `--skip-snapshots`, `--skip-build`, `--skip-runtime`, `--skip-report`,
  `--skip-idempotence`, `--skip-audit`, `--skip-remediation` : sautent l'étape
  correspondante pour itérer rapidement.
- `--no-artifacts` : n'écrit pas les dumps supplémentaires dans
  `validation_run/artifacts/` (les artefacts de base restent gérés par
  `recordScenarioRun`).
- `--stop-on-failure` : arrête l'exécution des scénarios dès la première erreur.
- `--job-prefix nightly` : préfixe les jobIds générés pour faciliter la
  corrélation côté logs.
- `--root ./validation_run_alt` : change le dossier racine utilisé pour la
  campagne (utile pour des tests isolés).

Toutes les options sont cumulables. Lorsqu'une étape est désactivée, le résumé
final mentionne explicitement qu'elle a été ignorée.

## Résolution des erreurs

- **Build en échec** : consulter `validation_run/logs/build.log` (mentionné dans
  le résumé) et corriger les commandes `npm` avant de relancer la campagne.
- **Idempotence inconnue/échec** : vérifier les artefacts de S01/S05 sous
  `validation_run/runs/` et utiliser `npm run validation:idempotence` pour un
  diagnostic détaillé.
- **Audit bloquant** : lire les erreurs de timings/artefacts et les éventuels
  `secretFindings`. Les notes sont ajoutées automatiquement dans le résumé.

## Intégration avec les scripts existants

`validation:campaign` ne remplace pas les autres scripts, mais les combine. Vous
pouvez toujours lancer `validation:metrics`, `validation:report`, etc. de façon
indépendante : l'orchestrateur utilise exactement les mêmes modules et respecte
les mêmes conventions (`validation_run/` uniquement, artefacts idempotents).

Pour des exécutions CI ou nightly, il est recommandé d'utiliser la commande
complète afin de garantir que toutes les étapes du playbook ont été vérifiées et
journalisées.
