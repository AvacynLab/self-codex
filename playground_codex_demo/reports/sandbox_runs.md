# Sandbox haute criticité

Les actions marquées `high_risk` sont d'abord exécutées dans la sandbox (`src/sim/sandbox.ts`).

| Run | Handler | Durée (ms) | Verdict | Notes |
| --- | --- | --- | --- | --- |
| sbx-001 | risk_probing | 420 | success | Pré-lecture réussie, plan approuvé |
| sbx-002 | destructive_guard | 1975 | failure | Requête sur base de prod bloquée, alerte transmise |

Les traces détaillées (payload normalisé, métriques) sont archivées dans
`../logs/sandbox_runs.json` et référencées par `reports/cognitive_feedback.md`.
