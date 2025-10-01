# Mémoire partagée & Attention contextuelle

La mémoire clé-valeurs et les épisodes récents sont résumés ci-dessous. Ils sont
sélectionnés par `memory/attention.ts` avant chaque `child_create`.

| Tag | Extrait contexte | Dernière mise à jour | Impact |
| --- | --- | --- | --- |
| lint | "Résoudre les linters flaky en lançant `npm run lint -- --cache=false`" | 2025-09-30T19:10:12Z | Injecté dans child-alpha |
| qa | "Couverture cible 85%, prioriser api-contract" | 2025-09-30T19:12:47Z | Guide la transformation child-beta |
| perf | "Stage build-bundle = 8.9s moyenne, envisager bundler incrémental" | 2025-09-30T19:15:02Z | Sert de rappel à child-gamma |

## Épisodes injectés
1. **Stabilisation CI** — objectifs : réduire le temps de feedback < 15min ;
   décisions : paralléliser lint/test, limiter les retries ; résultat : gain 20%.
2. **Audit QA** — objectifs : faire passer la couverture > 88% ; décisions :
   ajouter tests contractuels, renforcer sandbox ; résultat : en cours.

Les entrées brutes sont persistées dans `../logs/memory_store.json` pour audit.
