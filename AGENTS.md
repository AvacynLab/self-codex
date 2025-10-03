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
* [ ] **Modifier** `src/executor/*`, `src/coord/*`, `src/agents/*`

  * [ ] Publier évènements standardisés avec `opId/runId`
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

* [ ] **Créer** `src/infra/idempotency.ts` (store TTL)
* [ ] **Modifier** tools : `child_create`, `plan_run_bt`, `cnp_announce`, `graph_batch_mutate`, `tx_begin`

  * [ ] Accepter `idempotencyKey?` → rejouer résultat si déjà vu
* [ ] **Tests** : `tests/idempotency.replay.test.ts` (simuler retry réseau)

### 2.5 Opérations bulk atomiques

* [ ] **Modifier** `src/server.ts`

  * [x] tools `bb_batch_set([{ns,key,value,ttlMs?}])`
  * [x] `graph_batch_mutate({graphId, ops:GraphOp[]})`
  * [x] `child_batch_create([{idempotencyKey?, role?, prompt, limits?}])`
  * [x] `stig_batch([{nodeId,type,intensity}])`
* [x] **Tests** : `tests/bulk.bb-graph-child-stig.test.ts` (couverture `bb_batch_set` ajoutée, graph/child/stig restant)

  * [x] Atomicité : rollback si erreur partielle

---

## 3) Lifecycle Plan, Compilation/Exécution, Child Ops fines

### 3.1 Lifecycle uniforme

* [ ] **Créer** `src/executor/planLifecycle.ts`

  * [ ] États : `running|paused|done|failed`, progression %, last event seq
* [ ] **Modifier** `src/server.ts`

  * [ ] tools `plan_status({runId})`, `plan_pause({runId})`, `plan_resume({runId})`
  * [ ] `plan_dry_run({graphId|btJson})` → compile, applique `values_explain`, `rewrite` **en preview**
* [ ] **Tests** : `tests/plan.lifecycle.test.ts`, `tests/plan.dry-run.test.ts`

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

* [ ] **Modifier** `src/executor/bt/nodes.ts`

  * [ ] Décorateurs : `Retry(n, backoffJitter)`, `Timeout(ms)`, `Guard(cond)`, `Cancellable`
  * [ ] Parallel policy : `all|any|quota(k)`
* [ ] **Modifier** `src/executor/bt/interpreter.ts`

  * [ ] Persistance d’état par nœud (resume après pause/cancel) ; progress %
* [ ] **Tests** :

  * [ ] `tests/bt.decorators.retry-timeout-cancel.test.ts` (fake timers)
  * [ ] `tests/bt.parallel.quota.test.ts`

### 4.2 Scheduler réactif (fairness & budgets)

* [ ] **Modifier** `src/executor/reactiveScheduler.ts`

  * [ ] Priorité = f(âge, criticité, stigmergie) avec **aging** (anti-starvation)
  * [ ] Budgets CPU coopératifs (yield après quantum)
* [ ] **Tests** :

  * [ ] `tests/executor.scheduler.prio-aging.test.ts`
  * [ ] `tests/executor.scheduler.budgets.test.ts`

### 4.3 Stigmergie paramétrable

* [ ] **Modifier** `src/coord/stigmergy.ts`

  * [ ] Demi-vie configurable `halfLifeMs`, borne min/max intensité
  * [ ] Snapshot heatmap (pour dashboard)
* [ ] **Tests** : `tests/coord.stigmergy.field.test.ts` (évaporation contrôlée)

### 4.4 Autoscaler & Superviseur

* [ ] **Modifier** `src/agents/autoscaler.ts`

  * [ ] Métriques : backlog, latence, échecs ; scale up/down avec **cooldown**
* [ ] **Modifier** `src/agents/supervisor.ts`

  * [ ] Détection stagnation (N ticks sans progrès), relance/réallocation
  * [ ] Intégrer **rewrite** ciblée (règle `reroute-avoid`) en cas d’impasse
* [ ] **Tests** :

  * [ ] `tests/agents.autoscaler.scale-updown.test.ts` (no thrash)
  * [ ] `tests/agents.supervisor.unblock.test.ts`

### 4.5 Réécriture & invariants (idempotence)

* [ ] **Modifier** `src/graph/rewrite.ts`

  * [ ] Règles : `split-parallel`, `inline-subgraph`, `reroute-avoid(label|nodeId)`
  * [ ] **Idempotence** : même règle appliquée 2× → même graphe
* [ ] **Tests** : `tests/graph.rewrite.rules.test.ts` (idempotence, pas de cycles)

---

## 5) Mémoire d’implémentation, Valeurs, Assistance

### 5.1 Knowledge Graph (réutilisation)

* [ ] **Modifier** `src/knowledge/knowledgeGraph.ts`

  * [ ] Triplets `{s,p,o,source?,confidence?}` ; index par `(s,p)` et `(o,p)`
* [ ] **Créer** `src/knowledge/assist.ts`

  * [ ] `kg_suggest_plan({goal, context?}) -> {fragments: HierGraph[], rationale[]}`
* [ ] **Modifier** `src/server.ts`

  * [ ] tool `kg_suggest_plan`
* [ ] **Tests** : `tests/assist.kg.suggest.test.ts` (mocks)

### 5.2 Mémoire causale

* [ ] **Modifier** `src/knowledge/causalMemory.ts`

  * [ ] `record(event, causes[])`, `explain(outcome)` ; export DAG
  * [ ] Accrochage BT/scheduler (début/fin/échec nœuds)
* [ ] **Modifier** `src/server.ts`

  * [ ] tools `causal_export`, `causal_explain`
* [ ] **Tests** :

  * [ ] `tests/knowledge.causal.record-explain.test.ts`
  * [ ] `tests/causal.integration.bt-scheduler.test.ts`

### 5.3 Graphe de valeurs (filtrage + explication)

* [ ] **Modifier** `src/values/valueGraph.ts`

* [x] `values_explain({plan}) -> {violations:[{nodeId, value, severity, hint}]}`
* [ ] **Modifier** `src/server.ts`

  * [x] tool `values_explain`
  * [x] Intégration dans `plan_dry_run`
* [x] **Tests** : `tests/values.explain.integration.test.ts`

---

## 6) Observabilité/Logs/Dashboard

### 6.1 Logs corrélés & tail

* [ ] **Créer** `src/monitor/log.ts`

  * [ ] Log JSONL avec `runId|opId|graphId|childId|seq` ; rotation
* [ ] **Modifier** `src/server.ts`

  * [ ] tool `logs_tail({stream:"server"|"run"|"child", id?, limit?, fromSeq?})`
* [ ] **Tests** : `tests/logs.tail.filters.test.ts` (filtres, fromSeq)

### 6.2 Dashboard overlays

* [ ] **Modifier** `src/monitor/dashboard.ts`

  * [ ] Streams SSE : état BT, heatmap stigmergie, backlog scheduler
* [ ] **Modifier** `src/viz/mermaid.ts`

  * [ ] Overlays : badges BT (RUNNING/OK/KO), intensités stigmergiques
* [ ] **Tests** :

  * [ ] `tests/monitor.dashboard.streams.test.ts`
  * [ ] `tests/viz.mermaid.overlays.test.ts`

---

## 7) Concurrence, Robustesse, Perf

### 7.1 Tests de concurrence

* [ ] **Créer** `tests/concurrency.graph-mutations.test.ts`

  * [ ] Threads simulés : diffs concurrents → locks ; aucun deadlock
* [ ] **Créer** `tests/concurrency.events-backpressure.test.ts`

  * [ ] `events_subscribe/resources_watch` : limites, keep-alive, perte zéro

### 7.2 Cancellation & ressources

* [ ] **Créer** `tests/cancel.random-injection.test.ts`

  * [ ] Annuler aléatoirement pendant BT/scheduler ; vérifier cleanup

### 7.3 Flakiness & perf micro-bench (non-CI)

* [ ] **Créer** `tests/perf/scheduler.bench.ts` (local-only)

  * [ ] Mesurer latence avant/après stigmergie & aging
* [ ] **Créer** script `scripts/retry-flaky.sh`

  * [ ] Réexécuter 10× suites sensibles → vérifier stabilité

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

* [ ] **Supprimer** code mort et TODOs obsolètes (grep TODO/FIXME)
* [ ] **Renforcer** normalisation chemins (utiliser `src/paths.ts` partout)
* [ ] **Limiter** side-effects par défaut (no network write si `values` interdit)
* [ ] **Codes d’erreurs** homogènes :

  * [ ] `E-MCP-*`, `E-RES-*`, `E-EVT-*`, `E-CANCEL-*`, `E-TX-*`, `E-LOCK-*`, `E-PATCH-*`, `E-PLAN-*`, `E-CHILD-*`, `E-VALUES-*`, `E-ASSIST-*`
* [ ] **Tests** : `tests/server.tools.errors.test.ts` (codes/messages/hints)

---

## 10) Exemples E2E (scénarios de vérification)

* [ ] **E2E-1 :** Plan hiérarchique → compile BT → `plan_run_bt` → events_subscribe (pause/resume) → `plan_cancel` → tail des logs
* [ ] **E2E-2 :** Backlog massif → stig_mergie + autoscaler (scale up/down) → superviseur débloque → metrics ok
* [ ] **E2E-3 :** CNP announce → bids → award → `plan_join quorum=2/3` → `plan_reduce vote`
* [ ] **E2E-4 :** `plan_dry_run` → `values_explain` rejette un plan → `kg_suggest_plan` propose fragment alternatif → `rewrite` preview → exécution
* [ ] **E2E-5 :** `tx_begin` → `tx_apply` (ops multiples) → `graph_diff/patch` → `tx_commit` → `resources_read sc://graphs/<id>@vX`

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

> Bloquants actuels : `plan_dry_run`, `values_explain`, `kg_suggest_plan` et `causal_explain` restent à implémenter.

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
