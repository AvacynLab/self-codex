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
  | "blackboard_namespace";

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
  | { runId: string; events: ResourceRunEvent[] }
  | { childId: string; logs: ResourceChildLogEntry[] }
  | { namespace: string; entries: BlackboardEntrySnapshot[] };

interface ResourceReadResult {
  uri: string;
  kind: ResourceKind;
  payload: ResourcePayload;
}
```

`NormalisedGraph`, `ResourceRunEvent`, `ResourceChildLogEntry` et
`BlackboardEntrySnapshot` sont définis dans `src/graph/types.ts`,
`src/resources/registry.ts` et `src/coord/blackboard.ts`.

### Tool `resources_watch`

```ts
const ResourceWatchInput = z.object({
  uri: z.string().min(1),
  from_seq: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(500).optional(),
}).strict();

interface ResourceWatchResult {
  uri: string;
  kind: ResourceKind;
  events: Array<ResourceRunEvent | ResourceChildLogEntry>;
  next_seq: number; // pointeur pour l'appel suivant
}
```

Les événements sont ordonnés (seq croissant). Pour un flux complet, bouclez tant
que `events.length > 0` en rappelant `resources_watch` avec `from_seq = next_seq`.

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
| `--enable-idempotency` | `enableIdempotency` | Permet la ré-exécution avec `idempotencyKey` (à venir). |
| `--enable-locks` | `enableLocks` | Active les verrous de graphe (à venir). |
| `--enable-diff-patch` | `enableDiffPatch` | Expose `graph_diff`/`graph_patch` (à venir). |
| `--enable-plan-lifecycle` | `enablePlanLifecycle` | Contrôle plan_pause/plan_resume (à venir). |
| `--enable-child-ops-fine` | `enableChildOpsFine` | Active les outils de réglage fin des enfants (à venir). |
| `--enable-values-explain` | `enableValuesExplain` | Publie `values_explain` (à venir). |
| `--enable-assist` | `enableAssist` | Débloque `kg_suggest_plan` et assistance causale (à venir). |

Les modules marqués « à venir » seront ajoutés progressivement : cette référence
sera enrichie au fur et à mesure (bus d'événements, cancellations uniformes,
transactions, diff/patch, etc.).

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
