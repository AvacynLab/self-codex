# exactOptionalPropertyTypes — backlog de correction

Diagnostic collecté via `npm run typecheck -- --extendedDiagnostics --pretty false` le 2025-10-21 avec l’option stricte activée.

## Domaines et fichiers à corriger

### Autres

- [x] src/bridge/fsBridge.ts
- [x] src/childRuntime.ts
- [x] src/eventStore.ts
- [x] src/httpServer.ts
- [x] src/logger.ts
- [x] src/sim/sandbox.ts

### Connaissance & mémoire

- [x] src/knowledge/assist.ts
- [x] src/knowledge/knowledgeGraph.ts
- [x] src/memory/kg.ts
- [x] src/memory/retriever.ts
- [x] src/memory/vectorMemory.ts
- [x] src/resources/registry.ts
- [x] src/tools/causalTools.ts
- [x] src/tools/knowledgeTools.ts
- [x] src/tools/memory_upsert.ts

### Coordination & raisonnement

- [x] src/coord/consensus.ts
- [x] src/coord/stigmergy.ts
- [x] src/learning/lessons.ts
- [x] src/reasoning/thoughtCoordinator.ts
- [x] src/strategies/hypotheses.ts

### Graphes & rewriting

- [x] src/graph/adaptive.ts
- [x] src/graph/hierarchy.ts
- [x] src/graph/hypergraph.ts
- [x] src/graph/invariants.ts
- [x] src/graph/patch.ts
- [x] src/graph/rewrite.ts
- [x] src/graph/state.ts
- [x] src/graph/tx.ts
- [x] src/graph/validate.ts
- [x] src/tools/graph/query.ts
- [x] src/tools/graph/snapshot.ts

### Infrastructure & observabilité

- [x] src/events/bus.ts
- [x] src/events/cognitive.ts
- [x] src/infra/budget.ts
- [x] src/infra/graphWorkerThread.ts
- [x] src/infra/runtime.ts
- [x] src/monitor/dashboard.ts
- [x] src/monitor/replay.ts
- [x] src/server/toolErrors.ts

### Orchestrateur & enfants

- [x] src/agents/autoscaler.ts
- [x] src/agents/supervisor.ts
- [x] src/children/api.ts
- [x] src/children/supervisionStrategy.ts
- [x] src/children/supervisor.ts
- [x] src/gateways/childProcess.ts
- [x] src/orchestrator/controller.ts
- [x] src/orchestrator/runtime.ts
  - [x] Normaliser la balise de transport JSON-RPC et le journal scheduler pour éviter les `undefined` (helper `normaliseTransportTag`).
  - [x] Assainir les contextes outils, l'émission autoscaler, les métriques qualité et les options logger pour supprimer les champs `undefined`.
  - [x] Omettre les `weightKey`/`include_*` indéfinis dans Graph Forge et l'agrégateur de transcripts puis couvrir la normalisation via `tests/orchestrator/runtime.optional-contexts.test.ts`.
  - [x] Retirer `sessionId` implicite et filtrer les métadonnées de corrélation JSON-RPC pour éviter les valeurs `undefined` (couverture dédiée dans `tests/orchestrator/runtime.optional-contexts.test.ts`).
  - [x] Nettoyer `child_transcript`/`child_kill` pour purger les options `undefined` avant d'appeler le superviseur enfant.
  - [x] Garantir que `child_collect` publie `jobId: null` plutôt que `undefined` dans les événements cognitifs et couvrir la régression.

### Planification & exécution

- [x] src/executor/bt/compiler.ts
- [x] src/executor/bt/interpreter.ts
- [x] src/executor/bt/nodes.ts
- [x] src/executor/bt/types.ts
- [x] src/executor/loop.ts
- [x] src/executor/planLifecycle.ts
- [x] src/executor/reactiveScheduler.ts
- [x] src/planner/domain.ts
- [x] src/planner/schedule.ts
- [x] src/tools/planTools.ts

### Registres MCP & conformité

- [x] src/mcp/deprecations.ts
- [x] src/mcp/registry.ts

### Runtime enfant & passerelles

- [x] src/tools/child_orchestrate.ts

### Évaluation & scénarios

- [x] src/eval/runner.ts
- [x] src/eval/scenario.ts
