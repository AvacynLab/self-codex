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
- `graph_state_autosave` : ecrit periodiquement un snapshot JSON. Le viewer VS Code (`Self Fork: Open Viewer`) consomme ce fichier pour afficher enfants, evenements et conversations.

### Runtime dedie par enfant

Chaque enfant recu via `plan_fanout` (ou ajoute a chaud) enregistre un `runtime` distinct (`codex` par defaut). Les outils `job_view`, `status`, `child_info` et les evenements `PLAN` exposent ce champ, facilitant le suivi des instances actives et leur separation logique vis-a-vis de l'orchestrateur (considere comme l'utilisateur dans les transcripts).

