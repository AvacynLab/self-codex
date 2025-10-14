Remet à zero le fichier AGENTS.md et importe la liste des taches fournit ci dessous ainsi que les informations (au mot près) dans le fichier. Une fois effectué, commence l'implementation, et prend ton temps. 

----------
Voici ta **feuille de route** exhaustive, agent. Elle s’appuie sur la dernière version du dépôt (celle que je viens d’auditer), sur ce qui est déjà en place (auth HTTP, limites, idempotence persistée, supervision enfants, middleware JSON-RPC, observabilité, build Node20/ESM) et sur les améliorations “game-changer” proposées (Tool-OS, planner compilé, WAL/snapshots, mémoire multi-calques, sandbox, budgets).
Tu exécutes ces tâches **dans l’ordre proposé**. Chaque point liste les fichiers à modifier/créer, les sous-étapes, les extraits critiques, puis les tests associés. À la fin, tu trouveras les **règles build/tests** et les **critères d’acceptation**.

---

# Brief objectifs (lis-moi avant d’implémenter)

* Garantir un serveur MCP **robuste** (HTTP sécurisé, idempotence persistée, supervision enfants), **observable** (traces, métriques, logs corrélés), **scalable** (backpressure, timeouts/budgets).
* Donner à l’agent un **Tool-OS** (registry dynamique, tools composites) et un **planner** neuro-symbolique compilé en BT/graph.
* Ajout d’un **WAL** transactionnel + **snapshots** pour replay/debug et d’une **mémoire multi-calques** (vector store + KG).
* Durcir l’exécution enfants (sandbox/policies) et mesurer la qualité (harness d’**évaluation continue**).

**Contraintes à respecter pendant toute l’implémentation**

* **Imports core Node uniquement via `from "node:..."`**, jamais nus.
* **ESM/Node 20** partout, `tsconfig` en `module: "NodeNext", moduleResolution: "NodeNext"`.
* `@types/node` disponibles, `lib: ["ES2022"]`, `types: ["node"]`.
* Tous les endpoints/handlers JSON-RPC renvoient des erreurs **homogènes** via le middleware central.

---

# Liste de tâches à cocher (fichier par fichier, avec sous-étapes)

## 1) HTTP durci et homogénéisé

### 1.1 `src/httpServer.ts` – sécurisation et unification

* [x] Injecter systématiquement :

  * [x] `applySecurityHeaders(res)` et `ensureRequestId(req,res)` dès l’entrée de handler.
  * [x] `rateLimitOk(key)` (clé = IP + path) → 429 si refus.
  * [x] `tokenOk(req.headers["authorization"]?.replace(/^Bearer\s+/,""), requiredToken)` → 401 si KO.
  * [x] `readJsonBody(req, MAX_BYTES)` pour le body, avec 413 si trop gros.
* [x] Router additionnel :

  * [x] `GET /healthz` (no-auth) → `{ ok: true }`.
  * [x] `GET /readyz` (auth) → vérifie charge `graph-forge`, idempotency store, queue événements.
  * [x] `GET /metrics` (auth) → métriques texte simple (latences p50/p95/p99, counts, erreurs).
* [x] Tous les retours d’erreur passent par le **middleware JSON-RPC** (pas d’objets ad-hoc).
* [x] Journaliser `request_id`, `trace_id`, tailles in/out, durée, méthode JSON-RPC.

### 1.2 Tests

* [x] `tests/http/auth.test.ts` : 200 si bon token / 401 sinon / temps constant.
* [x] `tests/http/limits.test.ts` : 413 au-delà de `MAX_BYTES` / 429 en rafale.
* [x] `tests/http/headers.test.ts` : présence `x-request-id` + headers sécurité.
* [x] `tests/ops/health_ready.test.ts` : `/healthz` no-auth OK, `/readyz` dépendances OK/KO.

---

## 2) Idempotence **persistée** (déjà en place, compléter)

### 2.1 `src/infra/idempotencyStore.file.ts`

* [x] Ajouter une **compaction** périodique (optionnelle V1) si le fichier index dépasse N entrées.
* [x] Paramétrer TTL via `IDEMPOTENCY_TTL_MS` (défaut 600_000).
* [x] Renvoyer une **erreur 409** claire si conflit de sémantique (même clé, params divergents).

### 2.2 `src/server.ts`

* [x] Wrap **toutes** les méthodes à effet (tx, patch, commit, spawn/kill child, write artefact) avec get/set idempotence.
* [x] Écrire dans un **WAL** (cf. §5) en plus de l’idempotence (ordre: WAL → exécution → set store).

### 2.3 Tests

* [x] `tests/int/idempotency.http.test.ts` : deux POST avec même `Idempotency-Key` → même corps, latence plus faible.
* [x] `tests/infra/idempotencyStore.file.test.ts` : persistance/reload, TTL expiré, compaction.

---

## 3) Supervision enfants & circuit breaker (présents, intégrer plus loin)

### 3.1 `src/children/supervisor.ts`

* [x] Implémenter **backoff exponentiel** borné (min/max).
* [x] Ajouter **politiques** : `max_restarts_per_min`, `cooldown_ms`, `half_open_max`.
* [x] Émettre des **événements** supervisés : `child_restart`, `breaker_open`, `breaker_half_open`, `breaker_closed`.

### 3.2 `src/childSupervisor.ts`

* [x] Utiliser le breaker pour bloquer `spawn` si open.
* [x] Sur fermeture breaker, tenter un **spawn contrôlé** (half-open).

### 3.3 Tests

* [x] `tests/children/supervisor.test.ts` : enchaînement d’échecs → open; cooldown → half-open → closed.

---

## 4) Observabilité complète (traces + métriques + logs)

### 4.1 `src/infra/tracing.ts`

* [x] Instruments :

  * [x] Création `trace_id`/`span_id` par requête JSON-RPC.
  * [x] Histogrammes latence p50/p95/p99 par méthode.
  * [x] Compteurs erreurs par code.
  * [x] Option **OTLP** si `OTEL_EXPORTER_OTLP_ENDPOINT` est défini.
* [x] Export `/metrics` et join des stats.

### 4.2 `src/logger.ts`

* [x] Ajouter champs : `request_id`, `trace_id`, `child_id`, `method`, `duration_ms`, `bytes_in/out`.
* [x] Respecter `MCP_LOG_REDACT=on` pour masquer tokens/headers sensibles.
* [x] Rotation stable (max taille + max fichiers).

### 4.3 Tests

* [x] `tests/obs/metrics.test.ts` : compteurs/histo après rafale synthétique.
* [x] `tests/obs/logs.test.ts` : schema JSON log (golden sample).

---

## 5) Journalisation transactionnelle (WAL) + snapshots

### 5.1 `src/state/wal.ts` (nouveau)

* [x] Append-only JSONL par “topic” (`graph`, `tx`, `child`, `tool`) dans `runs/wal/<topic>/YYYY-MM-DD.log`.
* [x] Ligne = `{ ts, topic, event, payload, checksum }` (checksum = sha256 du JSON).

### 5.2 `src/state/snapshot.ts` (nouveau)

* [x] snapshots incrémentaux (toutes les K opérations ou M minutes) dans `runs/snapshots/…`.
* [x] `snapshot_take()` / `snapshot_list()` / `snapshot_load()`.

### 5.3 `src/server.ts` / `src/graph/*.ts`

* [x] Émettre dans WAL pour toute mutation.
* [x] Hook snapshots à la **validation commit** (voir §6).

### 5.4 Tests

* [x] `tests/state/wal.test.ts` : append + checksum + rotation.
* [x] `tests/state/snapshot.test.ts` : save/load + replay minimal.

---

## 6) Graphes : invariants forts + op-log (tu as déjà une base, durcir)

### 6.1 `src/graph/validate.ts`

* [x] **Invariants** : types valides, pas d’arêtes orphelines, contraintes de cardinalité, tailles bornées.
* [x] Erreur claire : code/raison/noeud fautif.

### 6.2 `src/graph/oplog.ts`

* [x] Append JSONL de chaque opération de patch/tx (distinct du WAL global, plus “métier”).

### 6.3 `src/graph/tx.ts` (ou équivalent)

* [x] Appeler `validateGraph()` avant `commit`. Refuser si KO (400 / -32602).
* [x] Écrire `oplog` et `wal` en plus de l’idempotence.

### 6.4 Tests

* [x] `tests/graph/invariants.test.ts` : cas OK/KO.
* [x] `tests/graph/oplog.test.ts` : contenu, rotation.

---

## 7) Backpressure & streaming SSE (compléter)

### 7.1 `src/resources/sse.ts`

* [x] Chunker > `MCP_SSE_MAX_CHUNK_BYTES` (défaut 32768).
* [x] Buffer **borné** par client (DROP ancien + warning) → `MCP_SSE_MAX_BUFFER`.
* [x] Timeout d’emit par client (`MCP_SSE_EMIT_TIMEOUT_MS`).

### 7.2 `src/rpc/timeouts.ts` (nouveau)

* [x] Mapping `method → timeoutMs` + défaut global.
* [x] Appliquer dans le dispatcher (abort contrôlé + code erreur dédié).

### 7.3 Tests

* [x] `tests/streaming/sse.test.ts` : gros payload → chunking; clients lents → pas d’OOM.

---

## 8) Middleware JSON-RPC (valider et normaliser)

### 8.1 `src/rpc/schemas.ts`

* [x] Définir un schéma **zod** pour chaque méthode publique (inputs/outputs).
* [x] Exporter des “builders” réutilisables (graph patch, child limits, plan compile…).

### 8.2 `src/rpc/middleware.ts`

* [x] Centraliser parse/validation/erreurs (codes stables), injection `request_id`/`trace_id`.
* [x] **Taxonomie** : `VALIDATION_ERROR`, `AUTH_REQUIRED`, `RATE_LIMITED`, `IDEMPOTENCY_CONFLICT`, `TIMEOUT`, `INTERNAL`.

### 8.3 Tests

* [x] `tests/rpc/validation.test.ts` : erreurs homogènes, golden outputs.

---

## 9) Budgets multi-dimensionnels (nouveau)

### 9.1 `src/infra/budget.ts`

* [x] Implémenter un `BudgetTracker` (temps/token/tool_calls/bytes_in/bytes_out).
* [x] Snapshot pour logs/métriques.

### 9.2 Intégrations

* [x] `src/server.ts` : instancier par run/enfant, décrémenter **avant** l’appel véritable.
* [x] `src/tools/*` : consommer budgets selon usage réel.

### 9.3 Tests

* [x] `tests/infra/budget.test.ts` : refus à zéro budget, mode dégradé, snapshot.

---

## 10) Tool-OS (registry dynamique + tools composites)

### 10.1 `src/mcp/registry.ts` (nouveau)

* [x] `register(manifest,impl)` / `list()` / `call(name,input,ctx)`.
* [x] Hot-reload simple : rescanner `tools/` sur signal `SIGHUP` (facultatif).

### 10.2 Method JSON-RPC

* [x] `tool_compose_register` : créer un tool composite (pipeline) et persister un **manifest synthétique**.
* [x] `tools_list` : renvoyer manifests.

### 10.3 Tests

* [x] `tests/mcp/registry.test.ts` : register/list/call, collisions, hot-reload.

---

## 11) Planner compilé (plan → BT/graph)

### 11.1 `src/planner/domain.ts` (nouveau)

* [x] Types : tâche, pré/post-conditions, dépendances, ressources.

### 11.2 `src/planner/compileBT.ts` + `src/planner/schedule.ts`

* [x] Compiler en Behavior Tree et en DAG ordonnancé.
* [x] Générer un **plan exécutable** (id de run) exposé au monitoring.

### 11.3 Tool

* [x] `plan_compile_execute` : entrée plan YAML/JSON → run id + suivi.

### 11.4 Tests

* [x] `tests/planner/compile.test.ts` : compilation non triviale, pré/post appliquées.

---

## 12) Mémoire multi-calques

### 12.1 `src/memory/vector.ts` (nouveau)

* [x] Embeddings locaux (cosine simple) + index on-disk.

### 12.2 `src/memory/kg.ts` (nouveau)

* [x] Triplets (suj/rel/obj), upsert, requêtes.

### 12.3 Tools

* [x] `memory_vector_search`, `kg_query`, `kg_upsert`.
* [x] Hook post-tool : output long → indexer vector/KG.

### 12.4 Tests

* [x] `tests/memory/vector.test.ts` et `tests/memory/kg.test.ts`.

---

## 13) Sandbox/profiles enfants

### 13.1 `src/children/sandbox.ts` (nouveau)

* [x] Spawner avec Node options : `--max-old-space-size`, `--frozen-intrinsics`, `--no-addons`, `--disable-proto=throw`.
* [x] Profils : `strict` / `standard` / `permissive`.

### 13.2 Intégration

* [x] `child_spawn_codex` : choisir profil, cwd isolé, env whitelists.

### 13.3 Tests

* [x] `tests/children/sandbox.test.ts` : limites mémoire/process, refus réseau (si support).

---

## 14) Packaging/ops

### 14.1 Docker

* [x] `Dockerfile` multi-stage : builder (devDeps) → runtime (prod only, distroless si possible).
* [x] `.dockerignore` : ignorer `node_modules`, `runs`, `tests`, etc.

### 14.2 CI

* [x] `.github/workflows/ci.yml` : cache npm, `npm ci --include=dev`, build, tests, couverture artifact.
* [x] Job optionnel : build image + smoke `/healthz`/`/readyz`.

---

## 15) Scripts de validation

### 15.1 `scripts/validation/run-smoke.mjs`

* [x] Enchaîne : `mcp_info` → `tools_list` → `tx_begin` → `graph_patch` → `tx_commit` → `child_spawn_codex` → `child_send` → `child_kill`.
* [x] Écrit entrées/sorties dans `runs/validation_<date>/…` + `summary.md` (latences p50/p95, taux erreurs).

### 15.2 `scripts/validation/run-eval.mjs`

* [x] Fuzz JSON-RPC, cas adversariaux (out-of-order, big payload), métamorphiques pour graphes.

---

## 16) Observabilité budgets

### 16.1 `src/infra/tracing.ts`

* [x] Agréger les consommations/exhaustions par méthode/étape/acteur et exposer les métriques budget_* via `/metrics`.

### 16.2 `src/infra/budget.ts`

* [x] Instrumenter chaque consommation/dépassement pour alimenter les métriques budgets.

### 16.3 Tests

* [x] `tests/obs/metrics.test.ts` : vérifie la présence des lignes budget_* et l'incrément des compteurs d'épuisement.

---

# Règles build/tests (obligatoire)

* Build local/Cloud :

  1. `npm ci --include=dev`
  2. `npm run build` (compile `src` puis `graph-forge`)
  3. `npm run lint`
* Tests : `npm run test` et `npm run coverage`

  * Couverture minimale **85%** (stmts/funcs/lines) ; branches **70%**.
  * Pas de flakiness ; tests HTTP isolés via token et petits payloads.
* Exécution HTTP :

  * `MCP_HTTP_TOKEN` **obligatoire** si HTTP actif.
  * `MCP_SSE_MAX_CHUNK_BYTES`, `MCP_SSE_MAX_BUFFER`, `MCP_SSE_EMIT_TIMEOUT_MS` définis pour la plate-forme Cloud.
  * `IDEMPOTENCY_TTL_MS` raisonnable (10–30 min).

---

# Critères d’acceptation (final)

* Tous les points 1→15 cochés et **tests associés verts**.
* `/healthz` et `/readyz` répondent conformément (readyz casse si une dépendance simulée tombe).
* **Idempotence** : même `Idempotency-Key` → même réponse après redémarrage.
* **SSE** : pas d’OOM ni blocage sur clients lents, payloads chunkés.
* **Observabilité** : `/metrics` expose p50/p95/p99 par méthode et erreurs/1000 reqs.
* **WAL + snapshots** : `snapshot_take`/`snapshot_load` opérationnels, `walAppend` présent sur toutes mutations.
* **Tool-OS** : `tool_compose_register` permet de créer un tool composite listable/exécutable.
* **Planner** : un plan non trivial compilé/exécuté avec vérif pré/post.
* **Sandbox** : profil `strict` limite mémoire et bloque fonctionnalités interdites.

---

Si tu veux, je peux te fournir **diffs initiaux** pour bootstraper les nouveaux fichiers (`wal.ts`, `snapshot.ts`, `budget.ts`, `registry.ts`, `planner/*`, `memory/*`) et un squelette de tests pour que tu partes avec des bases compilables dès la première passe.

### Historique des actions

* 2025-02-14T00:00Z — gpt-5-codex : Implémentation des modules `state/wal` et `state/snapshot` avec tests de rotation/checksum et chargement. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/state/wal.test.ts" "tests/state/snapshot.test.ts"`.
* 2025-10-13T12:18Z — gpt-5-codex : Durcissement HTTP (`httpServer.ts`), normalisation erreurs JSON-RPC et observabilité `/metrics`, ajout tests HTTP/ops ciblés. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/http/auth.test.ts" "tests/http/limits.test.ts" "tests/http/headers.test.ts" "tests/ops/health_ready.test.ts" "tests/obs/metrics.test.ts"`.
* 2025-10-13T12:40Z — gpt-5-codex : Durcit le store idempotence (compaction auto, TTL configurable, conflit 409) et étend le fast-path HTTP pour détecter les divergences, avec tests infra/int. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/infra/idempotencyStore.file.test.ts" "tests/int/idempotency.http.test.ts"`.
* 2025-10-13T13:10Z — gpt-5-codex : Instrumente le serveur HTTP/JSON-RPC pour tracer les mutations idempotentes dans le WAL avant exécution, rejoue les métadonnées en fast-path et vérifie la persistance via `tests/int/idempotency.http.test.ts`. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/int/idempotency.http.test.ts"`.
* 2025-10-13T13:45Z — gpt-5-codex : Ajoute les politiques de supervision (quota/minute, aliases snake_case), émet des événements breaker/restart et relaye vers le bus enfant en incluant une tentative de respawn contrôlée après cooldown. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/children/supervisor.test.ts"`.
* 2025-10-13T13:54Z — gpt-5-codex : Instrumente la télémétrie JSON-RPC (erreurs par code, export OTLP) et enrichit les logs structurés avec corrélations/redaction automatique. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/obs/metrics.test.ts" "tests/obs/logs.test.ts"`.
* 2025-10-13T14:25Z — gpt-5-codex : Étend la transaction graph pour émettre dans le WAL, déclencher des snapshots incrémentaux et journaliser les outils `graph_patch`/`graph_batch`/`tx_*`. Ajout du test `tests/graph/persistence.test.ts`. Commandes : tentative `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/graph/*.test.ts"` (échoue faute de dépendance facultative `fast-check`), puis `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/graph/invariants.test.ts" "tests/graph/oplog.test.ts" "tests/graph/persistence.test.ts"`.
* 2025-10-13T15:00Z — gpt-5-codex : Aligne le buffer SSE sur `MCP_SSE_MAX_BUFFER`, documente l’option et vérifie chunking/backpressure/timeouts via `tests/streaming/sse.test.ts`.
* 2025-10-13T17:08Z — gpt-5-codex : Normalise le middleware JSON-RPC (taxonomie d’erreurs, builders de schémas) et ajoute les tests `tests/rpc/validation.test.ts` tout en homogénéisant les erreurs HTTP (`tests/http/limits.test.ts`). Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/rpc/validation.test.ts" "tests/http/limits.test.ts"`.
* 2025-10-13T19:10Z — gpt-5-codex : Implémente le Tool-OS (registry dynamique + composites) avec `tool_compose_register`, `tools_list`, hot-reload et tests dédiés. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/mcp/registry.test.ts"` et `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/rpc/validation.test.ts"`.
* 2025-10-14T00:10Z — gpt-5-codex : Ajoute les modules planner (`domain`, `schedule`, `compileBT`), le tool `plan_compile_execute` et les schémas RPC associés. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/planner/compile.test.ts"`.
* 2025-10-14T01:36Z — gpt-5-codex : Ajoute la mémoire vectorielle persistée, la couche KG durable, les tools `memory_vector_search`/`kg_upsert` et l'indexation automatique post `child_collect`. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/memory/vector.test.ts" "tests/memory/kg.test.ts" "tests/knowledge.kg.insert-query.test.ts"`; tentative `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/events.subscribe.cognitive-correlation.test.ts"` (échec esbuild top-level await CJS).
* 2025-10-14T02:31Z — gpt-5-codex : Implémente le suivi budgétaire multi-dimensionnel (tracker, budgets requêtes/enfants, intégration outils) et ajoute les tests unitaires/acceptance associés. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/infra/budget.test.ts" "tests/child.tools.test.ts"`.
* 2025-10-14T02:52Z — gpt-5-codex : Ajoute le module sandbox (profils strict/standard/permissive, politiques réseau/mémoire), intègre `child_spawn_codex` avec whitelist d'environnement et ajoute les tests dédiés. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/children/sandbox.test.ts" "tests/children/supervisor.test.ts" "tests/child.tools.test.ts"`.
* 2025-10-14T03:45Z — gpt-5-codex : Finalise l'opérationnelle (Docker ignore/CI multi-étapes), enrichit la fumée validation (p99 + taux erreurs) et ajoute le script `run-eval.mjs` avec tests intégrés. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/validation/run-smoke.test.ts" "tests/validation/run-eval.test.ts"`.
* 2025-10-14T04:05Z — gpt-5-codex : Rétablit le test `events.subscribe.cognitive-correlation` via import dynamique du serveur pour éviter les limites CJS d'esbuild et exécute l'installation `npm ci`. Commandes : `npm ci --include=dev` puis `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/events.subscribe.cognitive-correlation.test.ts"`.
* 2025-10-14T05:10Z — gpt-5-codex : Instrumente le budget tracker pour publier les métriques budget_* (consommation & dépassement) et ajoute la couverture dédiée. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/obs/metrics.test.ts"`.
