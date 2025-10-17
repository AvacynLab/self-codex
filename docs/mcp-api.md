# MCP API — Référence rapide

Ce document résume les outils MCP déjà exposés par l'orchestrateur et fournit
une vue pseudo-schema des structures attendues/retournées. Les définitions
complètes vivent dans le code (`src/mcp/info.ts`, `src/resources/registry.ts`,
`src/server.ts`) et sont validées par Zod.

> ℹ️ Tous les outils ci-dessous respectent le contrat MCP JSON-RPC
> (`tools/list`, `tools/call`). Les exemples utilisent la méthode
> `tools/call` avec un transport JSON (STDIO ou HTTP).

## Introspection

### Tool `mcp_info`

```ts
// input
const McpInfoInput = z.object({}).strict();

// result (interface simplifiée)
interface McpInfoResult {
  server: {
    name: string;
    version: string;
    mcpVersion: string;
  };
  transports: {
    stdio: { enabled: boolean };
    http: {
      enabled: boolean;
      host: string | null;
      port: number | null;
      path: string | null;
      enableJson: boolean;
      stateless: boolean;
    };
  };
  features: FeatureToggles; // cf. serverOptions.ts
  timings: RuntimeTimingOptions; // cf. serverOptions.ts
  safety: ChildSafetyOptions; // cf. serverOptions.ts
  limits: {
    maxInputBytes: number;
    defaultTimeoutMs: number;
    maxEventHistory: number;
  };
}
```

Le champ `timings.heartbeatIntervalMs` reflète l'intervalle configuré (en
millisecondes) entre deux événements `HEARTBEAT`. Le serveur applique une borne
minimale de `250ms` afin d'éviter qu'une cadence trop agressive ne sature le bus
d'événements.

### Tool `mcp_capabilities`

```ts
// input
const McpCapabilitiesInput = z.object({}).strict();

// result
interface McpCapabilitiesResult {
  namespaces: Array<{
    name: string;
    description: string;
  }>;
  schemas: Record<string, {
    namespace: string;
    summary: string;
  }>;
  limits: {
    maxEventHistory: number;
  };
}
```

Chaque namespace reflète un toggle actif (`enableResources`, `enableBT`,
`enableBlackboard`, etc.). Les clients peuvent ainsi n'activer que les outils
supportés lors de la session.

## Registre de ressources

Les URI `sc://` sont exposées via trois outils complémentaires.

### Tool `resources_list`

```ts
const ResourceListInput = z.object({
  prefix: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
}).strict();

type ResourceKind =
  | "graph"
  | "graph_version"
  | "run_events"
  | "child_logs"
  | "snapshot"
  | "blackboard_namespace"
  | "validation_input"
  | "validation_output"
  | "validation_events"
  | "validation_logs";

interface ResourceListResult {
  items: Array<{
    uri: string;
    kind: ResourceKind;
    metadata?: Record<string, unknown>;
  }>;
}
```

### Tool `resources_read`

```ts
const ResourceReadInput = z.object({ uri: z.string().min(1) }).strict();

type ResourcePayload =
  | { graphId: string; version: number; committedAt: number | null; graph: NormalisedGraph }
  | { graphId: string; txId: string; baseVersion: number; startedAt: number; state: string; committedAt: number | null; finalVersion: number | null; baseGraph: NormalisedGraph; finalGraph: NormalisedGraph | null }
  | { runId: string; events: ResourceRunEvent[]; jsonl: string }
  | { childId: string; logs: ResourceChildLogEntry[] }
  | { namespace: string; entries: BlackboardEntrySnapshot[] }
  | { sessionId: string; runId: string | null; phase: string | null; artifactType: "input" | "output" | "events" | "logs"; name: string; recordedAt: number; mime: string; data: unknown; metadata?: Record<string, unknown> };

interface ResourceReadResult {
  uri: string;
  kind: ResourceKind;
  payload: ResourcePayload;
}
```

`NormalisedGraph`, `ResourceRunEvent`, `ResourceChildLogEntry` et
`BlackboardEntrySnapshot` sont définis dans `src/graph/types.ts`,
`src/resources/registry.ts` et `src/coord/blackboard.ts`.

```ts
interface ResourceRunEvent {
  seq: number;
  ts: number;
  kind: string;
  level: string;
  jobId: string | null;
  runId: string;        // toujours renseigné (identique au seau MCP)
  opId: string | null;  // identifiant d'opération (plan, valeur, fanout...)
  graphId: string | null;
  nodeId: string | null;
  childId: string | null;
  payload: unknown;
}

interface ResourceChildLogEntry {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr" | "meta";
  message: string;
  jobId: string | null;
  runId: string | null;
  opId: string | null;
  graphId: string | null;
  nodeId: string | null;
  childId: string;
  raw: string | null;
  parsed: unknown;
}
```

### Tool `resources_watch`

```ts
const ResourceWatchInput = z.object({
  uri: z.string().min(1),
  from_seq: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(500).optional(),
  format: z.enum(["json", "sse"]).optional(),
}).strict();

interface ResourceWatchResult {
  uri: string;
  kind: ResourceKind;
  events: Array<ResourceRunEvent | ResourceChildLogEntry>;
  next_seq: number; // pointeur pour l'appel suivant
  format?: "json" | "sse";
  messages?: ResourceWatchSseMessage[]; // présent quand format === "sse"
  stream?: string; // concaténation SSE prête à l'emploi
}
```

Les événements sont ordonnés (seq croissant) et incluent les hints de
corrélation (`jobId`, `runId`, `opId`, `graphId`, `nodeId`, `childId`). Pour un
flux complet, bouclez tant que `events.length > 0` en rappelant
`resources_watch` avec `from_seq = next_seq`.

> ℹ️ En passant `format = "sse"`, la réponse inclut `messages` (`id`, `event`,
> `data`) et `stream` prêts à l'emploi. Les payloads sont encodés via
> `serialiseForSse` afin de neutraliser `\r`, `\n`, `U+2028`, `U+2029` tout en
> conservant la possibilité de décoder avec `JSON.parse`.

## Observabilité

### Tool `logs_tail`

```ts
const LogsTailInput = z
  .object({
    stream: z.enum(["server", "run", "child"]).default("server"),
    id: z.string().trim().min(1).optional(),
    from_seq: z.number().int().min(0).optional(),
    limit: z.number().int().positive().max(500).optional(),
    levels: z.array(z.string().trim().min(1)).max(4).optional(),
    filters: z
      .object({
        run_ids: z.array(z.string().trim().min(1)).max(10).optional(),
        job_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    op_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    graph_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    node_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    child_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    message_contains: z.array(z.string().trim().min(1)).max(5).optional(),
    since_ts: z.number().int().min(0).optional(),
    until_ts: z.number().int().min(0).optional(),
  })
  .strict()
  .optional(),
  })
  .strict();

interface LogsTailResult {
  stream: "server" | "run" | "child";
  bucket_id: string; // "orchestrator" par défaut pour le flux serveur
  entries: Array<{
    seq: number;
    ts: number;
    stream: "server" | "run" | "child";
    bucket_id: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    data: unknown;
    job_id: string | null;
    run_id: string | null;
    op_id: string | null;
    graph_id: string | null;
    node_id: string | null;
    child_id: string | null;
  }>;
  next_seq: number;
  levels: string[] | null; // niveaux normalisés (lowercase, dédupliqués)
  filters:
    | {
        run_ids: string[] | null;
        job_ids: string[] | null;
        op_ids: string[] | null;
        graph_ids: string[] | null;
        node_ids: string[] | null;
        child_ids: string[] | null;
        message_contains: string[] | null;
        since_ts: number | null;
        until_ts: number | null;
      }
    | null;
}
```

* `stream` sélectionne le seau logique (`server` agrège l'orchestrateur).
* `id` est requis pour `run` et `child` (identifiant du run/enfant ciblé).
* `levels` accepte jusqu'à quatre sévérités, sans distinction de casse. Les
  doublons sont éliminés avant comparaison et reflétés normalisés en sortie.
* `filters` autorise des filtres croisés (`run_ids`, `job_ids`, etc.) ainsi que
  une recherche plein texte simple (`message_contains`) et une fenêtre
  temporelle inclusive (`since_ts`, `until_ts`). Un filtre vide est rejeté
  (`empty_filters`).

Pour paginer, rappelez l'outil avec `from_seq = next_seq`. Les entrées sont
retournées ordonnées (seq croissant) et déjà normalisées côté serveur afin que
le client puisse directement sérialiser ou afficher les journaux sans post-traitement.

## Contrôles fins du runtime enfant

Lorsque `enableChildOpsFine` est actif, quatre outils MCP complètent `child_create`
pour gérer la vie d'un runtime existant. Ils partagent les mêmes hints de
correlation (`run_id`, `op_id`, `job_id`, `graph_id`, `node_id`, `child_id`) que
les autres outils plan/valeur et mettent à jour immédiatement le registre
(`sc://children/<id>/logs`) ainsi que le bus d'événements.

```ts
const ChildSpawnCodexInput = z
  .object({
    child_id: z.string().min(1),
    manifest_path: z.string().min(1).default("codex.json"),
    role: z.string().min(1).optional(),
    limits: ChildLimitsInput.optional(),
    run_id: z.string().min(1).optional(),
    op_id: z.string().min(1).optional(),
    job_id: z.string().min(1).optional(),
    graph_id: z.string().min(1).optional(),
    node_id: z.string().min(1).optional(),
    child_id_hint: z.string().min(1).optional(),
  })
  .strict();

const ChildAttachInput = z
  .object({ child_id: z.string().min(1), run_id: z.string().min(1).optional(), op_id: z.string().min(1).optional() })
  .strict();

const ChildSetRoleInput = z
  .object({ child_id: z.string().min(1), role: z.string().min(1), run_id: z.string().min(1).optional(), op_id: z.string().min(1).optional() })
  .strict();

const ChildSetLimitsInput = z
  .object({ child_id: z.string().min(1), limits: ChildLimitsInput, run_id: z.string().min(1).optional(), op_id: z.string().min(1).optional() })
  .strict();
```

`ChildLimitsInput` reprend la structure utilisée par `child_create`
(`messages`, `wallclock_ms`, `cpu_percent`, etc.). Chaque réponse renvoie un
manifeste synchronisé avec `role`, `limits`, `attached_at` et les corrélations
actuelles afin que les clients puissent enchaîner des opérations idempotentes.

## Activation des modules MCP

Les flags suivants contrôlent l'exposition des outils facultatifs :

| Flag CLI | Toggle associé | Description |
| --- | --- | --- |
| `--enable-resources` | `enableResources` | Active le registre `sc://`. |
| `--enable-mcp-introspection` | `enableMcpIntrospection` | Force l'exposition des outils `mcp_*` (activé par défaut). |
| `--enable-events-bus` | `enableEventsBus` | Prépare l'exposition du bus d'événements unifié (outil à venir). |
| `--enable-cancellation` | `enableCancellation` | Active l'API d'annulation uniforme (en cours d'implémentation). |
| `--enable-tx` | `enableTx` | Expose la gestion de transactions graphe (à venir). |
| `--enable-bulk` | `enableBulk` | Active les opérations atomiques en lot (à venir). |
| `--enable-idempotency` | `enableIdempotency` | Active le cache idempotent (`child_create`, `child_spawn_codex`, `plan_run_bt`, `plan_run_reactive`, `cnp_announce`, `tx_begin`). |
| `--enable-locks` | `enableLocks` | Active `graph_lock`/`graph_unlock` pour protéger les mutations. |
| `--enable-diff-patch` | `enableDiffPatch` | Expose `graph_diff`/`graph_patch` (diff JSON + application). |
| `--enable-plan-lifecycle` | `enablePlanLifecycle` | Contrôle plan_pause/plan_resume (à venir). |
| `--enable-child-ops-fine` | `enableChildOpsFine` | Active les outils de réglage fin des enfants (à venir). |
| `--enable-values-explain` | `enableValuesExplain` | Publie `values_explain` (à venir). |
| `--enable-rag` | `enableRag` | Expose `rag_ingest` / `rag_query` et les fallbacks RAG du knowledge assistant. |
| `--enable-tool-router` | `enableToolRouter` | Active la façade `intent_route` et le suivi des décisions du routeur. |
| `--enable-thought-graph` | `enableThoughtGraph` | Sérialise les branches multi-voies dans le ThoughtGraph. |
| `--enable-assist` | `enableAssist` | Active `kg_suggest_plan` (fragments issus du graphe de connaissances). |

Les modules marqués « à venir » seront ajoutés progressivement : cette référence
sera enrichie au fur et à mesure (bus d'événements, cancellations uniformes,
transactions, diff/patch, etc.).

### Idempotence des outils

Lorsque `enableIdempotency` est actif, plusieurs outils acceptent un champ
optionnel `idempotency_key` afin de rejouer exactement la même réponse si la
requête est répétée :

* `child_create`
* `child_spawn_codex`
* `plan_run_bt`
* `plan_run_reactive`
* `cnp_announce`
* `tx_begin`

Chaque réponse inclut `idempotent` (booléen) et `idempotency_key` pour signaler
si le résultat provient du cache. Les journaux serveur émettent également un
évènement `*_replayed` lorsqu'une réponse est renvoyée sans ré-exécuter la
mutation.

### Blackboard & opérations bulk

```ts
const BbBatchSetInput = z
  .object({
    entries: z
      .array(
        z
          .object({
            key: z.string().min(1),
            value: z.unknown(),
            tags: z.array(z.string().min(1)).max(16).default([]),
            ttl_ms: z.number().int().min(1).max(86_400_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

interface BbBatchSetResult {
  entries: SerializedBlackboardEntry[];
}
```

* `bb_set` et `bb_batch_set` appliquent les mutations de manière atomique.
  `bb_batch_set` rejette la totalité du lot si l'un des éléments ne peut pas être
  cloné (valeur non sérialisable, par exemple une fonction).
* `bb_get`, `bb_query` et `bb_watch` s'appuient sur le même registre et exposent
  les versions séquentielles (`version`, `created_at`, `updated_at`, `expires_at`).

```ts
const StigBatchInput = z
  .object({
    entries: z
      .array(
        z
          .object({
            node_id: z.string().min(1),
            type: z.string().min(1),
            intensity: z.number().positive().max(10_000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

interface StigBatchResult {
  changes: Array<{
    point: { node_id: string; type: string; intensity: number; updated_at: number };
    node_total: { node_id: string; intensity: number; updated_at: number };
  }>;
}
```

* `stig_batch` applique plusieurs dépôts de phéromones d'un seul tenant. Une
  erreur (type vide, intensité non positive, etc.) restaure le champ et annule
  l'ensemble du lot. Les événements ne sont émis qu'après validation complète.
* `stig_mark`, `stig_decay` et `stig_snapshot` partagent les mêmes structures
  sérialisées (`point`, `node_total`). `stig_snapshot` ajoute également
  `pheromone_bounds` (bornes normalisées min/max/plafond), un bloc `summary`
  contenant des `rows` déjà formatées (`Min/Max/Ceiling`) et `heatmap.bounds_tooltip`
  pour alimenter directement les dashboards/autoscalers.

### Graphe de connaissances (`kg_*`)

Le registre de connaissances accepte des triplets via `kg_insert`, peut être
interrogé avec `kg_query` et exporté entièrement avec `kg_export`. Lorsque le
flag `--enable-assist` est actif, l'outil `kg_suggest_plan` synthétise des
fragments hiérarchiques prêts à être injectés dans les workflows de
planification. `kg_export` accepte désormais `format: "rag_documents"` pour
générer des passages directement ingérables par `rag_ingest` avec support des
filtres `min_confidence`, `include_predicates` et `max_triples_per_subject`.

```ts
const KgSuggestPlanInput = z
  .object({
    goal: z.string().min(1),
    context: z
      .object({
        preferred_sources: z.array(z.string().min(1).max(120)).max(16).optional(),
        exclude_tasks: z.array(z.string().min(1).max(120)).max(256).optional(),
        max_fragments: z.number().int().min(1).max(5).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

interface KgSuggestPlanResult {
  goal: string;
  fragments: HierGraph[]; // nodes avec kg_goal, kg_source, kg_seed, kg_group
  rationale: string[];
  coverage: {
    total_tasks: number;
    suggested_tasks: string[];
    excluded_tasks: string[];
    missing_dependencies: Array<{ task: string; dependencies: string[] }>;
    unknown_dependencies: Array<{ task: string; dependencies: string[] }>;
  };
  sources: Array<{ source: string; tasks: number }>;
  preferred_sources_applied: string[];
  preferred_sources_ignored: string[];
}
```

Les fragments sont des `HierGraph` standards : chaque nœud encode `kg_goal`
(identifiant du plan), `kg_source` (provenance), `kg_seed` (tâche cœur ou
dépendance), `kg_group` (groupe de suggestion) ainsi que `kg_confidence`,
`kg_duration`/`kg_weight` lorsque ces métadonnées sont présentes dans les
triplets. Les arêtes portent `label = "depends_on"` et `attributes.kg_dependency = true`.

* `preferred_sources` permet de prioriser certains playbooks (ordre conservé,
  sensible à la casse uniquement pour l'affichage).
* `exclude_tasks` filtre des identifiants spécifiques ; les dépendances
  manquantes apparaissent dans `coverage.missing_dependencies`.
* `max_fragments` limite le nombre de suggestions retournées (de 1 à 5).
* `rationale` détaille la couverture (`Plan '...' : X/Y tâches`), les exclusions
  et la présence éventuelle de dépendances inconnues.

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

La réponse inclut `fragments` (hiérarchie prête à compiler), `rationale`, les
compteurs `coverage` ainsi qu'un résumé des sources utilisées. Combine ce
résultat avec `values_explain` et `graph_patch` pour proposer des correctifs
guidés par le graphe de connaissances.

#### Contract-Net (`cnp_announce`)

* La réponse inclut `auto_bid_enabled` pour signaler si des enchères heuristiques
  sont gérées automatiquement. Lorsque c'est le cas, les enchères heuristiques
  exposent `metadata.reason` (`auto` lors de l'annonce, `auto_refresh` après une
  mise à jour) ainsi que `metadata.pheromone_pressure`, le facteur appliqué à la
  pénalité `busy_penalty`.
* Utilise `ContractNetCoordinator.updateCallPheromoneBounds(callId, bounds, options)`
  pour synchroniser un appel ouvert avec de nouvelles limites stigmergiques. La
  méthode réémet les enchères heuristiques (sauf si `refreshAutoBids` est désactivé)
  tout en conservant les offres manuelles.
* L'outil MCP `cnp_refresh_bounds` réalise cette opération côté serveur. Il accepte
  un `call_id`, des bornes optionnelles (par défaut les limites du champ
  stigmergique) et des flags `refresh_auto_bids` / `include_new_agents`. La
  réponse indique les agents rafraîchis, si les enchères heuristiques ont été
  rejouées (`auto_bid_refreshed`) et rappelle les options utilisées.
* L'outil MCP `cnp_watcher_telemetry` expose les compteurs du watcher automatique
  (`received_updates`, `coalesced_updates`, `skipped_refreshes`, `flushes`,
  `applied_refreshes`). Il retourne également `emissions`, `last_emitted_at_ms`
  (et son ISO associé) ainsi que `last_snapshot.last_bounds` pour diagnostiquer
  la pression stigmergique appliquée lors des derniers rafraîchissements.
* Chaque émission du watcher est aussi publiée sur le bus d'événements via
  `cat: "contract_net"` et `msg: "cnp_watcher_telemetry"` ; les clients
  `events_subscribe` peuvent ainsi corréler ces compteurs en temps réel sans
  devoir sonder `/metrics`. Le format `format: "sse"` de `events_subscribe`
  échappe les retours chariot, sauts de ligne et séparateurs Unicode afin que
  chaque bloc `data:` reste monoligne tout en conservant les raisons
  multi-lignes après `JSON.parse`. Le champ `event:` de la trame SSE reprend la
  valeur `kind` en majuscules exposée dans la version JSON Lines, garantissant
  que les consommateurs temps réel observent des identifiants cohérents.
* Les événements `SCHEDULER` publient `event_type`, `msg`, `pending_before`,
  `pending`, `pending_after`, `base_priority`, `duration_ms`, `batch_index`,
  `ticks_in_batch`, `sequence`, `priority` (pour les ticks) ainsi que la
  projection normalisée de l'événement sous-jacent (`event_payload`). Le champ
  `msg` vaut toujours `scheduler_event_enqueued` ou `scheduler_tick_result`
  afin de permettre aux clients SSE/JSON Lines de filtrer sans décoder la
  charge utile complète. Les champs de corrélation `run_id`, `op_id`, `job_id`,
  `graph_id`, `node_id` et `child_id` sont toujours présents pour lier la
  télémétrie scheduler aux runs réactifs et aux superviseurs.
  Les profondeurs de file pré/post-enqueue sont directement exposées par le
  planificateur afin d'éviter tout calcul implicite côté consommateurs.
* Les charges JSON Lines et SSE sont strictement alignées champ par champ ; un
  écart détecté par un client doit être considéré comme un bug et signalé.

```ts
const GraphBatchMutateInput = z
  .object({
    graph_id: z.string().min(1),
    operations: GraphMutateInputSchema.shape.operations,
    expected_version: z.number().int().nonnegative().optional(),
    owner: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().min(1).max(240).optional(),
    idempotency_key: z.string().min(1).optional(),
  })
  .strict();

interface GraphBatchMutateResult {
  graph_id: string;
  base_version: number;
  committed_version: number;
  committed_at: number;
  changed: boolean;
  operations_applied: number;
  applied: GraphMutationRecord[];
  graph: NormalisedGraph;
  owner: string | null;
  note: string | null;
  idempotent: boolean;
  idempotency_key: string | null;
}
```

* `graph_batch_mutate` rejoue les mêmes opérations que `graph_mutate` mais dans
  une transaction éphémère : soit toutes les mutations sont commit, soit le
  graphe est restauré. Le champ `expected_version` protège contre les conflits,
  tandis que `owner`/`note` assurent la traçabilité dans le registre
  `sc://snapshots/...`. En cas de clé d'idempotence, la réponse est rejouée sans
  réappliquer les opérations.
* Le champ `changed` indique si la version a effectivement progressé. Lorsque
  toutes les opérations sont des no-op (`changed = false`), la version reste
  inchangée et `committed_at` conserve le timestamp précédent.

```ts
const ChildBatchCreateInput = z
  .object({
    entries: z.array(ChildSpawnCodexInputSchema).min(1).max(16),
  })
  .strict();

interface ChildBatchCreateResult {
  children: ChildSpawnCodexResult[];
  created: number; // enfants réellement démarrés (hors replays idempotents)
  idempotent_entries: number;
}
```

* `child_batch_create` enchaîne plusieurs `child_spawn_codex` avec rollback : en
  cas d'échec, chaque runtime précédemment démarré est stoppé puis collecté.
  `created` compte uniquement les nouveaux enfants démarrés, tandis que
  `idempotent_entries` recense ceux qui proviennent du cache. Les entrées
  réutilisent exactement le schéma de `child_spawn_codex` (clés d'idempotence
  incluses).

### `graph_diff` & `graph_patch`

* `graph_diff({ graph_id, from, to })` accepte trois types de sélecteurs :
  * `{ latest: true }` — version actuellement commitée.
  * `{ version: <int> }` — version historique enregistrée dans le registre.
  * `{ graph: <descriptor> }` — descripteur inline (même schéma que `graph_mutate`).
  La réponse expose un patch RFC 6902 ainsi qu'un résumé `name|metadata|nodes|edges`.
* `graph_patch({ graph_id, patch, base_version?, enforce_invariants?, owner? })`
  applique le patch produit par `graph_diff`, vérifie les invariants (DAG,
  labels, ports, cardinalités) et commit automatiquement via le
  `GraphTransactionManager`. `base_version` protège contre les conflits
  optimistes et `enforce_invariants` reste activé par défaut. Lorsque
  `graph_lock` est actif, fournissez le même `owner` que celui ayant acquis le
  verrou, sinon l'opération sera rejetée (`E-GRAPH-MUTATION-LOCKED`).

Les deux outils publient leurs snapshots dans le registre `sc://graphs/<id>@vX`
et mettent à jour les métadonnées de transaction (`snapshots/`).

### `graph_lock` & `graph_unlock`

* `graph_lock({ graph_id, holder, ttl_ms? })` acquiert un verrou coopératif sur
  un graphe et retourne `{ lock_id, acquired_at, refreshed_at, expires_at }`.
  Appeler à nouveau avec le même `holder` rafraîchit le TTL et réutilise le même
  `lock_id`. Un verrou actif empêche tout autre `holder` de lancer `graph_patch`
  ou une transaction (`tx_*`).
* `graph_unlock({ lock_id })` libère le verrou. Si le TTL est déjà expiré, la
  réponse signale `expired: true` mais nettoie l'entrée côté serveur.

## Exemples JSON-RPC

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "resources_watch",
    "arguments": {
      "uri": "sc://runs/run_123/events",
      "from_seq": 0,
      "limit": 100
    }
  }
}
```

Utilisez la méthode `tools/list` pour vérifier la présence d'un outil avant de
l'appeler :

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

La réponse contiendra `mcp_info`, `mcp_capabilities` et les `resources_*` si les
flags correspondants sont actifs.
