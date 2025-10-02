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
* [x] **Modifier** `src/server.ts`

  * [x] Étendre `graph_generate`/`graph_mutate` pour `kind:"subgraph"`
  * [x] Nouvelle tool `graph_subgraph_extract` (extrait un sous-plan en fichier JSON, versionné dans run dir)
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
  * [x] Wrap `graph_rewrite_apply`
* [ ] **Tests**

  * [x] `tests/graph.tx.snapshot-rollback.test.ts`
  * [x] `tests/graph.tx.concurrency.test.ts` (refus MAJ si version diverge)

---

## B) Exécution **réactive** et **itérative**

### B1. Interpréteur Behavior Tree (BT)

* [x] **Créer** `src/executor/bt/types.ts` (Status: `SUCCESS|FAILURE|RUNNING`)
* [x] **Créer** `src/executor/bt/nodes.ts`

  * [x] Composites : `Sequence`, `Selector`, `Parallel(policy:all/any)`
  * [x] Décorateurs : `Retry(n, backoff)`, `Timeout(ms)`, `Guard(cond)`
  * [x] Feuilles : `TaskLeaf(toolName, inputSchema)` → appelle tools existants (child_send, graph_*…)
* [x] **Créer** `src/executor/bt/interpreter.ts` (tick async, persistance état nœuds)
* [x] **Créer** `src/executor/bt/compiler.ts` (compile `HierGraph` → BT selon patrons)
* [x] **Modifier** `src/server.ts`

  * [x] Nouvelle tool `plan_compile_bt` (retourne JSON BT)
  * [x] Nouvelle tool `plan_run_bt` (lance interpréteur + expose events)
* [x] **Tests**

  * [x] `tests/bt.nodes.sequence-selector.test.ts`
  * [x] `tests/bt.decorators.retry-timeout.test.ts` (fake timers)
  * [x] `tests/bt.compiler.from-hiergraph.test.ts`
  * [x] `tests/bt.run.integration.test.ts` (BT → outils réels mockés)

### B2. Scheduler réactif & bus d’événements

* [x] **Créer** `src/executor/reactiveScheduler.ts`

  * [x] EventBus (Node `EventEmitter`) : `taskReady`, `taskDone`, `blackboardChanged`, `stigmergyChanged`
  * [x] Politique : priorité dynamique (âge, criticité, phéromones)
* [x] **Relier** BT → Scheduler (ticks pilotés par événements)
* [x] **Tests**

  * [x] `tests/executor.scheduler.reactivity.test.ts` (réaction immédiate aux events)
  * [x] `tests/executor.scheduler.prio.test.ts` (priorités évolutives)

### B3. Boucle de *ticks* & budgets

* [x] **Créer** `src/executor/loop.ts`

  * [x] Tick cadencé (`setInterval`) + `pause/resume/stop`
  * [x] Budgets : tâches longues → coopérative (yield)
* [x] **Tests**

  * [x] `tests/executor.loop.timing.test.ts` (fake timers, no drift)
  * [x] `tests/executor.loop.budget.test.ts`

---

## C) Coordination & communication (blackboard, stigmergie, contrat, consensus)

### C1. **Blackboard** (tableau noir)

* [x] **Créer** `src/coord/blackboard.ts`

  * [x] KV typé + tags + TTL + watch (events)
  * [x] Snapshots (pour débogage, export)
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `bb_set`, `bb_get`, `bb_query`, `bb_watch(startFromVersion)` (stream)
* [x] **Tests**

  * [x] `tests/coord.blackboard.kv.test.ts`
  * [x] `tests/coord.blackboard.watch.test.ts` (dédup + ordre)

### C2. **Stigmergie** (phéromones)

* [x] **Créer** `src/coord/stigmergy.ts`

  * [x] API : `mark(nodeId, type, intensity)`, `evaporate(halfLifeMs)`, `fieldSnapshot()`
* [x] **Modifier** scheduler pour pondérer sélection de tâches par champ de phéromones
* [x] **Server tools** : `stig_mark`, `stig_decay`, `stig_snapshot`
* [x] **Tests**

  * [x] `tests/coord.stigmergy.field.test.ts` (accumulation/évaporation)
  * [x] `tests/coord.stigmergy.scheduler.test.ts` (impact mesurable sur choix)

### C3. **Contract-Net Protocol**

* [x] **Créer** `src/coord/contractNet.ts`

  * [x] Messages : `announce(task)`, `bid(agentId,cost)`, `award(agentId)`
  * [x] Stratégie d’attribution (min cost, heuristique)
* [x] **Intégrer** à `child_create`/`child_send` (routeur de tâches via CNP si activé)
* [x] **Server tool** : `cnp_announce` (expérimental)
* [x] **Tests**

  * [x] `tests/coord.contractnet.basic.test.ts`
  * [x] `tests/coord.contractnet.tie-breaker.test.ts`

### C4. **Consensus / Vote**

* [x] **Créer** `src/coord/consensus.ts`

  * [x] `majority`, `quorum(k)`, `weighted(weights)`
* [x] **Relier** à `plan_join` / `plan_reduce` (mode `vote`)
* [x] **Tests**

  * [x] `tests/coord.consensus.modes.test.ts`
  * [x] `tests/plan.join.vote.integration.test.ts`

---

## D) Auto-organisation & robustesse (autoscaler, superviseur, sécurité)

### D1. **Autoscaler d’enfants**

* [x] **Créer** `src/agents/autoscaler.ts`

  * [x] Metrics : backlog scheduler, latence, taux d’échec
  * [x] Politique : spawn/retire avec bornes et *cooldown*
* [x] **Intégrer** au loop (tick → `reconcile()`)
* [x] **Server tool** : `agent_autoscale_set({min,max,cooldown})`
* [x] **Tests**

  * [x] `tests/agents.autoscaler.scale-updown.test.ts` (sans fuite de process)
  * [x] `tests/agents.autoscaler.cooldown.test.ts`

### D2. **Superviseur (Global Workspace)**

* [x] **Créer** `src/agents/supervisor.ts`

  * [x] Détecte stagnation (aucun progrès N ticks), deadlocks, starvation
  * [x] Actions : réécriture de plan ciblée, redispatch, alertes
* [x] **Relier** à `loopDetector` et `rewrite`
* [x] **Tests**

  * [x] `tests/agents.supervisor.stagnation.test.ts`
  * [x] `tests/agents.supervisor.unblock.test.ts`

### D3. **Sécurité/opération**

* [ ] Limiteurs : nb max d’enfants, mémoire/CPU par enfant (config)
* [ ] Timeouts catégorisés (BT decorators)
* [ ] **Tests** : `tests/op.safety.limits.test.ts`

---

## E) Mémoire d’implémentation (réutilisation pratique des plans)

### E1. **Graphe de connaissances interne (KG)**

* [x] **Créer** `src/knowledge/knowledgeGraph.ts`

  * [x] Triplets `{subject,predicate,object,source?,confidence?}` + index
  * [x] Query simple par motif (sans dépendance RDF)
* [x] **Relier** `graph_generate` pour *suggérer* patrons de plan depuis KG
* [x] **Server tools** : `kg_insert`, `kg_query`, `kg_export`
* [x] **Tests**

  * [x] `tests/knowledge.kg.insert-query.test.ts`
  * [x] `tests/graph.generate.from-kg.test.ts` (patrons appliqués)

### E2. **Mémoire causale d’événements**

* [x] **Créer** `src/knowledge/causalMemory.ts`

  * [x] Noeuds = événements, arêtes cause→effet (exécution réelle)
  * [x] API : `record(event, causes[])`, `explain(outcome)`
* [x] **Brancher** exécution (BT & scheduler) pour enregistrer événements
* [x] **Server tools** : `causal_export`, `causal_explain(outcomeId)`
* [x] **Tests**

  * [x] `tests/knowledge.causal.record-explain.test.ts`
  * [x] `tests/causal.integration.bt-scheduler.test.ts`

---

## F) **Graphe de valeurs** & filtrage des plans

* [x] **Créer** `src/values/valueGraph.ts`

  * [x] Noeuds : valeurs (sécurité, confidentialité, coût, perfo…), arêtes : priorités/contraintes
  * [x] `scorePlan(plan):{score,total,violations[]}` + `filter(plan)`
* [x] **Intégrer** à `plan_fanout` (pré-filtrer), `plan_reduce` (pondérer)
* [x] **Server tools** : `values_set`, `values_score`, `values_filter`
* [x] **Tests**

  * [x] `tests/values.score-filter.test.ts`
  * [x] `tests/plan.values-integration.test.ts` (plan rejeté si violation critique)

---

## G) Intégration serveur (nouvelles tools, schémas, erreurs)

* [ ] **Modifier** `src/server.ts` (registre tools)

  * [ ] Ajouter :

    * `graph_subgraph_extract`, `graph_rewrite_apply`, `graph_hyper_export`
    * `plan_compile_bt`, `plan_run_bt`, `plan_run_reactive`
    * `bb_set/get/query/watch`, `stig_mark/decay/snapshot`
    * `cnp_announce`, `consensus_vote`
    * `agent_autoscale_set`
    * `kg_insert/query/export`, `causal_export/explain` ✅
    * `values_set/score/filter` ✅
  * [ ] **Zod schemas** pour chaque input, validation stricte
  * [x] Codes d’erreurs :

    * [x] `E-BT-INVALID`, `E-BT-RUN-TIMEOUT`
    * [x] `E-BB-NOTFOUND`, `E-STIG-TYPE`
    * [x] `E-CNP-NO-BIDS`, `E-CONSENSUS-NO-QUORUM`
    * [x] `E-KG-BAD-TRIPLE`, `E-CAUSAL-NO-PATH`
    * [x] `E-VALUES-VIOLATION`, `E-REWRITE-CONFLICT`
* [x] **Tests**

  * [x] `tests/server.tools.schemas.test.ts` (validation négative)
  * [x] `tests/server.tools.errors.test.ts` (codes/msgs cohérents)
* [x] Stabiliser `plan_reduce` (vote) pour normaliser les résumés JSON/textuels et éviter les erreurs de quorum.

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

* [x] **Modifier** `src/serverOptions.ts`

  * [x] Flags (off par défaut) :

    * `enableBT`, `enableReactiveScheduler`
    * `enableBlackboard`, `enableStigmergy`, `enableCNP`, `enableConsensus`
    * `enableAutoscaler`, `enableSupervisor`
    * `enableKnowledge`, `enableCausalMemory`, `enableValueGuard`
  * [x] Timeouts/délais : `btTickMs`, `stigHalfLifeMs`, `supervisorStallTicks`
* [x] **Tests**

  * [x] `tests/options.flags.wiring.test.ts` (activation/désactivation propre)

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

### 2025-10-01 – Agent `gpt-5-codex` (iteration 35)
- ✅ Étendu les outils `graph_generate` et `graph_mutate` pour détecter/consigner les sous-graphes et signaler les descripteurs manquants.
- ✅ Implémenté la tool `graph_subgraph_extract` avec export versionné vers le run dir et journalisation MCP.
- ✅ Créé la bibliothèque `subgraphRegistry` + `subgraphExtract` et le test `graph.subgraph.extract.test.ts` (horodatage déterministe, nettoyage run dir).

### 2025-10-01 – Agent `gpt-5-codex` (iteration 36)
- ✅ Implémenté `graph_rewrite_apply` côté outils avec schéma Zod, sélection manuelle/adaptative des règles et invalidation du cache.
- ✅ Enregistré la tool `graph_rewrite_apply` sur le serveur avec transactions, journalisation détaillée et suivi des sous-graphes.
- ✅ Ajouté `tests/graph.rewrite.apply.test.ts` et `tests/graph.tx.rewrite-integration.test.ts` couvrant règles manuelles/adaptatives et commits optimistes.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 37)
- ✅ Créé la suite Behaviour Tree (`types.ts`, `nodes.ts`, `interpreter.ts`, `compiler.ts`) avec commentaires détaillés et nœuds Sequence/Selector/Parallel/Retry/Timeout/Guard/TaskLeaf.
- ✅ Ajouté les outils MCP `plan_compile_bt` et `plan_run_bt` (Zod, invocations tracées, mode dry-run `noop`) et intégré au serveur.
- ✅ Couvert l’interpréteur avec `tests/bt.nodes.sequence-selector.test.ts`, `tests/bt.decorators.retry-timeout.test.ts`, `tests/bt.compiler.from-hiergraph.test.ts`, `tests/bt.run.integration.test.ts` (fake timers, flux stub).

### 2025-10-01 – Agent `gpt-5-codex` (iteration 38)
- ✅ Implémenté `src/executor/reactiveScheduler.ts` avec bus d’événements typé, calculs de priorité (criticité + phéromones + vieillissement) et traçabilité des ticks.
- ✅ Relié `plan_run_bt` au scheduler réactif pour piloter l’interpréteur via les signaux et exposer le nombre de ticks exécutés.
- ✅ Ajouté `tests/executor.scheduler.reactivity.test.ts` et `tests/executor.scheduler.prio.test.ts` (horloge manuelle déterministe) et maintenu `npm test` vert.
- 🔜 Suivi : brancher les futurs modules (blackboard/stigmergie réels) sur le bus pour enrichir les signaux et ajouter des handlers d’outils BT non-« noop ».

### 2025-10-01 – Agent `gpt-5-codex` (iteration 39)
- ✅ Créé `src/executor/loop.ts` avec boucle cadencée, budget coopératif et API `whenIdle`/`stop` documentées pour orchestrer les ticks.
- ✅ Écrit `tests/executor.loop.timing.test.ts` et `tests/executor.loop.budget.test.ts` avec horloges manuelles pour valider cadence, pause/reprise et yields coopératifs.
- ✅ Exécuté `npm test` pour garantir que l’ensemble de la suite reste déterministe et verte après l’ajout de la boucle.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 40)
- ✅ Implémenté `src/coord/blackboard.ts` avec KV typé, TTL déterministe, journal d’événements borné et API de watch synchronisée.
- ✅ Ajouté les tools `bb_set/get/query/watch` côté serveur (schémas Zod, logs dédiés, intégration au nettoyage TTL) et enregistrés via MCP.
- ✅ Créé les tests `coord.blackboard.kv.test.ts` & `coord.blackboard.watch.test.ts` (horloge manuelle) pour couvrir stockage, expiration et streaming; suite `npm test` vérifiée.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 41)
- ✅ Implémenté `src/coord/stigmergy.ts` avec accumulation déterministe, évaporation exponentielle et notifications de changements.
- ✅ Branché le scheduler réactif sur le champ de phéromones (priorités pondérées, rebalancement live) et exposé les tools `stig_mark/decay/snapshot` via le serveur MCP.
- ✅ Ajouté les tests `coord.stigmergy.field.test.ts` et `coord.stigmergy.scheduler.test.ts` garantissant évaporation, snapshots et impact sur la sélection des tâches.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 42)
- ✅ Ajouté le coordinateur Contract-Net (annonce/bid/award avec biais heuristiques et pénalité de charge) et documentation inline.
- ✅ Relié `child_create`/`child_send` au CNP (sélection automatique, résumé de dispatch, completion auto) et exposé la tool MCP `cnp_announce`.
- ✅ Créé les tests `coord.contractnet.*` et un scénario `child_send` validant le routage Contract-Net.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 43)
- ✅ Implémenté `src/coord/consensus.ts` avec calculs `majority`/`quorum`/`weighted`, normalisation des options et schéma Zod réutilisable.
- ✅ Relié le consensus aux outils `plan_join` et `plan_reduce` (mode vote) avec exposition des résultats dans les traces et les événements.
- ✅ Ajouté les tests `coord.consensus.modes.test.ts`, `plan.join.vote.integration.test.ts`, mis à jour `plan.fanout-join.test.ts` et `plan.reduce.test.ts`, puis exécuté `npm test`.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 44)
- ✅ Créé `src/agents/autoscaler.ts` (métriques backlog/latence/taux d’échec, politique bornée avec cooldown) et connecté au loop via l’interface `LoopReconciler`.
- ✅ Ajouté le tool `agent_autoscale_set` (schéma Zod + logging) et instancié l’autoscaler côté serveur.
- ✅ Écrit les tests `agents.autoscaler.scale-updown.test.ts`, `agents.autoscaler.cooldown.test.ts`, `executor.loop.reconciler.test.ts` (horloge manuelle) et vérifié `npm test`.

### 2025-10-02 – Agent `gpt-5-codex` (iteration 45)
- ✅ Stabilisé `tests/agents.autoscaler.scale-updown.test.ts` en abaissant la moyenne de latence sous le seuil de relaxation et en retirant les traces de debug.
- ✅ Exécuté la suite complète `npm test` (245 tests) pour confirmer que l’autoscaler et le loop restent verts.

### 2025-10-02 – Agent `gpt-5-codex` (iteration 46)
- ✅ Introduit `src/agents/supervisor.ts` (détection stagnation/starvation, gestion des alertes de loop, interface `LoopReconciler`).
- ✅ Relié le superviseur au serveur (`childTools`, `planTools`, `loopDetector`) avec événements MCP (`supervisor_*`) et callbacks de réécriture/redispatch.
- ✅ Ajouté `tests/agents.supervisor.stagnation.test.ts` & `tests/agents.supervisor.unblock.test.ts`, ajusté le scheduler pour exposer le backlog post-tick et maintenu `npm test` vert (248 tests).

### 2025-10-02 – Agent `gpt-5-codex` (iteration 47)
- ✅ Étendu `serverOptions` avec les toggles de modules et délais (`btTickMs`, `stigHalfLifeMs`, `supervisorStallTicks`) et exposé l’API de configuration runtime.
- ✅ Mis à jour `tests/serverOptions.parse.test.ts` pour couvrir l’activation/désactivation et les délais personnalisés.
- ✅ Ajouté `tests/options.flags.wiring.test.ts` pour vérifier l’application dynamique des toggles et timings via le serveur.

### 2025-10-02 – Agent `gpt-5-codex` (iteration 48)
- ✅ Créé `src/knowledge/knowledgeGraph.ts` (index triple, motifs wildcard, patterns de plan) et horloge injectée pour tests déterministes.
- ✅ Relié `handleGraphGenerate` aux patterns KG et ajouté les tools MCP `kg_insert/query/export` avec garde feature flag.
- ✅ Ajouté `tests/knowledge.kg.insert-query.test.ts` et `tests/graph.generate.from-kg.test.ts` couvrant stockage, requêtes et génération pilotée; suite `npm test` (254) verte.

### 2025-10-02 – Agent `gpt-5-codex` (iteration 49)
- ✅ Implémenté `src/knowledge/causalMemory.ts` (enregistrement d'événements, explication ascendante, export complet) et résumé JSON compact.
- ✅ Branché la mémoire causale sur le scheduler réactif et `plan_run_bt` (événements `bt.tool.*`, `scheduler.tick.*`) avec garde feature flag.
- ✅ Ajouté les tools MCP `causal_export` / `causal_explain`, journalisation dédiée et tests ciblés (`knowledge.causal.record-explain`, `causal.integration.bt-scheduler`).

### 2025-10-02 – Agent `gpt-5-codex` (iteration 50)
- ✅ Créé `src/values/valueGraph.ts` avec scoring, propagation des contraintes et filtrage par seuil configurable.
- ✅ Intégré le garde-fou dans `plan_fanout` (pré-filtrage + journalisation) et `plan_reduce` (pondération des votes) avec enregistrement des décisions par enfant.
- ✅ Ajouté les tools `values_set/score/filter`, les tests unitaires `values.score-filter` et l'intégration `plan.values-integration`, plus la signalisation d'erreur `E-VALUES-VIOLATION` côté serveur.

### 2025-10-02 – Agent `gpt-5-codex` (iteration 51)
- ✅ Harmonisé les codes d’erreurs MCP (`E-BT-INVALID`, `E-BT-RUN-TIMEOUT`, `E-BB-NOTFOUND`, `E-STIG-TYPE`, `E-CNP-NO-BIDS`, `E-CONSENSUS-NO-QUORUM`, `E-KG-BAD-TRIPLE`, `E-CAUSAL-NO-PATH`, `E-VALUES-VIOLATION`, `E-REWRITE-CONFLICT`) via des classes dédiées et la normalisation serveur.
- ✅ Étendu `plan_run_bt` avec `timeout_ms`, ajouté le timeout runtime `BehaviorTreeRunTimeoutError` et câblé `plan_reduce` pour lever `ConsensusNoQuorumError` lors des votes infructueux.
- ✅ Ajouté les suites ciblées `tests/server.tools.schemas.test.ts` et `tests/server.tools.errors.test.ts` vérifiant les validations négatives et la remontée des codes; exécuté les nouvelles suites Mocha.

### 2025-10-02 – Agent `gpt-5-codex` (iteration 52)
- ✅ Ajouté la tool `graph_hyper_export` (projection hyper-graphe → graphe standard) avec exports Mermaid/DOT et test dédié.
- ✅ Enregistré `plan_run_reactive` (ExecutionLoop + scheduler réactif) et couvert le flux avec `tests/plan.run-reactive.test.ts`.
- ✅ Exposé `consensus_vote` côté coordination, schéma Zod et test majoritaire pour valider le calcul.
- 🔄 Étendu `tests/server.tools.schemas.test.ts` pour inclure les nouveaux schémas (`graph_hyper_export`, `plan_run_reactive`, `consensus_vote`).

### 2025-10-02 – Agent `gpt-5-codex` (iteration 53)
- ✅ Normalisé les résumés de vote dans `plan_reduce` pour extraire les champs `vote`/`value` lorsque disponibles et conserver des sources de diagnostic.
- ✅ Ajouté une assertion sur la valeur gagnante dans `tests/plan.fanout-join.test.ts` et relancé la suite ciblée (verts).
- 🔜 Audit global des schémas Zod (Section G) toujours ouvert.
