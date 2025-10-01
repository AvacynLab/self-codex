----------  
Voici ta **liste de tâches à cocher** (adressée directement à toi, l’agent) pour intégrer — finement et intelligemment — les innovations de mes deux dernières recherches dans la **version actuelle** du dépôt.
Elle précise **objectifs**, **correctifs attendus**, **fichiers à créer/modifier**, **sous-étapes** (avec sous-sous-étapes), ainsi que ce qu’il faut **respecter pour les tests et le build**.
Contexte inchangé : TypeScript/Node ESM, exécution locale, une instance Codex par enfant, pas d’auth, CI Node 18/20/22.

---

## BRIEF (lis-moi d’abord)

**Objectif général**
Élever la puissance d’**utilisation/implémentation** des graphes et du système multi-agent, sans dépendre d’infra externe :

* Graphes **hiérarchiques/adaptatifs** (sous-graphes, hyper-arêtes ciblées, réécriture transactionnelle).
* Exécution **réactive/itérative** (interpréteur Behavior Tree + scheduler réactif à événements).
* **Coordination** avancée (blackboard, stigmergie, Contract-Net, consensus) et **auto-organisation** (autoscaling d’enfants, superviseur “global workspace”).
* **Mémoire structurée** d’implémentation (graphe de connaissance interne + mémoire causale d’événements) pour *réutiliser* et *reconfigurer* les plans en direct.
* **Filtrage par valeurs** (graphe de valeurs → garde-fous éthiques/fonctionnels).
* Intégration serveur (nouvelles tools MCP) + visualisations temps réel.

**Correctifs attendus**

* Zod pour *toute* nouvelle tool, erreurs codifiées, timeouts contrôlés.
* Aucune écriture dans le repo, uniquement `children/<id>/` et répertoires de run.
* Tests **offline** déterministes (fake timers), CI **verte** 18/20/22.
* Feature flags *off* par défaut, activables via `serverOptions`.

**Critères d’acceptation**

* Plans hiérarchiques exécutables, réécriture sûre (snapshot/rollback).
* Moteur BT fonctionnel (Sequence/Selector/Parallel/Decorator) + scheduler réactif.
* Blackboard, stigmergie, contract-net et consensus **opérationnels** + tests.
* Autoscaler et Superviseur débloquent les impasses sans fuite de processus.
* Mémoire (KG + causal) branchée à la planification, exportable.
* Graphe de valeurs filtrant réellement les plans.
* Dashboard : heatmaps stigmergiques + statut BT en temps réel.

---

## RÈGLES BUILD/TEST (à respecter partout)

* **Install**

  * Si lockfile : `npm ci`
  * Sinon : `npm install --omit=dev --no-save --no-package-lock`
* **Build** : `npm run build` (racine + `graph-forge`)
* **Lint** : `npm run lint` (double `tsc --noEmit`)
* **Tests** : `npm test` offline, déterministes (use `sinon.useFakeTimers()`), seeds fixées
* **Zod** : messages `code`/`message`/`hint` courts, stables
* **FS** : pas de `..`, chemins normalisés (utilise `src/paths.ts`)
* **Logs** : JSONL compact + rotation, pas de blobs lourds en CI

---

## A) Graphes : expressivité, hiérarchie, réécriture, transactions

### A1. Sous-graphes hiérarchiques (plans imbriqués)

* [x] **Créer** `src/graph/hierarchy.ts`

  * [x] Types :

    * `HierNode = TaskNode | SubgraphNode`
    * `SubgraphNode = { id, kind:"subgraph", ref:string, params?:Record<string,any> }`
    * `HierGraph = { id, nodes:HierNode[], edges:Edge[] }`
  * [x] API : `embedSubgraph(parent:HierGraph, nodeId, sub:HierGraph)`, `flatten(h:HierGraph): Graph` (expansion contrôlée)
  * [x] **Validation** (no cycles inter-niveaux, ports d’entrée/sortie nommés)
* [ ] **Modifier** `src/server.ts`

  * [ ] Étendre `graph_generate`/`graph_mutate` pour `kind:"subgraph"`
  * [ ] Nouvelle tool `graph_subgraph_extract` (extrait un sous-plan en fichier JSON, versionné dans run dir)
* [x] **Tests**

  * [x] `tests/graph.hierarchy.generate-embed.test.ts` (embed + validate)
  * [x] `tests/graph.hierarchy.flatten.test.ts` (flatten = graphe équivalent, topologie conservée)

### A2. Hyper-arêtes minimales (relations n-aires ciblées)

* [x] **Créer** `src/graph/hypergraph.ts`

  * [x] `HyperEdge = { id, sources:string[], targets:string[], label?, weight? }`
  * [x] Projection automatique → arêtes binaires (pour algos existants) avec métadonnées
* [x] **Modifier** `graph_export` (Mermaid/DOT) pour indiquer hyper-arêtes (annotation)
* [x] **Tests**

  * [x] `tests/graph.hyper.project.test.ts` (projection correcte)
  * [x] `tests/graph.export.hyper.test.ts` (export annoté lisible)

### A3. Moteur de réécriture & adaptativité contrôlée

* [x] **Créer** `src/graph/rewrite.ts`

  * [x] `Rule = { name, match:(g)=>MatchSet, apply:(g, m)=>g’ }`
  * [x] Banque de règles : *split-parallel*, *inline-subgraph*, *reroute-avoid(node/label)*
  * [x] Combinator : `applyAll(g, rules, stopOnNoChange=true)`
* [x] **Relier** à `src/graph/adaptive.ts` (renforcement/élagage déclenchent règles)
* [x] **Tests**

  * [x] `tests/graph.rewrite.rules.test.ts` (idempotence, pas de cycles induits)
  * [x] `tests/graph.adaptive.rewrite.test.ts` (réécriture pilotée par score)

### A4. Transactions & versions

* [x] **Créer** `src/graph/tx.ts`

  * [x] Snapshot/rollback : `begin(g)->txId`, `commit(txId)`, `rollback(txId)`
  * [x] Numéro de **version** incrémental + horodatage
* [ ] **Intégrer** à *toutes* mutations serveur (wrap `graph_mutate`, `graph_rewrite_apply`)
  * [x] Wrap `graph_mutate`
  * [ ] Wrap `graph_rewrite_apply`
* [ ] **Tests**

  * [x] `tests/graph.tx.snapshot-rollback.test.ts`
  * [x] `tests/graph.tx.concurrency.test.ts` (refus MAJ si version diverge)

---

## B) Exécution **réactive** et **itérative**

### B1. Interpréteur Behavior Tree (BT)

* [ ] **Créer** `src/executor/bt/types.ts` (Status: `SUCCESS|FAILURE|RUNNING`)
* [ ] **Créer** `src/executor/bt/nodes.ts`

  * [ ] Composites : `Sequence`, `Selector`, `Parallel(policy:all/any)`
  * [ ] Décorateurs : `Retry(n, backoff)`, `Timeout(ms)`, `Guard(cond)`
  * [ ] Feuilles : `TaskLeaf(toolName, inputSchema)` → appelle tools existants (child_send, graph_*…)
* [ ] **Créer** `src/executor/bt/interpreter.ts` (tick async, persistance état nœuds)
* [ ] **Créer** `src/executor/bt/compiler.ts` (compile `HierGraph` → BT selon patrons)
* [ ] **Modifier** `src/server.ts`

  * [ ] Nouvelle tool `plan_compile_bt` (retourne JSON BT)
  * [ ] Nouvelle tool `plan_run_bt` (lance interpréteur + expose events)
* [ ] **Tests**

  * [ ] `tests/bt.nodes.sequence-selector.test.ts`
  * [ ] `tests/bt.decorators.retry-timeout.test.ts` (fake timers)
  * [ ] `tests/bt.compiler.from-hiergraph.test.ts`
  * [ ] `tests/bt.run.integration.test.ts` (BT → outils réels mockés)

### B2. Scheduler réactif & bus d’événements

* [ ] **Créer** `src/executor/reactiveScheduler.ts`

  * [ ] EventBus (Node `EventEmitter`) : `taskReady`, `taskDone`, `blackboardChanged`, `stigmergyChanged`
  * [ ] Politique : priorité dynamique (âge, criticité, phéromones)
* [ ] **Relier** BT → Scheduler (ticks pilotés par événements)
* [ ] **Tests**

  * [ ] `tests/executor.scheduler.reactivity.test.ts` (réaction immédiate aux events)
  * [ ] `tests/executor.scheduler.prio.test.ts` (priorités évolutives)

### B3. Boucle de *ticks* & budgets

* [ ] **Créer** `src/executor/loop.ts`

  * [ ] Tick cadencé (`setInterval`) + `pause/resume/stop`
  * [ ] Budgets : tâches longues → coopérative (yield)
* [ ] **Tests**

  * [ ] `tests/executor.loop.timing.test.ts` (fake timers, no drift)
  * [ ] `tests/executor.loop.budget.test.ts`

---

## C) Coordination & communication (blackboard, stigmergie, contrat, consensus)

### C1. **Blackboard** (tableau noir)

* [ ] **Créer** `src/coord/blackboard.ts`

  * [ ] KV typé + tags + TTL + watch (events)
  * [ ] Snapshots (pour débogage, export)
* [ ] **Modifier** `src/server.ts`

  * [ ] Tools : `bb_set`, `bb_get`, `bb_query`, `bb_watch(startFromVersion)` (stream)
* [ ] **Tests**

  * [ ] `tests/coord.blackboard.kv.test.ts`
  * [ ] `tests/coord.blackboard.watch.test.ts` (dédup + ordre)

### C2. **Stigmergie** (phéromones)

* [ ] **Créer** `src/coord/stigmergy.ts`

  * [ ] API : `mark(nodeId, type, intensity)`, `evaporate(halfLifeMs)`, `fieldSnapshot()`
* [ ] **Modifier** scheduler pour pondérer sélection de tâches par champ de phéromones
* [ ] **Server tools** : `stig_mark`, `stig_decay`, `stig_snapshot`
* [ ] **Tests**

  * [ ] `tests/coord.stigmergy.field.test.ts` (accumulation/évaporation)
  * [ ] `tests/coord.stigmergy.scheduler.test.ts` (impact mesurable sur choix)

### C3. **Contract-Net Protocol**

* [ ] **Créer** `src/coord/contractNet.ts`

  * [ ] Messages : `announce(task)`, `bid(agentId,cost)`, `award(agentId)`
  * [ ] Stratégie d’attribution (min cost, heuristique)
* [ ] **Intégrer** à `child_create`/`child_send` (routeur de tâches via CNP si activé)
* [ ] **Server tool** : `cnp_announce` (expérimental)
* [ ] **Tests**

  * [ ] `tests/coord.contractnet.basic.test.ts`
  * [ ] `tests/coord.contractnet.tie-breaker.test.ts`

### C4. **Consensus / Vote**

* [ ] **Créer** `src/coord/consensus.ts`

  * [ ] `majority`, `quorum(k)`, `weighted(weights)`
* [ ] **Relier** à `plan_join` / `plan_reduce` (mode `vote`)
* [ ] **Tests**

  * [ ] `tests/coord.consensus.modes.test.ts`
  * [ ] `tests/plan.join.vote.integration.test.ts`

---

## D) Auto-organisation & robustesse (autoscaler, superviseur, sécurité)

### D1. **Autoscaler d’enfants**

* [ ] **Créer** `src/agents/autoscaler.ts`

  * [ ] Metrics : backlog scheduler, latence, taux d’échec
  * [ ] Politique : spawn/retire avec bornes et *cooldown*
* [ ] **Intégrer** au loop (tick → `reconcile()`)
* [ ] **Server tool** : `agent_autoscale_set({min,max,cooldown})`
* [ ] **Tests**

  * [ ] `tests/agents.autoscaler.scale-updown.test.ts` (sans fuite de process)
  * [ ] `tests/agents.autoscaler.cooldown.test.ts`

### D2. **Superviseur (Global Workspace)**

* [ ] **Créer** `src/agents/supervisor.ts`

  * [ ] Détecte stagnation (aucun progrès N ticks), deadlocks, starvation
  * [ ] Actions : réécriture de plan ciblée, redispatch, alertes
* [ ] **Relier** à `loopDetector` et `rewrite`
* [ ] **Tests**

  * [ ] `tests/agents.supervisor.stagnation.test.ts`
  * [ ] `tests/agents.supervisor.unblock.test.ts`

### D3. **Sécurité/opération**

* [ ] Limiteurs : nb max d’enfants, mémoire/CPU par enfant (config)
* [ ] Timeouts catégorisés (BT decorators)
* [ ] **Tests** : `tests/op.safety.limits.test.ts`

---

## E) Mémoire d’implémentation (réutilisation pratique des plans)

### E1. **Graphe de connaissances interne (KG)**

* [ ] **Créer** `src/knowledge/knowledgeGraph.ts`

  * [ ] Triplets `{subject,predicate,object,source?,confidence?}` + index
  * [ ] Query simple par motif (sans dépendance RDF)
* [ ] **Relier** `graph_generate` pour *suggérer* patrons de plan depuis KG
* [ ] **Server tools** : `kg_insert`, `kg_query`, `kg_export`
* [ ] **Tests**

  * [ ] `tests/knowledge.kg.insert-query.test.ts`
  * [ ] `tests/graph.generate.from-kg.test.ts` (patrons appliqués)

### E2. **Mémoire causale d’événements**

* [ ] **Créer** `src/knowledge/causalMemory.ts`

  * [ ] Noeuds = événements, arêtes cause→effet (exécution réelle)
  * [ ] API : `record(event, causes[])`, `explain(outcome)`
* [ ] **Brancher** exécution (BT & scheduler) pour enregistrer événements
* [ ] **Server tools** : `causal_export`, `causal_explain(outcomeId)`
* [ ] **Tests**

  * [ ] `tests/knowledge.causal.record-explain.test.ts`
  * [ ] `tests/causal.integration.bt-scheduler.test.ts`

---

## F) **Graphe de valeurs** & filtrage des plans

* [ ] **Créer** `src/values/valueGraph.ts`

  * [ ] Noeuds : valeurs (sécurité, confidentialité, coût, perfo…), arêtes : priorités/contraintes
  * [ ] `scorePlan(plan):{score,total,violations[]}` + `filter(plan)`
* [ ] **Intégrer** à `plan_fanout` (pré-filtrer), `plan_reduce` (pondérer)
* [ ] **Server tools** : `values_set`, `values_score`, `values_filter`
* [ ] **Tests**

  * [ ] `tests/values.score-filter.test.ts`
  * [ ] `tests/plan.values-integration.test.ts` (plan rejeté si violation critique)

---

## G) Intégration serveur (nouvelles tools, schémas, erreurs)

* [ ] **Modifier** `src/server.ts` (registre tools)

  * [ ] Ajouter :

    * `graph_subgraph_extract`, `graph_rewrite_apply`, `graph_hyper_export`
    * `plan_compile_bt`, `plan_run_bt`, `plan_run_reactive`
    * `bb_set/get/query/watch`, `stig_mark/decay/snapshot`
    * `cnp_announce`, `consensus_vote`
    * `agent_autoscale_set`
    * `kg_insert/query/export`, `causal_export/explain`
    * `values_set/score/filter`
  * [ ] **Zod schemas** pour chaque input, validation stricte
  * [ ] Codes d’erreurs :

    * `E-BT-INVALID`, `E-BT-RUN-TIMEOUT`
    * `E-BB-NOTFOUND`, `E-STIG-TYPE`
    * `E-CNP-NO-BIDS`, `E-CONSENSUS-NO-QUORUM`
    * `E-KG-BAD-TRIPLE`, `E-CAUSAL-NO-PATH`
    * `E-VALUES-VIOLATION`, `E-REWRITE-CONFLICT`
* [ ] **Tests**

  * [ ] `tests/server.tools.schemas.test.ts` (validation négative)
  * [ ] `tests/server.tools.errors.test.ts` (codes/msgs cohérents)

---

## H) Visualisation & Dashboard (temps réel, interprétable)

* [ ] **Modifier** `src/monitor/dashboard.ts`

  * [ ] Streams : état BT (nœuds RUNNING/OK/KO), heatmap stigmergie (champ par nœud), backlog scheduler
  * [ ] Endpoints JSON + SSE/WebSocket (local by default)
* [ ] **Modifier** `src/viz/mermaid.ts`

  * [ ] Overlays (labels couleur par intensité stigmergique, badges BT)
* [ ] **Tests**

  * [ ] `tests/monitor.dashboard.streams.test.ts` (smoke + shape)
  * [ ] `tests/viz.mermaid.overlays.test.ts` (échappement/attributs stables)

---

## I) Build, tsconfig, CI

* [ ] **tsconfig.json**

  * [ ] Ajouter paths pour `executor/*`, `coord/*`, `knowledge/*`, `values/*`, `graph/*`
  * [ ] `types:["node"]`, `strict:true`, `moduleResolution:"node"`, `lib:["ES2022"]`
* [ ] **package.json**

  * [ ] Scripts : `test:unit`, `test:int`, `coverage` (nyc/c8)
  * [ ] `start:dashboard` si déport UI local facultatif
* [ ] **.github/workflows/ci.yml**

  * [ ] Matrice Node 18/20/22, steps : install → build → lint → test → coverage artifact
* [ ] **Tests**

  * [ ] `tests/ci.smoke-all-tools.test.ts` (appelle rapidement chaque tool en mode mock)

---

## J) Documentation & démos

* [ ] **README.md**

  * [ ] Section “Mode réactif (BT + scheduler)” avec exemples JSON d’un BT
  * [ ] Usage blackboard/stigmergie/contract-net/consensus
  * [ ] Valeurs/KG/causal : exemples courts
* [ ] **AGENTS.md**

  * [ ] Recettes :

    * Fan-out via CNP → Join par `quorum` → Reduce `vote`
    * Plan réécrit dynamiquement (rewrite rules) en fonction des échecs
    * Autoscaler + superviseur pour déblocage automatique
* [ ] **playground_codex_demo/**

  * [ ] Scénarios couvrant : BT, stigmergie visible, consensus, values filter, KG bootstrap

---

## K) Feature flags & configuration

* [ ] **Modifier** `src/serverOptions.ts`

  * [ ] Flags (off par défaut) :

    * `enableBT`, `enableReactiveScheduler`
    * `enableBlackboard`, `enableStigmergy`, `enableCNP`, `enableConsensus`
    * `enableAutoscaler`, `enableSupervisor`
    * `enableKnowledge`, `enableCausalMemory`, `enableValueGuard`
  * [ ] Timeouts/délais : `btTickMs`, `stigHalfLifeMs`, `supervisorStallTicks`
* [ ] **Tests**

  * [ ] `tests/options.flags.wiring.test.ts` (activation/désactivation propre)

---

## L) Suites d’intégration (end-to-end ciblées)

* [ ] **E2E-1 : Plan hiérarchique réactif**

  * [ ] Génère `HierGraph` → compile BT → run réactif → succès avec re-ordonnancement après `bb_set`
* [ ] **E2E-2 : Stigmergie + autoscaling**

  * [ ] Backlog lourd → champs phéromones → autoscaler scale-up → drain → scale-down
* [ ] **E2E-3 : Contract-Net + consensus**

  * [ ] `cnp_announce` 3 enfants → bids → attribution → `plan_join quorum=2/3` → reduce vote
* [ ] **E2E-4 : Values guard**

  * [ ] 2 plans, 1 viole “confidentialité” → filtré → autre plan choisi
* [ ] **E2E-5 : Rewrite sous pression**

  * [ ] Échecs répétés → superviseur déclenche `rewrite` → plan passe

---

## M) Qualité, perfs et robustesse

* [ ] **Micro-bench** scheduler (avant/après stigmergie) dans `tests/perf/` (non-CI)
* [ ] **Robustesse** : chaos tests légers (enfant qui crash → récupération)
* [ ] **Flakiness** : ré-exécuter 10× tests sensibles avec timers fake

---

### Notes d’implémentation (pragmatiques)

* **Interop avec existants** : reposer sur `graph-forge` pour algos de base, ne pas réinventer. Les hyper-arêtes restent *internes* et sont projetées avant passage aux algos.
* **Feuilles BT** : mapper chaque leaf vers une tool existante (ou vers `child_send`), sérialiser l’input validé Zod, journaliser `start/stop/status`.
* **Blackboard** : commencer en mémoire (Map + index par tag). Snapshot sur disque *optionnel* (JSON) dans le run dir.
* **Stigmergie** : champ = dictionnaire `{nodeId: intensity}`, appliquer décroissance à chaque tick.
* **Contract-Net** : implémenter d’abord attribution “min-cost”, puis heuristique.
* **Consensus** : préférer `quorum(k)` pour intégration simple avec `plan_join`.
* **Autoscaler** : bornes strictes, `cooldown` pour éviter oscillations.
* **Supervisor** : s’appuyer sur `loopDetector` existant, ajouter seuils de stagnation + actions prioritaires.
* **ValueGuard** : commencer avec règles déclaratives JSON (ex : “no network write” sans flag explicite).
* **CausalMemory** : enregistrer *seulement* événements clés (début/fin/échec de nœuds), lier par dépendances + erreurs.
* **Dashboard** : SSE pour simplicité (SSE > WS si pas besoin de duplex).
* **Erreurs** : codes stables, messages courts, `hint` actionnable.

---

Si tu veux, je peux ensuite te générer les **squelettes TypeScript** (fichiers & exports) et les **fichiers de tests Mocha** correspondants aux modules marqués “Créer”, pour te faire gagner du temps sur l’amorçage.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 30)
- ✅ Créé `src/graph/hierarchy.ts` avec types hiérarchiques, validations anti-cycles et expansion `flatten` documentée.
- ✅ Rédigé les tests `tests/graph.hierarchy.generate-embed.test.ts` et `tests/graph.hierarchy.flatten.test.ts` couvrant l’embed multi-niveaux et la projection.
- ✅ Vérifié l’intégrité des ports et le rejet des cycles via les nouvelles validations.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 31)
- ✅ Ajouté `src/graph/hypergraph.ts` avec projection des hyper-arêtes vers des arêtes binaires annotées et validations robustes.
- ✅ Étendu les exports Mermaid/DOT pour afficher les annotations hyper-arêtes et couvert avec `tests/graph.export.hyper.test.ts`.
- ✅ Couvert la projection hypergraphe avec `tests/graph.hyper.project.test.ts` et aligné la checklist A2.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 32)
- ✅ Implémenté `src/graph/rewrite.ts` (règles split-parallel / inline-subgraph / reroute-avoid + combinator `applyAll`).
- ✅ Relié les réécritures adaptatives dans `src/graph/adaptive.ts` via `applyAdaptiveRewrites`.
- ✅ Ajouté les tests `tests/graph.rewrite.rules.test.ts` et `tests/graph.adaptive.rewrite.test.ts` couvrant idempotence et pilotage par renforcement.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 33)
- ✅ Créé le gestionnaire transactionnel `src/graph/tx.ts` (snapshots, rollback, version + horodatage, métadonnée `__txCommittedAt`).
- ✅ Ajouté les tests `tests/graph.tx.snapshot-rollback.test.ts` et `tests/graph.tx.concurrency.test.ts` validant rollback et conflits de version.
- ⏳ Intégration serveur à venir : wrap des mutations MCP avec le gestionnaire transactionnel.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 34)
- ✅ Intégré le gestionnaire transactionnel côté serveur pour `graph_mutate` avec rollback automatique et journalisation dédiée.
- ✅ Exposé des helpers de normalisation/sérialisation pour relier les outils de graphe aux transactions.
- ✅ Ajouté le test `tests/graph.tx.mutate-integration.test.ts` couvrant l'interop entre mutations et transactions.
