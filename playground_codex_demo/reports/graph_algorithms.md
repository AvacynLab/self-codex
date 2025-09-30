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

