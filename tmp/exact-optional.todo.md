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

- [ ] src/coord/consensus.ts
- [ ] src/coord/stigmergy.ts
- [ ] src/learning/lessons.ts
- [ ] src/reasoning/thoughtCoordinator.ts
- [ ] src/strategies/hypotheses.ts

### Graphes & rewriting

- [ ] src/graph/adaptive.ts
- [ ] src/graph/hierarchy.ts
- [ ] src/graph/hypergraph.ts
- [ ] src/graph/invariants.ts
- [ ] src/graph/patch.ts
- [ ] src/graph/rewrite.ts
- [ ] src/graph/state.ts
- [ ] src/graph/tx.ts
- [ ] src/graph/validate.ts
- [ ] src/tools/graph/query.ts
- [ ] src/tools/graph/snapshot.ts

### Infrastructure & observabilité

- [ ] src/events/bus.ts
- [ ] src/events/cognitive.ts
- [ ] src/infra/budget.ts
- [ ] src/infra/graphWorkerThread.ts
- [ ] src/infra/runtime.ts
- [ ] src/monitor/dashboard.ts
- [ ] src/monitor/replay.ts
- [ ] src/server/toolErrors.ts

### Orchestrateur & enfants

- [x] src/agents/autoscaler.ts
- [ ] src/agents/supervisor.ts
- [ ] src/children/api.ts
- [ ] src/children/supervisionStrategy.ts
- [ ] src/children/supervisor.ts
- [ ] src/gateways/childProcess.ts
- [ ] src/orchestrator/controller.ts
- [ ] src/orchestrator/runtime.ts

### Planification & exécution

- [ ] src/executor/bt/compiler.ts
- [ ] src/executor/bt/interpreter.ts
- [ ] src/executor/bt/nodes.ts
- [ ] src/executor/bt/types.ts
- [ ] src/executor/loop.ts
- [ ] src/executor/planLifecycle.ts
- [ ] src/executor/reactiveScheduler.ts
- [ ] src/planner/domain.ts
- [ ] src/planner/schedule.ts
- [ ] src/tools/planTools.ts

### Registres MCP & conformité

- [ ] src/mcp/deprecations.ts
- [ ] src/mcp/registry.ts

### Runtime enfant & passerelles

- [ ] src/tools/child_orchestrate.ts

### Évaluation & scénarios

- [ ] src/eval/runner.ts
- [ ] src/eval/scenario.ts
