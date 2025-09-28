# mcp-self-fork-orchestrator

Serveur MCP (STDIO) pour Codex : orchestration de **sous-chats parallèles** (enfants) sans appel LLM côté outil.  
Codex reste le moteur d'inférence ; l'outil gère l'état, le parallélisme, l'agrégation.

## Installation

```bash
pnpm i    # ou npm i / yarn
pnpm run build
```

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


## Orchestrateur : outils graphe et visualisation

Plusieurs outils MCP rendent l'etat graphe exploitable sans quitter VS Code :

- `job_view` : resume un job (etat, enfants) avec un extrait du transcript. Chaque enfant expose un lien `vscode://` ainsi qu'une commande `selfForkViewer.openConversation` pour ouvrir la vue web internee.
- `conversation_view` et `events_view` : surfaces respectivement les messages d'un enfant et les evenements recents ou en attente. Les reponses incluent les memes liens cliquables.
- `events_view_live` : lit directement le bus live (option `min_seq`, tri, filtrage par job/enfant) afin d'eviter la saturation liee aux HEARTBEAT.
- `graph_prune` : permet de purger manuellement une conversation (`keep_last`) ou les evenements conserves dans le graphe (`max_events`).
- `graph_state_inactivity` : signale les enfants sans activité récente ou pending trop long (filtres par job/runtime/état, rendu JSON ou texte).
- `graph_state_autosave` : ecrit periodiquement un snapshot JSON. Le viewer VS Code (`Self Fork: Open Viewer`) consomme ce fichier pour afficher enfants, evenements et conversations.

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

Une fois lance, le serveur repond sur `http://<hote>:<port><chemin>` et supporte les GET (SSE) et POST/DELETE conformes au protocole MCP. Les journaux standard affichent l'URL exposee et les options (JSON/stateless).

### Déploiement Codex Cloud pas-à-pas

Un guide exhaustif (build, packaging, service systemd, configuration Codex) est disponible dans [`docs/codex-cloud-setup.md`](docs/codex-cloud-setup.md).

Résumé rapide :

1. Construire l'orchestrateur en local : `npm ci --omit=dev && npm run build` puis archiver `dist/` et `node_modules/`.
2. Déployer l'archive sur l'environnement Codex Cloud et lancer `node dist/server.js --http --http-host 0.0.0.0 --http-port 4000 --no-stdio` (ou via systemd).
3. Déclarer le serveur côté Codex dans `~/.codex/config.toml` via un bloc `[[servers]]` utilisant le transport `streamable-http` pointant vers `https://<domaine>/mcp`.
4. Vérifier la connectivité avec `curl` (`initialize`, flux SSE, `call_tool`) avant d'activer l'agent Codex.

Le guide fournit également un tableau de dépannage (codes d'erreur fréquents, sessions manquantes, blocages réseau) et des exemples d'en-têtes à passer (`Mcp-Session-Id`).

Pour automatiser l'exposition dans Codex Cloud, la section 9 du guide détaille les scripts « configuration » et « maintenance » à coller directement dans le panneau de l'environnement (capture fournie par l'utilisateur).

