# Playground Codex Demo

## Objectifs
- Évaluer les outils MCP disponibles dans l'orchestrateur actuel.
- Documenter chaque tentative d'appel d'outil et l'état de disponibilité associé.
- Héberger un mini-projet de démonstration totalement isolé du dépôt principal.
- Fournir des scripts autonomes qui reproduisent les étapes MCP manquantes :
  - `scripts/run_graph_analyses.mjs` pour les graphes (génération, mutation, algorithmes, simulation, optimisation, exports).
  - `scripts/run_children_fanout.mjs` pour l'orchestration d'enfants (planification, exécution, agrégation des sorties).

## Structure du dossier
- `logs/` — journaux d'exécution et traces de tests (ex. `children_orchestration_log.json`).
- `reports/` — synthèses structurées des essais d'outils et analyses (graphes, planification, enfants, exports, rapport final).
- `graphs/` — instantanés JSON des graphes manipulés (générés via Graph Forge).
- `exports/` — exports de graphes (JSON, Mermaid, DOT).
- `children/` — artefacts produits par les agents enfants (1 dossier par enfant, avec workspace/inbox/outbox).
- `scripts/` — outils locaux permettant de rejouer les étapes MCP indisponibles (analyses de graphes et orchestration enfants).

## Comment rejouer les tests
1. Se placer à la racine du dépôt : `cd /workspace/self-codex`.
2. Regénérer les artefacts de graphe : `node playground_codex_demo/scripts/run_graph_analyses.mjs`.
3. Simuler l'orchestration des enfants et exécuter leurs tests locaux : `node playground_codex_demo/scripts/run_children_fanout.mjs`.
   - Le script recrée les dossiers `children/child-*`, génère les modules et lance automatiquement `node test.mjs` pour chaque enfant.
4. Consulter `reports/children_fanout.md` et `reports/children_merge.json` pour examiner les entrées/sorties agrégées.
5. Consulter `reports/final_report.md` pour la synthèse détaillée de l'ensemble des opérations.

## Notes
- Toutes les écritures réalisées par cette mission sont confinées à `./playground_codex_demo/` et à la mise à jour d'`AGENTS.md`.
- Aucune dépendance externe n'est requise ; les scripts restent hors ligne.
- Les résultats produits avant l'arrivée des tools MCP sont conservés pour comparaison avec de futures exécutions outillées.
