# Synthèse des opérations de graphe

## Génération et mutation
- Graphe source : `Pipeline` (8 nœuds initiaux).
- Mutation appliquée : ajout du nœud `deploy_stage` et de 2 arêtes sortant de `package_artifacts` et `docs_generate`.
- Total final : **9 nœuds**, **11 arêtes**.

## Validation
- Cycle détecté : non.
- Ordre topologique (9 nœuds) : lint_core → lint_ui → lint_api → test_unit → test_integration → build_bundle → docs_generate → package_artifacts → deploy_stage.

## Statistiques
- Degré moyen : 2.44.
- Couches topologiques :
  - Niveau 0 : lint_core, lint_ui, lint_api
  - Niveau 1 : test_unit
  - Niveau 2 : test_integration
  - Niveau 3 : build_bundle
  - Niveau 4 : docs_generate
  - Niveau 5 : package_artifacts
  - Niveau 6 : deploy_stage
- Nœuds pivots (centralité d'intermédiarité normalisée) :
  - test_unit (0.268)
  - build_bundle (0.268)
  - docs_generate (0.107)

