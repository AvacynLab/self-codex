# Résultats de simulation et optimisation

## Simulation de référence (parallélisme max = 2)
- Makespan : **35** unités de temps.
- Chronologie :
  - lint_core : démarrage 0, fin 3
  - lint_api : démarrage 0, fin 2
  - lint_ui : démarrage 2, fin 4
  - test_unit : démarrage 4, fin 9
  - test_integration : démarrage 9, fin 17
  - build_bundle : démarrage 17, fin 23
  - docs_generate : démarrage 23, fin 26
  - package_artifacts : démarrage 26, fin 30
  - deploy_stage : démarrage 30, fin 35

## Chemin critique (poids = weight)
- Longueur totale : 29.
- Chemin : lint_core → test_unit → test_integration → build_bundle → docs_generate → package_artifacts → deploy_stage.

## Optimisation (objectif makespan)
- Solution retenue : Tests intégration parallélisés + Build incrémental + Templates docs précompilés + Packaging cache compressé (makespan 30, coût total 26.30).

## Solutions Pareto (makespan, coût total)
- Tests intégration parallélisés + Build incrémental + Templates docs précompilés + Packaging cache compressé : makespan 30, coût 26.30
- Tests intégration parallélisés + Templates docs précompilés + Packaging cache compressé : makespan 31, coût 25.30
- Tests intégration parallélisés + Templates docs précompilés : makespan 32, coût 24.60
- Templates docs précompilés + Packaging cache compressé : makespan 33, coût 23.90
- Templates docs précompilés : makespan 34, coût 23.20
- Baseline : makespan 35, coût 22.60

