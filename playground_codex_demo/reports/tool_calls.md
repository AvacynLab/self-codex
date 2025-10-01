# Journal des appels MCP simulés

Les entrées exhaustives (inputs exacts, sorties condensées, verdicts, artefacts) sont archivées dans [`logs/graph_tool_calls.json`](../logs/graph_tool_calls.json) et dans [`logs/children_orchestration_log.json`](../logs/children_orchestration_log.json).

## Opérations de graphe

| Tool | Verdict | Résumé | Artefacts |
| --- | --- | --- | --- |
| graph_generate | SIMULATED_OK | 8 nœuds / 9 arêtes générés depuis pipeline.gf | graphs/demo_graph.json |
| graph_mutate | SIMULATED_OK | Mutation appliquée : ajout de deploy_stage → 9 nœuds, 11 arêtes | — |
| graph_export | SIMULATED_OK | Export JSON complet pour inspection automatisée | exports/demo_graph.json |
| graph_export | SIMULATED_OK | Diagramme Mermaid généré pour visualisation textuelle | exports/demo_graph.mmd |
| graph_export | SIMULATED_OK | Export DOT prêt pour Graphviz | exports/demo_graph.dot |
| graph_validate | SIMULATED_OK | Pas de cycle détecté | — |
| graph_summarize | SIMULATED_OK | Résumé : 9 nœuds, degré moyen 2.44 | — |
| graph_paths_k_shortest | SIMULATED_OK | 3 chemins calculés (meilleur coût 17) | — |
| graph_paths_constrained | SIMULATED_OK | Chemin alternatif trouvé (coût 17) | — |
| graph_centrality_betweenness | SIMULATED_OK | Top pivots : test_unit, build_bundle, docs_generate | — |
| graph_simulate | SIMULATED_OK | Simulation terminée (makespan 35) | logs/simulation_events.json |
| graph_critical_path | SIMULATED_OK | Chemin critique (lint_core → test_unit → test_integration → build_bundle → docs_generate → package_artifacts → deploy_stage) | — |
| graph_optimize | SIMULATED_OK | Scénario optimal retenu : Tests intégration parallélisés + Build incrémental + Templates docs précompilés + Packaging cache compressé (makespan 30) | — |
| graph_optimize_moo | SIMULATED_OK | 6 solutions Pareto | — |

## Orchestration d’enfants

| Tool | Verdict | Résumé | Artefacts |
| --- | --- | --- | --- |
| plan_fanout | SIMULATED_OK | 3 enfants préparés | — |
| child_create | SIMULATED_OK | Environnement initialisé pour child-alpha → children/child-alpha/workspace | — |
| child_send | SIMULATED_OK | Brief transmis à child-alpha | — |
| child_status | SIMULATED_OK | État ready — Test OK pour child-alpha | — |
| child_collect | SIMULATED_OK | Artefacts collectés (3) | children/child-alpha/workspace/module.mjs<br>children/child-alpha/workspace/test.mjs<br>children/child-alpha/outbox/output.json |
| child_create | SIMULATED_OK | Environnement initialisé pour child-beta → children/child-beta/workspace | — |
| child_send | SIMULATED_OK | Brief transmis à child-beta | — |
| child_status | SIMULATED_OK | État ready — Test OK pour child-beta | — |
| child_collect | SIMULATED_OK | Artefacts collectés (3) | children/child-beta/workspace/module.mjs<br>children/child-beta/workspace/test.mjs<br>children/child-beta/outbox/output.json |
| child_create | SIMULATED_OK | Environnement initialisé pour child-gamma → children/child-gamma/workspace | — |
| child_send | SIMULATED_OK | Brief transmis à child-gamma | — |
| child_status | SIMULATED_OK | État ready — Test OK pour child-gamma | — |
| child_collect | SIMULATED_OK | Artefacts collectés (3) | children/child-gamma/workspace/module.mjs<br>children/child-gamma/workspace/test.mjs<br>children/child-gamma/outbox/output.json |
| plan_join | SIMULATED_OK | 3 enfants synchronisés | — |
| plan_reduce | SIMULATED_OK | Fusion enregistrée dans reports/children_merge.json | reports/children_merge.json |

## Mémoire, critiques & sandbox

| Module | Verdict | Résumé | Artefacts |
| --- | --- | --- | --- |
| memory.store.persist | SIMULATED_OK | 2 épisodes sauvegardés (lint, QA) | logs/memory_store.json |
| memory.attention.select | SIMULATED_OK | Contexte réduit injecté dans 3 enfants | reports/memory_attention.md |
| agents.metaCritic.review | SIMULATED_OK | Scores 0.78–0.86 avec feedback ciblé | reports/cognitive_feedback.md |
| agents.selfReflect.run | SIMULATED_OK | Post-mortems générés et archivés | reports/cognitive_feedback.md |
| quality.scoring.evaluate | SIMULATED_OK | Seuils lint/tests validés | reports/cognitive_feedback.md |
| sim.sandbox.execute | SIMULATED_OK | 2 exécutions (1 succès, 1 échec contrôlé) | logs/sandbox_runs.json |
| monitor.dashboard.stream | SIMULATED_OK | Heatmap consolidée (tokens/attentes/alertes) | logs/dashboard_heatmap.json |
