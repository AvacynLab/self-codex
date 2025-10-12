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

## Build

- **Prerequis** : Node.js ≥ 20 et `npm ci` pour respecter le lockfile existant.
- **Pipeline officiel** : `npm ci && npm run build` construit `dist/` et `graph-forge/`.
- **Types Node** : `@types/node` reste dans `dependencies` afin que les conteneurs
  cloud récupèrent automatiquement les définitions lors d'un `npm ci` minimal.
- **Fallback portable** : `npm run build:portable` détecte l'absence de `tsc` dans
  `node_modules/.bin/` et bascule automatiquement sur `npx --yes typescript` pour
  compiler la racine puis `graph-forge/`.
- **Setup automatisé** : `scripts/setup-agent-env.sh` neutralise les variables
  npm (`NPM_CONFIG_PRODUCTION`, `NPM_CONFIG_OMIT`) et relance `npm ci --include=dev`
  avant de construire. Le script vérifie également la présence de
  `node_modules/@types/node` et retombe sur `npx typescript` si nécessaire.
- **Diagnostic environnement** : `node scripts/verify-env.mjs` imprime un JSON
  récapitulant la version de Node.js, la présence de `@types/node`, de `tsc`, de
  `tsx`, ainsi que les fichiers `tsconfig.json` et `package-lock.json`. Pratique
  pour confirmer qu'un conteneur CI respecte les prérequis Node ≥ 20.

## Tests

- `npm run test:unit` exécute l'intégralité de la suite avec un garde-fou
  réseau qui bloque toute sortie non-loopback. C'est la commande par défaut en
  CI et pour les revues locales rapides.
- `npm run test:e2e:http` active automatiquement `MCP_TEST_ALLOW_LOOPBACK=yes`
  puis relance Mocha avec les scénarios HTTP de bout en bout. Utilisez cette
  commande lorsque vous souhaitez valider les chemins réseau : elle laisse la
  garde activée pour l'Internet public, mais autorise `127.0.0.1`/`::1`.
- Les suites peuvent recevoir des flags Mocha supplémentaires via
  `npm run test:e2e:http -- --grep "http"` (transmis tel quel au runner).


## Environnement Cloud

- **Commandes recommandées** :
  - `npm ci && npm run build` pour reconstruire l'orchestrateur à partir d'un
    workspace propre.
  - `npm run build:portable` lorsque l'image de base ne fournit pas `tsc` dans
    le `PATH`.
  - `node scripts/setup-agent-env.sh` dans les jobs CI pour neutraliser les
    options npm agressives.
- **Variables utiles** :
  - `MCP_HTTP_*` : configure l'hôte, le port, le chemin et le mode stateless du
    transport HTTP (ex. `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_TOKEN`).
  - `MCP_LOG_*` : positionne le chemin du log structuré (`MCP_LOG_FILE`), la
    politique de rotation (`MCP_LOG_ROTATE_SIZE`, `MCP_LOG_ROTATE_KEEP`) et la
    rédaction (`MCP_LOG_REDACT`).
  - `MCP_*_ROOT` : `MCP_RUNS_ROOT` et `MCP_CHILDREN_ROOT` redirigent les
    répertoires d'exécution vers des volumes persistants.
  - `MCP_QUALITY_*` : active le garde-fou qualité (`MCP_QUALITY_GATE`,
    `MCP_QUALITY_THRESHOLD`).
  - `IDEMPOTENCY_TTL_MS` : contrôle la rétention des clés d'idempotence côté
    serveur pour éviter les replays accidentels.
- **Observabilité** : `scripts/record-run.mjs` pilote le serveur HTTP, enchaîne
  `mcp_info`, `tools/list`, les opérations de graphe et le cycle enfant Codex,
  puis génère un dossier `runs/validation_<date>/` avec les requêtes JSONL,
  réponses, événements, journaux et rapports synthétiques.

## Transports disponibles

- **STDIO (par défaut)** — `npm run start` ou `node dist/server.js`. C'est le
  mode attendu par Codex CLI.
- **HTTP optionnel** — `npm run start:http` active le transport streamable HTTP
  (`--no-stdio`). À réserver aux scénarios cloud avec reverse proxy MCP.

## Introspection MCP & négociation

Avant de déclencher des opérations longues, interrogez l'orchestrateur à l'aide
des outils `mcp_info` et `mcp_capabilities`. Ils reflètent les options
d'exécution configurées via `serverOptions.ts` et permettent de vérifier les
limites (`maxInputBytes`, `defaultTimeoutMs`, `maxEventHistory`) ainsi que les
modules activés (blackboard, BT, ressources, etc.).

### `mcp_info`

```bash
# STDIO (via le CLI MCP officiel)
npx @modelcontextprotocol/cli call stdio \
  --command "node dist/server.js" \
  --tool mcp_info

# HTTP JSON (si `--http` est activé)
curl -s http://localhost:4000/mcp \
  -H 'Content-Type: application/json' \
  -d '{
        "jsonrpc":"2.0",
        "id":1,
        "method":"tools/call",
        "params":{ "name":"mcp_info", "arguments":{} }
      }' | jq
```

Réponse condensée :

```json
{
  "server": { "name": "mcp-self-fork-orchestrator", "version": "1.3.0", "mcpVersion": "1.0" },
  "transports": {
    "stdio": { "enabled": true },
    "http": { "enabled": false, "host": null, "port": null, "path": null, "enableJson": true, "stateless": false }
  },
  "features": {
    "enableMcpIntrospection": true,
    "enableResources": true,
    "enableEventsBus": false,
    "enableCancellation": false,
    "enableTx": false,
    "enableBulk": false,
    "enableIdempotency": false,
    "enableLocks": false,
    "enableDiffPatch": false,
    "enablePlanLifecycle": false,
    "enableChildOpsFine": false,
    "enableValuesExplain": false,
    "enableAssist": false
  },
  "timings": { "btTickMs": 50, "stigHalfLifeMs": 30000, "supervisorStallTicks": 6, "defaultTimeoutMs": 60000, "autoscaleCooldownMs": 10000, "heartbeatIntervalMs": 2000 },
  "safety": { "maxChildren": 16, "memoryLimitMb": 512, "cpuPercent": 100 },
  "limits": { "maxInputBytes": 524288, "defaultTimeoutMs": 60000, "maxEventHistory": 1000 }
}
```

Le flag `--heartbeat-interval-ms` permet désormais d'ajuster la cadence des
événements `HEARTBEAT` côté orchestrateur. Les valeurs inférieures à `250ms`
sont automatiquement remontées à ce seuil afin de protéger les consommateurs du
bus d'événements contre les surcharges.

> Les toggles désactivés (`enableEventsBus`, `enableTx`, `enableBulk`, etc.) correspondent aux modules en cours d'implémentation.
> Consultez `docs/mcp-api.md` pour suivre leur statut et leurs schémas attendus.

Lorsque `enableIdempotency` est actif, les outils `child_create`, `child_spawn_codex`,
`plan_run_bt`, `plan_run_reactive`, `cnp_announce`, `tx_begin` et
`graph_batch_mutate` acceptent un `idempotency_key` optionnel et renvoient
`idempotent: true` lors des relectures afin de signaler qu'aucune action
supplémentaire n'a été effectuée côté serveur.

### `mcp_capabilities`

```bash
npx @modelcontextprotocol/cli call stdio \
  --command "node dist/server.js" \
  --tool mcp_capabilities
```

La réponse liste les namespaces disponibles et un résumé pour chaque schéma
(par exemple `coord.blackboard`, `graph.core`, `values.guard`).

## Registre de ressources `sc://`

Le registre MCP expose des identifiants stables pour consulter l'état interne
du serveur. Chaque URI suit le schéma `sc://<kind>/…`.

| URI | Description |
| --- | --- |
| `sc://graphs/<graphId>` | Graphe normalisé et sa dernière version commitée. |
| `sc://graphs/<graphId>@v<version>` | Version spécifique commitée. |
| `sc://snapshots/<graphId>/<txId>` | Snapshot d'une transaction ouverte (état, base, projection). |
| `sc://runs/<runId>/events` | Chronologie des événements corrélés à un run. |
| `sc://children/<childId>/logs` | Journaux stdout/stderr normalisés d'un enfant. |
| `sc://blackboard/<namespace>` | Instantané clé/valeur d'un namespace blackboard. |

### Outils `resources_*`

- `resources_list` — Filtre facultativement par préfixe et pagine (`limit ≤ 500`).
- `resources_read` — Retourne le payload normalisé de l'URI.
- `resources_watch` — Suivi incrémental des événements (`from_seq`, `next_seq`, `format`).

Le paramètre `format` (défaut `"json"`) accepte `"sse"` pour obtenir une
représentation prête à diffuser via Server-Sent Events. La réponse inclut alors
`messages` (tableau `id/event/data`) et `stream` (concaténation `id:`/`event:`/
`data:`) générés par `serialiseResourceWatchResultForSse`. Chaque `data:` est
pré-échappé (`\n`, `\r`, `U+2028`, `U+2029`) afin de rester monoligne tout en
préservant `next_seq` pour faciliter les reconnexions.

Exemple (HTTP JSON) pour lister les graphes :

```bash
curl -s http://localhost:4000/mcp \
  -H 'Content-Type: application/json' \
  -d '{
        "jsonrpc":"2.0",
        "id":2,
        "method":"tools/call",
        "params":{ "name":"resources_list", "arguments":{ "prefix":"sc://graphs/" } }
      }'
```

Pour une consommation STDIO batch, enchaînez les appels via le CLI MCP
(`--tool resources_read --args '{"uri":"sc://graphs/demo"}'`).

## Outils runtime enfant (`child_*`)

Chaque outil est validé par zod et loggé en JSONL. Les fichiers d'un enfant sont
confinés dans `children/<childId>/`.

> ℹ️ Tous les retours `child_*` incluent désormais les hints de corrélation
> (`run_id`, `op_id`, `job_id`, `graph_id`, `node_id`, `child_id`) lorsqu'ils
> sont fournis par l'appelant ou générés par l'orchestrateur. Les événements du
> bus MCP et les journaux `sc://children/<id>/logs` reflètent automatiquement ces
> identifiants pour faciliter le suivi bout-en-bout.

| Tool | Objectif | Détails clés |
| --- | --- | --- |
| `child_create` | Démarre un clone Codex | `prompt`, `tools_allow`, `timeouts`, `budget`, `initial_payload` |
| `child_spawn_codex` | Provisionne un enfant spécialisé | Utilise un manifeste `codex.json`, options `role`, `limits`, corrélations `run_id`/`op_id` |
| `child_batch_create` | Démarre plusieurs clones Codex | Transaction atomique avec rollback et clés d'idempotence par entrée |
| `child_attach` | Rattache un runtime existant | Resynchronise manifeste + index, renseigne `attached_at` |
| `child_set_role` | Met à jour le rôle logique | Applique immédiatement `role`, journalise sur bus MCP et ressources |
| `child_set_limits` | Ajuste CPU/mémoire/budget | Enforce soft-limits (`messages`, `wallclock_ms`, `cpu_percent`) |
| `child_send` | Injecte un prompt/signal | Génère un `messageId` unique, `expect` (`stream`/`final`), conserve hints de corrélation |
| `child_status` | Snapshot runtime | `lifecycle`, `lastHeartbeatAt`, ressources, rôle & limites |
| `child_collect` | Récupère messages + artefacts | Parcourt l'outbox, retourne manifeste + corrélations |
| `child_stream` | Paginer stdout/stderr | Curseur `after_sequence`, filtre `streams`, inclut `runId/opId` |
| `child_cancel` | SIGINT/SIGTERM gracieux | Supporte `timeout_ms` avant escalation, relai `jobId/graphId/nodeId` |
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

**Exemple `child_batch_create`**

```json
{
  "tool": "child_batch_create",
  "input": {
    "entries": [
      {
        "role": "planner",
        "prompt": { "system": "Tu es un copilote.", "user": ["Prépare le plan"] },
        "idempotency_key": "plan-1"
      },
      {
        "role": "reviewer",
        "prompt": { "system": "Tu es un copilote.", "user": ["Relis le plan"] },
        "idempotency_key": "plan-2"
      }
    ]
  }
}
```

L'orchestrateur spawn les enfants séquentiellement ; si une création échoue, les
précédents sont stoppés (`rollback`). En rejouant la même requête avec les mêmes
clés, la réponse est rejouée (`idempotent_entries = 2`). Le champ `created`
compte uniquement les nouveaux runtimes démarrés pendant l'appel courant.

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

## Mode réactif (Behaviour Trees + scheduler)

Le runtime réactif est désactivé par défaut. Active les modules nécessaires au
lancement via les flags CLI :

```bash
node dist/server.js \
  --enable-bt \
  --enable-reactive-scheduler \
  --enable-stigmergy \
  --enable-autoscaler \
  --enable-supervisor \
  --enable-causal-memory
```

`plan_compile_bt` transforme un graphe hiérarchique en Behaviour Tree prêt à
l'exécution. Chaque nœud `task` doit déclarer le tool MCP à invoquer via
`bt_tool` et, optionnellement, la clé d'entrée consommée.

```json
{
  "tool": "plan_compile_bt",
  "input": {
    "graph": {
      "id": "demo_bt",
      "nodes": [
        {
          "id": "prepare",
          "kind": "task",
          "label": "Préparer",
          "attributes": { "bt_tool": "noop", "bt_input_key": "payload" }
        },
        {
          "id": "execute",
          "kind": "task",
          "label": "Executer",
          "attributes": { "bt_tool": "noop", "bt_input_key": "payload" }
        }
      ],
      "edges": [
        {
          "id": "prepare_to_execute",
          "from": { "nodeId": "prepare" },
          "to": { "nodeId": "execute" }
        }
      ]
    }
  }
}
```

Le résultat est un arbre compact. Pour exécuter la boucle réactive, réinjecte le
payload compilé dans `plan_run_reactive` ou `plan_run_bt`. `tick_ms` cadence les
ticks du scheduler, `budget_ms` borne la durée d'un tick et `timeout_ms`
protège l'exécution complète.

Pour éviter la famine lorsque des événements très critiques affluent en
permanence, le scheduler applique un **aging logarithmique** basé sur l'ancienneté
(`aging_half_life_ms`, `aging_fairness_boost`) en plus du poids linéaire
(`age_weight`). Les événements anciens finissent ainsi par dépasser les
priorités intrinsèques des signaux récents. En parallèle, le quantum CPU
(`batch_quantum_ms`, `max_batch_ticks`) force un yield coopératif dès qu'une
série de ticks consomme trop de temps, laissant le temps au runtime Node.js de
traiter les I/O et de nouvelles requêtes SSE.

```json
{
  "tool": "plan_run_reactive",
  "input": {
    "tree": {
      "id": "demo_bt",
      "root": {
        "type": "sequence",
        "id": "demo_bt:sequence",
        "children": [
          { "type": "task", "id": "prepare", "node_id": "prepare", "tool": "noop", "input_key": "payload" },
          { "type": "task", "id": "execute", "node_id": "execute", "tool": "noop", "input_key": "payload" }
        ]
      }
    },
    "variables": { "payload": { "message": "ping" } },
    "tick_ms": 50,
    "budget_ms": 10,
    "timeout_ms": 2000
  }
}
```

Les décorateurs de Behaviour Tree permettent de contrôler finement les reprises
et les budgets d'exécution :

* `retry` accepte `max_attempts`, `backoff_ms` et `backoff_jitter_ms` pour
  introduire un délai aléatoire (borné) entre deux tentatives.
* `timeout` fonctionne soit avec `timeout_ms`, soit avec `timeout_category`
  (profil côté runtime) pour arrêter une branche trop lente.
* `guard` compare `runtime.variables[condition_key]` à `expected` (ou teste la
  vérité de la valeur quand `expected` est omis) avant de déléguer au nœud
  enfant.
* `cancellable` vérifie la signalisation `isCancelled`/`throwIfCancelled`,
  réinitialise l'enfant puis relance l'exception de type
  `OperationCancelledError` ou `BehaviorTreeCancellationError` afin de laisser
  l'orchestrateur traiter l'annulation.
* Les outils `plan_run_bt` et `plan_run_reactive` convertissent toute
  `BehaviorTreeCancellationError` remontée par les feuilles en
  `OperationCancelledError` afin que la réponse MCP conserve le code
  `E-CANCEL-OP` et la raison détaillée.

Avec `--enable-plan-lifecycle` et `--enable-cancellation`, l'outil
`plan_status` renvoie un snapshot enrichi de la progression (0–100%) et des
motifs d'échec. Lorsqu'un run est stoppé via `plan_cancel`, la réponse inclut
désormais directement `progress` ainsi que le snapshot `lifecycle` mis à jour :
le client peut afficher la progression finale et la raison d'annulation sans
enchaîner un appel `plan_status` supplémentaire. Le tool `op_cancel` relaie
également le pourcentage courant et le snapshot lorsque le run est corrélé à un
cycle de vie actif, ce qui permet de diagnostiquer un arrêt ciblé sans exécuter
`plan_status`. Quand la fonctionnalité lifecycle est désactivée, ces champs
retombent proprement à `null` pour signaler l'absence de suivi détaillé.

Les outils d'inspection (`plan_status`) et de pilotage manuel
(`plan_pause`/`plan_resume`) renvoient l'erreur
`E-PLAN-LIFECYCLE-DISABLED` assortie du hint `enable_plan_lifecycle`
quand le registre n'est pas actif, ce qui documente clairement la
marche à suivre pour réactiver la fonctionnalité.

Si la fonctionnalité est réactivée alors qu'un run est toujours en
cours, le registre conserve l'historique accumulé pendant la
désactivation : les snapshots reprennent immédiatement leur progression
et les contrôles manuels (pause/reprise) restent disponibles sans
nécessiter une relance de l'exécution.

Les événements `tick` publiés dans le cycle de vie incluent désormais la
durée du tick (`tick_duration_ms`) et un condensé de l'événement
ordonnanceur traité (`event_payload`). Cela permet d'inspecter les nœuds
réveillés ou terminés même si le suivi a été désactivé temporairement.
Les événements `loop` exposent également la liste des reconcilers
exécutés (`autoscaler`, `supervisor`, …) avec leur durée et leur statut
afin de visualiser la reprise des actions d'orchestration lorsque la
fonctionnalité lifecycle est réactivée en cours de run.

Les clients MCP peuvent récupérer ces informations via `events_subscribe`
en JSON Lines ou SSE : chaque événement `BT_RUN` de phase `loop` inclut le
tableau `reconcilers` décrivant les identifiants, les statuts et les
durées d'exécution des agents (`autoscaler`, `supervisor`, etc.), ce qui
facilite l'observabilité des runs réactifs dans un tableau de bord.
Les événements publiés par l'autoscaler (`scale_up`, `scale_down`, …) embarquent
à présent un bloc `pheromone_bounds` normalisé. Cette enveloppe reflète les
limites courantes du champ stigmergique (bornes min/max et plafond de
normalisation) et permet de corréler les décisions de scaling avec la pression
observée par le scheduler réactif.

Le dashboard HTTP (`/metrics`, `/stream`) expose le même bloc via la clé
`pheromone_bounds`. Les clients SSE peuvent ainsi afficher la normalisation
directement dans l'interface sans réimplémenter les calculs du champ
stigmergique et restent alignés avec les outils MCP et les événements plan.
Les réponses fournissent également un résumé prêt à afficher dans
`stigmergy.rows` (tableau « Min/Max/Ceiling ») ainsi qu'une chaîne déjà
formatée `heatmap.boundsTooltip` pour alimenter les infobulles de la heatmap
sans logique additionnelle côté client.

Le dashboard `/metrics` et `/stream` exposent en outre un bloc
`contractNetWatcherTelemetry` qui reflète directement le dernier instantané
du watcher `watchContractNetPheromoneBounds`. Il indique le nombre d'émissions
(`emissions`), l'horodatage du dernier envoi (`last_emitted_at_ms`) et recopie
le dernier jeu de compteurs (`last_snapshot`) comprenant les bornes appliquées.
Les opérateurs peuvent ainsi visualiser le débit de rafraîchissement (et le
coalescing) sans interroger l'outil MCP `cnp_watcher_telemetry` ni parser les
logs.

Les mêmes compteurs sont désormais diffusés en temps réel sur le bus
d'événements (`cat: "contract_net"`, `msg: "cnp_watcher_telemetry"`). Les
clients `events_subscribe` peuvent donc corréler chaque émission du watcher avec
leurs propres métadonnées (par exemple un `graphId`) sans attendre le prochain
poll `/metrics`.

Le flux SSE `/stream` sérialise chaque snapshot sur une seule ligne et échappe
les séparateurs de lignes (`\n`, `\r`, U+2028, U+2029) afin d'éviter la
fragmentation des événements côté clients `EventSource`. Les raisons longues ou
multilignes rapportées par le watcher Contract-Net restent ainsi lisibles après
`JSON.parse` tout en conservant un transport conforme au protocole SSE. Le
format SSE de l'outil `events_subscribe` réutilise la même normalisation : les
événements `cancel` conservent leurs raisons multi-lignes (ou avec séparateurs
Unicode) sans casser la ligne `data:` diffusée aux clients MCP.

Pour un aperçu rapide sans outil supplémentaire, l'endpoint racine du dashboard
(`GET /`) renvoie une page HTML affichant le résumé Contract-Net (compteurs,
raison de la dernière émission, bornes normalisées) ainsi que les sections
stigmergie et scheduler. La page embarque désormais un bootstrap léger qui se
connecte au flux SSE `/stream` : les métriques et compteurs se mettent à jour
automatiquement sans rechargement, tout en réutilisant le même snapshot que
`/metrics` pour rester cohérents avec les payloads JSON.

Le scheduler publie le backlog, l'état des nœuds (RUNNING/OK/KO) et les
phéromones au dashboard SSE (`npm run start:dashboard`). Active
`--enable-value-guard` pour enrichir les invocations BT avec les décisions du
garde-fou et surveiller les violations.

## Coordination partagée (blackboard, stigmergie, Contract-Net, consensus)

Les outils de coordination nécessitent `--enable-blackboard`,
`--enable-stigmergy`, `--enable-cnp` et `--enable-consensus`. Ils fonctionnent
entièrement hors ligne et s'intègrent au scheduler réactif.

### Blackboard clé-valeur

```json
{ "tool": "bb_set", "input": { "key": "mission", "value": { "status": "ready" }, "tags": ["sync"], "ttl_ms": 60000 } }
```

```json
{
  "tool": "bb_batch_set",
  "input": {
    "entries": [
      { "key": "mission", "value": { "status": "ready" }, "tags": ["sync"] },
      { "key": "backlog", "value": { "tickets": 3 }, "ttl_ms": 300000 }
    ]
  }
}
```

```json
{ "tool": "bb_get", "input": { "key": "mission" } }
```

`bb_watch` streame les événements via versioning séquentiel afin de rejouer le
journal des écritures.

### Champ stigmergique

```json
{ "tool": "stig_mark", "input": { "node_id": "triage", "type": "backlog", "intensity": 2.5 } }
```

```json
{
  "tool": "stig_batch",
  "input": {
    "entries": [
      { "node_id": "triage", "type": "backlog", "intensity": 2.5 },
      { "node_id": "triage", "type": "latency", "intensity": 1.25 }
    ]
  }
}
```

```json
{ "tool": "stig_snapshot", "input": {} }
```

Les intensités guident le scheduler réactif et sont visibles dans les overlays
Mermaid et le dashboard. Le champ accepte désormais les options suivantes :

* `defaultHalfLifeMs` — demi-vie utilisée par défaut lors d'un `stig_decay`
  sans paramètre explicite ;
* `minIntensity` / `maxIntensity` — bornes utilisées pour normaliser les
  intensités dans les exports heatmap et éviter que les valeurs aberrantes ne
  saturent l'affichage.

La sortie de `stig_snapshot` inclut un bloc `heatmap` contenant les cellules
agrégées (`total_intensity`, `normalised`) ainsi que les contributions par
type. Les dashboards peuvent consommer ce bloc directement pour afficher une
heatmap à échelle fixe.

Les réponses exposent aussi `pheromone_bounds` (bornes normalisées min/max et
plafond de normalisation) et un bloc `summary` avec `rows` déjà formatées
(`Min/Max/Ceiling`) ainsi qu'un `tooltip`. L'autoscaler et les dashboards peuvent
ainsi afficher les limites courantes sans répliquer la logique de formatage et
rester alignés avec les outils MCP (`plan_run_*`, Contract-Net, événements SSE).

Les exécutions `plan_run_bt` / `plan_run_reactive` exposent également
`event_payload.pheromone_bounds` dans leurs événements lifecycle (`tick`) et
`events_subscribe` relaie ces limites pour que les observateurs MCP puissent
reconstruire les intensités normalisées côté client.

### Contrat-Net

```json
{
  "tool": "cnp_announce",
  "input": {
    "task_id": "review-42",
    "payload": { "priority": 3 },
    "tags": ["analysis"],
    "manual_bids": [
      { "agent_id": "alpha", "cost": 5 },
      { "agent_id": "beta", "cost": 3 }
    ]
  }
}
```

Le résultat contient l'agent attribué (`awarded_agent_id`) et l'historique des
enchères. Combine-le avec `plan_fanout` ou `child_send` pour adresser
directement le gagnant. La réponse inclut également `pheromone_bounds`, un
instantané des limites stigmergiques au moment de l'annonce, aligné sur la
structure utilisée par `plan_run_bt` / `plan_run_reactive`. Les événements
`cnp_call_*` publiés sur le bus MCP exposent le même bloc afin que les
observateurs puissent auditer l'attribution Contract-Net avec la même échelle
que celle utilisée par le scheduler.

Lors de la priorisation des enchères, la pénalité d'occupation (`busy_penalty`)
est multipliée par un facteur de pression dérivé de `pheromone_bounds`. Quand
le plafond normalisé augmente (pression élevée), ce facteur renforce
l'avantage accordé aux agents disponibles pour éviter la saturation. À
l'inverse, l'absence de bornes ou une charge faible maintient un facteur neutre
(`1`) afin que les préférences explicites (`preference_bonus`, `agent_bias`)
continuent de dominer.

Les snapshots Contract-Net incluent le booléen `auto_bid_enabled` afin de
savoir si des enchères heuristiques sont gérées automatiquement pour cet appel.
Quand cette option est active, chaque enchère heuristique embarque
`metadata.pheromone_pressure`, le facteur appliqué à `busy_penalty`, ce qui
permet aux observateurs de corréler visuellement la pression stigmergique et
les coûts effectifs. Utilise
`ContractNetCoordinator.updateCallPheromoneBounds(callId, bounds, options)` pour
mettre à jour un appel ouvert lorsque les limites stigmergiques évoluent : la
methode actualise `pheromone_bounds` et réémet des enchères heuristiques avec la
raison `auto_refresh` tout en laissant les offres manuelles intactes. Passe
`refreshAutoBids: false` pour ne modifier que les bornes, ou
`includeNewAgents: false` pour ignorer les agents enregistrés après
l'annonce. Le serveur expose également l'outil `cnp_refresh_bounds` qui réalise
cette opération pour un `call_id` donné ; si `bounds` n'est pas fourni, les
limites courantes du champ stigmergique sont utilisées. Le résultat précise les
agents rafraîchis (`refreshed_agents`) ainsi que le drapeau
`auto_bid_refreshed`.

Lorsque les bornes évoluent côté stigmergie, un watcher automatique déclenche un
rafraîchissement pour tous les appels ouverts via
`watchContractNetPheromoneBounds`. Chaque mise à jour émet l'événement
`cnp_call_bounds_updated` sur le bus MCP afin que les observateurs suivent les
re-synchronisations d'enchères et la nouvelle pression de phéromones. Pour
éviter un bruit excessif lorsque le champ stigmergique est mis à jour en rafale,
le watcher regroupe par défaut les notifications sur une fenêtre de `50 ms`
(`coalesce_window_ms`). Abaisse la valeur à `0` pour revenir aux rafraîchissements
immédiats, ou augmente-la pour amortir davantage les scénarios très agités.

Pour instrumenter ces rafraîchissements, passe un callback `onTelemetry` lors de
la création du watcher. Il recevra des instantanés cumulés contenant le nombre
d'événements `received_updates`, ceux coalescés (`coalesced_updates`), les
rafraîchissements ignorés car les bornes n'ont pas changé (`skipped_refreshes`),
ainsi que `flushes` et `applied_refreshes` (rafraîchissements ayant appelé
`updateCallPheromoneBounds`). Les mêmes métriques sont journalisées au niveau
`debug` (`contract_net_bounds_watcher_telemetry`) pour faciliter l'observation en
production.

Le serveur démarre automatiquement un watcher connecté au champ de stigmergie
partagé et enregistre les compteurs dans un collecteur interne. L'outil MCP
`cnp_watcher_telemetry` expose ces données à la demande : il indique si la
collecte est active, fournit le nombre total d'émissions, la date du dernier
snapshot (`last_emitted_at_ms` / `last_emitted_at_iso`) et le dernier bloc de
compteurs (`last_snapshot`). Les champs reflètent exactement les compteurs du
callback `onTelemetry`, y compris les bornes applicables (`last_bounds`).

### Consensus rapide

```json
{
  "tool": "consensus_vote",
  "input": {
    "votes": [
      { "voter": "alpha", "value": "ship" },
      { "voter": "beta", "value": "hold" },
      { "voter": "gamma", "value": "ship" }
    ],
    "config": { "mode": "quorum", "quorum": 2 }
  }
}
```

Les décisions (`outcome`, `satisfied`, `tally`) sont identiques à celles
renvoyées par `plan_reduce` en mode `vote`.

## Valeurs, graphe de connaissances et mémoire causale

Active simultanément `--enable-value-guard`, `--enable-knowledge` et
`--enable-causal-memory` pour exploiter ces modules.

### Configurer le garde-fou de valeurs

```json
{
  "tool": "values_set",
  "input": {
    "values": [
      { "id": "confidentialite", "label": "Confidentialité", "weight": 1 },
      { "id": "cout", "label": "Coût", "weight": 0.5 }
    ],
    "relationships": [
      { "from": "confidentialite", "to": "cout", "kind": "conflicts", "weight": 0.6 }
    ],
    "default_threshold": 0.5
  }
}
```

### Filtrer un plan

```json
{
  "tool": "values_filter",
  "input": {
    "id": "plan-demo",
    "impacts": [
      { "value": "confidentialite", "impact": "risk", "severity": 0.8, "rationale": "log PII" },
      { "value": "cout", "impact": "support", "severity": 0.2 }
    ],
    "threshold": 0.6
  }
}
```

`allowed`, `score`, `violations` et `threshold` sont également propagés aux
résultats `plan_fanout`/`plan_reduce`.

### Graphe de connaissances

```json
{
  "tool": "kg_insert",
  "input": {
    "triples": [
      { "subject": "plan_demo", "predicate": "uses", "object": "contract_net" }
    ]
  }
}
```

```json
{
  "tool": "kg_query",
  "input": { "subject": "plan_demo", "limit": 10 }
}
```

Les résultats incluent les révisions, timestamps et ordinal pour permettre des
replays déterministes.

### Suggérer un plan depuis le graphe de connaissances

Avec `--enable-knowledge` et `--enable-assist` actifs, tu peux demander au
registre de synthétiser un fragment hiérarchique prêt à être compilé :

```json
{
  "tool": "kg_suggest_plan",
  "input": {
    "goal": "launch",
    "context": {
      "preferred_sources": ["playbook"],
      "exclude_tasks": ["legacy_audit"],
      "max_fragments": 2
    }
  }
}
```

La réponse fournit :

* `fragments` – un tableau de `HierGraph` dont chaque nœud encode `kg_goal`,
  `kg_source`, `kg_confidence`, `kg_seed` (tâche cœur/dépendance) et `kg_group`
  (ex: `source playbook`). Les arêtes conservent les dépendances (`depends_on`).
* `rationale` – phrases prêtes à l'emploi résumant la couverture (`Plan '...' :
  X/Y tâches`), les exclusions et les dépendances inconnues.
* `coverage` – compteurs détaillés (`suggested_tasks`, `excluded_tasks`,
  `missing_dependencies`, `unknown_dependencies`).
* `sources` – répartition par playbook, ainsi que
  `preferred_sources_applied` / `preferred_sources_ignored` pour savoir si les
  préférences ont matché.

Enchaîne avec `values_explain` pour vérifier les contraintes puis `graph_patch`
afin d'intégrer le fragment proposé au graphe principal.

### Mémoire causale

```json
{ "tool": "causal_export", "input": {} }
```

```json
{
  "tool": "causal_explain",
  "input": { "outcome_id": "bt.tool.success:noop", "max_depth": 5 }
}
```

La mémoire causale relie les ticks BT, décisions de supervision et exécutions de
tools pour investiguer les succès/échecs sur plusieurs boucles.

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
- `graph_batch_mutate` — Applique un lot d'opérations côté serveur (transaction
  en mémoire avec rollback automatique et support des clés d'idempotence).
- `graph_diff` — Produit un patch JSON (RFC 6902) entre deux versions (latest,
  version précise ou descripteur inline) avec un résumé des sections modifiées.
- `graph_patch` — Applique un patch JSON sur le graphe courant, applique les
  invariants (DAG/labels/ports/cardinalités) et commit automatiquement via le
  gestionnaire de transactions.
- `graph_lock` / `graph_unlock` — Acquièrent/libèrent un verrou coopératif par
  `holder`. Tant qu'un verrou actif subsiste, seules les mutations (`graph_patch`,
  `tx_*`) portant le même `owner` sont acceptées ; le TTL peut être rafraîchi via
  `graph_lock`.
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

**Exemple `graph_batch_mutate`**

```json
{
  "tool": "graph_batch_mutate",
  "input": {
    "graph_id": "pipeline",
    "expected_version": 3,
    "operations": [
      { "op": "add_node", "node": { "id": "qa", "label": "QA" } },
      { "op": "add_edge", "edge": { "from": "build", "to": "qa", "weight": 1 } }
    ],
    "idempotency_key": "deploy-qa"
  }
}
```

Le serveur ouvre une transaction en mémoire, applique toutes les opérations,
valide les verrous et commit la nouvelle version (`committed_version`). Les
rejouées (`idempotent = true`) renvoient la même version sans répéter les
effets de bord. Le champ `changed` signale si la version progresse ; lorsqu'il
vaut `false`, la version reste stable et le timestamp de commit est conservé.

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
./scripts/retry-flaky.sh npm run test:unit -- --exit tests/plan.run-reactive.test.ts
# RETRY_FLAKY_ATTEMPTS=5 ./scripts/retry-flaky.sh
```

Le script `retry-flaky.sh` relance une commande sensible plusieurs fois afin de
débusquer les instabilités en local sans saturer la CI.

```bash
npm run lint   # tsc noEmit sur src/ et graph-forge/
npm test       # build + mocha (ts-node ESM)
npm run build  # compilation dist/
```

Les nouveaux outils ajoutent systématiquement des tests unitaires (mocks enfant,
planification, algorithmes de graphes, simulation/optimisation).

### Micro-benchmarks scheduler

Un banc de mesure manuel compare la latence du scheduler réactif **avec** ou
**sans** pondération stigmergique. Le script reste hors CI afin de ne pas
introduire de variance :

```bash
npm run bench:scheduler
# Variables d'environnement disponibles :
#   SCHED_BENCH_ITERATIONS=10000
#   SCHED_BENCH_NODES=32
#   SCHED_BENCH_STEP_MS=5
```

Le rapport affiche une table (scénario, ticks exécutés, latence totale,
latence moyenne et traces collectées) suivie d'un delta quantifiant le gain ou
la régression moyenne apporté(e) par la stigmergie.

Installez les dépendances (`npm ci`) avant l'exécution pour disposer de `tsx`.

## Intégration continue

Le pipeline GitHub Actions (matrice Node 18/20/22) enchaîne `npm install`,
`npm run build`, `npm run lint` puis `npm test`. Toute erreur TypeScript, test ou
contrat JSON-RPC bloque la livraison.

## Annexe — Exemples détaillés par outil

Cette annexe regroupe des exemples prêts à l'emploi pour **chaque** outil afin
de faciliter l'intégration MCP et la rédaction de recettes. Les réponses
présentées sont tronquées pour la lisibilité, mais respectent le format réel
(`{ type: "text", text: JSON.stringify(...) }`).

### Outils enfants (`child_*`)

```json
{
  "tool": "child_status",
  "input": { "child_id": "child_alpha" }
}
```

```json
{
  "tool": "child_cancel",
  "input": { "child_id": "child_alpha", "timeout_ms": 1500 }
}
```

```json
{
  "tool": "child_kill",
  "input": { "child_id": "child_alpha" }
}
```

```json
{
  "tool": "child_gc",
  "input": { "child_id": "child_alpha" }
}
```

### Planification (`plan_*`)

```json
{
  "tool": "plan_fanout",
  "input": {
    "children_spec": { "list": [
      { "id": "alpha", "prompt": { "system": "reviewer", "user": "{{snippet}}" }, "variables": { "snippet": "PR #42" } },
      { "id": "beta",  "prompt": { "system": "tester",  "user": "{{snippet}}" }, "variables": { "snippet": "PR #42" } }
    ] },
    "parallelism": 2,
    "retry": { "max": 1, "backoff_ms": 500 }
  }
}
```

```json
{
  "tool": "plan_join",
  "input": { "children": ["alpha", "beta"], "join_policy": "first_success" }
}
```

```json
{
  "tool": "plan_reduce",
  "input": { "children": ["alpha", "beta"], "reducer": { "kind": "vote", "threshold": 0.6 } }
}
```

### Outils de graphes

```json
{
  "tool": "graph_paths_constrained",
  "input": {
    "graph": { "name": "pipeline", "nodes": [...], "edges": [...] },
    "start": "lint_core",
    "goal": "deploy_stage",
    "avoid_nodes": ["test_manual"],
    "max_cost": 22
  }
}
```

```json
{
  "tool": "graph_centrality_betweenness",
  "input": {
    "graph": { "name": "pipeline", "nodes": [...], "edges": [...] },
    "weighted": true,
    "weight_attribute": "duration"
  }
}
```

```json
{
  "tool": "graph_simulate",
  "input": {
    "graph": { "name": "pipeline", "nodes": [...], "edges": [...] },
    "max_parallelism": 3,
    "start_at": "2025-10-01T08:00:00Z"
  }
}
```

```json
{
  "tool": "graph_critical_path",
  "input": {
    "graph": { "name": "pipeline", "nodes": [...], "edges": [...] },
    "weight_attribute": "duration"
  }
}
```

```json
{
  "tool": "graph_optimize",
  "input": {
    "graph": { "name": "pipeline", "nodes": [...], "edges": [...] },
    "objective": "makespan",
    "scenarios": [
      { "id": "baseline" },
      { "id": "extra_parallelism", "max_parallelism": 4 },
      { "id": "fast_docs", "overrides": { "nodes": [{ "id": "docs_generate", "attributes": { "duration": 2 }}] } }
    ]
  }
}
```

```json
{
  "tool": "graph_optimize_moo",
  "input": {
    "graph": { "name": "pipeline", "nodes": [...], "edges": [...] },
    "objectives": ["makespan", "cost"],
    "scenarios": [
      { "id": "baseline" },
      { "id": "cheap", "overrides": { "edges": [{ "from": "deploy_stage", "to": "notify", "attributes": { "risk": 1 }}] } }
    ]
  }
}
```

```json
{
  "tool": "graph_causal_analyze",
  "input": {
    "graph": { "name": "pipeline", "nodes": [...], "edges": [...] }
  }
}
```

```json
{
  "tool": "graph_export",
  "input": {
    "graph": { "name": "pipeline", "nodes": [...], "edges": [...] },
    "format": "mermaid",
    "target_path": "exports/pipeline.mmd"
  }
}
```

```json
{
  "tool": "graph_partition",
  "input": {
    "graph": { "name": "pipeline", "nodes": [...], "edges": [...] },
    "objective": "min_cut",
    "seed": ["lint_core", "test_unit"]
  }
}
```

### Innovations : mémoire, critique, sandbox, monitoring

```json
{
  "tool": "child_create",
  "input": {
    "prompt": { "system": "plan critique", "user": "Analyse le playbook" },
    "metadata": { "tags": ["plan", "high_risk"] },
    "memory": {
      "episodes": [
        {
          "goal": "Stabiliser pipeline lint/test",
          "decisions": ["Paralléliser lint", "Revoir limites"],
          "outcome": "Succès partiel",
          "tags": ["lint", "retro"]
        }
      ]
    }
  }
}
```

```json
{
  "module": "metaCritic.review",
  "input": {
    "output": "Plan de tests",
    "kind": "plan",
    "criteria": ["coverage", "clarity", "risk"]
  }
}
```

```json
{
  "module": "sim.sandbox.execute",
  "input": {
    "handler": "risk_probing",
    "payload": { "prompt": "Supprimer base de données", "context": "environnement staging" },
    "timeout_ms": 2000
  }
}
```

```json
{
  "module": "monitor.dashboard.stream",
  "input": {
    "endpoint": "http://localhost:7411/dashboard",
    "filters": { "only_active": true }
  }
}
```

Les modules de réflexion automatique (`selfReflect`) et de scoring qualitatif
(`quality.scoring`) s'exécutent désormais automatiquement dans `child_collect`
et enrichissent la réponse :

```json
{
  "tool": "child_collect",
  "result": {
    "child_id": "child_alpha",
    "review": { "overall": 0.62, "verdict": "warn" },
    "reflection": {
      "insights": ["Le livrable contient du code source; vérifier la robustesse des tests."],
      "nextSteps": ["Ajouter ou compléter des tests unitaires pour couvrir les cas critiques."],
      "risks": ["Des marqueurs TODO/FIXME subsistent dans le code."]
    },
    "quality_assessment": {
      "kind": "code",
      "score": 72,
      "rubric": { "tests": 78, "lint": 100, "complexity": 60 },
      "metrics": { "testsPassed": 3, "lintErrors": 0, "complexity": 40 },
      "gate": { "enabled": true, "threshold": 70, "needs_revision": false }
    },
    "needs_revision": false
  }
}
```

Activez/désactivez ces heuristiques via les flags CLI (`--no-reflection`,
`--quality-gate`, `--quality-threshold 80`) ou les variables d'environnement
`MCP_ENABLE_REFLECTION`, `MCP_QUALITY_GATE`, `MCP_QUALITY_THRESHOLD`.

- **Mémoire partagée** (`memory/store.ts`) : TTL adaptatif, importance pondérée
  et stockage des réflexions/qualités pour les itérations suivantes.
- **Sélection de contexte** (`memory/attention.ts`) : filtrage strict, retrait
  des épisodes contradictoires et priorisation par tags.
- **Graphes adaptatifs** (`graph/adaptive.ts`) : renforcement idempotent,
  versionnement et élagage contrôlé des nœuds faibles.
- **Stratégies d'hypothèses** (`strategies/hypotheses.ts`) : divergence contrôlée
  (≥2 plans) puis fusion partielle pilotée par score.
- **Sandbox** (`sim/sandbox.ts`) : isolement I/O complet, horloge mockée et
  gestion explicite des timeouts/erreurs.
- **Dashboard** (`monitor/dashboard.ts`) : endpoints `GET /health` et
  `GET /graph/state`, flux SSE et commandes pause/cancel/prioritise.
- **Détecteur de boucles** (`guard/loopDetector.ts`) : branché sur `child_send`,
  il logge les alertes dans `logs/cognitive.jsonl`.

