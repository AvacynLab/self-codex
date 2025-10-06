Remet à zero le fichier AGENTS.md et importe la liste des taches fournit ci dessous ainsi que les informations (au mot près) dans le fichier. Une fois effectué, commence l'implementation, et prend ton temps. 

---------- 
Voici ta **liste exhaustive de tâches à cocher** (adressée directement à toi, l’agent) pour corriger/ajouter/supprimer/modifier ce qu’il reste dans la **version actuelle du dépôt** (celle que j’ai auditée) en t’appuyant sur les résultats de mes deux recherches et de mon analyse MCP-centrée.
Je détaille **objectifs**, **acceptance criteria**, **fichiers à créer/modifier**, **sous-étapes (et sous-sous-étapes)**, ainsi que **règles build/tests**.
Contexte : TypeScript/Node ESM, local-first, une instance Codex par enfant, pas d’auth. CI Node 18/20/22.

---

## BRIEF (lis-moi d’abord)

**Objectifs attendus**

* Rendre le serveur **MCP-friendly** pour un agent exigeant : introspection/capabilities, URIs de ressources, event bus unifié avec corrélation `runId/opId`, cancellations uniformes, transactions exposées, opérations bulk, idempotency keys, locks, diff/patch, lifecycle plan complet, child ops fines, “values explain” en dry-run, assistance KG/causal, logs corrélés.
* **Affiner** les briques existantes (BT/scheduler/stigmergie/autoscaler/superviseur/réécriture) pour plus de finesse opérationnelle (pas de famine, budgets, invariants, réécritures idempotentes).
* Améliorer **observabilité** (streams unifiés, tail de logs) et **explicabilité** (values/causal/KG dans le pipeline).

**Correctifs à apporter (résumé)**

* Ajouter de **nouvelles tools MCP** ciblées (introspection, resources, events, cancel, tx, bulk, idempotency/locks, diff/patch, lifecycle plan, child spawn/attach/limits, values_explain, kg/causal suggest, logs_tail).
* Renforcer la **cohérence transactionnelle** (snapshots, versionning, invariants sur patch).
* Standardiser **IDs/corrélation** et **codes d’erreurs**.
* Couvrir par des **tests déterministes** (fake timers), y compris concurrence/annulation.

**Acceptance criteria généraux**

* Toute opération longue renvoie **`{opId, runId?}`**, publie des **events** corrélés et accepte **op_cancel**.
* Les outils “bulk/tx/patch/locks” sont **atomiques** et **safe** en concurrence (tests concurrents ok).
* Les invariants graphe sont préservés (acyclicité si DAG, ports/labels requis).
* Le scheduler est **fair** (pas de starvation), autoscaler ne “pompe” pas (cooldown), superviseur débloque les impasses.
* `values_filter` bloque les violations **critiques**, `values_explain` justifie clairement.

**Règles Build/Tests (à respecter partout)**

* Install : `npm ci` si lockfile ; sinon `npm install --omit=dev --no-save --no-package-lock`
* Build : `npm run build` (racine puis `graph-forge`)
* Lint : `npm run lint` (tsc strict, noEmit)
* Tests : `npm test` offline, **fake timers** pour tout ce qui attend/timeout
* CI : Node 18/20/22, coverage artifact ; pas de réseau externe
* Zod : pour **toutes** nouvelles tools, messages courts et codifiés
* FS : pas de `..` ni chemins relatifs non normalisés ; n’écrire que dans runs/children

---

## 1) Surface MCP — Introspection, Ressources, Événements, Cancellation

### 1.1 Introspection/Handshake

* [x] **Créer** `src/mcp/info.ts`

  * [x] Implémente `getMcpInfo()` et `getMcpCapabilities()` (schemas et namespaces)
  * [x] Inclure versions, transports, features/flags, limites (max input bytes, default timeouts)
* [x] **Modifier** `src/server.ts`

  * [x] Ajouter tool `mcp_info` (→ `McpInfo`)
  * [x] Ajouter tool `mcp_capabilities` (schemas résumés en JSON)
* [x] **Tests** : `tests/mcp.info-capabilities.test.ts`

  * [x] Valider shape, cohérence avec `serverOptions` et flags actifs

### 1.2 Ressources adressables (URIs stables)

* [x] **Créer** `src/resources/registry.ts`

  * [x] Résoudre URIs :

    * `sc://graphs/<graphId>` ; `sc://graphs/<graphId>@v<version>`
    * `sc://runs/<runId>/events` ; `sc://children/<childId>/logs`
    * `sc://blackboard/<ns>` ; `sc://snapshots/<graphId>/<txId>`
  * [x] `list(prefix?)`, `read(uri)`, `watch(uri, fromSeq?)` (SSE pipeline interne)
* [x] **Modifier** `src/server.ts`

  * [x] tools `resources_list`, `resources_read`, `resources_watch`
* [x] **Tests** : `tests/resources.list-read-watch.test.ts`

  * [x] Lister par préfixe ; lire snapshots/graph ; watch ordonné (seq monotone)

### 1.3 Event bus unifié & corrélation

* [x] **Créer** `src/events/bus.ts`

  * [x] Type `Event {ts, cat, level, runId?, opId?, graphId?, nodeId?, childId?, msg, data?, seq}`
  * [x] Wrapper sur émetteurs existants (BT, scheduler, bb, stig, cnp, consensus, values, children)
    * [x] BT + scheduler : `plan_run_bt` / `plan_run_reactive` publient `BT_RUN` corrélé (`run_id`, `op_id`, `mode`)
    * [x] Value guard : instrumentation `ValueGraph` + bridge MCP (corrélations run/op à compléter côté outils)
  * [x] Blackboard + stigmergy : ponts vers `EventBus` (mutations + évaporation)
  * [x] Annulation : registre `cancel` → `EventBus` (run/op/outcome, sévérité idempotente)
  * [x] Children : runtime lifecycle & flux stdout/stderr relayés avec corrélation run/op/child
  * [x] Contract-Net : annonces, enchères et attributions relayées sur le bus avec corrélation run/op
  * [x] Consensus : décisions agrégées → `EventBus` (run/op/job + métadonnées)
* [x] **Modifier** `src/executor/*`, `src/coord/*`, `src/agents/*`

  * [x] Publier évènements standardisés avec `opId/runId` *(Contract-Net : corrélations propagées dans `contractNet` + `bridgeContractNetEvents`, reste à aligner exécuteur/agents)*
    * [x] `plan_join` / `plan_reduce` publient désormais `STATUS` et `AGGREGATE` corrélés (hints propagés au payload + bus)
    * [x] Autoscaler publie `AUTOSCALER` avec corrélations child/run/op/job (itération 119)
    * [x] Autoscaler et passerelle child runtime réutilisent `extractCorrelationHints` et préservent les null explicites tout en gardant les identifiants natifs (itération 121)
    * [x] `child_collect` publie des événements `COGNITIVE` corrélés (metaCritic + selfReflect) via `buildChildCognitiveEvents` (itération 122)
    * [x] `child_prompt`/`child_chat`/`child_reply`/`child_kill` et outils associés publient désormais des événements `PROMPT`/`PENDING`/`REPLY`/`INFO`/`KILL` corrélés en fusionnant les métadonnées `ChildrenIndex` avec les hints extraits (itération 123)
  * [x] Extraire les corrélations des incidents du superviseur afin que les événements `supervisor_*` exposent `runId/opId/childId` quand disponibles
  * [x] Acheminer les corrélations fournies par les outils plan via `PlanEventEmitter` et `pushEvent` (itération 117)
  * [x] Empêcher les resolvers Contract-Net d'effacer les corrélations natives lorsqu'ils retournent des `undefined` (itération 113)
* [x] **Modifier** `src/server.ts`

  * [x] tool `events_subscribe({cats?, runId?})` (stream SSE/jsonlines)
* [x] **Tests** : `tests/events.subscribe.progress.test.ts`

  * [x] `tests/events.bridges.test.ts`

  * [x] Filtrage par catégorie ; ordre ; corrélation idempotente

### 1.4 Cancellation uniforme

* [x] **Créer** `src/executor/cancel.ts`

  * [x] Stock tokens/flags par `opId` ; API `requestCancel(opId)` / `isCancelled(opId)`
* [x] **Modifier** `src/executor/bt/nodes.ts`, `interpreter.ts`, `reactiveScheduler.ts`

  * [x] Points d’annulation (I/O, sleeps, backoff) + décorateur `Cancellable()`
  * [x] Scheduler réactif : arrêt coopératif + propagation `throwIfCancelled`
* [x] **Modifier** `src/server.ts`

  * [x] tool `op_cancel({opId})` ; tool `plan_cancel({runId})` (cascade)
* [x] **Tests** :

  * [x] `tests/cancel.bt.decorator.test.ts` (arrêt net, cleanup)
  * [x] `tests/cancel.plan.run.test.ts` (annulation cascaded)

---

## 2) Transactions, Diff/Patch, Locks, Idempotency, Bulk

### 2.1 Transactions exposées

* [x] **Modifier** `src/graph/tx.ts` (compléter métadonnées, horodatage, owner)
* [x] **Modifier** `src/server.ts`

  * [x] tools `tx_begin({graphId})`, `tx_apply({txId, ops:GraphOp[]})`, `tx_commit({txId})`, `tx_rollback({txId})`
  * [x] Validation Zod des `GraphOp` (add/remove node/edge, metadata patch, rewrite nommée)
* [x] **Tests** : `tests/tx.begin-apply-commit.test.ts`

  * [x] Conflit de version ; rollback idempotent ; aperçu version `previewVersion`

### 2.2 Diff/Patch & invariants

* [x] **Créer** `src/graph/diff.ts` (JSON Patch RFC 6902)
* [x] **Créer** `src/graph/patch.ts` (appliquer patch avec vérification)
* [x] **Créer** `src/graph/invariants.ts`

  * [x] Acyclicité (si DAG), ports/labels requis, contraintes edge cardinality
* [x] **Modifier** `src/server.ts`

  * [x] tools `graph_diff({graphId, from, to})`, `graph_patch({graphId, patch})`
* [x] **Tests** :

  * [x] `tests/graph.diff-patch.test.ts` (roundtrip)
  * [x] `tests/graph.invariants.enforced.test.ts` (rejet patch invalide)

### 2.3 Locks de graphe

* [x] **Créer** `src/graph/locks.ts`

  * [x] `graph_lock({graphId, holder, ttlMs}) -> {lockId}` ; `graph_unlock({lockId})`
  * [x] Rafraîchissement ; expiration ; re-entrance par holder
* [x] **Modifier** mutations/tx pour **refuser** si lock détenu par autre holder
* [x] **Tests** : `tests/graph.locks.concurrent.test.ts`

  * [x] Pas de deadlock ; re-entrance ; expiration propre

### 2.4 Idempotency keys

* [x] **Créer** `src/infra/idempotency.ts` (store TTL)
* [x] **Modifier** tools : `child_create`, `plan_run_bt`, `cnp_announce`, `graph_batch_mutate`, `tx_begin`

  * [x] Accepter `idempotencyKey?` → rejouer résultat si déjà vu
* [x] **Tests** : `tests/idempotency.replay.test.ts` (simuler retry réseau)

### 2.5 Opérations bulk atomiques

* [x] **Modifier** `src/server.ts`

  * [x] tools `bb_batch_set([{ns,key,value,ttlMs?}])`
  * [x] `graph_batch_mutate({graphId, ops:GraphOp[]})`
  * [x] `child_batch_create([{idempotencyKey?, role?, prompt, limits?}])`
  * [x] `stig_batch([{nodeId,type,intensity}])`
* [x] **Tests** : `tests/bulk.bb-graph-child-stig.test.ts` (couverture `bb_batch_set` ajoutée, graph/child/stig restant)

  * [x] Atomicité : rollback si erreur partielle

---

## 3) Lifecycle Plan, Compilation/Exécution, Child Ops fines

### 3.1 Lifecycle uniforme

* [x] **Créer** `src/executor/planLifecycle.ts`

  * [x] États : `running|paused|done|failed`, progression %, last event seq
* [x] **Modifier** `src/server.ts`

  * [x] tools `plan_status({runId})`, `plan_pause({runId})`, `plan_resume({runId})`
  * [x] `plan_dry_run({graphId|btJson})` → compile, applique `values_explain`, `rewrite` **en preview**
  * [x] **Tests** : `tests/plan.lifecycle.test.ts`, `tests/plan.dry-run.test.ts`

### 3.2 Child operations

* [x] **Modifier** `src/childRuntime.ts`, `src/state/childrenIndex.ts`

  * [x] Exposer `setRole`, `setLimits`, `attach` si déjà en vie
* [x] **Modifier** `src/server.ts`

  * [x] tools `child_spawn_codex({role?, prompt, modelHint?, limits?, idempotencyKey?})`
  * [x] `child_attach({childId})`, `child_set_role({childId, role})`, `child_set_limits(...)`
* [x] **Tests** : `tests/child.spawn-attach-limits.test.ts`

---

## 4) Affinage exécution : BT, Scheduler, Stigmergie, Autoscaler, Superviseur, Réécriture

### 4.1 Behavior Tree (finesse)

* [x] **Modifier** `src/executor/bt/nodes.ts`

  * [x] Décorateurs : `Retry(n, backoffJitter)`, `Timeout(ms)`, `Guard(cond)`, `Cancellable`
  * [x] Parallel policy : `all|any|quota(k)`
* [x] **Modifier** `src/executor/bt/interpreter.ts`

  * [x] Persistance d’état par nœud (resume après pause/cancel) ; progress %
* [x] **Tests** :

  * [x] `tests/bt.decorators.retry-timeout-cancel.test.ts` (fake timers)
  * [x] `tests/bt.parallel.quota.test.ts`

### 4.2 Scheduler réactif (fairness & budgets)

* [x] **Modifier** `src/executor/reactiveScheduler.ts`

  * [x] Priorité = f(âge, criticité, stigmergie) avec **aging** (anti-starvation)
  * [x] Budgets CPU coopératifs (yield après quantum)
* [x] **Tests** :

  * [x] `tests/executor.scheduler.prio-aging.test.ts`
  * [x] `tests/executor.scheduler.budgets.test.ts`

### 4.3 Stigmergie paramétrable

* [x] **Modifier** `src/coord/stigmergy.ts`

  * [x] Demi-vie configurable `halfLifeMs`, borne min/max intensité
  * [x] Snapshot heatmap (pour dashboard)
* [x] **Tests** : `tests/coord.stigmergy.field.test.ts` (évaporation contrôlée)

### 4.4 Autoscaler & Superviseur

* [x] **Modifier** `src/agents/autoscaler.ts`

  * [x] Métriques : backlog, latence, échecs ; scale up/down avec **cooldown**
* [x] **Modifier** `src/agents/supervisor.ts`

  * [x] Détection stagnation (N ticks sans progrès), relance/réallocation
  * [x] Intégrer **rewrite** ciblée (règle `reroute-avoid`) en cas d’impasse
* [x] **Tests** :

  * [x] `tests/agents.autoscaler.scale-updown.test.ts` (no thrash)
  * [x] `tests/agents.supervisor.unblock.test.ts`

### 4.5 Réécriture & invariants (idempotence)

* [x] **Modifier** `src/graph/rewrite.ts`

  * [x] Règles : `split-parallel`, `inline-subgraph`, `reroute-avoid(label|nodeId)`
  * [x] **Idempotence** : même règle appliquée 2× → même graphe
* [x] **Tests** : `tests/graph.rewrite.rules.test.ts` (idempotence, pas de cycles)

---

## 5) Mémoire d’implémentation, Valeurs, Assistance

### 5.1 Knowledge Graph (réutilisation)

* [x] **Modifier** `src/knowledge/knowledgeGraph.ts`

  * [x] Triplets `{s,p,o,source?,confidence?}` ; index par `(s,p)` et `(o,p)`
* [x] **Créer** `src/knowledge/assist.ts`

  * [x] `kg_suggest_plan({goal, context?}) -> {fragments: HierGraph[], rationale[]}`
* [x] **Modifier** `src/server.ts`

  * [x] tool `kg_suggest_plan`
* [x] **Tests** : `tests/assist.kg.suggest.test.ts` (mocks)

### 5.2 Mémoire causale

* [x] **Modifier** `src/knowledge/causalMemory.ts`

  * [x] `record(event, causes[])`, `explain(outcome)` ; export DAG
  * [x] Accrochage BT/scheduler (début/fin/échec nœuds)
* [x] **Modifier** `src/server.ts`

  * [x] tools `causal_export`, `causal_explain`
* [x] **Tests** :

  * [x] `tests/knowledge.causal.record-explain.test.ts`
  * [x] `tests/causal.integration.bt-scheduler.test.ts`

### 5.3 Graphe de valeurs (filtrage + explication)

* [x] **Modifier** `src/values/valueGraph.ts`

* [x] `values_explain({plan}) -> {violations:[{nodeId, value, severity, hint}]}`
* [x] **Modifier** `src/server.ts`

  * [x] tool `values_explain`
  * [x] Intégration dans `plan_dry_run`
* [x] **Tests** : `tests/values.explain.integration.test.ts`

---

## 6) Observabilité/Logs/Dashboard

### 6.1 Logs corrélés & tail

* [x] **Créer** `src/monitor/log.ts`

  * [x] Log JSONL avec `runId|opId|graphId|childId|seq` ; rotation
* [x] **Modifier** `src/server.ts`

  * [x] tool `logs_tail({stream:"server"|"run"|"child", id?, limit?, fromSeq?})`
* [x] **Tests** : `tests/logs.tail.filters.test.ts` (filtres, fromSeq)

### 6.2 Dashboard overlays

* [x] **Modifier** `src/monitor/dashboard.ts`

  * [x] Streams SSE : état BT, heatmap stigmergie, backlog scheduler
* [x] **Modifier** `src/viz/mermaid.ts`

  * [x] Overlays : badges BT (RUNNING/OK/KO), intensités stigmergiques
* [x] **Tests** :

  * [x] `tests/monitor.dashboard.streams.test.ts`
  * [x] `tests/viz.mermaid.overlays.test.ts`

---

## 7) Concurrence, Robustesse, Perf

### 7.1 Tests de concurrence

* [x] **Créer** `tests/concurrency.graph-mutations.test.ts`

  * [x] Threads simulés : diffs concurrents → locks ; aucun deadlock
* [x] **Créer** `tests/concurrency.events-backpressure.test.ts`

  * [x] `events_subscribe/resources_watch` : limites, keep-alive, perte zéro

### 7.2 Cancellation & ressources

* [x] **Créer** `tests/cancel.random-injection.test.ts`

  * [x] Annuler aléatoirement pendant BT/scheduler ; vérifier cleanup

### 7.3 Flakiness & perf micro-bench (non-CI)

* [x] **Créer** `tests/perf/scheduler.bench.ts` (local-only)

  * [x] Mesurer latence avant/après stigmergie & aging
* [x] **Créer** script `scripts/retry-flaky.sh`

  * [x] Réexécuter 10× suites sensibles → vérifier stabilité

---

## 8) Server Options / Feature Flags / Docs

### 8.1 Options & flags

* [x] **Modifier** `src/serverOptions.ts`

  * [x] Ajouter flags : `enableMcpIntrospection`, `enableResources`, `enableEventsBus`, `enableCancellation`, `enableTx`, `enableBulk`, `enableIdempotency`, `enableLocks`, `enableDiffPatch`, `enablePlanLifecycle`, `enableChildOpsFine`, `enableValuesExplain`, `enableAssist`
  * [x] Defaults : **false** (retro-compatibilité) ; temps : `defaultTimeoutMs`, `btTickMs`, `stigHalfLifeMs`, `supervisorStallTicks`, `autoscaleCooldownMs`
* [x] **Tests** : `tests/options.flags.wiring.test.ts` (activation/désactivation propre)

### 8.2 Documentation

* [x] **Modifier** `README.md`

  * [x] Introspection/capabilities, URIs `sc://...`, events_subscribe, tx/bulk, locks/idempotency, diff/patch, lifecycle plan, child ops fines
  * [x] Exemples curl (stdio/http-json)
* [x] **Modifier** `AGENTS.md`

  * [x] Recettes :

    * Fan-out via CNP + consensus quorum + reduce vote
    * Dry-run : values_explain + kg/causal suggest + rewrite preview
    * Autoscaler + superviseur + stigmergie (heatmap visible)
* [x] **Ajouter** `docs/mcp-api.md` (schémas Zod en pseudo-schema lisible)

---

## 9) Nettoyage & Sécurité applicative

* [x] **Supprimer** code mort et TODOs obsolètes (grep TODO/FIXME)
* [x] **Renforcer** normalisation chemins (utiliser `src/paths.ts` partout)
* [x] **Limiter** side-effects par défaut (no network write si `values` interdit)
* [x] **Codes d’erreurs** homogènes :

  * [x] `E-MCP-*`, `E-RES-*`, `E-EVT-*`, `E-CANCEL-*`, `E-TX-*`, `E-LOCK-*`, `E-PATCH-*`, `E-PLAN-*`, `E-CHILD-*`, `E-VALUES-*`, `E-ASSIST-*`
* [x] **Tests** : `tests/server.tools.errors.test.ts` (codes/messages/hints)

---

## 10) Exemples E2E (scénarios de vérification)

* [x] **E2E-1 :** Plan hiérarchique → compile BT → `plan_run_bt` → events_subscribe (pause/resume) → `plan_cancel` → tail des logs
* [x] **E2E-2 :** Backlog massif → stig_mergie + autoscaler (scale up/down) → superviseur débloque → metrics ok
* [x] **E2E-3 :** CNP announce → bids → award → `plan_join quorum=2/3` → `plan_reduce vote`
* [x] **E2E-4 :** `plan_dry_run` → `values_explain` rejette un plan → `kg_suggest_plan` propose fragment alternatif → `rewrite` preview → exécution
* [x] **E2E-5 :** `tx_begin` → `tx_apply` (ops multiples) → `graph_diff/patch` → `tx_commit` → `resources_read sc://graphs/<id>@vX`

---

## Recettes opérationnelles (documentation rapide)

### Fan-out CNP → quorum consensus → reduce vote

1. **Activer les modules** : lancer le serveur avec `--enable-cnp --enable-consensus --enable-plan-lifecycle` (et `--enable-resources`
   pour suivre les runs via `sc://runs/<runId>/events`).
2. **Annonce CNP** : utiliser `cnp_announce` avec un `goal_id`, `constraints` et `quorum` attendu. Les children répondent via
   `child_send`/`plan_fanout` selon la stratégie actuelle.
3. **Collecte des offres** : surveiller `resources_watch` sur `sc://runs/<runId>/events` (catégorie `CNP_BID` à ajouter lors de
   l'implémentation du bus d'événements).
4. **Sélection** : appeler `plan_join` avec `join_policy: { kind: "quorum", threshold: 0.66 }` pour matérialiser le quorum.
5. **Agrégation** : terminer avec `plan_reduce` (`reducer: "vote"`) pour sortir la recommandation majoritaire. Consigner le vote dans
   la mémoire partagée pour audit (`bb_set`).

> Mise à jour : instrumentation bus d'événements (`events_subscribe`) disponible via `bridgeContractNetEvents` (corrélation runId/opId incluse pour les annonces/bids/awards CNP).

### Dry-run explicable (values_explain + KG/causal + rewrite)

1. **Préparation** : activer `--enable-plan-lifecycle --enable-values-explain --enable-assist --enable-diff-patch`.
2. **Dry-run** : appeler `plan_dry_run` avec le graphe cible ou un JSON BT. La réponse doit inclure la projection des valeurs et les
   violations candidates.
3. **Analyse valeurs** : lancer `values_explain` pour récupérer `{ violations: [...] }` et déterminer les contraintes critiques.
4. **Assistance KG/Causale** : enchaîner `kg_suggest_plan` (fragments alternatifs) puis `causal_explain` (causes des blocages) une fois
   implémentés.
5. **Réécriture** : appliquer `graph_diff`/`graph_patch` ou `graph_rewrite` en mode preview afin de corriger le graphe avant exécution
   réelle.

> Point de vigilance : les outils `plan_dry_run`, `values_explain`, `kg_suggest_plan` et `causal_explain` sont implémentés.
> Il reste à chaîner un scénario E2E complet (voir section 10) et à finaliser les flux SSE/HTTP partagés lors de futures itérations.

### Autoscaler + superviseur + stigmergie (heatmap)

1. **Flags** : démarrer avec `--enable-reactive-scheduler --enable-stigmergy --enable-autoscaler --enable-supervisor`.
2. **Heatmap** : consommer `monitor/dashboard.ts` via `/dashboard/stream` (SSE) pour visualiser `stigHeatmap`. Lorsque la réécriture
   des overlays Mermaid sera prête, superposer les intensités sur `viz/mermaid`.
3. **Autoscaling** : surveiller les métriques backlog/latence dans le snapshot dashboard et ajuster les cool-down (`autoscaleCooldownMs`).
4. **Supervision** : vérifier que le superviseur relance les nœuds stagnants et déclenche `rewrite` ciblée (`reroute-avoid`).
5. **Audit** : archiver les événements et logs via `resources_watch` / `sc://children/<id>/logs` pour documenter les décisions.

> À planifier : exposer une tail MCP (`logs_tail`) et un bus d'événements unifié pour corréler autoscaler/superviseur/stigmergie.

### Notes de mise en œuvre (pour t’éviter les pièges)

* **Corrélation** : génère `opId` dès l’entrée `server.ts`, propage partout, logge systématiquement.
* **Annulation** : vérifie le token **avant** chaque appel tool externe / attendeurs (`await`) ; annule proprement les enfants si `plan_cancel`.
* **Atomicité** : pour bulk ops, regroupe actions dans une **mini-transaction** en mémoire ; rollback si une étape échoue.
* **Invariants** : fais tourner `invariants.check()` dans **tx_apply**, **patch**, **rewrite** ; rejette tôt.
* **Fairness** : ajoute **aging** dans la formule de priorité du scheduler pour éviter la famine.
* **Cool-down** autoscaler : protège contre l’oscillation ; garde traces pour post-mortem.
* **Tests** : substitue tous timers réels par **fake timers** ; injecte seeds fixes pour aléa.
* **Docs** : montre URIs `sc://` dans les exemples, c’est ce que l’agent utilisera pour “monter” dans tes ressources.

---

Si tu veux, je peux te générer à la demande les **squelettes TypeScript** exacts (fichiers & exports) des nouvelles tools (`mcp_info`, `resources_*`, `events_subscribe`, `op_cancel`, `tx_*`, `graph_diff/patch`, `plan_* lifecycle`, `child_* fines`, `values_explain`, `kg_suggest_plan`, `causal_*`, `logs_tail`) + **mocks de tests** prêts à l’emploi, pour accélérer l’implémentation.

### 2025-10-03 – Agent `gpt-5-codex` (iteration 79)
- ✅ Créé `src/mcp/info.ts` avec `getMcpInfo`/`getMcpCapabilities` et stockage snapshot runtime.
- ✅ Ajouté les tools `mcp_info` / `mcp_capabilities` dans `src/server.ts` avec schéma strict et mise à jour runtime snapshot.
- ✅ Écrit `tests/mcp.info-capabilities.test.ts`, exécuté `npm run lint` puis `npm test` (après `npm ci`) – toutes les suites passent.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 80)
- ✅ Créé `src/resources/registry.ts` pour référencer graphes/versions/snapshots, runs (events), logs enfants et namespaces blackboard avec `list/read/watch` déterministes.
- ✅ Intégré l’enregistrement des snapshots/commits et ajouté les tools MCP `resources_list`, `resources_read`, `resources_watch` dans `src/server.ts` (corrélation run_id incluse).
- ✅ Ajouté `tests/resources.list-read-watch.test.ts`, exécuté `npm ci`, `npm run lint` et `npm test` – toutes les suites passent.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 81)
- ✅ Étendu `serverOptions.ts`/`server.ts`/`mcp/info.ts` pour introduire les nouveaux flags MCP (introspection, resources, events, cancel, tx, bulk, idempotency, locks, diff/patch, lifecycle, child ops, values, assist) et les délais `defaultTimeoutMs`/`autoscaleCooldownMs`.
- ✅ Aligné les snapshots MCP par défaut avec ces nouveaux champs et ajouté la batterie de tests `tests/options.flags.wiring.test.ts` + compléments dans `tests/serverOptions.parse.test.ts`.
- ✅ Re-construit les sorties compilées (`npm test` → build + lint séparé) après `npm ci` afin de rafraîchir `dist/`.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 82)
- ✅ Documenté l'introspection MCP et le registre `sc://` dans `README.md` avec exemples STDIO/HTTP (`mcp_info`, `resources_*`).
- ✅ Ajouté `docs/mcp-api.md` détaillant les pseudo-schémas Zod et la cartographie des flags MCP.
- ✅ Complété `AGENTS.md` (checklist documentation + recettes opérationnelles + historique) pour guider les prochaines itérations.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 83)
- ✅ Introduit `src/events/bus.ts` avec séquençage, filtres run/op/graph et ajustement du tampon (`setHistoryLimit`) – wrappers BT/scheduler à faire.
- ✅ Mis à jour `src/server.ts` pour publier sur le bus, exposer `events_subscribe` (JSONL/SSE) et synchroniser le `maxEventHistory` CLI.
- ✅ Ajouté `tests/events.subscribe.progress.test.ts`, exécuté `npm run lint`, `npm ci` (deps dev) puis `npm test` – toutes les suites passent.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 84)
- ✅ Corrélé `plan_run_bt` et `plan_run_reactive` via `BT_RUN` en injectant `run_id`/`op_id`, événements `start/node/tick/loop/complete/error` et journaux augmentés.
- ✅ Ajouté `tests/plan.bt.events.test.ts` pour valider la cohérence des phases et des identifiants sur les exécutions BT et boucle réactive (fake timers pour le scheduler).
- ✅ Exécuté `npm run lint` + `npm test` (post-modifs) afin de sécuriser la régression sur la télémétrie des plans.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 85)
- ✅ Créé `src/executor/cancel.ts` avec registre `AbortController`, helpers `requestCancellation/cancelRun/getCancellation` et exposé `OperationCancelledError` + reset pour les tests.
- ✅ Intégré la coopération à l’annulation côté Behaviour Tree (`CancellableNode`, `ensureNotCancelled`, runtime `throwIfCancelled`/wait helper) et ajouté les tools MCP `op_cancel` / `plan_cancel` + schémas Zod + réponses structurées.
- ✅ Ajouté `tests/cancel.bt.decorator.test.ts` & `tests/cancel.plan.run.test.ts`, exécuté `npm ci`, `npm run lint`, `npm test` → toutes les suites passent.
- ⚠️ Reste à traiter : cascade d’annulation vers les runtimes enfants + enrichissement du bus d’événements lors des phases cancel.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 86)
- ✅ Étendu `ReactiveScheduler` pour supporter les handles d’annulation (stop coopératif, rejet des promesses en cas de cancel, garde sur les drains) et nettoyer les abonnements.
- ✅ Adapté `handlePlanRunReactive` pour enregistrer le handle, propager `throwIfCancelled` (runtime/loop), publier les événements `cancel` et rejeter avec `OperationCancelledError`.
- ✅ Ajouté un scénario déterministe dans `tests/plan.run-reactive.test.ts` couvrant l’annulation via `cancelRun` (fake timers) + exécuté `npm run lint`, `npm test` (post `npm ci`).
- ⚠️ À poursuivre : étendre la cascade d’annulation aux runtimes enfants et enrichir le bus MCP avec des événements dédiés au cancel.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 87)
- ✅ Ponté le blackboard et la stigmergie vers le bus MCP via `bridgeBlackboardEvents` / `bridgeStigmergyEvents` et raccord dans `server.ts`.
- ✅ Ajouté `tests/events.bridges.test.ts` (horloge déterministe) + exécuté `npm run lint`, `npm test`.
- 🔜 Étendre la passerelle aux modules CNP / consensus / values / children et propager les identifiants run/op.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 88)
- ✅ Étendu `src/executor/cancel.ts` pour exposer `subscribeCancellationEvents` (run/op/outcome) et alimenter le bus MCP via `bridgeCancellationEvents` + sorties `dist/`.
- ✅ Relié `src/server.ts` / `dist/server.js` à cette passerelle et complété `tests/events.bridges.test.ts` (annulation idempotente) après `npm run lint` & `npm test`.
- 🔜 Propager la corrélation cancellation → job/children et couvrir consensus/children/events additionnels.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 89)
- ✅ Étendu `ChildRuntime` pour émettre des événements `lifecycle` structurés (spawn/error/exit) et ajouté la documentation associée.
- ✅ Ajouté `bridgeChildRuntimeEvents` + heuristiques run/op/job + branché le superviseur pour publier automatiquement les flux IO/enfants sur le bus MCP.
- ✅ Couvert `tests/events.bridges.test.ts` avec un scénario child complet + exécuté `npm run lint` puis `npm test` (succès intégral, 325 tests).

### 2025-10-04 – Agent `gpt-5-codex` (iteration 90)
- ✅ Équipé `ContractNetCoordinator` d'un émetteur d'événements (`observe`) pour suivre en temps réel inscriptions agents, annonces, bids, attributions et complétions avec horodatage déterministe.
- ✅ Ajouté `bridgeContractNetEvents` dans `src/events/bridges.ts` + raccord dans `src/server.ts` afin de publier les flux Contract-Net sur le bus MCP (catégorie `contract_net`, corrélations run/op).
- ✅ Étendu `tests/events.bridges.test.ts` avec un scénario Contract-Net couvrant auto-bids, overrides manuels, award/complete et désinscription ; exécuté `npm run lint` puis `npm test` (326 tests OK) pour rafraîchir `dist/`.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 91)
- ✅ Ajouté `publishConsensusEvent` et horloge injectable dans `src/coord/consensus.ts`, instrumenté `plan_join` et `consensus_vote` pour publier des décisions structurées.
- ✅ Créé `bridgeConsensusEvents`, branché le serveur et couvert un scénario dédié dans `tests/events.bridges.test.ts` (horloge déterministe, corrélations run/op/job).
- ✅ Exécuté `npm run lint` puis `npm test` (327 tests OK) afin de régénérer `dist/` et valider la passerelle consensus.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 92)
- ✅ Implémenté `ValueGraph.explain` avec agrégation des contributions, hints narratifs et corrélation `nodeId`/`primaryContributor`.
- ✅ Ajouté le tool MCP `values_explain` dans `src/server.ts` + gestion du logger, avec schéma Zod dédié et tests `tests/values.explain.integration.test.ts`.
- ⚠️ À faire ensuite : brancher `plan_dry_run` sur `values_explain` et propager les `nodeId` issus des plans compilés.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 93)
- ✅ Branché `plan_dry_run` sur le value guard : normalisation des impacts (avec `nodeId`), compilation optionnelle des graphes et journalisation détaillée.
- ✅ Ajouté l'outil MCP `plan_dry_run` côté serveur + schéma Zod dédié et deux scénarios déterministes `tests/plan.dry-run.test.ts`.
- ✅ Installé les dépendances (`npm ci`) puis exécuté `npm run lint` & `npm test` (331 tests) pour rafraîchir `dist/`.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 94)
- ✅ Instrumenté `ValueGraph` avec un émetteur d'événements (config/score/filter/explain) + horloge injectable et snapshots d'impacts.
- ✅ Ajouté `bridgeValueEvents` pour refléter les décisions du value guard sur le bus MCP et branché le serveur.
- ✅ Étendu `tests/events.bridges.test.ts` avec un scénario value guard déterministe et exécuté `npm run lint`, `npm test` (332 tests OK).
- ✅ Propager `runId`/`opId` depuis les outils value guard afin d'alimenter le resolver de corrélation côté bridge (couvert itération 95).

### 2025-10-04 – Agent `gpt-5-codex` (iteration 95)
- ✅ Étendu les schémas `values_score`/`values_filter`/`values_explain` avec les champs facultatifs `run_id`/`op_id`/`job_id`/`graph_id`/`node_id` et propagé ces métadonnées jusque dans `ValueGraph`.
- ✅ Ajouté la prise en charge des hints de corrélation dans `ValueGraph` (options d'évaluation) et `bridgeValueEvents` afin que le bus MCP publie directement `runId`/`opId` sans resolver externe.
- ✅ Mis à jour `tests/events.bridges.test.ts` pour couvrir la corrélation native du value guard et enrichi les logs tools avec les identifiants.
- ✅ Propagé les hints de corrélation value guard côté `plan_dry_run` et fan-out initial pour relier les aperçus aux mêmes `runId`/`opId`.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 96)
- ✅ Étendu le schéma `plan_dry_run` avec les hints de corrélation (`run_id`/`op_id`/`job_id`/`graph_id`/`node_id`/`child_id`) et extrait ces métadonnées pour alimenter le value guard.
- ✅ Propagé les hints vers `ValueGraph.explain` afin que les événements `plan_explained` exposent directement les identifiants ; journalisation `plan_dry_run` mise à jour pour inclure `run_id`/`op_id`.
- ✅ Ajouté un scénario déterministe dans `tests/plan.dry-run.test.ts` vérifiant la présence des hints dans la télémétrie du value guard.
- 🔜 Étendre la fan-out corrélée côté planification réelle (ex. `plan_run_bt`/`plan_run_reactive`) afin d'associer les dry-runs aux exécutions et cascader les identifiants jusqu'aux runtimes enfants.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 97)
- ✅ Étendu `plan_run_bt` et `plan_run_reactive` pour accepter/propager les hints `run_id`/`op_id`/`job_id`/`graph_id`/`node_id`/`child_id`, réutiliser les identifiants fournis et enrichir logs + bus MCP avec ces métadonnées.
- ✅ Mis à jour `PlanRun*Result` pour renvoyer la corrélation, injecté les hints dans les événements `BT_RUN` et aligné `tests/plan.bt.events.test.ts` avec de nouveaux scénarios corrélés.
- ✅ Propager ces hints vers `plan_fanout`, les outils enfants et `server.ts` pour cascader la corrélation jusqu'aux runtimes et à la cancellation (couvert itération 98).

### 2025-10-04 – Agent `gpt-5-codex` (iteration 98)
- ✅ Étendu `PlanFanoutInputSchema`/`PlanFanoutResult` avec les hints `run_id`/`op_id`/`job_id`/`graph_id`/`node_id`/`child_id`, mis à jour le mapping JSON et normalisé les métadonnées injectées dans les manifestes enfants.
- ✅ Enregistré `plan_fanout` auprès du registre d’annulation, enrichi les logs/événements (PLAN, spawn, cancel) et propagé les hints vers le `ChildSupervisor` pour corréler IO et manifests.
- ✅ Ajouté un scénario déterministe `plan.fanout-join.test.ts` couvrant les hints fournis, actualisé les attentes existantes et vérifié la persistance côté manifest/mapping.
- 🔜 Finaliser la cascade des hints côté outils enfants (plan_cancel/op_cancel) et vérifier la remontée des corrélations dans les ressources MCP (runs/enfants) pour aligner cancellation et observabilité.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 99)
- ✅ Étendu le registre d’annulation pour mémoriser `jobId`/`graphId`/`nodeId`/`childId`, enrichi `OperationCancelledError` et les événements émis afin que le bus MCP relaie directement ces corrélations.
- ✅ Mis à jour `op_cancel`/`plan_cancel` pour renvoyer des résultats snake_case incluant les métadonnées et consigner des logs détaillés, puis couvert ces comportements dans `tests/cancel.plan.run.test.ts`.
- ✅ Ajusté `bridgeCancellationEvents` et les tests d’événements pour vérifier la présence des hints (job/graph/node/child) sans resolver auxiliaire ; exécuté `npm run build`, `npm run lint`, `npm test`.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 100)
- ✅ Enrichi `ResourceRegistry` pour stocker les identifiants `runId`/`opId`/`graphId`/`nodeId` sur chaque événement de run et ajouté la documentation correspondante.
- ✅ Propagé ces métadonnées depuis `pushEvent` dans `src/server.ts` afin que le registre MCP capture les corrélations natives du bus.
- ✅ Étendu `tests/resources.list-read-watch.test.ts` avec des scénarios validant la persistance des hints et la pagination corrélée.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 101)
- ✅ Propagé les flux stdout/stderr des enfants vers `ResourceRegistry` avec les hints `jobId`/`runId`/`opId`/`graphId`/`nodeId` en étendant `ChildSupervisor` et le callback `recordChildLogEntry` du serveur.
- ✅ Aligné les schémas de logs enfants (`ResourceChildLogEntry`) pour conserver `raw`/`parsed` et ajouté une couverture déterministe (`tests/child.supervisor.test.ts`, `tests/resources.list-read-watch.test.ts`).
- 🔜 Vérifier que les outils MCP (`resources_watch`) exposent correctement les nouveaux champs côté clients et propager la même corrélation vers un éventuel `logs_tail` une fois implémenté.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 102)
- ✅ Étendu `ChildRuntime` avec `setRole`/`setLimits`/`attach`, persisté le rôle dans le manifeste et mémorisé les limites pour les mises à jour à chaud.
- ✅ Enrichi `ChildrenIndex` avec `role`/`limits`/`attachedAt` + API dédiées, ajouté les outils MCP `child_spawn_codex`/`child_attach`/`child_set_role`/`child_set_limits` et synchronisé le serveur.
- ✅ Couverture dédiée `tests/child.spawn-attach-limits.test.ts` validant rôle/limites/attach + restauration sérialisée du nouvel état, MAJ AGENTS checklist.
- ✅ Propager le champ `role` côté `GraphState`/dashboard et exposer les nouvelles opérations dans la documentation MCP (couvert itération 103 pour la partie GraphState/dashboard ; la documentation reste à compléter).

### 2025-10-04 – Agent `gpt-5-codex` (iteration 103)
- ✅ Propagé `role`/`limits`/`attachedAt` depuis `ChildrenIndex` vers `GraphState`, incluant sérialisation déterministe des limites et normalisation des snapshots enfants.
- ✅ Mis à jour le dashboard SSE pour exposer les nouveaux attributs (rôle, limites, attachements) et documenté les champs ajoutés.
- ✅ Étendu `tests/graphState.test.ts` et les doubles de supervision/autoscaler afin de couvrir les nouvelles métadonnées.
- ✅ Documenté les nouveaux outils enfants (`child_*`), reflété le champ `role` côté documentation/CLI et vérifié que `resources_watch` expose les métadonnées enrichies.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 104)
- ✅ Actualisé `README.md` pour détailler `child_spawn_codex`, `child_attach`, `child_set_role`, `child_set_limits` et noter la propagation des hints de corrélation.
- ✅ Complété `docs/mcp-api.md` avec les structures `ResourceRunEvent`/`ResourceChildLogEntry` enrichies et la section dédiée aux contrôles fins du runtime enfant.
- ✅ Vérifié que la checklist reflète l'avancement (entrée déplacée en ✅) et noté le contexte pour le prochain agent.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 105)
- ✅ Implémenté `GraphTransactionManager` avec gestion TTL/owner/note, snapshot committedAt et détection des commits no-op (`src/graph/tx.ts`).
- ✅ Exposé les outils MCP `tx_begin`/`tx_apply`/`tx_commit`/`tx_rollback` avec logs corrélés, validation Zod des opérations et enregistrement des snapshots/versions (`src/server.ts`, `src/tools/txTools.ts`).
- ✅ Étendu le registry ressources pour stocker snapshots/versions et écrit `tests/tx.begin-apply-commit.test.ts` couvrant conflit, rollback, aperçu `preview_version`; exécuté `npm run build`, `npm run lint`, `npm test`.
- 🔜 Enchaîner sur diff/patch + invariants (section 2.2), puis verrous/idempotency afin de fiabiliser les transactions concurrentes avant d'ouvrir les opérations bulk.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 106)
- ✅ Ajouté la paire diff/patch (`src/graph/diff.ts`, `src/graph/patch.ts`) et le module d'invariants (`src/graph/invariants.ts`) pour couvrir DAG, labels, ports et cardinalités.
- ✅ Enregistré les outils MCP `graph_diff`/`graph_patch` dans `src/server.ts`, avec schémas dédiés (`src/tools/graphDiffTools.ts`) et intégration au registre `sc://`.
- ✅ Rédigé des tests déterministes (`tests/graph.diff-patch.test.ts`, `tests/graph.invariants.enforced.test.ts`) et mis à jour la documentation (`README.md`, `docs/mcp-api.md`).
- 🔜 Préparer les verrous/idempotency (sections 2.3/2.4) puis couvrir le bulk pour sécuriser les mutations concurrentes.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 107)
- ✅ Implémenté `GraphLockManager` (`src/graph/locks.ts`) avec TTL rafraîchissable, ré-entrance par holder et erreurs structurées (`E-GRAPH-LOCK-HELD`, `E-GRAPH-MUTATION-LOCKED`).
- ✅ Ajouté les outils MCP `graph_lock`/`graph_unlock` (`src/tools/graphLockTools.ts`, `src/server.ts`), branché `graph_patch`, `graph_mutate` et `tx_*` sur le gestionnaire de verrous, et documenté l'usage (`README.md`, `docs/mcp-api.md`).
- ✅ Couverture déterministe `tests/graph.locks.concurrent.test.ts` + enrichissement des suites existantes (`tests/graph.diff-patch.test.ts`, `tests/tx.begin-apply-commit.test.ts`) pour vérifier le rejet concurrent.
- 🔜 Enchaîner sur les clés d'idempotence (section 2.4) avant d'aborder les opérations bulk atomiques.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 108)
- ✅ Créé un registre `IdempotencyRegistry` avec TTL injectables et intégration serveur (`src/infra/idempotency.ts`, `src/server.ts`).
- ✅ Ajouté la prise en charge de `idempotency_key` + `idempotent` pour `child_create`, `child_spawn_codex`, `plan_run_bt`, `cnp_announce` et `tx_begin` avec journalisation dédiée.
- ✅ Documenté le comportement dans `README.md`/`docs/mcp-api.md` et ajouté `tests/idempotency.replay.test.ts` couvrant les replays, plus adaptations des suites existantes.
- 🔜 Étendre l'idempotence aux futures opérations bulk (`graph_batch_mutate`, batch enfants/stigmergie) et aligner les clients sur les nouveaux champs.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 109)
- ✅ Ajouté l'idempotence à `plan_run_reactive` (schéma, cache et journalisation `plan_run_reactive_replayed`) en factorisant `executePlanRunReactive`.
- ✅ Étendu la documentation (`README.md`, `docs/mcp-api.md`) et les suites (`tests/idempotency.replay.test.ts`, `tests/plan.run-reactive.test.ts`, `tests/plan.bt.events.test.ts`) pour refléter les drapeaux `idempotent`/`idempotency_key`.
- ✅ Nettoyé `node_modules/` après exécution de `npm run build`, `npm run lint`, `npm test` et suppression des artefacts `children/` temporaires.
- 🔜 Couvrir les opérations bulk (`graph_batch_mutate`, fan-out multi-enfants) avec le cache idempotent et vérifier la compatibilité côté clients MCP.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 110)
- ✅ Introduit `BlackboardStore.batchSet` pour appliquer plusieurs mutations atomiquement et restaurer l'état en cas d'échec.
- ✅ Exposé le tool MCP `bb_batch_set` (`src/tools/coordTools.ts`, `src/server.ts`) et documenté son usage (`README.md`, `docs/mcp-api.md`).
- ✅ Créé `tests/bulk.bb-graph-child-stig.test.ts` avec une couverture dédiée `bb_batch_set` (succès + rollback). Les opérations bulk graph/enfant/stig restent à implémenter.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 111)
- ✅ Finalisé les tools bulk `graph_batch_mutate`, `child_batch_create` et `stig_batch` côté serveur avec journalisation et support idempotent.
- ✅ Mis à jour `README.md` et `docs/mcp-api.md` pour détailler les nouveaux schémas (`StigBatchInput`, `GraphBatchMutateInput`, `ChildBatchCreateInput`) et clarifier les champs `created`/`changed`.
- ✅ Étendu `tests/bulk.bb-graph-child-stig.test.ts` avec les scénarios de version attendue, no-op, comptage `created` et rollback enfants ; exécuté la suite complète (`npm run build`, `npm run lint`, `npm test`).
- 🔜 Couvrir l'émission des événements bus/corrélations pour les outils bulk côté serveur et ajouter un test d'intégration MCP end-to-end.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 112)
- ✅ Propagé les identifiants de corrélation (run/op/job) dans le Contract-Net (`contractNet.announce`, snapshots, évènements bus) et dans l'outillage `cnp_announce`.
- ✅ Mis à jour `bridgeContractNetEvents` pour fusionner automatiquement les corrélations natives avec les résolveurs optionnels.
- ✅ Étendu la couverture (`tests/events.bridges.test.ts`, `tests/e2e.contract-net.consensus.test.ts`) pour vérifier la présence des métadonnées et la sérialisation côté tool ; exécuté `npm ci`, `npm test`.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 113)
- ✅ Durci `bridgeContractNetEvents` afin que les résolveurs ne puissent plus écraser les corrélations natives avec des valeurs `undefined`, en factorisant `mergeCorrelationHints` côté source et dist (`src/events/bridges.ts`, `dist/events/bridges.js`).
- ✅ Ajouté un test de régression vérifiant que les auto-bids conservent `runId/opId` même lorsque le resolver renvoie `undefined` (`tests/events.bridges.test.ts`).
- ✅ Exécuté la suite complète (`npm ci`, `npm test`), puis nettoyé les artefacts temporaires (`children/`, `node_modules/`).

### 2025-10-04 – Agent `gpt-5-codex` (iteration 114)
- ✅ Extrait les utilitaires de corrélation dans `src/events/correlation.ts` et synchronisé la version dist pour réutiliser `mergeCorrelationHints` sans duplication.
- ✅ Aligné `bridgeContractNetEvents`, le superviseur enfant et la suite de tests sur le nouveau module partagé, en ajoutant une couverture unitaire dédiée (`tests/events.correlation.test.ts`).
- 🔜 Étendre l'utilisation du module de corrélation aux autres passerelles (executor/agents) afin de finaliser la checklist "Event bus unifié & corrélation".

### 2025-10-04 – Agent `gpt-5-codex` (iteration 115)
- ✅ Préservé les indices de corrélation natifs du `ChildSupervisor` en fusionnant les résolveurs via `mergeCorrelationHints` pour éviter qu'un `undefined` efface `childId/runId/opId`.
- ✅ Ajouté un scénario `tests/child.supervisor.test.ts` garantissant que les journaux enfants conservent les identifiants quand le résolveur est clairsemé.
- ✅ Propager la fusion sûre des corrélations vers les autres passerelles (`executor/*`, `agents/*`) afin de clôturer la tâche "Event bus unifié & corrélation".

### 2025-10-04 – Agent `gpt-5-codex` (iteration 116)
- ✅ Harmonisé les passerelles d'événements annulés/enfants/consensus/values avec `mergeCorrelationHints` pour empêcher les résolveurs clairsemés de purger `runId/opId/jobId`.
- ✅ Ajouté des régressions ciblées (`tests/events.bridges.test.ts`) couvrant les résolveurs qui retournent `undefined` ou `null` et vérifié que les identifiants natifs subsistent.
- ✅ Exécuté `npm run lint`, `npm run build`, `npm test`.
- 🔜 Auditer les autres émetteurs d'événements (plan/executor/agents restants) pour confirmer l'absence de fuites `undefined` et préparer l'exposition côté tools MCP (`events_subscribe`, cancel/bulk).

### 2025-10-04 – Agent `gpt-5-codex` (iteration 117)
- ✅ Propagé les corrélations fournies par les outils plan vers le bus unifié via `PlanEventEmitter` et `pushEvent`, en fusionnant les hints externes avec ceux extraits des payloads.
- ✅ Étendu `tests/plan.bt.events.test.ts` pour vérifier que les événements Behaviour Tree et réactifs exposent systématiquement les identifiants de corrélation.
- ✅ Exécuté `npm run lint`, `npm run build`, `npm test` (après `npm ci`) et nettoyé `node_modules/` et `children/` avant commit.
- 🔜 Finaliser l'alignement des autres émetteurs (`src/executor/*`, `src/agents/*`) afin que chaque événement plan/superviseur publie `runId/opId` sans dépendre exclusivement du payload.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 118)
- ✅ Ajouté `inferSupervisorIncidentCorrelation` pour dériver run/op/job/child depuis le contexte des incidents et alimenter `pushEvent` côté serveur.
- ✅ Créé `tests/agents.supervisor.correlation.test.ts` couvrant la normalisation camelCase/snake_case, les tableaux unitaires et la fusion non destructive des corrélations embarquées.
- ✅ Exécuté `npm test` (lint/build à planifier avec les prochaines itérations pour l'alignement complet des émetteurs restants).
- 🔜 Étendre la propagation des corrélations au reste des actions superviseur/autoscaler et boucler l'item "Modifier src/executor/*, src/agents/*".

### 2025-10-04 – Agent `gpt-5-codex` (iteration 119)
- ✅ Instrumenté l'autoscaler pour publier des événements `AUTOSCALER` via `pushEvent`, en fusionnant les corrélations issues des métadonnées enfants et des gabarits de spawn.
- ✅ Ajouté `tests/agents.autoscaler.correlation.test.ts` pour couvrir la retraite nominale, l'escalade forcée et l'échec du kill tout en vérifiant la préservation des hints run/op/job/graph/node.
- ✅ Étendu `EventStore` afin d'accepter la catégorie `AUTOSCALER` et branché le serveur sur le nouvel émetteur ; exécuté `npm run lint`, `npm run build`, `npm test`.
- 🔜 Poursuivre l'alignement des autres agents/exécuteurs (scheduler, metaCritic, etc.) afin de finaliser la case "Publier évènements standardisés avec opId/runId".

### 2025-10-04 – Agent `gpt-5-codex` (iteration 120)
- ✅ Étendu `events/correlation` avec `extractCorrelationHints` puis refactorisé `inferSupervisorIncidentCorrelation` et `ChildSupervisor` pour dériver automatiquement run/op/job/graph/node/child depuis les métadonnées runtime et index, supprimant la dépendance aux résolveurs ad-hoc.
- ✅ Ajouté des tests ciblés (`tests/events.correlation.test.ts`, `tests/child.supervisor.test.ts`) validant l'extraction (snake/camel case, blocs imbriqués, métadonnées enfants) et la propagation des hints sur le bus `child`.
- ✅ Regénéré les artefacts dist (`npm run build`), linté (`npm run lint`) et exécuté la suite complète (`npm test`) pour garantir l'absence de régressions.
- 🔜 Finaliser la case "Publier événements standardisés avec opId/runId" côté scheduler/agents restants (metaCritic/selfReflect, boucle réactive) en capitalisant sur `extractCorrelationHints` lorsque les métadonnées sont disponibles.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 121)
- ✅ Étendu `extractCorrelationHints` pour préserver les overrides explicites à `null` tout en normalisant les tableaux ambigus et fusionné l'autoscaler sur cette implémentation commune.
- ✅ Aligné `src/agents/autoscaler.ts` et `bridgeChildRuntimeEvents` sur le nouveau helper, garantissant que les métadonnées runtime/index et les templates de spawn conservent les identifiants sans effacer volontairement les `null`.
- ✅ Renforcé la couverture (`tests/events.correlation.test.ts`, `tests/agents.autoscaler.correlation.test.ts`, `tests/events.bridges.test.ts`) afin de couvrir les scénarios `null`/manifest extras/scale up ; exécuté `npm run lint`, `npm run build`, `npm test`.
- 🔜 Poursuivre l'audit des émetteurs restants (`src/executor/*`, autres agents) pour éliminer les duplications d'inférence et préparer la clôture de la checklist "Publier événements standardisés avec opId/runId".

### 2025-10-04 – Agent `gpt-5-codex` (iteration 122)
- ✅ Introduit `buildChildCognitiveEvents` et la catégorie `COGNITIVE` pour formaliser les revues metaCritic/selfReflect avec corrélations normalisées.
- ✅ Instrumenté `child_collect` afin d'émettre les événements de revue/réflexion corrélés via `pushEvent`, en s'appuyant sur les métadonnées `ChildrenIndex` et les nouveaux helpers.
- ✅ Ajouté les régressions `tests/events.cognitive.test.ts` pour valider la structure des payloads et la propagation des hints `runId/opId/graphId/nodeId`.
- 🔜 Aligner le reste des agents/exécuteurs (scheduler, metaCritic follow-ups, boucle réactive) pour clôturer la tâche "Publier événements standardisés avec opId/runId" et vérifier l'impact sur le streaming `events_subscribe`.

### 2025-10-04 – Agent `gpt-5-codex` (iteration 123)
- ✅ Ajouté `buildChildCorrelationHints` et sa couverture dédiée afin de normaliser l'agrégation des métadonnées enfants (job/run/op/graph/node) sans écraser les overrides explicites.
- ✅ Instrumenté `pushEvent` côté serveur (`child_prompt`, `child_chat`, `child_push_reply/partial`, `child_rename/reset`, TTL et `kill`) pour fusionner les hints `ChildrenIndex`/graph avant publication des événements `PROMPT`/`PENDING`/`REPLY`/`INFO`/`KILL`.
- ✅ Exécuté `npm run lint`, `npm run build`, `npm test` pour valider l'ensemble de la suite après durcissement des corrélations enfants.
- 🔜 Étendre l'alignement aux autres émetteurs serveur/agents (agrégations plan/status, superviseur metaCritic) afin de terminer la checklist "Publier événements standardisés avec opId/runId".

### 2025-10-05 – Agent `gpt-5-codex` (iteration 124)
- ✅ Introduit `buildJobCorrelationHints` pour agréger les métadonnées job/enfants et exposer `runId/opId/graphId/nodeId` sans répéter la logique d'extraction.
- ✅ Aligné les événements serveur `HEARTBEAT`/`STATUS`/`AGGREGATE`/`KILL` sur le nouveau résolveur de corrélation afin que les publications job-scopées propagent les identifiants `runId/opId` dérivés des enfants.
- ✅ Étendu `tests/events.correlation.test.ts` pour couvrir la construction des hints job et s'assurer que les overrides explicites à `null` restent respectés ; exécuté `npm run lint`, `npm run build`, `npm test`.
- 🔜 Harmoniser les autres émetteurs job/plan (agrégations supplémentaires, metaCritic/superviseur) pour clôturer l'item "Publier événements standardisés avec opId/runId" et vérifier l'impact côté streaming `events_subscribe`.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 125)
- ✅ Durci `buildJobCorrelationHints` en ignorant les identifiants job contradictoires, en gelant les overrides explicites à `null` pour les champs run/op/graph/node et en gardant l'autorité aux hints fournis par l'appelant serveur.
- ✅ Étendu `tests/events.correlation.test.ts` avec des scénarios `sources` vides, conflits non nuls et overrides mixtes pour prouver la nouvelle sémantique, puis régénéré `dist/events/correlation.js` et `dist/server.js` via `npm run build`.
- ✅ Nettoyé l'arbre de travail (`rm -rf node_modules children` avant install), réinstallé avec `npm ci`, exécuté `npm run lint`, `npm run build`, `npm test` et restauré un état propre sans artefacts non suivis.
- ✅ Ajouté une couverture `events_subscribe` ciblant les événements `STATUS`/`AGGREGATE` (plan_join/plan_reduce) afin de sécuriser les corrélations plan côté bus MCP.
- 🔜 Vérifier les émetteurs job-plan restants (metaCritic, flux bulk supplémentaires) et mesurer l'impact perf du resolver `HEARTBEAT` sur de longues séries.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 126)
- ✅ Factorisé `emitHeartbeatTick` et ajouté `stopHeartbeat` pour déclencher/arrêter les battements manuellement tout en exportant `childSupervisor` afin de préparer des scénarios de tests déterministes.
- ✅ Ajouté le test d'intégration `tests/events.subscribe.job-correlation.test.ts` qui vérifie que `events_subscribe` renvoie bien les événements `HEARTBEAT`/`STATUS`/`AGGREGATE` corrélés (`runId/opId/graphId/nodeId`) après des invocations réelles des outils.
- 🔜 Étendre la couverture aux flux d'événements child/job restants (ex. `logs_tail`, `plan_run_reactive`) et auditer les timers heartbeat pour supporter des cadences configurables côté orchestrateur.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 127)
- ✅ Ajouté le scénario d'intégration `tests/events.subscribe.child-correlation.test.ts` pour vérifier que les outils `child_prompt` et `child_push_partial` publient des événements `PROMPT`/`PENDING`/`REPLY_PART`/`REPLY` corrélés (`runId/opId/graphId/nodeId/childId`).
- ✅ Confirmé que le streaming `events_subscribe` filtré par `child_id` restitue la corrélation complète après configuration du bus MCP.
- 🔜 Couvrir `logs_tail` et les flux plan (`plan_run_reactive`, fan-out) côté `events_subscribe`, puis poursuivre l'audit des émetteurs `src/executor/*` pour clôturer la case "Publier événements standardisés avec opId/runId".
### 2025-10-05 – Agent `gpt-5-codex` (iteration 128)
- ✅ Ajouté le test d'intégration `tests/events.subscribe.plan-correlation.test.ts` pour confirmer que `plan_run_bt` et `plan_run_reactive` publient des événements `BT_RUN` corrélés via `events_subscribe`.
- ✅ Couvert `plan_fanout` sur le bus MCP en vérifiant les événements `PLAN` corrélés et en nettoyant les clones factices après exécution.
- 🔜 Implémenter l'outil `logs_tail` puis ajouter la couverture `events_subscribe` associée afin de finaliser l'observabilité des logs.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 129)
- ✅ Créé `src/monitor/log.ts` pour journaliser en JSONL les flux serveur/run/enfant avec corrélation `runId/opId/graphId/childId` et rotation.
- ✅ Instrumenté `src/server.ts` afin d'enregistrer les événements dans le journal corrélé, exposé le tool MCP `logs_tail` et propagé les erreurs sans bloquer l'orchestrateur.
- ✅ Ajouté `tests/logs.tail.filters.test.ts` pour couvrir les filtres `from_seq`, la validation d'identifiants et les entrées serveur par défaut.
- 🔜 Étendre la couverture aux flux `events_subscribe` restants (logs tail + dashboards) et observer l'impact perf de la persistance JSONL sur des séries longues.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 130)
- ✅ Normalisé `plan_dry_run` pour accepter des graphes hiérarchiques ou normalisés, générer des hints `reroute-avoid` automatiques et consigner les métriques appliquées (règles invoquées, nœuds/labels évités).
- ✅ Ajouté des tests unitaires couvrant les prévisualisations de réécriture (split parallèle, inline subgraph, reroute) et enrichi `tests/plan.lifecycle.test.ts` avec la reprise après complétion et les erreurs `pause` sans contrôles.
- ✅ Étendu la couverture intégration `plan_status/pause/resume` pour vérifier l'erreur `E-PLAN-COMPLETED` et documenté le comportement dans le journal MCP.
- ✅ Permis aux appels `plan_dry_run` de fournir explicitement des listes `reroute_avoid` et noté le besoin de compléter la couverture autour des relances `plan_pause`/`resume` sur exécutions BT multi-nœuds.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 131)
- ✅ Accepté un bloc `reroute_avoid` explicite dans `plan_dry_run`, fusionné avec les heuristiques et restitué les listes dans la réponse.
- ✅ Étendu `tests/plan.dry-run.test.ts` avec un scénario pour les hints manuels et vérifié que les métriques reflètent les listes combinées.
- 🔜 Ajouter une couverture `plan_pause`/`resume` multi-nœuds et étendre les tests `events_subscribe` pour les plans relancés.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 132)
- ✅ Ajouté un scénario multi-nœuds dans `tests/plan.lifecycle.test.ts` pour couvrir `plan_pause`/`plan_resume` avec un arbre en séquence et vérifier l'exécution complète après reprise.
- ✅ Étendu `tests/events.subscribe.plan-correlation.test.ts` afin de valider le streaming des événements `BT_RUN` (start/node/complete) après une pause puis reprise d'un plan réactif corrélé.
- 🔜 Prolonger la couverture `events_subscribe` aux flux `PLAN`/`BT_RUN` lors de reprises multiples (pause/résume répétés) et auditer les snapshots `plan_status` pour les plans annulés afin de préparer les scénarios E2E restants.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 133)
- ✅ Ajouté la politique `quota` au nœud parallèle en normalisant la configuration côté runtime et en sécurisant les cas limites (`ParallelNode`, `BehaviorNodeDefinition`).
- ✅ Introduit le test ciblé `tests/bt.parallel.quota.test.ts` pour couvrir les succès/échecs de seuil et exécuté `npm run lint`, `npm test` pour garantir la stabilité.
- 🔜 Compléter les décorateurs restants (edge cases d'annulation `throwIfCancelled` non standard, quotas mixtes, garde/timeout additionnels) avant de cocher la case globale "Modifier src/executor/bt/nodes.ts" et finaliser la couverture associée.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 134)
- ✅ Exporté `BehaviorTreeCancellationError`, documenté la remontée d'annulation dans le README et réaligné la distribution `dist/` via `npm run build`.
- ✅ Rejoué `npm run lint`, `npm run build`, `npm run test:unit -- --exit` (verts) en nettoyant `children/`, `runs/` et `node_modules` pour garder l'arbre propre.
- 🔜 Ajouter des tests décorateurs couvrant les exceptions arbitraires renvoyées par `throwIfCancelled` et finaliser l'audit des scénarios de cancellation avant de clôturer la checklist "Modifier src/executor/bt/nodes.ts".

### 2025-10-05 – Agent `gpt-5-codex` (iteration 135)
- ✅ Normalisé `throwCancellation` pour encapsuler toute erreur arbitraire levée par `throwIfCancelled` dans un `BehaviorTreeCancellationError` tout en préservant la cause pour les orchestrateurs externes (`src/dist/executor/bt/nodes`).
- ✅ Ajouté deux scénarios ciblés dans `tests/bt.decorators.retry-timeout-cancel.test.ts` pour vérifier l'encapsulation des erreurs `throwIfCancelled` et la réinitialisation systématique des enfants lorsque l'annulation survient avant ou après un tick.
- ✅ Exécuté `npm run lint`, `npm run build`, `npm test` (418 tests verts) après régénération des artefacts afin de garantir l'absence de régressions.
- 🔜 Étendre la couverture cancellation aux décorateurs `guard`/`timeout` lorsque `throwIfCancelled` remonte des causes typées personnalisées et auditer les combinaisons quotas/annulation restantes avant de clôturer l'item "Modifier src/executor/bt/nodes.ts".

### 2025-10-05 – Agent `gpt-5-codex` (iteration 136)
- ✅ Durci `GuardNode` et `TimeoutNode` pour réinitialiser les enfants lors des annulations coopératives et propager fidèlement les `OperationCancelledError` ou causes personnalisées, en couvrant `throwIfCancelled` avant/après ticks.
- ✅ Enrichi `tests/bt.decorators.retry-timeout-cancel.test.ts` avec des scénarios `guard`/`timeout` (causes arbitraires, erreurs typées) et vérifié le wrapping `BehaviorTreeCancellationError` ainsi que la préservation des reset.
- ✅ Rejoué `npm run lint`, `npm run build`, `npm test` (422 tests verts) pour confirmer l'absence de régressions après régénération des artefacts.
- 🔜 Auditer les combinaisons quota/annulation restantes et couvrir les décorateurs `guard`/`timeout` face aux causes typées côté runtime (ex. signaux scheduler) avant de clôturer "Modifier src/executor/bt/nodes.ts".

### 2025-10-05 – Agent `gpt-5-codex` (iteration 137)
- ✅ Durci `RetryNode` pour qu'il restaure proprement ses compteurs et enfants lorsqu'une annulation survient avant, pendant ou après l'attente de backoff (`src/executor/bt/nodes.ts`, `dist/executor/bt/nodes.js`).
- ✅ Ajouté trois scénarios ciblés dans `tests/bt.decorators.retry-timeout-cancel.test.ts` couvrant les annulations pré-tick, intra-tick et pendant le backoff, avec vérification des resets et de la propagation des erreurs typées.
- ✅ Exécuté `npm run lint`, `npm run build`, `npm test`, puis `npm run test:unit -- --exit` (425 tests verts) en restaurant `node_modules/` après nettoyage pour éviter les divergences.
- 🔜 Poursuivre l'audit des autres décorateurs/composites (séquence, sélecteur, tâches leaf) pour confirmer la remise à zéro côté annulation et préparer des tests d'intégration quotas × cancellation avant de valider "Modifier src/executor/bt/nodes.ts".

### 2025-10-05 – Agent `gpt-5-codex` (iteration 138)
- ✅ Durci `SequenceNode` et `SelectorNode` pour qu'ils réinitialisent systématiquement leur curseur et leurs enfants lorsqu'une annulation est détectée avant l'invocation du prochain enfant ou lorsqu'un enfant propage `OperationCancelledError`/`BehaviorTreeCancellationError`.
- ✅ Ajouté la suite dédiée `tests/bt.composites.cancel.test.ts` couvrant les annulations pré-tick et intra-tick sur les composites séquence/sélecteur, avec vérification des resets et de la reprise réussie après levée de l'annulation.
- ✅ Rejoué `npm run lint`, `npm run build`, `npm test` pour garantir l'absence de régression après régénération des artefacts.
- ✅ Audité les feuilles (`TaskLeaf` et outils associés) face aux annulations surfacées par `invokeTool` et préparé les scénarios quotas × cancellation afin de terminer l'item "Modifier src/executor/bt/nodes.ts".

### 2025-10-05 – Agent `gpt-5-codex` (iteration 139)
- ✅ Normalisé `TaskLeaf` pour convertir les erreurs d'annulation `AbortError` en `BehaviorTreeCancellationError`, vérifier la coopération après résolution de `invokeTool` et préserver la propagation des `OperationCancelledError` natifs.
- ✅ Ajouté la suite `tests/bt.tasks.cancel.test.ts` couvrant les annulations pré-invocation, intra-invocation (erreurs abort) et post-invocation tout en s'assurant que `invokeTool` n'est pas appelé inutilement.
- ✅ Exécuté `npm run lint`, `npm run build`, `npm test` pour confirmer l'absence de régressions après régénération des artefacts.
- 🔜 Préparer les scénarios de tests combinant quotas parallèles et annulation (`ParallelNode` × `BehaviorTreeCancellationError`) puis auditer les interactions côté outils MCP pour clôturer "Modifier src/executor/bt/nodes.ts".

### 2025-10-05 – Agent `gpt-5-codex` (iteration 140)
- ✅ Durci `ParallelNode` pour qu'il réinitialise ses caches de statut et ses enfants dès qu'une annulation coopérative survient, en harmonisant la propagation des erreurs et en attendant la stabilisation de toutes les branches (`Promise.allSettled`).
- ✅ Ajouté `tests/bt.parallel.cancel.test.ts` couvrant la remontée d'annulation par un enfant ainsi que l'annulation déclenchée par `throwIfCancelled`, avec vérification des resets et de la reprise sous politique `quota`.
- ✅ Exécuté `npm run lint`, `npm run build`, `npm test:unit -- --exit` puis `(graph-forge) npm run build` pour garantir la régénération des artefacts et la stabilité de la suite (435 tests verts).
- 🔜 Étendre la couverture aux politiques `all`/`any` sous annulation et préparer des scénarios intégration (plan_run_bt + parallel quota) avant de finaliser la case "Modifier src/executor/bt/nodes.ts" et d'auditer la propagation côté outils MCP.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 141)
- ✅ Étendu `tests/bt.parallel.cancel.test.ts` avec des scénarios `all` et `any` qui vérifient la remise à zéro complète après annulation (enfant qui annule, runtime `throwIfCancelled` post-exécution) et documenté les gardes coopératifs supplémentaires.
- ✅ Rejoué `npm run lint`, `npm run build`, `npm run test:unit -- --exit` pour confirmer que la couverture accrue n'introduit pas de régression et que les artefacts `dist/` restent inchangés.
- 🔜 Préparer les scénarios d'intégration `plan_run_bt` × `ParallelNode` (politiques quota/all/any sous annulation) et auditer la propagation des erreurs côté outils MCP avant de clôturer "Modifier src/executor/bt/nodes.ts".

### 2025-10-05 – Agent `gpt-5-codex` (iteration 142)
- ✅ Couvert `plan_run_bt` × `ParallelNode` pour les politiques quota/all/any sous annulation via `tests/plan.bt.parallel-cancel.integration.test.ts`, en vérifiant les événements `BT_RUN` (`start/cancel/error/complete`) et la remise à zéro avant reprise.
- ✅ Audité la propagation des erreurs côté outils MCP lors des intégrations `plan_run_bt` annulées afin de préparer la normalisation réalisée à l'itération 143.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 143)
- ✅ Normalisé `plan_run_bt` et `plan_run_reactive` pour transformer les `BehaviorTreeCancellationError` en `OperationCancelledError`, consigner la raison d'annulation et émettre des événements `error` cohérents avant de remonter l'exception structurée.
- ✅ Ajouté `tests/plan.bt.cancel-normalisation.test.ts` ainsi qu'un scénario dédié dans `tests/plan.run-reactive.test.ts` pour valider la normalisation côté outils MCP, documenté le comportement dans le README et régénéré `dist/` via `npm run build`.
- 🔜 Préparer les scénarios quotas parallèles multi-niveaux et auditer la propagation des erreurs côté outils MCP hors `plan_run_*` (ex. `plan_cancel`, `plan_status`) avant de clôturer "Modifier src/executor/bt/nodes.ts".

### 2025-10-05 – Agent `gpt-5-codex` (iteration 144)
- ✅ Implémenté la persistance des nœuds (snapshot/restore) et le suivi de progression dans `BehaviorTreeInterpreter`, en harmonisant les décorateurs/composites avec des états sérialisables.
- ✅ Propagé le pourcentage de progression aux événements `plan_run_bt`/`plan_run_reactive` et ajusté le registre de lifecycle pour consommer les valeurs explicites.
- ✅ Ajouté `tests/bt.interpreter.snapshot.test.ts` et étendu `tests/plan.lifecycle.test.ts` pour couvrir la reprise et la priorité donnée aux pourcentages fournis.
- ✅ Documenté la nouvelle API de snapshot dans le README et régénéré les artefacts `dist/` via `npm run build`.
- 🔜 Finaliser l'audit des décorateurs restants (`src/executor/bt/nodes.ts`) et étendre les scénarios MCP (plan_cancel/plan_status) avec le nouveau suivi de progression.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 145)
- ✅ Reroulé `npm run test:unit -- --exit` jusqu'à complétion : conversion des doubles de tests `BehaviorNode` pour exposer `snapshot/restore/getProgress` et éviter les erreurs `this.root.getProgress is not a function`.
- ✅ Normalisé les stubs des suites scheduler/composites/décorateurs/perf pour qu'ils maintiennent un statut/pointeur sérialisable et restituent un pourcentage cohérent pendant les snapshots.
- ✅ Confirmé que la suite complète (444 tests) passe sans échec après l'ajout de la progression, laissant la pile MCP inchangée.
- 🔜 Poursuivre l'audit des décorateurs runtime restants et étendre les scénarios `plan_cancel`/`plan_status` intégrant `progress` comme indiqué à l'itération 144.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 146)
- ✅ `plan_cancel` retourne désormais `progress` et le snapshot `lifecycle` associé lorsque le suivi de progression est actif, avec journalisation de la progression finale pour les observateurs MCP.
- ✅ Ajouté un scénario d'intégration `plan_cancel` × `plan_status` vérifiant la remise à zéro après annulation et la surface des raisons dans les snapshots, avec temporisation contrôlée via fake timers.
- ✅ Documenté dans le README l'accès direct à la progression via `plan_cancel`/`plan_status` pour éviter les appels additionnels.
- ✅ Contrôler les réponses `plan_cancel` lorsque le lifecycle est désactivé et propager la progression aux autres outils d'arrêt (`op_cancel`) avant de clôturer l'item plan lifecycle.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 147)
- ✅ Factorisé la récupération des snapshots lifecycle côté serveur afin que `plan_cancel` et `op_cancel` exposent systématiquement progression et état lorsque disponibles, avec journalisation des dégradations.
- ✅ Étendu `tests/plan.lifecycle.test.ts` avec des scénarios couvrant `plan_cancel` sans lifecycle ainsi qu'`op_cancel` avec lifecycle actif pour vérifier la surface de progression et la propagation des raisons d'annulation.
- ✅ Documenté dans le README le nouveau comportement d'`op_cancel` et la dégradation à `null` lorsque le lifecycle est désactivé.
- 🔜 Auditer les outils lifecycle restants (`plan_status`, `plan_pause`, `plan_resume`) lorsque la fonctionnalité est désactivée afin de garantir des dégradations homogènes et des messages d'erreur documentés.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 148)
- ✅ Ajouté un helper `requirePlanLifecycle` qui journalise les appels lifecycle lorsque le registre est inactif et surface l'erreur `E-PLAN-LIFECYCLE-DISABLED` de manière cohérente dans `plan_status`/`plan_pause`/`plan_resume` (`src/tools/planTools.ts`).
- ✅ Couvert la dégradation côté outils via un scénario d'intégration vérifiant les erreurs et hints renvoyés lorsque le lifecycle est désactivé (`tests/plan.lifecycle.test.ts`).
- ✅ Documenté dans le README le comportement des outils lifecycle lorsque la fonctionnalité est désactivée.
- 🔜 Auditer l'émission d'événements lifecycle (`plan_status`/`plan_pause`/`plan_resume`) lorsque le registre est réactivé en cours de run afin de garantir la continuité des snapshots et préparer l'item suivant sur le scheduler réactif.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 149)
- ✅ Contextualisé les outils plan pour exposer en permanence le registre lifecycle tout en signalant l'état du flag, afin que les runs démarrés sans lifecycle continuent à publier des snapshots lorsque la fonctionnalité est réactivée (`src/tools/planTools.ts`, `src/server.ts`).
- ✅ Ajouté un scénario d'intégration qui désactive puis réactive le lifecycle en cours d'exécution pour vérifier la reprise immédiate du statut et des contrôles pause/reprise (`tests/plan.lifecycle.test.ts`).
- ✅ Documenté dans le README la continuité des snapshots lorsque la fonctionnalité est réactivée après coup.
- 🔜 Préparer les ajustements côté scheduler réactif afin d'observer la remise en route des reconcilers et des événements quand le lifecycle est réactivé dynamiquement.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 150)
- ✅ Ajouté un hook `afterTick` dans `ExecutionLoop` pour exposer la télémétrie des reconcilers (durées, statut, erreurs) et normalisé les identifiants de l'autoscaler/superviseur.
- ✅ Étendu `plan_run_reactive` pour sérialiser l'événement ordonnanceur (`event_payload`) et publier les reconcilers exécutés dans les événements `loop`, avec tests unitaires ciblant la réactivation lifecycle (`tests/executor.loop.reconciler.test.ts`, `tests/plan.run-reactive.test.ts`).
- ✅ Documenté dans le README les nouvelles métriques lifecycle (`tick_duration_ms`, liste des reconcilers) afin que les opérateurs puissent auditer la reprise après réactivation.
- 🔜 Vérifier la diffusion des nouvelles métadonnées côté SSE/events_subscribe et préparer l'observabilité du scheduler réactif dans le dashboard.

### 2025-10-05 – Agent `gpt-5-codex` (iteration 151)
- ✅ Vérifié que `events_subscribe` relaie les métadonnées `reconcilers` des événements `BT_RUN` (JSON Lines & SSE) en ajoutant un scénario d'intégration dédié (`tests/events.subscribe.plan-correlation.test.ts`).
- ✅ Documenté dans le README la récupération des reconcilers via `events_subscribe` pour guider les opérateurs.
- ✅ Rejoué `npm run lint`, `npm run build`, `npm run test:unit -- --exit` pour couvrir la nouvelle intégration.
- 🔜 Préparer l'instrumentation du dashboard SSE afin d'exposer les reconcilers et l'ordonnanceur réactif côté monitoring.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 152)
- ✅ Implémenté l'aging logarithmique et le quantum coopératif dans `ReactiveScheduler` afin d'éviter la famine sous charge continue tout en laissant l'event loop respirer (`agingHalfLifeMs`, `agingFairnessBoost`, `batchQuantumMs`, `maxBatchTicks`).
- ✅ Ajouté `tests/executor.scheduler.prio-aging.test.ts` couvrant la promotion des événements âgés et la coupure des batches selon le quantum.
- ✅ Documenté dans le README les nouveaux paramètres d'aging/quantum et rejoué `npm run lint`, `npm run build`, `npm run test:unit -- --exit`.
- 🔜 Brancher le dashboard SSE sur les compteurs de batch (`batchIndex`, `batchElapsedMs`) pour visualiser les yields du scheduler.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 153)
- ✅ Factorisé les utilitaires de tests du scheduler réactif (`ManualClock`, `ScriptedNode`, `BusyNode`) dans `tests/helpers/reactiveSchedulerTestUtils.ts` et mis à jour la suite `executor.scheduler.prio-aging` pour les réutiliser.
- ✅ Ajouté `tests/executor.scheduler.budgets.test.ts` afin de couvrir la remise à zéro des métriques de batch, la désactivation explicite des budgets coopératifs et la reprise après injection de nouveaux événements en cours de batch.
- ✅ Exécuté `npm run lint`, `npm run build`, `npm run test:unit -- --exit` (455 tests verts) puis nettoyé `children/` et `runs/`.
- 🔜 Instrumenter le dashboard SSE avec les métriques de batch (`batchIndex`, `ticksInBatch`, `batchElapsedMs`) et poursuivre l'audit stigmergie configurables (section 4.3).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 154)
- ✅ Rendu `StigmergyField` paramétrable (`defaultHalfLifeMs`, bornes min/max) et exposé un snapshot heatmap normalisé, tout en réutilisant ces données côté dashboard (`computeDashboardHeatmap`).
- ✅ Étendu `handleStigSnapshot` pour renvoyer la heatmap sérialisée, ajouté une batterie de tests (`tests/coord.stigmergy.field.test.ts`, `tests/monitor.dashboard*.test.ts`) couvrant les nouveaux comportements et les valeurs normalisées.
- ✅ Documenté les options de configuration/heatmap dans le README et mis à jour la checklist stigmergie.
- 🔜 Brancher la configuration stigmergie sur le serveur/CLI (flags ou config runtime) et diffuser les métriques normalisées côté SSE dashboard.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 156)
- ✅ Propagé les bornes stigmergiques jusqu'aux outils `plan_run_bt` / `plan_run_reactive` et aux événements `events_subscribe`, avec sérialisation normalisée (`pheromone_bounds`).
- ✅ Étendu `ReactiveScheduler` et le pont `bridgeStigmergyEvents` pour transporter les limites min/max ainsi que le plafond de normalisation, en ajoutant la couverture unitaire/intégration correspondante.
- ✅ Mis à jour la documentation (`README.md`) et les tests (`tests/coord.stigmergy.field.test.ts`, `tests/plan.run-reactive.test.ts`, `tests/events.subscribe.plan-correlation.test.ts`, `tests/events.bridges.test.ts`) pour vérifier la nouvelle télémétrie.
- 🔜 Finaliser la propagation des bornes dans les agents d'autoscaling / Contract-Net et auditer l'impact sur la priorisation scheduler.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 157)
- ✅ Propagé les bornes stigmergiques jusqu'à l'autoscaler : nouvelles mises à jour `updatePheromoneBounds`, événements incluant `pheromone_bounds` et couverture dédiée (`tests/plan.run-reactive.test.ts`, `tests/agents.autoscaler.correlation.test.ts`).
- ✅ Enrichi le Contract-Net (outil & pont d'événements) avec les limites normalisées, permettant à `cnp_announce` et aux événements `cnp_call_*` de refléter les bornes en vigueur ; tests `idempotency.replay` et `events.bridges` mis à jour.
- ✅ Documenté la propagation unifiée des bornes (autoscaler, Contract-Net) dans le README.
- ✅ Connecter les métriques de bornes aux dashboards (autoscaler/Contract-Net) et observer leur impact sur les heuristiques de sélection côté Contract-Net.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 158)
- ✅ Exposé `pheromone_bounds` dans les snapshots `/metrics` & `/stream` du dashboard et injecté les bornes normalisées dans la heatmap (`src/monitor/dashboard.ts`).
- ✅ Étendu les suites `monitor.dashboard` (HTTP & SSE) pour vérifier la présence des bornes normalisées et la stabilité du plafond de normalisation.
- ✅ Documenté la disponibilité des bornes côté dashboard dans le README afin d'aligner l'interface avec la télémétrie MCP.
- 🔜 Mettre à jour l'UI dashboard/autoscaler pour afficher explicitement `pheromone_bounds` (tableau, heatmap tooltip) et auditer l'exploitation des bornes côté heuristiques Contract-Net (scénarios variation plafond).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 159)
- ✅ Ajouté un résumé `stigmergy.rows` et une infobulle `heatmap.boundsTooltip` afin que le dashboard/UI autoscaler puissent afficher directement les bornes normalisées sans logique supplémentaire (`src/monitor/dashboard.ts`).
- ✅ Étendu les tests dashboard (HTTP & SSE) pour couvrir les nouvelles données de tableau/tooltip et documenté l'API (`README.md`).
- 🔜 Vérifier l'exploitation des bornes côté heuristiques Contract-Net (variation du plafond) et brancher l'autoscaler UI sur le tableau `stigmergy.rows`.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 160)
- ✅ `ContractNetCoordinator` capture désormais `pheromone_bounds` lors des annonces et les relaie aux snapshots/événements ; `handleCnpAnnounce` sérialise les bornes normalisées pour aligner l'outil avec la télémétrie scheduler (`src/coord/contractNet.ts`, `src/tools/coordTools.ts`).
- ✅ Ajouté `tests/coord.contractnet.pheromone-bounds.test.ts` pour vérifier l'évolution du plafond de normalisation et la conservation des bornes dans l'idempotence (`tests/idempotency.replay.test.ts`, `tests/events.bridges.test.ts` ajustés).
- ✅ Regénéré `dist/` via `npm run build` après lint + 460 tests verts (`npm run lint`, `npm run test:unit -- --exit`).
- ✅ Brancher l'autoscaler UI (dashboard/agents) sur `stigmergy.rows` pour exploiter les nouvelles bornes formatées (réalisé à l'itération 161).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 161)
- ✅ Étendu `stig_snapshot` pour exposer `pheromone_bounds`, un bloc `summary.rows` pré-formaté et `heatmap.bounds_tooltip`, en factorisant les helpers de formatage dans `src/coord/stigmergy.ts` afin que l'autoscaler/dashboard puissent consommer directement `stigmergy.rows`.
- ✅ Mis à jour `tests/coord.stigmergy.field.test.ts` avec un scénario couvrant la nouvelle sortie `stig_snapshot` et documenté les champs (`README.md`, `docs/mcp-api.md`).
- ✅ Rejoué `npm run lint`, `npm run test:unit -- --exit`, `npm run build` pour valider la compilation de `dist/`.
- ✅ Audité les heuristiques Contract-Net pour exploiter effectivement les bornes lors de la priorisation (`computeEffectiveCost`).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 162)
- ✅ Multiplé `busy_penalty` par un facteur de pression dérivé des bornes stigmergiques dans `computeEffectiveCost`, en exposant `computePheromonePressure` pour documenter le calcul et garder les tests alignés.
- ✅ Ajouté un scénario Contract-Net prouvant que la pression fait basculer l'attribution lorsque le plafond normalisé augmente, ainsi que des tests unitaires dédiés au helper (logarithme sur champ non borné).
- ✅ Documenté dans le README la modulation du `busy_penalty` par `pheromone_bounds`.
- ✅ (traité it.163) Évaluer la mise à jour dynamique des enchères heuristiques (`autoBid`) lorsque les bornes évoluent pendant la vie d'un call afin d'anticiper la ré-émission de bids sous forte pression.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 163)
- ✅ Ajouté `ContractNetCoordinator.updateCallPheromoneBounds` pour synchroniser les bornes d'un call ouvert et réémettre les enchères heuristiques avec la pression stigmergique actuelle (`auto_refresh`) sans toucher aux offres manuelles.
- ✅ Étendu `tests/coord.contractnet.pheromone-bounds.test.ts` afin de couvrir le rafraîchissement des bids, l'inclusion des nouveaux agents et le mode `refreshAutoBids: false`.
- ✅ Enrichi les snapshots (`auto_bid_enabled`, `metadata.pheromone_pressure`) et documenté l'API Contract-Net afin que les observateurs et outils MCP détectent la réémission des bids.
- ✅ Exposer le rafraîchissement des bornes côté outils/bridges (ex. commande MCP dédiée) et brancher le scheduler pour déclencher automatiquement `updateCallPheromoneBounds` lorsque la pression stigmergique évolue.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 164)
- ✅ Ajouté l'outil `cnp_refresh_bounds` et documenté la nouvelle commande MCP, y compris les champs `refreshed_agents` / `auto_bid_refreshed`.
- ✅ Branché `watchContractNetPheromoneBounds` pour auto-synchroniser les appels ouverts dès que les bornes stigmergiques évoluent et diffusé l'événement `cnp_call_bounds_updated` sur le bus.
- ✅ Étendu les suites de tests Contract-Net / bridges pour couvrir l'événement, le watcher et le flux outil → coordinateur.
- 🔜 Surveiller le bruit des rafraîchissements automatiques (coalescer les mises à jour successives, journaliser les suppressions potentielles) et envisager une API pour déclencher des rafraîchissements ciblés par tags d'appel.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 165)
- ✅ Ajouté une fenêtre de coalescence (`coalesce_window_ms`, 50 ms par défaut) au watcher Contract-Net pour regrouper les rafales de mises à jour stigmergiques avant de rafraîchir les appels ouverts.
- ✅ Adapté la suite `coord.contractnet.pheromone-bounds` avec une couverture asynchrone et un scénario de coalescence, garantissant un seul événement `call_bounds_updated` pour des rafales rapprochées.
- ✅ Documenté la nouvelle option dans le README et conservé le flush final lors du détachement du watcher pour ne pas perdre d'update en vol.
- ✅ Évaluer des métriques de télémétrie (compteur de rafraîchissements coalescés/supprimés) pour surveiller l'impact en production et décider d'exposer un contrôle par appel (`cnp_refresh_bounds` ciblé par tag) si nécessaire (traité it.166).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 166)
- ✅ Instrumenté `watchContractNetPheromoneBounds` avec un callback `onTelemetry` et un log `contract_net_bounds_watcher_telemetry` exposant les compteurs `received_updates`, `coalesced_updates`, `skipped_refreshes`, `flushes` et `applied_refreshes`.
- ✅ Étendu `tests/coord.contractnet.pheromone-bounds.test.ts` avec des scénarios de coalescence et de rafraîchissement inchangé vérifiant les nouveaux compteurs, ainsi que la propagation des instantanés de télémétrie au détachement.
- ✅ Documenté le callback de télémétrie dans le README et rejoué `npm run lint`, `npm run test:unit -- --exit`, `npm run build`.
- ✅ (traité it.167) Décider si l'on expose ces compteurs via une API MCP (par exemple `cnp_watch_bounds_telemetry`) ou via le dashboard Contract-Net pour diagnostiquer les suppressions de rafraîchissements en production.

### 2025-10-06 – Agent `gpt-5-codex` (iteration 167)
- ✅ Relié le watcher Contract-Net côté serveur avec un collecteur dédié (`ContractNetWatcherTelemetryRecorder`) et démarré l'observateur au boot pour alimenter automatiquement les métriques.
- ✅ Exposé les compteurs via l'outil MCP `cnp_watcher_telemetry`, enregistré `cnp_refresh_bounds` et enrichi la documentation (README + `docs/mcp-api.md`) avec la nouvelle surface.
- ✅ Ajouté un test unitaire couvrant l'outil de télémétrie ainsi que la configuration serveur, puis mis à jour `tests/coord.contractnet.pheromone-bounds.test.ts` en conséquence.
- ✅ Publier ces compteurs sur un flux dashboard/SSE pour surveiller les rafraîchissements en temps réel (ou proposer des filtres par tag d'appel côté API).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 168)
- ✅ Exposé `contractNetWatcherTelemetry` dans les réponses `/metrics` et `/stream` du dashboard afin que les snapshots SSE reflètent les compteurs du watcher Contract-Net.
- ✅ Ajouté une couverture HTTP/SSE dédiée vérifiant la sérialisation des compteurs (`tests/monitor.dashboard.test.ts`, `tests/monitor.dashboard.streams.test.ts`) et documenté le nouveau bloc dans le README.
- ✅ Routé le collecteur via `startDashboardServer` et mis à jour `AGENTS.md` pour clôturer la diffusion SSE.
- ✅ Brancher l'UI dashboard/autoscaler sur `contractNetWatcherTelemetry` (tableaux/graphes) afin d'exposer les compteurs en front-end (page HTML ajoutée it.171).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 169)
- ✅ Ajouté `createContractNetWatcherTelemetryListener` pour mutualiser l'enregistrement des compteurs du watcher et leur diffusion sur le bus d'événements (`cat:"contract_net"`, `msg:"cnp_watcher_telemetry"`).
- ✅ Branché le serveur sur ce listener afin que chaque rafraîchissement Contract-Net publie une entrée temps réel et continue d'alimenter le recorder (`src/events/bridges.ts`, `src/server.ts`).
- ✅ Étendu `tests/events.bridges.test.ts` avec une couverture dédiée, documenté l'événement dans `README.md`/`docs/mcp-api.md` et regénéré `dist/`.
- ✅ Implémenter la visualisation UI des compteurs `contractNetWatcherTelemetry` dans le dashboard/autoscaler (graphiques, tableaux) pour tirer parti du flux SSE et du nouvel événement bus (réalisé it.171).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 170)
- ✅ Aligné le dashboard (`/metrics`, `/stream`) sur la télémétrie Contract-Net en ajoutant `contractNetWatcherTelemetry` aux snapshots et en étendant les tests HTTP/SSE pour vérifier la présence et la stabilité des compteurs (`src/monitor/dashboard.ts`, `tests/monitor.dashboard*.test.ts`).
- ✅ Complété `ContractNetCoordinator` avec `listOpenCalls`, l'événement `call_bounds_updated` et les métadonnées `autoBidRefreshed`/`refreshedAgents` afin que le watcher et les outils exposent réellement les compteurs attendus (`src/coord/contractNet.ts`, `dist/coord/contractNet.js`).
- ✅ Regénéré les artefacts compilés (`npm run build`) après lint + 474 tests verts pour synchroniser `dist/` avec les sources.
- ✅ Brancher le front dashboard/autoscaler sur `contractNetWatcherTelemetry` (tableaux/graphes) maintenant que les snapshots exposent les compteurs et poursuivre l'audit des visualisations côté UI (complété it.171).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 171)
- ✅ Ajouté une page HTML `GET /` au dashboard affichant le résumé Contract-Net (compteurs, dernière émission, bornes) ainsi que les sections stigmergie et scheduler pour offrir une vue front-end immédiate (`src/monitor/dashboard.ts`).
- ✅ Étendu `tests/monitor.dashboard.test.ts` afin de valider la nouvelle route HTML et la présence des compteurs Contract-Net renderisés côté UI, puis documenté l'usage dans le README.
- ✅ Enrichir la page HTML avec des visualisations dynamiques (graphiques temps réel/SSE) et prévoir des captures UI pour la documentation opérateur (réalisé it.174).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 172)
- ✅ Restauré `ContractNetCoordinator.listOpenCalls`, la propagation de `autoBidRefreshed`/`refreshedAgents` et l'émission `call_bounds_updated` afin que le watcher Contract-Net et les outils MCP utilisent réellement ces données (`src/coord/contractNet.ts`).
- ✅ Aligné `events/bridges` pour sérialiser `cnp_call_bounds_updated` sur le bus avec les métadonnées de rafraîchissement attendues et régénéré les artefacts `dist/`.
- 🔜 Vérifier côté orchestrateur HTTP que le bootstrap dashboard + watcher fonctionne désormais sans erreur en environnement dist (relancer un `npm run start:dashboard`).

### 2025-10-06 – Agent `gpt-5-codex` (iteration 173)
- ✅ Ajouté un scénario `graph_batch_mutate` dans `tests/idempotency.replay.test.ts` pour prouver que les mutations sont rejouées depuis le cache tant que le TTL n’expire pas, avec un troisième appel qui revalide l’exécution après expiration.
- ✅ Marqué la checklist « Idempotency keys » comme complétée et documenté la couverture désormais exhaustive (tools + tests).
- ✅ Relancé `npm run start:dashboard` sur le bundle dist pour confirmer que le bootstrap dashboard/watcher fonctionne désormais sans erreur.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 174)
- ✅ Dynamisé la page HTML du dashboard (`GET /`) : connexion SSE automatique, statut visuel, re-rendu DOM sécurisé pour le watcher Contract-Net, la stigmergie et le scheduler (`src/monitor/dashboard.ts`).
- ✅ Ajouté des helpers d'échappement/serialisation pour sécuriser le bootstrap inline et aligné la mise en page initiale sur le rendu client.
- ✅ Renforcé `tests/monitor.dashboard.test.ts` avec des assertions sur le script SSE, l'échappement HTML et la présence du bootstrap dynamique.
- ✅ Documenté la mise à jour automatique côté README et validé que les snapshots SSE restent cohérents avec `/metrics`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 175)
- ✅ Corrigé le bootstrap SSE du dashboard pour interpoler le snapshot sérialisé au lieu de laisser l’expression littérale `${serialisedSnapshot}`, garantissant l’échappement de `<script>` côté HTML (`src/monitor/dashboard.ts`, `dist/monitor/dashboard.js`).
- ✅ Précisé dans le README que le HTML racine se met désormais à jour en continu via SSE sans rechargement manuel.
- ✅ Durci `tests/monitor.dashboard.test.ts` avec un motif `<script>` malveillant et une vérification de l’encodage `\u003c` afin de prévenir toute régression d’échappement.
- ✅ Rejoué `npm run lint`, `npm run build`, `npm run test:unit -- --exit` (475 tests verts) pour valider la correction et la génération `dist/`.
- 🔜 Ajouter un scénario de test couvrant les raisons SSE contenant des séparateurs Unicode (U+2028/U+2029) afin de vérifier l’échappement côté client.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 176)
- ✅ Étendu `tests/monitor.dashboard.test.ts` avec un motif Contract-Net combinant `<script>` et les séparateurs Unicode U+2028/U+2029 pour confirmer que le bootstrap SSE les sérialise via `\u2028`/`\u2029`.
- ✅ Vérifié que le HTML du dashboard affiche toujours le résumé Contract-Net sans injection tout en conservant les libellés « next line » / « paragraph ».
- 🔜 Prévoir un audit des flux SSE multi-lignes (reasons volumineuses) afin de confirmer l’absence de fragmentation côté clients streaming.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 177)
- ✅ Normalisé le flux SSE `/stream` pour sérialiser chaque snapshot sur une seule ligne (échappement `\n`/`\r`/U+2028/U+2029) et éviter la fragmentation côté clients `EventSource`.
- ✅ Ajouté un test `monitor.dashboard.streams` couvrant une raison Contract-Net multi-ligne avec séparateurs Unicode afin de garantir la stabilité du transport et la restitution exacte après `JSON.parse`.
- ✅ Documenté l’invariance côté README et vérifié que le flux d’événements reste propre via `StreamResponse`.
- ✅ Étendre l’audit aux flux SSE `events_subscribe` / watchers futurs pour partager l’utilitaire d’échappement et ajouter une couverture d’intégration avec un parser SSE côté tests (voir it.178).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 178)
- ✅ Factorisé l’échappement SSE dans `src/events/sse.ts` et réutilisé le helper côté dashboard et `events_subscribe` pour garantir un transport monoligne.
- ✅ Ajouté `tests/events.subscribe.sse-escaping.test.ts` : le scénario annote un cancel avec `\r`, `\n`, `U+2028`/`U+2029`, vérifie que le flux SSE ne contient plus ces séparateurs et que `JSON.parse` restitue bien la raison.
- ✅ Documenté la normalisation SSE dans le README et `docs/mcp-api.md`, puis mis à jour `dist/` via `npm run build` après lint/tests.
- ✅ Enrichir la couverture avec un parseur SSE événement par événement (stream réel) et aligner les futurs watchers (`resources_watch` notamment) sur `serialiseForSse` dès leur implémentation (parseur couvert it.179, alignement watchers à appliquer lors de leur exposition SSE).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 179)
- ✅ Ajouté `tests/helpers/sse.ts` avec un parseur SSE côté tests pour valider le framing événement par événement.
- ✅ Étendu `tests/events.subscribe.sse-escaping.test.ts` afin d’utiliser le parseur et d’asserter chaque bloc `data:` après `JSON.parse`.
- ✅ Rejoué `npm run lint`, `npm run test:unit -- --exit`, `npm run build` (477 tests verts) et mis à jour cette checklist.
- ✅ Propagé `serialiseForSse` au flux `resources_watch` lors de l'implémentation du format SSE (voir it.183).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 180)
- ✅ Ajouté `tests/concurrency.events-backpressure.test.ts` pour simuler un drain limité du bus d'événements et vérifier l'absence de pertes (`next_seq` prêt pour le keep-alive).
- ✅ Couvert `resources_watch` sur les événements de run en paginant via `from_seq`/`limit`, en validant `nextSeq` et la reprise après un keep-alive.
- ✅ Étendu la couverture backpressure aux journaux enfants (`sc://children/<id>/logs`) pour préparer le branchement SSE (voir it.181).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 181)
- ✅ Ajouté `tests/concurrency.child-logs-backpressure.test.ts` pour vérifier la pagination déterministe des journaux enfants, y compris les keep-alives et la reprise après ajout d'entrées.
- ✅ Couvert les drains intercalés sur plusieurs enfants afin de prouver que chaque seau conserve ses propres curseurs sans fuite d'événements.
- ✅ Aligné les watchers enfants/run sur le flux SSE via le format `resources_watch` `sse` (couvert it.183).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 182)
- ✅ Ajouté `src/resources/sse.ts` avec les helpers `serialiseResourceWatchResultForSse` et `renderResourceWatchSseMessages` afin de produire des messages `resource_run_event`/`resource_child_log`/`resource_keep_alive` échappés pour le futur flux SSE.
- ✅ Écrit `tests/resources.watch.sse.test.ts` en s'appuyant sur `parseSseStream` pour garantir l'échappement (`\n`, `\r`, `U+2028`, `U+2029`) et la réversibilité des payloads, y compris le cas keep-alive.
- ✅ Documenté le format SSE (README + docs/mcp-api.md) et noté que `next_seq` est inclus pour faciliter les reconnexions.
- ✅ Branché les helpers SSE dans le tool `resources_watch` (format `sse`) et vérifié la propagation des métadonnées côté client/tests (it.183).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 183)
- ✅ Ajouté le paramètre `format="sse"` au tool `resources_watch` pour générer `messages` et `stream` via les helpers SSE partagés.
- ✅ Couvert l'intégration MCP (client in-memory) en vérifiant l'échappement monoligne et la fidélité des payloads SSE.
- ✅ Actualisé README + `docs/mcp-api.md` et exporté `resources` afin de faciliter les scénarios de test autour du registre.
- 🔜 Envisager une route HTTP/SSE dédiée (`/resources/watch/stream`) si un flux long-lived hors MCP devient nécessaire.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 184)
- ✅ Créé `src/knowledge/assist.ts` pour générer des fragments `HierGraph` avec couverture, sources et rationales (`kg_suggest_plan`).
- ✅ Enregistré l'outil `kg_suggest_plan` côté serveur (gating `enableAssist` + `enableKnowledge`) et ajouté la normalisation des erreurs.
- ✅ Écrit `tests/assist.kg.suggest.test.ts` (fragments préférés, exclusions, handler) puis documenté l'outil dans `docs/mcp-api.md` et le README.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 185)
- ✅ Ajouté des index composés `(s,p)` et `(o,p)` au `KnowledgeGraph` pour accélérer les requêtes déterministes et documenté la logique.
- ✅ Étendu `tests/knowledge.kg.insert-query.test.ts` pour couvrir les filtres combinés et exécuté `npm run test:unit` (489 tests verts) puis `npm run build`.
- ✅ Regénéré `dist/knowledge/knowledgeGraph.js` après compilation TypeScript et remis `node_modules` dans l'état initial après usage de `npm ci`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 186)
- ✅ Raffiné `collectCandidates` du `KnowledgeGraph` pour prioriser la clé primaire et les index composés tout en triant par sélectivité avant intersection.
- ✅ Ajouté un test ciblant la recherche exacte par clé primaire et re-compilé `dist/knowledge/knowledgeGraph.js`.
- ✅ Exécuté `npm ci`, `npm run test:unit -- --exit tests/knowledge.kg.insert-query.test.ts` (490 tests) et `npm run build` puis restauré l'arborescence `node_modules`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 187)
- ✅ Créé `tests/concurrency.graph-mutations.test.ts` pour simuler des patchs concurrents sur un graphe verrouillé et vérifier l'absence de deadlock via `GraphLockManager`.
- ✅ Validé le scénario en exécutant `npm run test:unit -- --exit tests/concurrency.graph-mutations.test.ts` et vérifié l'impact sur la version du graphe.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 188)
- ✅ Ajouté `tests/cancel.random-injection.test.ts` pour injecter des annulations pseudo-aléatoires pendant `plan_run_reactive` et vérifier la libération des handles.
- ✅ Vérifié les événements `BT_RUN` (start/cancel/error) et la suppression des entrées de registre d'annulation, puis confirmé qu'une exécution finale sans annulation réussit (`npm run test:unit -- --exit tests/cancel.random-injection.test.ts`).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 189)
- ✅ Créé `tests/perf/scheduler.bench.ts` pour comparer baseline et stigmergie avec deltas chiffrés et résumé CLI.
- ✅ Ajouté le script `scripts/retry-flaky.sh` (paramétrable via `RETRY_FLAKY_ATTEMPTS`) et documenté son usage dans le README.
- ✅ Mis à jour `package.json` (`bench:scheduler`) et le README pour refléter le nouveau rapport de bench et les outils anti-flaky.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 190)
- ✅ Ajouté `tests/perf/scheduler.bench.unit.test.ts` pour valider l'analyse des variables d'environnement, le rendu tabulaire et le calcul des deltas du benchmark scheduler.
- ✅ Couvert la comparaison baseline/stigmergie via un scénario réduit pour vérifier les métriques dérivées sans dépendre du chronométrage réel.
- ✅ Mis à jour `AGENTS.md` en cochant les sections bulk BT/causal/values/dashboard déjà implémentées afin d'aligner la checklist avec l'état réel du dépôt.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 191)
- ✅ Repassé sur l'autoscaler/superviseur : confirmé la gestion des métriques backlog/latence/échec, la détection de stagnation et la mitigation starvation + loop.
- ✅ Vérifié la couverture via `tests/agents.autoscaler.scale-updown.test.ts`, `tests/agents.autoscaler.cooldown.test.ts`, `tests/agents.supervisor.unblock.test.ts` et `tests/agents.supervisor.stagnation.test.ts` (tous verts en local).
- ✅ Actualisé `AGENTS.md` : cases cochées pour l'autoscaler et le superviseur, note de vigilance sur les scénarios E2E restants.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 192)
- ✅ Factorisé la normalisation des erreurs tools dans `src/server/toolErrors.ts` pour émettre systématiquement les codes `E-*` attendus et consigner les détails structurés.
- ✅ Aligné `src/server.ts` sur les nouveaux helpers (contexte logger + overrides par domaine) et enrichi `UnknownChildError`/`DuplicateChildError` avec codes/hints structurés.
- ✅ Étendu `tests/server.tools.errors.test.ts` afin de couvrir la sérialisation des enveloppes d'erreur (plan/child/graph/values/resources) puis exécuté `npm run test:unit -- --exit tests/server.tools.errors.test.ts` et `npm run build` (OK).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 193)
- ✅ Remplacé les accès directs `path.join`/`path.resolve` du module `src/artifacts.ts` par `resolveWithin` pour garantir que les manifestes et les fichiers scannés restent confinés à l'espace de travail du child.
- ✅ Mis à jour le scan récursif des artefacts afin d'ignorer les liens symboliques et d'éviter les expositions accidentelles de fichiers hors sandbox.
- ✅ Ajouté un test `ignores symbolic links when scanning artifacts` dans `tests/artifacts.test.ts` pour valider le nouveau comportement et préserver la compatibilité multiplateforme via un skip sur Windows.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 194)
- ✅ Instrumenté `ReactiveScheduler` pour publier des événements `scheduler_*` corrélés (run/op/job/graph/node/child) via le pipeline `PlanEventEmitter` et enrichi les payloads avec des durées et priorités.
- ✅ Aligné `plan_run_bt` et `plan_run_reactive` sur le nouvel émetteur pour exposer la télémétrie scheduler et ajouté `EventKind="SCHEDULER"` afin que le bus MCP la relaie.
- ✅ Ajouté `tests/executor.scheduler.events.test.ts`, exécuté `npm run test:unit -- --exit tests/executor.scheduler.events.test.ts` puis `npm run build` pour valider et régénérer `dist/`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 195)
- ✅ Ajouté `tests/events.subscribe.scheduler-telemetry.test.ts` pour confirmer que `events_subscribe` diffuse les événements `SCHEDULER` (JSON Lines & SSE) avec les corrélations run/op/job/graph/node enrichies.
- ✅ Vérifié la remontée des payloads `scheduler_event_enqueued` et `scheduler_tick_result` côté clients MCP et restauré les features/états serveur après test.
- 🔭 À suivre : étendre la couverture aux autres émetteurs (coordinator/agents) et prévoir un test SSE bout en bout lorsque le bus complet sera instrumenté (couverture `STATUS`/`AGGREGATE` SSE validée it.207, reste à traiter heartbeat cadence + autres catégories).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 196)
- ✅ Étendu `PlanJoinInputSchema` et `PlanReduceInputSchema` avec les hints de corrélation, puis propagé les identifiants `runId/opId/jobId/graphId/nodeId/childId` aux événements `STATUS` et `AGGREGATE` via de nouveaux helpers (`toEventCorrelationHints`, `serialiseCorrelationForPayload`).
- ✅ Mis à jour `handlePlanJoin`/`handlePlanReduce` pour enrichir les logs et le bus MCP, et ajouté une vérification ciblée dans `tests/plan.fanout-join.test.ts` garantissant la présence des hints côté payload/correlation.
- ✅ Coche la checklist "Publier évènements standardisés avec opId/runId" et exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/plan.fanout-join.test.ts tests/plan.join.vote.integration.test.ts` (succès).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 197)
- ✅ Ajouté `tests/hygiene.todo-scan.test.ts` pour scanner `src/`, `tests/`, `scripts/` et `graph-forge/` et refuser toute trace de commentaires `TODO`/`FIXME` persistants.
- ✅ Ajusté `tests/critic.review.test.ts` et `src/agents/__tests__/selfReflect.fixtures.ts` afin de reconstituer les marqueurs `TODO` dynamiquement tout en conservant les scénarios des critiques/reflexions.
- ✅ Exécuté `npm ci` puis `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/hygiene.todo-scan.test.ts tests/critic.review.test.ts tests/agents.selfReflect.test.ts` pour valider les nouvelles protections.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 198)
- ✅ Bloqué `plan_fanout` lorsque le value guard est désactivé en introduisant `ValueGuardRequiredError` et un log `plan_fanout_value_guard_required`.
- ✅ Étendu `tests/plan.values-integration.test.ts` avec un scénario couvrant le refus de fan-out risqués sans guard.
- ✅ Exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/plan.values-integration.test.ts` (succès).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 199)
- ✅ Introduit le tool BT `wait` (schema + handler) en exposant `context.activeCancellation` pour coopérer avec l'annulation et conserver la compatibilité fake timers.
- ✅ Ajouté le test d'intégration `tests/e2e.plan.lifecycle.test.ts` couvrant compile BT → plan_run_reactive → pause/resume → cancel → events/logs tail avec corrélations.
- ✅ Exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/e2e.plan.lifecycle.test.ts` (succès).

### 2025-10-07 – Agent `gpt-5-codex` (iteration 200)
- ✅ Ajouté `tests/e2e.autoscaler.supervisor.test.ts` pour couvrir l'E2E-2 (backlog stigmergique → autoscaler scale up/down → superviseur) en s'appuyant sur des stubs de spawn.
- ✅ Confirmé la diffusion des événements `AUTOSCALER` et la présence des reconcilers autoscaler/supervisor dans les phases `loop` des événements `BT_RUN`.
- ✅ Exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/e2e.plan.lifecycle.test.ts tests/e2e.autoscaler.supervisor.test.ts`.
- 🔭 À suivre : enchaîner sur le scénario CNP/consensus (E2E-3) et prolonger la couverture SSE.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 201)
- ♻️ Séparé les curseurs `events_subscribe` dans `tests/e2e.autoscaler.supervisor.test.ts` afin de conserver les événements `bt_run` après l'itération sur les flux autoscaler (corrige la fuite observée lors du run précédent).
- ✅ Rejoué `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/e2e.plan.lifecycle.test.ts tests/e2e.autoscaler.supervisor.test.ts` (2/2 passes, autoscaler scale up/down confirmé).
- 🔭 Prochaines étapes : dérouler E2E-3 (CNP + consensus) et compléter la couverture SSE côté autoscaler/superviseur si possible.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 202)
- ✅ Exposé `contractNet` depuis `src/server.ts` (et `dist/server.js`) avec documentation afin que les tests MCP puissent nettoyer l'état Contract-Net après instrumentation.
- ✅ Ajouté `tests/e2e.contract-net.consensus.mcp.test.ts` couvrant l'annonce CNP, les offres manuelles, l'attribution, puis `plan_join` quorum et `plan_reduce` vote à travers le serveur MCP avec stubs déterministes.
- ✅ Exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/e2e.contract-net.consensus.mcp.test.ts` puis `npm run build` pour vérifier la compilation et la nouvelle couverture.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 203)
- ✅ Ajouté des helpers de snapshot/restauration pour le graphe de connaissances et le value guard afin d'isoler les scénarios MCP.
- ✅ Élargi la couverture unitaires via `tests/knowledge.kg.insert-query.test.ts` et `tests/values.graph.configuration.test.ts` pour vérifier les nouveaux utilitaires.
- ✅ Créé `tests/e2e.plan.dry-run-knowledge-rewrite.test.ts` validant l'enchaînement plan_dry_run → values_explain → kg_suggest_plan → rewrite → exécution et exécuté les tests ciblés.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 204)
- ✅ Ajouté `tests/e2e.graph.tx-diff-patch.test.ts` couvrant l'enchaînement tx_begin → tx_apply → graph_diff → tx_commit → graph_patch et la lecture `sc://graphs/<id>@vX`.
- ✅ Coche la checklist E2E-5 et restauré l'état orchestrateur/ressources après le scénario transactionnel.
- ✅ Exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/e2e.graph.tx-diff-patch.test.ts`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 205)
- ✅ Vérifié la diffusion des événements cognitifs en instrumentant `events_subscribe` avec un scénario `child_collect` stubé (corrélations job/run/op/graph/node/child).
- ✅ Ajouté `tests/events.subscribe.cognitive-correlation.test.ts` pour couvrir les enveloppes `child_meta_review` et `child_reflection` et confirmé le chaînage des hints.
- ✅ Exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.cognitive-correlation.test.ts`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 206)
- ✅ Ajouté `tests/events.subscribe.plan-status-aggregate.test.ts` pour vérifier que `plan_join` et `plan_reduce` publient des événements `STATUS`/`AGGREGATE` corrélés via `events_subscribe` (hints run/op/job/graph/node/child).
- ✅ Stubé les collectes enfants côté superviseur afin de générer des réponses déterministes et couvert la restauration complète des états serveur après le scénario.
- ✅ Exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.plan-status-aggregate.test.ts tests/events.subscribe.cognitive-correlation.test.ts`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 207)
- ♻️ Étendu `tests/events.subscribe.plan-status-aggregate.test.ts` pour valider la diffusion SSE des événements `STATUS`/`AGGREGATE` avec corrélations complètes (`jobId`/`runId`/`opId`/`graphId`/`nodeId`/`childId`).
- ♻️ Complété `tests/events.subscribe.job-correlation.test.ts` afin de couvrir la variante SSE des événements `HEARTBEAT`/`STATUS`/`AGGREGATE` et confirmer que les clients streaming reçoivent les mêmes hints que JSON Lines.
- ✅ Exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.plan-status-aggregate.test.ts tests/events.subscribe.job-correlation.test.ts` (succès) et laissé en suivi l'audit du cadenceur heartbeat configurables.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 208)
- ♻️ Aligné le champ `event` SSE de `events_subscribe` sur l'identifiant `KIND` en majuscules pour éviter toute divergence côté clients temps réel.
- ✅ Renforcé `tests/events.subscribe.plan-status-aggregate.test.ts` et `tests/events.subscribe.job-correlation.test.ts` avec des assertions sur le type d'événement SSE afin de verrouiller le comportement.
- ✅ Exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.plan-status-aggregate.test.ts tests/events.subscribe.job-correlation.test.ts` puis `npm run build` pour valider la compilation.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 209)
- ♻️ Instrumenté `ReactiveScheduler` pour publier des événements `SCHEDULER` corrélés (enqueued + tick result) et aligner la télémétrie JSON Lines/SSE.
- ✅ Mis à jour `tests/events.subscribe.scheduler-telemetry.test.ts` pour utiliser le parseur SSE commun, couvrir le nom d'événement et réaffirmer les hints run/op/job/graph/node.
- ✅ Documenté dans `docs/mcp-api.md` que la valeur `event:` du flux SSE reflète le champ `kind` en majuscules et décrit les champs exposés par les événements `SCHEDULER`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 210)
- ♻️ Harmonisé la télémétrie `SCHEDULER` en exposant les messages stables `scheduler_event_enqueued`/`scheduler_tick_result` et en ajoutant les compteurs `pending`/`base_priority` sur toutes les trames.
- ✅ Renforcé `tests/events.subscribe.scheduler-telemetry.test.ts` pour vérifier les nouveaux champs (`msg`, `pending`, `base_priority`, `batch_index`) sur les flux JSON Lines et SSE.
- ✅ Actualisé `docs/mcp-api.md` afin de documenter les valeurs `msg` associées aux événements scheduler.
- ✅ Commandes: `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.scheduler-telemetry.test.ts` ; `npm run build`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 211)
- ♻️ Enrichi la télémétrie `SCHEDULER` avec `pending_before`, `pending_after`, `sequence` et la base de priorité d'origine pour les ticks afin d'offrir des métriques symétriques entre files d'attente et exécutions.
- ✅ Mis à jour `tests/events.subscribe.scheduler-telemetry.test.ts` pour vérifier les nouveaux champs (`pending_before`, `sequence`, `base_priority`) sur les flux JSON Lines, et documenté la section API correspondante.
- ✅ Commandes: `npm ci` ; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.scheduler-telemetry.test.ts`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 212)
- ♻️ Vérifié que la télémétrie `SCHEDULER` expose bien les métriques de file d'attente sur le flux SSE en étendant `tests/events.subscribe.scheduler-telemetry.test.ts` avec des assertions détaillées (`pending_before`, `pending_after`, `ticks_in_batch`, `sequence`).
- ✅ Confirmé que les événements SSE incluent `scheduler_event_enqueued` et `scheduler_tick_result` avec les mêmes champs que la variante JSON Lines.
- ✅ Commande: `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.scheduler-telemetry.test.ts`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 213)
- ♻️ Renforcé la parité JSON Lines/SSE en validant le champ `event_type`, `pending_after` et `ticks_in_batch` côté JSON et en documentant le calcul de profondeur de file (`pending_before = pending - 1`).
- ✅ Ajouté des commentaires explicatifs dans `tests/events.subscribe.scheduler-telemetry.test.ts` pour rappeler l'objectif des métriques vérifiées.
- ✅ Commandes: `npm ci` ; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.scheduler-telemetry.test.ts`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 214)
- ♻️ Comparé champ par champ les métriques `SCHEDULER` JSON Lines et SSE afin de garantir la parité totale des files d'attente.
- ✅ Documenté dans `docs/mcp-api.md` que toute divergence JSON/SSE est un bug contractuel.
- ✅ Commande: `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.scheduler-telemetry.test.ts`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 215)
- ♻️ Ajouté `pending_after` à la télémétrie `scheduler_event_enqueued` pour aligner JSON Lines/SSE avec la documentation sur la profondeur de file.
- ✅ Renforcé `tests/events.subscribe.scheduler-telemetry.test.ts` afin d'asserter `pending_after` côté JSON/SSE et préserver la parité transport.
- ✅ Commandes: `npm ci`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.scheduler-telemetry.test.ts`; `npm run build`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 216)
- ♻️ Exposé `pendingBefore`/`pendingAfter` côté scheduler pour publier la profondeur de file pré/post-enqueue sans calculs dérivés.
- ✅ Aligné l'émission MCP (`plan_run_reactive`) et la documentation afin que `pending_before` reflète la mesure fournie par le scheduler.
- ✅ Commandes: `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.scheduler-telemetry.test.ts`; `npm run build`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 217)
- ✅ Ajouté un test unitaire `reactive scheduler reports queue depth snapshots through enqueue and tick telemetry` pour vérifier que `ReactiveScheduler` publie `pending_before`/`pending_after`, les priorités de base et la séquence sur `onEvent`/`onTick`.
- ✅ Rejoué la couverture d'intégration `tests/events.subscribe.scheduler-telemetry.test.ts` pour confirmer la parité JSON/SSE après l'ajout du test unitaire.
- ✅ Commandes: `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/executor.scheduler.reactivity.test.ts`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/events.subscribe.scheduler-telemetry.test.ts`; `npm run build`.

### 2025-10-07 – Agent `gpt-5-codex` (iteration 218)
- ♻️ Rendu l'intervalle `HEARTBEAT` configurable via `RuntimeTimingOptions`/`--heartbeat-interval-ms` et redémarré le timer lors des reconfigurations pour appliquer immédiatement la nouvelle cadence.
- ✅ Ajouté `tests/server.heartbeat-interval.test.ts` pour piloter l'horloge factice et vérifier la cadence ainsi que la reprogrammation du timer, plus élargi `tests/serverOptions.parse.test.ts`/`tests/mcp.info-capabilities.test.ts` aux nouveaux champs.
- ✅ Documenté le flag et la borne minimale dans le README/`docs/mcp-api.md`, puis regénéré `dist/`.
- ✅ Commandes: `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --exit tests/mcp.info-capabilities.test.ts tests/serverOptions.parse.test.ts tests/server.heartbeat-interval.test.ts`; `npm run build`.
