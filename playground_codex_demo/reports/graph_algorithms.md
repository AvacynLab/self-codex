# Algorithmes de chemins et centralité

## k=3 plus courts chemins (lint_core → deploy_stage)
- Chemin 1 : lint_core → test_unit → build_bundle → docs_generate → deploy_stage (coût 17)
- Chemin 2 : lint_core → test_unit → build_bundle → package_artifacts → deploy_stage (coût 18)
- Chemin 3 : lint_core → test_unit → build_bundle → docs_generate → package_artifacts → deploy_stage (coût 21)

## Chemin contraint (évite test_integration)
- Statut : found.
- Chemin trouvé : lint_core → test_unit → build_bundle → docs_generate → deploy_stage (coût 17).
- Nœuds filtrés : test_integration.
- Notes : constraints_pruned_graph.

## Centralité d'intermédiarité
- test_unit : 0.268
- build_bundle : 0.268
- docs_generate : 0.107
- lint_core : 0.000
- lint_ui : 0.000
- lint_api : 0.000
- test_integration : 0.000
- package_artifacts : 0.000
- deploy_stage : 0.000

## Stratégies multi-hypothèses
- Hypothèse A : prioriser `lint_core` → `test_unit` → `build_bundle` (score 0.82).
- Hypothèse B : insérer une revue docs avant `docs_generate` (score 0.74).
- Hypothèse C : détour par `qa_manual` (score 0.41, rejetée).
- Fusion finale : Hypothèses A + B (convergence 0.88) → plan retenu pour fan-out.

## Optimisation mono-objectif (makespan)
- Baseline : 35.
- Parallélisme étendu : 32.
- Build incrémental + docs précompilées : 30 (**sélectionnée**).

## Optimisation multi-objectif (makespan/cost)
- Scénario S1 : (makespan 35, coût 28.4) — dominé.
- Scénario S2 : (makespan 32, coût 27.1) — Pareto.
- Scénario S3 : (makespan 30, coût 26.3) — Pareto, meilleur compromis pondéré.

## Simulation & heatmap
- Makespan simulé : 35 (voir `reports/scheduling_results.md`).
- Parallélisme maximal respecté : 3.
- Journal détaillé : `../logs/simulation_events.json`.

