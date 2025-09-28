# Agent Guidelines

## Objectif utilisateur
- Explorer des pistes d'amélioration en s'appuyant sur les outils MCP disponibles dans le serveur.

## Tâches à suivre
- [x] Cartographier rapidement les axes d'amélioration possibles dans `GraphState` / outils MCP.
- [x] Ajouter une détection des enfants inactifs côté `GraphState`.
- [x] Exposer cette détection via un nouvel outil MCP côté serveur.
- [x] Documenter la nouvelle capacité dans le `README`.
- [x] Couvrir la logique ajoutée par des tests automatisés.

## Notes
- Toujours laisser des commentaires explicatifs et de la documentation.
- Écrire et exécuter les tests avant de livrer.

## Historique
- 2025-02-14 : Ajout d'une détection d'inactivité (GraphState + outil `graph_state_inactivity`), documentation et tests Node.
