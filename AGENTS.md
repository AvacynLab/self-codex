# Agent Guidelines

## Objectif utilisateur
- Explorer des pistes d'amélioration en s'appuyant sur les outils MCP disponibles dans le serveur.

## Tâches à suivre
- [x] Cartographier rapidement les axes d'amélioration possibles dans `GraphState` / outils MCP.
- [x] Ajouter une détection des enfants inactifs côté `GraphState`.
- [x] Exposer cette détection via un nouvel outil MCP côté serveur.
- [x] Documenter la nouvelle capacité dans le `README`.
- [x] Couvrir la logique ajoutée par des tests automatisés.
- [x] Permettre l'exposition HTTP optionnelle (Streamable) du serveur MCP.
- [x] Documenter la configuration cloud/HTTP et ajouter des tests de parsing CLI.
- [x] Rédiger un guide détaillé pour le déploiement Codex Cloud (HTTP + sécurité) et le relier depuis le README.
- [x] Fournir un extrait `config.toml` prêt à l'emploi pour pointer Codex vers le transport HTTP.
- [x] Lister une procédure de vérification (curl/healthcheck) pour valider la connectivité MCP à distance.

## Notes
- Toujours laisser des commentaires explicatifs et de la documentation.
- Écrire et exécuter les tests avant de livrer.

## Historique
- 2025-02-14 : Ajout d'une détection d'inactivité (GraphState + outil `graph_state_inactivity`), documentation et tests Node.
- 2025-02-15 : Ajout du transport HTTP Streamable, parsing CLI, documentation cloud et tests dédiés.
- 2025-02-16 : Rédaction du guide Codex Cloud (build, déploiement, config `.codex`, diagnostics) et résumé dans le README.
