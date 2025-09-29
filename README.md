# mcp-self-fork-orchestrator

Serveur MCP (STDIO) pour Codex : orchestration de **sous-chats parallèles** (enfants) sans appel LLM côté outil.  
Codex reste le moteur d'inférence ; l'outil gère l'état, le parallélisme, l'agrégation.

## Installation

```bash
npm install    # ou pnpm install / yarn install
npm run build
```

Les scripts de maintenance détectent automatiquement la présence d'un lockfile et
basculent sur `npm install` lorsqu'aucun fichier `package-lock.json` n'est
présent.

## Graph Forge integration

Le dossier `graph-forge/` fournit une DSL pour decrire des graphes orientes pesees. La build principale compile aussi ce module (`npm run build`).

Un nouvel outil MCP `graph_forge_analyze` charge un fichier `.gf` ou une source inline, compile la description, puis execute les analyses demandees (`shortestPath`, `criticalPath`, `stronglyConnected`).

Exemple (pseudo requete SDK) :

```json
{
  "tool": "graph_forge_analyze",
  "input": {
    "path": "graph-forge/examples/pipeline.gf",
    "analyses": [
      { "name": "shortestPath", "args": ["Ingest", "Store"] }
    ]
  }
}
```

La reponse retourne un resume du graphe (noeuds, arcs, directives) et les resultats des analyses definies dans le script ou envoyees a la volee.


## Fonctionnalités avancées

- **Analyses GraphForge étendues** : le moteur inclut désormais un tri
  topologique (`topologicalSort`), la détection explicite de cycles
  (`detectCycles`), des mesures de centralité (`degreeCentrality`,
  `closenessCentrality`) ainsi que le calcul des *k* plus courts chemins via
  `kShortestPaths`. Toutes les fonctions acceptent un paramètre
  `costFunction` (descripteur JSON ou fonction TypeScript) permettant de
  personnaliser la pondération des arêtes.
- **Tests unitaires** : la suite Mocha (`npm test`) couvre les nouvelles
  analyses GraphForge, les métriques GraphState et le parsing CLI.
- **Journalisation structurée** : l'orchestrateur écrit désormais des lignes
  JSON (`timestamp`, `level`, `message`, `payload`) sur `stdout` et peut les
  refléter dans un fichier via `--log-file`.

## Intégration continue

Un workflow GitHub Actions (`.github/workflows/ci.yml`) reconstruit le projet sur
chaque `push` et `pull_request` en exécutant successivement :

1. `npm install` (ou `npm ci` si un lockfile existe dans le dépôt cloné).
2. `npm run build` pour compiler `src/` et `graph-forge/`.
3. `npm run lint` pour valider les options TypeScript.
4. `npm test` pour lancer la suite Mocha avec `ts-node`.

Ce pipeline empêche d'introduire des régressions sur les outils MCP et
documente la version de Node testée (matrice `18.x` et `20.x`).


## Orchestrateur : outils graphe et visualisation

Plusieurs outils MCP rendent l'etat graphe exploitable sans quitter VS Code :

- `job_view` : resume un job (etat, enfants) avec un extrait du transcript. Chaque enfant expose un lien `vscode://` ainsi qu'une commande `selfForkViewer.openConversation` pour ouvrir la vue web internee.
- `conversation_view` et `events_view` : surfaces respectivement les messages d'un enfant et les evenements recents ou en attente. Les reponses incluent les memes liens cliquables.
- `events_view_live` : lit directement le bus live (option `min_seq`, tri, filtrage par job/enfant) afin d'eviter la saturation liee aux HEARTBEAT.
- `graph_prune` : permet de purger manuellement une conversation (`keep_last`) ou les evenements conserves dans le graphe (`max_events`).
- `graph_state_inactivity` : signale les enfants sans activité récente ou pending trop long (filtres par job/runtime/état, rendu JSON ou texte). Le paramètre `inactivityThresholdSec` définit le seuil global en secondes.
- `graph_state_metrics` : agrège les métriques clés (jobs actifs, enfants en attente, taille de l'historique d'événements, intervalle moyen des heartbeats).
- `graph_state_autosave` : ecrit periodiquement un snapshot JSON accompagné de métadonnées (`inactivity_threshold_ms`, `event_history_limit`). Le viewer VS Code (`Self Fork: Open Viewer`) consomme ce fichier pour afficher enfants, evenements et conversations.

### Runtime dedie par enfant

Chaque enfant recu via `plan_fanout` (ou ajoute a chaud) enregistre un `runtime` distinct (`codex` par defaut). Les outils `job_view`, `status`, `child_info` et les evenements `PLAN` exposent ce champ, facilitant le suivi des instances actives et leur separation logique vis-a-vis de l'orchestrateur (considere comme l'utilisateur dans les transcripts).

## Exposer le serveur MCP via HTTP (cloud)

Le transport STDIO reste actif par defaut. Pour utiliser l'orchestrateur dans un environnement distant (VM, conteneur cloud, etc.), il est possible d'activer un transport HTTP conforme a la specification *Streamable HTTP* :

```bash
node dist/server.js --http --http-port 4000 --no-stdio
```

Options disponibles :

- `--http` active le serveur HTTP avec les valeurs par defaut (hote `0.0.0.0`, port `4000`, chemin `/mcp`).
- `--http-port <port>` / `--http-host <hote>` personnaliser le binding.
- `--http-path <chemin>` (par defaut `/mcp`).
- `--http-json` autorise les reponses JSON directes en plus du flux SSE.
- `--http-stateless` desactive la generation de `mcp-session-id` (mode stateless).
- `--no-stdio` desactive explicitement le transport STDIO; il est automatiquement supprime si HTTP est actif.
- `--max-event-history <n>` limite le nombre d'événements conservés en mémoire (valeur par défaut : `5000`).
- `--log-file <chemin>` duplique les journaux JSON dans un fichier (écriture thread-safe).

Une fois lance, le serveur repond sur `http://<hote>:<port><chemin>` et supporte les GET (SSE) et POST/DELETE conformes au protocole MCP. Utilisez `npm run start:http` pour démarrer directement en mode HTTP (`node dist/server.js --http --http-host 0.0.0.0 --http-port 4000 --no-stdio`).
Les journaux standard (JSON Lines) exposent l'URL et les options activées.

> ⚠️ L'agent Codex CLI ne sait pas dialoguer en HTTP : déployez un adaptateur
> (ex. [`mcp-proxy`](https://github.com/modelcontextprotocol/implementations/tree/main/typescript/packages/mcp-proxy)) pour exposer l'orchestrateur en HTTP tout en conservant la configuration STDIO dans `~/.codex/config.toml`.

### Déploiement Codex Cloud pas-à-pas

Un guide exhaustif (build, packaging, service systemd, configuration Codex) est disponible dans [`docs/codex-cloud-setup.md`](docs/codex-cloud-setup.md).

Résumé rapide :

1. Construire l'orchestrateur en local : `npm install --omit=dev && npm run build` puis archiver `dist/` et `node_modules/`.
2. Déployer l'archive sur l'environnement Codex Cloud et lancer `node dist/server.js --http --http-host 0.0.0.0 --http-port 4000 --no-stdio` (ou via systemd).
3. Déclarer le serveur côté Codex dans `~/.codex/config.toml` via un bloc `[[servers]]` utilisant le transport `streamable-http` pointant vers `https://<domaine>/mcp`.
4. Vérifier la connectivité avec `curl` (`initialize`, flux SSE, `call_tool`) avant d'activer l'agent Codex.

Le guide fournit également un tableau de dépannage (codes d'erreur fréquents, sessions manquantes, blocages réseau) et des exemples d'en-têtes à passer (`Mcp-Session-Id`).

