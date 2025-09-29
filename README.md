# mcp-self-fork-orchestrator

Serveur MCP focalisé sur le transport **STDIO** pour piloter des clones Codex en
parallèle. L'orchestrateur assure la planification, l'agrégation des sorties et
une riche boîte à outils d'ingénierie de graphes sans dépendance réseau.

> ℹ️ Le mode HTTP reste optionnel et isolé. Il est désactivé par défaut afin de
> privilégier l'usage interne via STDIO (`codex` CLI) et éviter les surfaces
> d'exposition accidentelles.

## Installation

```bash
npm install              # n'écrit pas de lockfile (utilise --no-save si nécessaire)
npm run build            # compile src/ et graph-forge/
```

Les scripts d'environnement de production doivent rester "sans écriture" pour
le dépôt : `npm ci` lorsqu'un lockfile est présent, sinon
`npm install --omit=dev --no-save --no-package-lock`, puis `npm run build` et
configuration éventuelle de `~/.codex/config.toml`.

## Transports disponibles

- **STDIO (par défaut)** — `npm run start` ou `node dist/server.js`. C'est le
  mode attendu par Codex CLI.
- **HTTP optionnel** — `npm run start:http` active le transport streamable HTTP
  (`--no-stdio`). À réserver aux scénarios cloud avec reverse proxy MCP.

## Outils runtime enfant (`child_*`)

Chaque outil est validé par zod et loggé en JSONL. Les fichiers d'un enfant sont
confinés dans `children/<childId>/`.

| Tool | Objectif | Détails clés |
| --- | --- | --- |
| `child_create` | Démarre un clone Codex | `initial_payload`, `timeouts`, `metadata` | 
| `child_send` | Injecte un prompt/signal | Génère un `messageId` unique |
| `child_status` | Snapshot runtime | `lifecycle`, `lastHeartbeatAt`, ressources |
| `child_collect` | Récupère messages + artefacts | Parcourt l'outbox et retourne le manifeste |
| `child_stream` | Paginer stdout/stderr | Curseur `after_sequence`, filtre `streams` |
| `child_cancel` | SIGINT/SIGTERM gracieux | Supporte `timeout_ms` avant escalation |
| `child_kill` | Terminaison forcée | SIGKILL configurable |
| `child_gc` | Nettoyage FS + index | Supprime logs, manifestes et réindexe |

**Exemple `child_create` + `child_collect`**

```json
{
  "tool": "child_create",
  "input": {
    "metadata": { "experiment": "fanout" },
    "initial_payload": { "type": "prompt", "content": "Analyse le ticket #42" },
    "timeouts": { "idle_ms": 30000 }
  }
}
```

```json
{
  "tool": "child_collect",
  "input": { "child_id": "child_123" }
}
```

**Paginer le transcript avec `child_stream`**

```json
{
  "tool": "child_stream",
  "input": { "child_id": "child_123", "limit": 25, "streams": ["stdout"] }
}
```

## Planification multi-enfants (`plan_*`)

Les plans orchestrent des cohortes d'enfants en fan-out puis agrègent les
résultats.

1. **`plan_fanout`** — Crée `N` enfants à partir d'un template de prompt et
   déclenche le premier envoi. `parallelism` et `retry` contrôlent la pression.
2. **`plan_join`** — Attends la complétion (`all`, `first_success`, `quorum`).
   Chaque entrée contient `status`, résumé et artefacts découverts.
3. **`plan_reduce`** — Combine les sorties (`concat`, `merge_json`, `vote`,
   `custom`). Retourne `aggregate` + `trace` des décisions.

Les exécutions génèrent `run-<timestamp>/fanout.json` pour audit.

### Exemple : fan-out de 3 clones puis vote majoritaire

```json
{
  "tool": "plan_fanout",
  "input": {
    "children_spec": { "count": 3 },
    "prompt_template": {
      "system": "Tu es un relecteur de PR",
      "user": "{{summary}}\n\nPR: {{pr_link}}"
    }
  }
}
```

```json
{
  "tool": "plan_join",
  "input": { "children": ["child_a", "child_b", "child_c"], "join_policy": "all" }
}
```

```json
{
  "tool": "plan_reduce",
  "input": { "children": ["child_a", "child_b", "child_c"], "reducer": "vote" }
}
```

## Templates de prompts (`src/prompts.ts`)

Le moteur de templating extrait les placeholders (`{{variable}}`) et impose que
les variables fournies correspondent exactement aux placeholders détectés.

```json
{
  "system": "Tu es expert CI",
  "user": "Analyse {{service}} sur le commit {{sha}}",
  "assistant": "Dis bonjour à {{owner}}"
}
```

En fan-out, fournissez `variables` à `plan_fanout` pour injecter des valeurs
spécifiques à chaque clone (ex. via `children_spec.list`).

## Atelier de graphes MCP

Tous les outils manipulent des DAGs pondérés et sont testés hors ligne.

- `graph_generate` — Construit un graphe depuis une liste de tâches ou un
  patron (pipeline lint → test → build → package).
- `graph_mutate` — Opérations idempotentes : ajout/retrait/renommage de nœuds ou
  d'arêtes, mise à jour des poids/labels.
- `graph_validate` — Détection de cycles, poids invalides, nœuds inaccessibles
  avec suggestions d'auto-fix.
- `graph_summarize` — Couches, degrés, goulets d'étranglement et nœuds critiques.
- `graph_paths_k_shortest` / `graph_paths_constrained` — K plus courts chemins
  (Yen) et Dijkstra contraint (évictions, budget de coût).
- `graph_centrality_betweenness` — Centralité de Brandes pondérée/non pondérée.
- `graph_simulate` — Simulation temporelle avec `schedule`, `queue` et métriques
  (makespan, parallélisme, utilisation).
- `graph_optimize` — Compare plusieurs niveaux de parallélisme et suggère les
  ajustements les plus pertinents.

**Exemple `graph_simulate`**

```json
{
  "tool": "graph_simulate",
  "input": {
    "graph": {
      "name": "pipeline",
      "nodes": [
        { "id": "lint", "attributes": { "duration": 1 } },
        { "id": "test", "attributes": { "duration": 2 } },
        { "id": "build", "attributes": { "duration": 2 } }
      ],
      "edges": [
        { "from": "lint", "to": "test" },
        { "from": "test", "to": "build" }
      ]
    },
    "parallelism": 2
  }
}
```

Le résultat expose un planning détaillé, les temps d'attente et un JSON prêt à
être visualisé en Gantt.

## Tests et qualité

Les tests sont 100 % hors ligne et déterministes.

```bash
npm run lint   # tsc noEmit sur src/ et graph-forge/
npm test       # build + mocha (ts-node ESM)
npm run build  # compilation dist/
```

Les nouveaux outils ajoutent systématiquement des tests unitaires (mocks enfant,
planification, algorithmes de graphes, simulation/optimisation).

## Intégration continue

Le pipeline GitHub Actions (matrice Node 18/20/22) enchaîne `npm install`,
`npm run build`, `npm run lint` puis `npm test`. Toute erreur TypeScript, test ou
contrat JSON-RPC bloque la livraison.
