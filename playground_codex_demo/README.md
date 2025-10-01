# Playground Codex Demo

## Objectifs
- Évaluer les outils MCP disponibles dans l'orchestrateur actuel.
- Documenter chaque tentative d'appel d'outil et l'état de disponibilité associé.
- Héberger un mini-projet de démonstration totalement isolé du dépôt principal.
- Fournir des scripts autonomes qui reproduisent les étapes MCP manquantes :
  - `scripts/run_graph_analyses.mjs` pour les graphes (génération, mutation, algorithmes, simulation, optimisation, exports).
  - `scripts/run_children_fanout.mjs` pour l'orchestration d'enfants (planification, exécution, agrégation des sorties).

## Structure du dossier
- `logs/` — journaux d'exécution et traces de tests (ex. `children_orchestration_log.json`, `dashboard_heatmap.json`).
- `reports/` — synthèses structurées des essais d'outils et analyses (graphes, planification, enfants, exports, cognition, monitoring).
- `graphs/` — instantanés JSON des graphes manipulés (générés via Graph Forge).
- `exports/` — exports de graphes (JSON, Mermaid, DOT).
- `children/` — artefacts produits par les agents enfants (1 dossier par enfant, avec workspace/inbox/outbox).
- `scripts/` — outils locaux permettant de rejouer les étapes MCP indisponibles (analyses de graphes et orchestration enfants).

## Nouveaux outils couverts
- **Mémoire partagée & attention** : le script `run_children_fanout.mjs` enregistre désormais les souvenirs générés par chaque enfant et synthétise un contexte réduit (`reports/memory_attention.md`).
- **MetaCritic & auto-réflexion** : chaque collecte d'enfant produit une critique (`reports/cognitive_feedback.md`) combinant score MetaCritic et réflexion `selfReflect`/`quality.scoring`.
- **Sandbox haute criticité** : les scénarios marqués `high_risk` déclenchent une simulation avant `child_send` ; le résultat est consigné dans `reports/sandbox_runs.md`.
- **Dashboard & heatmaps** : une extraction de la SSE du dashboard est simulée et convertie en heatmap (`reports/dashboard_heatmap.md`, `logs/dashboard_heatmap.json`).
- **Plans multi-hypothèses & multi-objets** : `run_graph_analyses.mjs` ajoute une étape `strategies.hypotheses` et consigne les solutions Pareto (`reports/graph_algorithms.md`).

## Comment rejouer les tests
1. Se placer à la racine du dépôt : `cd /workspace/self-codex`.
2. Regénérer les artefacts de graphe : `node playground_codex_demo/scripts/run_graph_analyses.mjs`.
3. Simuler l'orchestration des enfants et exécuter leurs tests locaux : `node playground_codex_demo/scripts/run_children_fanout.mjs`.
   - Le script recrée les dossiers `children/child-*`, génère les modules et lance automatiquement `node test.mjs` pour chaque enfant.
4. Consulter `reports/children_fanout.md`, `reports/cognitive_feedback.md` et `reports/memory_attention.md` pour examiner les entrées/sorties agrégées, la critique et les souvenirs persistés.
5. Parcourir `reports/dashboard_heatmap.md` pour la vue monitoring et `reports/final_report.md` pour la synthèse consolidée.

## Notes
- Toutes les écritures réalisées par cette mission sont confinées à `./playground_codex_demo/` et à la mise à jour d'`AGENTS.md`.
- Aucune dépendance externe n'est requise ; les scripts restent hors ligne.
- Les résultats produits avant l'arrivée des tools MCP sont conservés pour comparaison avec de futures exécutions outillées.
- Les nouveaux rapports (mémoire, critiques, sandbox, heatmap) sont régénérés lors de la prochaine exécution des scripts `scripts/run_children_fanout.mjs` et `scripts/run_graph_analyses.mjs`.
