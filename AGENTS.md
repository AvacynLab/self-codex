# Agent Guidelines

## Objectif utilisateur
- Explorer des pistes d'amélioration en s'appuyant sur les outils MCP disponibles dans le serveur.

## Tâches à suivre
- [x] Stabiliser le build (détection `npm install`/`npm ci`, installation de `@types/node`).
- [x] Étendre GraphForge (tri topo, détection de cycles, centralités, k chemins, `costFunction`).
- [x] Rendre l'inactivité configurable (`inactivityThresholdSec`) et limiter l'historique d'événements (`--max-event-history`).
- [x] Exporter des métriques (`graph_state_metrics`) et journaliser en JSON (`--log-file`).
- [x] Isoler le transport HTTP (`src/httpServer.ts`) et fournir `npm run start:http`.
- [x] Documenter les nouvelles options/tests et fournir les scripts `scripts/setup-environment.mjs` & `scripts/maintenance.mjs`.
- [x] Couvrir les nouveautés via Mocha (`npm test`) + script `npm run lint`.
- [x] Surveiller l'intégration d'un pipeline CI (GitHub Actions) pour automatiser build/tests.

## Notes
- Toujours laisser des commentaires explicatifs et de la documentation.
- Exécuter `npm test` (Mocha + ts-node) et `npm run lint` avant de livrer.
- Les scripts d'environnement :
  - `node scripts/setup-environment.mjs` installe, compile et écrit `~/.codex/config.toml` (transport STDIO).
  - `node scripts/maintenance.mjs` rejoue l'installation/la compilation et rafraîchit la config.
- `npm run start` démarre en STDIO, `npm run start:http` nécessite un adaptateur type `mcp-proxy` (Codex CLI reste sur STDIO).

- 2025-02-14 : Ajout d'une détection d'inactivité (GraphState + outil `graph_state_inactivity`), documentation et tests Node.
- 2025-02-15 : Ajout du transport HTTP Streamable, parsing CLI, documentation cloud et tests dédiés.
- 2025-02-16 : Rédaction du guide Codex Cloud (build, déploiement, config `.codex`, diagnostics) et résumé dans le README.
- 2025-02-17 : Refactor serveur (logger JSON, `EventStore`, module HTTP), nouvelles analyses GraphForge, scripts d'environnement et documentation associée.
- 2025-02-18 : Rétablissement de `node_modules/`, exécution de `npm run lint` et `npm test`, préparation du commit final (aucune CI encore).
- 2025-02-19 : Ajout du workflow CI (matrix Node 18/20), mise à jour du script `npm test` (ts-node via `node`), exécution de `npm run lint` et `npm test` après modifications.
- 2025-02-20 : Ajout de tests unitaires EventStore (rétention, filtres, setMaxHistory) et re-lancement de `npm run lint` / `npm test`.
