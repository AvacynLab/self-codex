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
| `child_create` | Démarre un clone Codex | `prompt`, `tools_allow`, `timeouts`, `budget`, `initial_payload` |
| `child_send` | Injecte un prompt/signal | Génère un `messageId` unique, `expect` (`stream`/`final`) |
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
    "prompt": {
      "system": "Tu es un clone spécialisé en revue de PR.",
      "user": [
        "Analyse la requête #42.",
        "Identifie les risques majeurs."
      ]
    },
    "tools_allow": ["graph_generate", "graph_optimize"],
    "timeouts": { "ready_ms": 2000, "idle_ms": 30000 },
    "budget": { "messages": 12, "wallclock_ms": 600000 },
    "metadata": { "experiment": "fanout" },
    "initial_payload": { "type": "prompt", "content": "Analyse le ticket #42" }
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

**Attendre une réponse finale via `child_send`**

```json
{
  "tool": "child_send",
  "input": {
    "child_id": "child_123",
    "payload": { "type": "prompt", "content": "résume le ticket" },
    "expect": "final",
    "timeout_ms": 4000
  }
}
```

`child_send` renvoie alors `awaited_message` contenant la ligne `stdout` qui satisfait
l'attente (typiquement `type: "response"`). Utilisez `expect: "stream"` pour
capturer une réponse partielle (`type: "pong"`, `"chunk"`, …) sans attendre la
complétion de l'enfant.

Les champs `prompt`, `tools_allow`, `timeouts` et `budget` sont conservés dans le
`manifest.json` de l'enfant pour faciliter l'audit et les ré-exécutions.

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
  ajustements les plus pertinents (`objective` = `makespan`/`cost`/`risk` avec
  pénalités optionnelles).
- `graph_optimize_moo` — Pareto multi-objectifs (makespan/coût/risque) avec
  scalarisation pondérée en option.
- `graph_causal_analyze` — Ordre topologique, cycles détectés et coupures
  minimales sur les graphes causaux.
- `graph_export` — Export JSON/Mermaid/DOT/GraphML (inline ou fichier sur disque).
- `graph_partition` — Partition heuristique (min-cut/community) avec graine
  optionnelle pour sélectionner les nœuds pivot.

**Exemple `graph_generate`**

```json
{
  "tool": "graph_generate",
  "input": {
    "name": "release_pipeline",
    "preset": "lint_test_build_package",
    "tasks": [
      {
        "id": "deploy",
        "label": "Déploiement",
        "depends_on": ["package"],
        "duration": 5,
        "metadata": { "environment": "staging" }
      },
      {
        "id": "notify",
        "label": "Notifier l'équipe",
        "depends_on": ["deploy"]
      }
    ]
  }
}
```

Le preset fournit les étapes lint/test/build/package, puis les tâches JSON sont
fusionnées, avec ajout automatique d'arêtes synthétiques pour les dépendances
absentes (`deploy → notify`).

**Exemple `graph_mutate`**

```json
{
  "tool": "graph_mutate",
  "input": {
    "graph": {
      "name": "pipeline",
      "nodes": [
        { "id": "lint", "attributes": { "duration": 1 } },
        { "id": "test", "attributes": { "duration": 2 } },
        { "id": "build", "attributes": { "duration": 3 } }
      ],
      "edges": [
        { "from": "lint", "to": "test" },
        { "from": "test", "to": "build" }
      ]
    },
    "operations": [
      { "op": "add_node", "node": { "id": "qa", "attributes": { "duration": 2 } } },
      { "op": "add_edge", "edge": { "from": "build", "to": "qa" } },
      { "op": "set_node_attribute", "id": "build", "key": "duration", "value": 4 }
    ]
  }
}
```

Chaque opération retourne un enregistrement `applied` précisant si la mutation
a effectivement changé le graphe (diff structuré insensible à l'ordre).

**Exemple `graph_validate`**

```json
{
  "tool": "graph_validate",
  "input": {
    "graph": {
      "name": "pipeline",
      "nodes": [
        { "id": "lint" },
        { "id": "test" },
        { "id": "build" }
      ],
      "edges": [
        { "from": "lint", "to": "test" },
        { "from": "test", "to": "build" },
        { "from": "build", "to": "lint" }
      ]
    },
    "strict_weights": true,
    "cycle_limit": 5
  }
}
```

Le résultat répertorie les cycles détectés (`lint → test → build → lint`), les
poids manquants (si `strict_weights`) et les nœuds inaccessibles.

**Exemple `graph_summarize`**

```json
{
  "tool": "graph_summarize",
  "input": {
    "graph": {
      "name": "pipeline",
      "nodes": [
        { "id": "lint", "attributes": { "duration": 1 } },
        { "id": "test", "attributes": { "duration": 2 } },
        { "id": "build", "attributes": { "duration": 3 } },
        { "id": "deploy", "attributes": { "duration": 2 } }
      ],
      "edges": [
        { "from": "lint", "to": "test" },
        { "from": "test", "to": "build" },
        { "from": "build", "to": "deploy" }
      ]
    }
  }
}
```

Le résumé produit les couches topologiques, les nœuds critiques (chemin
critique `lint → test → build → deploy`), les hubs et un aperçu des degrés.

**Exemple `graph_paths_k_shortest`**

```json
{
  "tool": "graph_paths_k_shortest",
  "input": {
    "graph": {
      "name": "routes",
      "nodes": [
        { "id": "A" },
        { "id": "B" },
        { "id": "C" },
        { "id": "D" }
      ],
      "edges": [
        { "from": "A", "to": "B", "weight": 1 },
        { "from": "B", "to": "D", "weight": 4 },
        { "from": "A", "to": "C", "weight": 2 },
        { "from": "C", "to": "D", "weight": 1 },
        { "from": "B", "to": "C", "weight": 1 }
      ]
    },
    "from": "A",
    "to": "D",
    "k": 3,
    "max_deviation": 2
  }
}
```

Yen renvoie jusqu'à trois itinéraires triés par coût, avec la route de base et
les détours admissibles selon `max_deviation`.

**Exemple `graph_paths_constrained`**

```json
{
  "tool": "graph_paths_constrained",
  "input": {
    "graph": {
      "name": "routes",
      "nodes": [
        { "id": "A" },
        { "id": "B" },
        { "id": "C" },
        { "id": "D" }
      ],
      "edges": [
        { "from": "A", "to": "B", "weight": 1 },
        { "from": "B", "to": "D", "weight": 4 },
        { "from": "A", "to": "C", "weight": 2 },
        { "from": "C", "to": "D", "weight": 1 },
        { "from": "B", "to": "C", "weight": 1 }
      ]
    },
    "from": "A",
    "to": "D",
    "avoid_nodes": ["B"],
    "max_cost": 5
  }
}
```

Le moteur Dijkstra contraint filtre `B`, recalculant un chemin via `A → C → D`
et indique si le budget `max_cost` est respecté.

**Exemple `graph_centrality_betweenness`**

```json
{
  "tool": "graph_centrality_betweenness",
  "input": {
    "graph": {
      "name": "routes",
      "nodes": [
        { "id": "A" },
        { "id": "B" },
        { "id": "C" },
        { "id": "D" }
      ],
      "edges": [
        { "from": "A", "to": "B", "weight": 1 },
        { "from": "B", "to": "D", "weight": 4 },
        { "from": "A", "to": "C", "weight": 2 },
        { "from": "C", "to": "D", "weight": 1 }
      ]
    },
    "weighted": true,
    "weight_attribute": "weight",
    "top_k": 2
  }
}
```

Brandes calcule le score de centralité de chaque nœud, fournit le top 2, le
classement complet et les statistiques (min/max/moyenne).

**Exemple `graph_optimize`**

```json
{
  "tool": "graph_optimize",
  "input": {
    "graph": {
      "name": "pipeline",
      "nodes": [
        { "id": "lint", "attributes": { "duration": 1, "cost": 1 } },
        { "id": "test", "attributes": { "duration": 4, "cost": 3 } },
        { "id": "build", "attributes": { "duration": 5, "cost": 4 } },
        { "id": "deploy", "attributes": { "duration": 2, "cost": 2 } }
      ],
      "edges": [
        { "from": "lint", "to": "test" },
        { "from": "test", "to": "build" },
        { "from": "build", "to": "deploy" }
      ]
    },
    "parallelism": 1,
    "max_parallelism": 4,
    "explore_parallelism": [1, 2, 3, 4],
    "duration_attribute": "duration",
    "objective": { "type": "cost", "attribute": "cost", "parallel_penalty": 1 }
  }
}
```

La sortie contient la simulation de base (`parallelism=1`), les projections pour
chaque parallélisme candidat et les recommandations (augmentation de
parallélisme, focus chemin critique, etc.) avec la valeur objective.

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

**Exemple `graph_optimize_moo`**

```json
{
  "tool": "graph_optimize_moo",
  "input": {
    "graph": { "name": "fan_in", "nodes": [
      { "id": "A", "attributes": { "duration": 8, "cost": 5 } },
      { "id": "B", "attributes": { "duration": 6, "cost": 4 } },
      { "id": "C", "attributes": { "duration": 4, "cost": 3 } },
      { "id": "D", "attributes": { "duration": 2, "cost": 2 } }
    ], "edges": [
      { "from": "A", "to": "D" },
      { "from": "B", "to": "D" },
      { "from": "C", "to": "D" }
    ] },
    "parallelism_candidates": [1, 2, 3],
    "objectives": [
      { "type": "makespan" },
      { "type": "cost", "attribute": "cost", "parallel_penalty": 2 }
    ],
    "duration_attribute": "duration",
    "scalarization": { "method": "weighted_sum", "weights": { "makespan": 0.7, "cost": 0.3 } }
  }
}
```

Le résultat renvoie les métriques pour chaque parallélisme, la frontière de
Pareto (ici `[1, 2, 3]`) et, si demandé, le classement pondéré.

**Exemple `graph_partition`**

```json
{
  "tool": "graph_partition",
  "input": {
    "graph": {
      "name": "clusters",
      "nodes": [
        { "id": "A" }, { "id": "B" }, { "id": "C" },
        { "id": "D" }, { "id": "E" }, { "id": "F" }
      ],
      "edges": [
        { "from": "A", "to": "B" },
        { "from": "B", "to": "C" },
        { "from": "C", "to": "D" },
        { "from": "D", "to": "E" },
        { "from": "E", "to": "F" }
      ]
    },
    "k": 2,
    "objective": "community",
    "seed": 1
  }
}
```

**Exemple `graph_causal_analyze`**

```json
{
  "tool": "graph_causal_analyze",
  "input": {
    "graph": {
      "name": "dag",
      "nodes": [
        { "id": "A" },
        { "id": "B" },
        { "id": "C" },
        { "id": "D" }
      ],
      "edges": [
        { "from": "A", "to": "B" },
        { "from": "A", "to": "C" },
        { "from": "B", "to": "D" },
        { "from": "C", "to": "D" }
      ]
    }
  }
}
```

Le retour contient l'ordre topologique (`["A","B","C","D"]`), les ancêtres,
descendants et, pour ce DAG, la coupe minimale `[{"from":"B","to":"D"},{"from":"C","to":"D"}]`.

**Exemple `graph_export`**

```json
{
  "tool": "graph_export",
  "input": { "format": "mermaid", "label_attribute": "label", "truncate": 512 }
}
```

L'orchestrateur renvoie un aperçu Mermaid du graphe courant (`graph LR ...`). En
fournissant `"inline": false, "path": "tmp/graph.mmd"`, le fichier est écrit
sur disque dans le workspace.

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
