Parfait. Je me base sur **la version actuelle du dépôt que tu as fournie** (dernière archive dézippée) et sur **l’audit précédent** : les modules “MCP-friendly avancés” que nous avions définis (introspection, events unifiés, cancellation, transactions exposées, diff/patch, locks, idempotency, bulk, lifecycle plan, child ops fines, values explain, assistance KG/causal, resources URIs, logs tail) **ne sont pas encore présents** dans cette archive, et donc **aucun test associé** non plus.
Voici une **liste de tâches à cocher** ultra-précise, **fichier par fichier**, pour obtenir un code **propre, fonctionnel et robuste**, avec **sous-étapes**, **objectifs**, **critères d’acceptation**, et **règles build/tests** à respecter.

---

## BRIEF (lis-moi d’abord)

**Objectifs attendus (résumé)**

* Offrir à l’agent MCP une surface d’API **complète et ergonomique** : introspection/capabilities, ressources adressables, **event bus unifié** (progress/corrélation), **cancellation** uniforme, **transactions** exposées, **diff/patch** + invariants, **locks**, **idempotency keys**, **opérations bulk**, **lifecycle plan** cohérent, **child ops fines**, **values explain**, **assistance KG/causal**, **logs tail**.
* Conserver un **comportement déterministe** en test (fake timers, seeds) et une **sécurité de concurrence** (locks/versions/rollback).
* Zod sur **toutes** les nouvelles tools, codes d’erreurs **normalisés**, chemins **normalisés** (aucune écriture hors dossiers d’exécution contrôlés).

**Règles Build/Tests (obligatoires)**

* Install :

  * Si lockfile : `npm ci`
  * Sinon : `npm install --omit=dev --no-save --no-package-lock`
* Build : `npm run build` (racine → puis `graph-forge` si séparé)
* Lint : `npm run lint` (tsc strict, `noEmit`)
* Tests : `npm test` **offline**, **fake timers** pour tout ce qui attend/timeout ; **aucune dépendance réseau**
* CI : Node **18/20/22**, artefact coverage ; pas d’appels externes
* Zod : toutes les nouvelles tools **valident** leur input ; messages d’erreur courts avec **codes** stables
* FS : n’écrire **que** dans `runs/…` / `children/…` / répertoires temporaires dédiés ; interdire `..` ; normaliser avec un utilitaire `paths`

---

## 0) Hygiène et fondations (préparatifs)

* [x] **Créer** `src/paths.ts`

  * [x] Fonctions : `resolveRunDir(runId)`, `resolveChildDir(childId)`, `sanitizeFilename(name)`, `safeJoin(base, ...parts)` (interdit `..`)
  * **Accept.** : tous les modules écrivent via `paths.ts`, **pas** d’accès direct `fs` avec chemins relatifs bruts.

* [x] **Créer** `src/types.ts` (si absent)

  * [x] Types de base partagés (RunId, OpId, GraphId, Version, ChildId…)
  * [x] Map des **codes d’erreurs** : `E-MCP-*`, `E-RES-*`, `E-EVT-*`, `E-CANCEL-*`, `E-TX-*`, `E-LOCK-*`, `E-PATCH-*`, `E-PLAN-*`, `E-CHILD-*`, `E-VALUES-*`, `E-ASSIST-*`
  * **Accept.** : chaque tool retourne `{ok:false, code, message, hint?}` en cas d’échec.

* [x] **Mettre à jour** `tsconfig.json`

  * [x] `strict:true`, `moduleResolution:"node"`, `target:"ES2022"`, `types:["node"]`
  * [x] `paths` pour : `graph/*`, `executor/*`, `coord/*`, `agents/*`, `knowledge/*`, `values/*`, `monitor/*`, `events/*`, `mcp/*`, `resources/*`, `infra/*`, `state/*`, `viz/*`.

* [x] **Mettre à jour** `src/serverOptions.ts`

  * [x] **Feature flags** (par défaut **false**) :
    `enableMcpIntrospection`, `enableResources`, `enableEventsBus`, `enableCancellation`, `enableTx`, `enableBulk`, `enableIdempotency`, `enableLocks`, `enableDiffPatch`, `enablePlanLifecycle`, `enableChildOpsFine`, `enableValuesExplain`, `enableAssist`
  * [x] Timeouts : `defaultTimeoutMs`, `btTickMs`, `supervisorStallTicks`, `autoscaleCooldownMs`, `stigHalfLifeMs`.
  * **Accept.** : flags reflétés par `mcp_info`.

* [x] **Tests**

  * [x] `tests/options.flags.wiring.test.ts` (activer/désactiver un flag fait réellement apparaître/disparaître les tools associées)
  * [x] `tests/paths.sanitization.test.ts` (aucun `..`, normalisation).

---

## 1) Introspection MCP & Capacités

* [x] **Créer** `src/mcp/info.ts`

  * [x] `getMcpInfo() -> { server:{name,version}, mcp:{protocol,transport[]}, features:string[], limits:{maxInputBytes, defaultTimeoutMs}, flags:Record<string,boolean> }`
  * [x] `getMcpCapabilities() -> { namespaces: string[], tools: {name, inputSchemaSummary}[] }`
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `mcp_info`, `mcp_capabilities` (Zod `{}`)
* [x] **Tests**

  * [x] `tests/mcp.info-capabilities.test.ts` (cohérence avec `serverOptions`, listage complet, shape stable)

**Accept.** : un client MCP peut découvrir **tout** ce qui est activé et les limites d’entrée.

---

## 2) Ressources adressables & lecture/abonnement

* [x] **Créer** `src/resources/registry.ts`

  * [x] URIs supportées :
    `sc://graphs/<graphId>`, `sc://graphs/<graphId>@v<version>`,
    `sc://runs/<runId>/events`, `sc://children/<childId>/logs`,
    `sc://blackboard/<ns>`, `sc://snapshots/<graphId>/<txId>`
  * [x] API : `list(prefix?)`, `read(uri) -> {mime,data}`, `watch(uri, fromSeq?) -> AsyncIterable<Event>`
  * [x] Surveillance `sc://blackboard/<ns>` → événements versionnés (`set/delete/expire`) relayés via watch & SSE.
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `resources_list`, `resources_read`, `resources_watch`
* [x] **Tests**

  * [x] `tests/resources.list-read-watch.test.ts` (listing filtré, lecture snapshots/graphes, flux ordonné par `seq`)

**Accept.** : un agent peut **parcourir et suivre** les ressources clés par URI stable.

---

## 3) Event bus unifié (progress/corrélation)

* [x] **Créer** `src/events/bus.ts`

  * [x] Type `Event {ts, cat:string, level, runId?, opId?, graphId?, nodeId?, childId?, msg, data?, seq}`
  * [x] EventEmitter global + séquence monotone par stream
* [x] **Brancher** le bus dans : `src/executor/*`, `src/coord/*`, `src/agents/*` (publication à chaque étape significative)
* [x] **Modifier** `src/server.ts`

  * [x] Tool : `events_subscribe({cats?, runId?}) -> stream`
* [x] **Tests**

  * [x] `tests/events.subscribe.progress.test.ts` (filtrage cat/runId, ordre, complétion)

**Accept.** : toute opération longue émet des events **corrélés** par `opId/runId`.

---

## 4) Cancellation uniforme

* [x] **Créer** `src/executor/cancel.ts`

  * [x] Store `opId -> {cancelled:boolean}` ; `requestCancel(opId)`, `isCancelled(opId)`
* [x] **Modifier** `src/executor/bt/nodes.ts`, `src/executor/bt/interpreter.ts`, `src/executor/reactiveScheduler.ts`

  * [x] Ajout **points d’annulation** (avant I/O, sleeps, backoff, boucles longues)
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `op_cancel({opId})`, `plan_cancel({runId})` (cascade)
* [x] **Tests**

  * [x] `tests/cancel.bt.decorator.test.ts` (interruption nette, cleanup)
  * [x] `tests/cancel.plan.run.test.ts` (annulation en cascade)

**Accept.** : **toute** op longue peut être annulée proprement, sans fuite.

---

## 5) Transactions exposées (TX)

* [x] **Créer/Compléter** `src/graph/tx.ts`

  * [x] `tx_begin(graphId) -> {txId, baseVersion}` ; `tx_apply(txId, ops[]) -> {previewVersion, diff}` ; `tx_commit(txId)` ; `tx_rollback(txId)`
  * [x] `GraphOp` : add/remove node/edge, patch meta, apply rewrite(rule, params)
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `tx_begin`, `tx_apply`, `tx_commit`, `tx_rollback` (Zod strict)
* [x] **Tests**

  * [x] `tests/tx.begin-apply-commit.test.ts` (rollback idempotent, conflits de version)

**Accept.** : un agent peut regrouper des mutations en TX **atomiques**.

---

## 6) Diff/Patch & invariants

* [x] **Créer** `src/graph/diff.ts` (JSON Patch RFC 6902)
* [x] **Créer** `src/graph/patch.ts` (applique patch)
* [x] **Créer** `src/graph/invariants.ts`

  * [x] Règles : acyclicité (si DAG), ports/labels requis, edge cardinality
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `graph_diff({graphId, from, to})`, `graph_patch({graphId, patch})`
* [x] **Tests**

  * [x] `tests/graph.diff-patch.test.ts` (roundtrip)
  * [x] `tests/graph.invariants.enforced.test.ts` (rejet patch invalide)

**Accept.** : **aucun** patch ne viole les invariants ; diff/patch stables.

---

## 7) Locks & Idempotency

* [x] **Créer** `src/graph/locks.ts`

  * [x] `graph_lock({graphId, holder, ttlMs}) -> {lockId}` ; `graph_unlock({lockId})` ; refresh
  * [x] Mutations refusent si lock détenu par autre holder
* [x] **Créer** `src/infra/idempotency.ts`

  * [x] Store TTL `(key -> result)` ; relecture résultat pour les clés rejouées
* [x] **Modifier** `src/server.ts`

  * [x] Exiger `idempotencyKey?` pour : `child_create`, `plan_run_bt`, `cnp_announce`, `graph_batch_mutate`, `tx_begin`
  * [x] Tools : `graph_lock`, `graph_unlock`
* [x] **Tests**

  * [x] `tests/graph.locks.concurrent.test.ts` (pas de deadlock, re-entrance)
  * [x] `tests/idempotency.replay.test.ts` (mêmes inputs → même résultat)

**Accept.** : **retries réseau** sûrs ; concurrence maîtrisée.

---

## 8) Opérations bulk atomiques

* [x] **Modifier** `src/server.ts`

  * [x] Tools :

    * `bb_batch_set([{ns,key,value,ttlMs?}])`
    * `graph_batch_mutate({graphId, ops:GraphOp[]})`
    * `child_batch_create([{idempotencyKey?, role?, prompt, limits?}])`
    * `stig_batch([{nodeId,type,intensity}])`
  * [x] Implémenter mini-transaction en mémoire (rollback si échec partiel)
* [x] **Tests**

  * [x] `tests/bulk.bb-graph-child-stig.test.ts` (atomicité, erreurs partielles → rollback)

**Accept.** : **moins de tours** MCP, latence réduite.

---

## 9) Lifecycle plan (status/pause/resume/dry-run)

* [x] **Créer** `src/executor/planLifecycle.ts`

  * [x] États : `running|paused|done|failed`, `progress%`, `lastEventSeq`
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `plan_status({runId})`, `plan_pause({runId})`, `plan_resume({runId})`
  * [x] `plan_dry_run({graphId|btJson})` : compile, applique `values_explain`, **preview rewrite** (sans effets)
* [x] **Tests**

  * [x] `tests/plan.lifecycle.test.ts`
  * [x] `tests/plan.dry-run.test.ts`

**Accept.** : contrôle fin des plans depuis l’agent, sans exécution réelle en dry-run.

---

## 10) Child ops fines

* [x] **Créer/Compléter** `src/state/childrenIndex.ts`, `src/childRuntime.ts`

  * [x] `attach`, `setRole`, `setLimits` (cpuMs, memMb, wallMs), lecture `status`
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `child_spawn_codex({role?, prompt, modelHint?, limits?, idempotencyKey?})`, `child_attach({childId})`, `child_set_role({childId, role})`, `child_set_limits(...)`
* [x] **Tests**

  * [x] `tests/child.spawn-attach-limits.test.ts` (respect des limites, attachement)

**Accept.** : gestion fine des enfants “une instance Codex par enfant”.

---

## 11) Exécution réactive : BT/Scheduler (si tu actives ce volet)

> (Ces fichiers étaient absents dans l’archive ; si tu les ajoutes maintenant, suis ces étapes)

* [x] **Créer** `src/executor/bt/types.ts` (Status, Node API)
* [x] **Créer** `src/executor/bt/nodes.ts`

  * [x] `Sequence`, `Selector`, `Parallel(all|any|quota)`, Décorateurs `Retry(n, jitter)`, `Timeout(ms)`, `Guard(cond)`, `Cancellable()`
* [x] **Créer** `src/executor/bt/interpreter.ts` (tick async, persistance état nœuds, progress %)
* [x] **Créer** `src/executor/bt/compiler.ts` (compile HierGraph → BT)
* [x] **Créer** `src/executor/reactiveScheduler.ts` (priorité f(âge, criticité, stig), aging anti-starvation, budgets coopératifs)
* [x] **Créer** `src/executor/loop.ts` (ticks, pause/resume/stop)
* [x] **Modifier** `src/server.ts` (tools `plan_compile_bt`, `plan_run_bt`, `plan_run_reactive`)
* [x] **Tests**

  * [x] `tests/bt.nodes.sequence-selector.test.ts`
  * [x] `tests/bt.decorators.retry-timeout-cancel.test.ts` (fake timers)
  * [x] `tests/bt.parallel.quota.test.ts`
  * [x] `tests/bt.compiler.from-graph.test.ts`
  * [x] `tests/bt.run.integration.test.ts` (mock tools réels)

**Accept.** : BT réactif fiable, sans famine, avec cancellation.

---

## 12) Coordination : blackboard, stigmergie, CNP, consensus

* [x] **Créer** `src/coord/blackboard.ts` (KV typé, tags, TTL, watch)
* [x] **Créer** `src/coord/stigmergy.ts` (`mark`, `evaporate(halfLifeMs)`, `snapshot`)
* [x] **Créer** `src/coord/contractNet.ts` (announce/bid/award, heuristique min-cost puis tie-break)
* [x] **Créer** `src/coord/consensus.ts` (`majority`, `quorum(k)`, `weighted`)
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `bb_set/get/query/watch`, `stig_mark/decay/snapshot`, `cnp_announce`, `consensus_vote`
* [x] **Tests**

  * [x] `tests/coord.blackboard.kv-watch.test.ts`
  * [x] `tests/coord.stigmergy.field-scheduler.test.ts`
  * [x] `tests/coord.contractnet.basic.test.ts`
  * [x] `tests/coord.consensus.modes.test.ts`

**Accept.** : coordination émergente + protocoles explicites disponibles.

---

## 13) Réécriture/Hiérarchie/Hypergraphes (si tu actives ce volet)

* [x] **Créer** `src/graph/hierarchy.ts` (SubgraphNode, flatten/embed, validation anti-cycles inter-niveaux)
* [x] **Créer** `src/graph/hypergraph.ts` (HyperEdge sources[]/targets[] ; projection binaire pour algos)
* [x] **Créer** `src/graph/rewrite.ts` (rules : split-parallel, inline-subgraph, reroute-avoid(label|nodeId) ; **idempotence**)
* [x] **Modifier** `src/server.ts` (tools `graph_subgraph_extract`, `graph_rewrite_apply`, `graph_hyper_export` si export)
* [x] **Tests**

  * [x] `tests/graph.hierarchy.flatten-embed.test.ts`
  * [x] `tests/graph.hyper.project.test.ts`
  * [x] `tests/graph.rewrite.rules.test.ts` (aucun cycle introduit)

**Accept.** : expressivité accrue des plans, réécritures sûres.

---

## 14) Mémoire, Assistance, Valeurs

* [x] **Créer** `src/knowledge/knowledgeGraph.ts` (triplets {s,p,o, source?, confidence?}, index)
* [x] **Créer** `src/knowledge/assist.ts`

  * [x] `kg_suggest_plan({goal, context?}) -> {fragments: HierGraph[], rationale[]}`
* [x] **Créer** `src/knowledge/causalMemory.ts` (record events cause→effet, explain(outcome), export DAG)
* [x] **Créer** `src/values/valueGraph.ts`

  * [x] `values_score/values_filter(plan)`, `values_explain(plan) -> violations[{nodeId,value,severity,hint}]`
* [x] **Modifier** `src/server.ts`

  * [x] Tools : `kg_insert/query/export`, `kg_suggest_plan`, `causal_export/explain`, `values_set/score/filter/explain`
  * [x] Intégrer `values_explain` dans `plan_dry_run`
* [x] **Tests**

  * [x] `tests/knowledge.kg.insert-query.test.ts`
  * [x] `tests/assist.kg.suggest.test.ts`
  * [x] `tests/knowledge.causal.record-explain.test.ts`
  * [x] `tests/values.score-filter-explain.test.ts`

**Accept.** : assistance “pratique”, filtrage par valeurs explicable.

---

## 15) Observabilité : logs corrélés & dashboard

* [x] **Créer** `src/monitor/log.ts` (JSONL corrélé : runId/opId/graphId/childId/seq, rotation)
* [x] **Modifier** `src/server.ts`

  * [x] Tool : `logs_tail({stream:"server"|"run"|"child", id?, limit?, fromSeq?})`
* [x] **Modifier** `src/monitor/dashboard.ts` (SSE : état BT, heatmap stigmergie, backlog scheduler)
* [x] **Modifier** `src/viz/mermaid.ts` (overlays : badges RUNNING/OK/KO, intensités)
* [x] **Tests**

  * [x] `tests/logs.tail.filters.test.ts`
  * [x] `tests/monitor.dashboard.streams.test.ts`
  * [x] `tests/viz.mermaid.overlays.test.ts`

**Accept.** : l’agent peut **suivre** l’exécution et **diagnostiquer** vite.

---

## 19) Observabilité : filtres avancés journal

* [x] Étendre `logs_tail` pour accepter un filtre `levels` (normalisation, sortie écho).
* [x] Étendre `logs_tail` pour accepter un filtrage temporel (`since_ts`/`until_ts`) appliqué avant la pagination.
* [x] Couvrir le filtrage par sévérité via `tests/logs.tail.filters.test.ts`.

**Accept.** : les opérateurs peuvent cibler les entrées critiques sans bruit.

---

## 16) Nettoyage, sécurité applicative, erreurs

* [x] Repasser tous les `fs` → via `paths.ts` ; supprimer code mort, TODO obsolètes
* [x] Normaliser **tous** les codes d’erreurs & messages courts
* [x] **Tests** : `tests/server.tools.errors.test.ts` (codes/messages/hints consistants)

---

## 17) E2E (vérification intégrée)

* [x] **E2E-1 :** plan hiérarchique → compile BT → `plan_run_bt` → `events_subscribe` (pause/resume) → `plan_cancel` → `logs_tail`
* [x] **E2E-2 :** backlog massif → stigmergie + autoscaler → superviseur débloque → metrics ok
* [x] **E2E-3 :** `cnp_announce` 3 enfants → bids → award → `plan_join quorum=2/3` → `plan_reduce vote`
* [x] **E2E-4 :** `plan_dry_run` → `values_explain` rejette un plan → `kg_suggest_plan` propose fragment alternatif → `rewrite` preview → exécution
* [x] **E2E-5 :** `tx_begin` → `tx_apply` (ops multiples) → `graph_diff/patch` → `tx_commit` → `resources_read sc://graphs/<id>@vX`

**Accept.** : scénarios bout-en-bout stables, sans flakiness (fake timers).

---

## 18) Concurrence, robustesse, performance

* [x] **Créer** `tests/concurrency.graph-mutations.test.ts` (mutations concurrentes, locks → OK)
* [x] **Créer** `tests/concurrency.events-backpressure.test.ts` (`events_subscribe/resources_watch` charges élevées, backpressure)
* [x] **Créer** `tests/cancel.random-injection.test.ts` (annulation aléatoire pendant BT/scheduler)
* [x] **Créer** `tests/perf/scheduler.bench.ts` (non-CI, micro-bench aging/stigmergie)

---

### Conseils d’implémentation (pour éviter les pièges)

* **Corrélation** : alloue `opId` dès l’entrée de la tool ; propage-le **partout** ; log JSONL systématique.
* **Annulation** : vérifie `isCancelled(opId)` **avant/après** chaque `await` critique ; nettoyage enfant si `plan_cancel`.
* **Atomicité** : TX/bulk → rollback si la moindre sous-op échoue ; invariants **toujours** évalués en fin d’appliquer/patch/rewrite.
* **Fairness** : scheduler → ajoute **aging** pour éviter la famine ; budgets coopératifs (yield périodique).
* **Autoscaler** : impose `cooldown` pour éviter l’oscillation ; journaux synthétiques pour audit.
* **Tests** : remplace timers réels par **fake timers** ; fixe des seeds ; **pas** de réseau.
* **Docs** : expose les URIs `sc://` et les réponses typiques pour que les agents MCP puissent s’auto-configurer rapidement.

---

Si tu veux, je peux te fournir au prochain message les **squelettes TypeScript** de toutes les nouvelles tools (avec Zod) et les **tests Mocha** minimaux correspondants, prêts à copier/coller, pour accélérer la première passe d’implémentation.

---

### 2025-10-07 – Agent `gpt-5-codex` (iteration 7)
- ✅ Étendu le registre de ressources pour suivre les mutations du blackboard (`watch` + `watchStream`) avec limite de rétention par namespace.
- ✅ Actualisé la sérialisation SSE et la suite de tests (`resources.list-read-watch`, `resources.watch.stream`, `resources.watch.sse`) pour couvrir les événements `set/delete` du blackboard.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 8)
- ✅ Enrichi `resources.list` avec des métadonnées (`entry_count`, `latest_version`) pour les namespaces du blackboard afin de faciliter l'amorçage des cursors MCP.
- ✅ Étendu `tests/resources.list-read-watch.test.ts` pour vérifier les métadonnées initiales et après suppression, garantissant que la version la plus récente reste exposée.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 9)
- ♻️ Préservé les namespaces du blackboard dans `resources.list` même lorsque toutes les entrées ont été supprimées en fusionnant les statistiques live et historiques.
- ✅ Mis à jour `resources.read` pour renvoyer des payloads vides mais valides sur les namespaces drainés et couvert le scénario via `tests/resources.list-read-watch.test.ts`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 10)
- ✅ Ajouté un filtrage par clés aux flux `resources_watch` (pages et streams) pour les namespaces du blackboard avec propagation des métadonnées `filters`.
- ✅ Étendu `ResourceRegistry` pour normaliser les clés (pleinement qualifiées ou relatives) et maintenir des curseurs monotones malgré les événements ignorés.
- ✅ Mis à jour `resources.watch.sse.test.ts`, `resources.watch.stream.test.ts` et `resources.list-read-watch.test.ts` afin de couvrir le filtrage, les keep-alives enrichis et la progression des séquences.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 11)
- ✅ Ajouté des filtres `run` et `child` aux pages/streams `resources_watch` (types/ids/corrélations) avec normalisation, clonage défensif et propagation SSE/outil serveur.
- ✅ Couvert les nouveaux filtres via des tests unitaires (watch paginé/stream/SSE + intégration outil) garantissant curseurs monotones et métadonnées reflétées côté client.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 12)
- ✅ Ajouté des fenêtres temporelles (`sinceTs`/`untilTs`) aux filtres `resources_watch` pour les runs et les enfants, avec normalisation, clonage défensif et validation côté serveur/SSE.
- ✅ Étendu les tests (`resources.list-read-watch`, `resources.watch.stream`, `resources.watch.sse`) afin de couvrir le filtrage temporel et la propagation des métadonnées normalisées.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 13)
- ♻️ Étendu `resources_watch` pour accepter des filtres `blackboard` combinant clés et bornes temporelles ; normalisation côté registre et echo côté SSE.
- ✅ Mis à jour les schémas MCP (`resources_watch`) et les tests (`resources.list-read-watch`, `resources.watch.stream`, `resources.watch.sse`) pour couvrir le filtrage temporel des namespaces du blackboard et vérifier les métadonnées.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 14)
- ✅ Ajouté un filtrage `kinds` (set/delete/expire) aux flux `resources_watch` du blackboard avec normalisation, déduplication et rejet des valeurs inconnues.
- ✅ Propagé les filtres `kinds` côté serveur/SSE et enrichi les suites `resources.list-read-watch`, `resources.watch.stream`, `resources.watch.sse` (y compris intégration MCP) pour valider l’écho des métadonnées.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 15)
- ✅ Ajouté un filtrage par tags (`blackboard.tags`) aux pages/streams `resources_watch` en vérifiant les mutations via `entry`/`previous` et en normalisant les valeurs en minuscules.
- ✅ Étendu le schéma MCP, la sérialisation SSE et les suites de tests (`resources.list-read-watch`, `resources.watch.stream`, `resources.watch.sse`) pour couvrir les filtres par tags y compris un scénario d’intégration serveur.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 16)
- ✅ Ajouté un filtrage `levels` au tool `logs_tail` (normalisation côté serveur, passage au journal et echo dans la réponse structurée).
- ✅ Étendu `tests/logs.tail.filters.test.ts` pour vérifier que la sévérité `error` est isolée lorsque le filtre est utilisé.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 17)
- ♻️ Rendu le schéma d'entrée de `logs_tail` tolérant à la casse sur `levels` tout en conservant une validation stricte sur les valeurs supportées.
- ✅ Ajouté un scénario d'intégration garantissant que les filtres de sévérité acceptent des valeurs mixtes/majuscule et renvoient les niveaux normalisés.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 18)
- ♻️ Nettoyé le dépôt en supprimant les dossiers obsolètes `playground_codex_demo` et `projet_mcp_test` ainsi que leurs artefacts générés.
- 🧹 Vérifié qu'aucun fichier utile ne restait orphelin et mis à jour cette note pour informer les prochains contributeurs du nettoyage effectué.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 19)
- ✅ Ajouté des filtres corrélés (`run/job/op/graph/node/child`) au tool `logs_tail` avec normalisation côté serveur et journal afin de limiter les extraits aux identifiants demandés.
- ✅ Dédupliqué/assaini les identifiants fournis, exposé les filtres actifs dans la réponse structurée et complété la suite `logs.tail.filters` avec un scénario couvrant la sélection croisée.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 20)
- ✅ Ajouté un filtrage temporel (`since_ts`/`until_ts`) au journal et au tool `logs_tail`, normalisé côté serveur et appliqué avant la pagination.
- ✅ Étendu la réponse structurée pour refléter les bornes temporelles actives et ajouté un scénario d'intégration garantissant l'exclusion des entrées hors fenêtre.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 21)
- ♻️ Dédupliqué la normalisation des sévérités côté serveur afin d'éviter les comparaisons redondantes tout en conservant la casse normalisée.
- ✅ Ajouté un scénario d'intégration couvrant les doublons `levels` et vérifiant que seuls les journaux WARN/ERROR sont retournés.
- 📝 Documenté l'outil `logs_tail` dans `docs/mcp-api.md` (contrat, filtres croisés, fenêtre temporelle) pour faciliter l'intégration MCP.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 22)
- ✅ Ajouté un filtre `message_contains` côté journal/serveur pour isoler les entrées dont le message contient toutes les sous-chaînes demandées (insensible à la casse).
- ✅ Complété `tests/logs.tail.filters.test.ts` avec un scénario couvrant la normalisation, le cumul des sous-chaînes et la pagination déterministe.
- 📝 Mis à jour `docs/mcp-api.md` pour décrire le nouveau filtre et refléter les réponses structurées.
