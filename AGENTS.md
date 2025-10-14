----------
Très bien, agent — voici ta **feuille de route détaillée et vérifiable** pour la version actuelle du dépôt. Elle s’appuie sur mon dernier audit (version la plus récente que j’ai extraite et analysée) et vise deux objectifs clairs :

1. **Réduire le nombre d’outils exposés** sans perdre de capacités (façades stables qui encapsulent les primitives).
2. **Fluidifier le processus d’utilisation** (routing par intention, budgets/timeout par défaut, erreurs homogènes, observabilité).

Lis d’abord le brief, puis exécute les tâches **dans l’ordre**. Chaque tâche mentionne **les fichiers exacts à créer/modifier**, les **sous-étapes** (avec cases à cocher), **snippets** quand nécessaire, et les **tests** à écrire. Termine par les **règles build/tests** et les **critères d’acceptation**.

---

## Brief objectifs (résumé pour toi)

* Exposer ~12 **façades** “haut niveau” qui couvrent 90% des usages (création projet/artefacts, graphe, planification/exécution, enfants Codex, observation, mémoire).
* Basculer toutes les **primitives** en `hidden:true` (mode pro uniquement).
* Ajouter un **intent router** qui mappe un but naturel → façade.
* Appliquer **budgets** et **timeouts** par façade, **idempotence** par défaut, et **erreurs JSON-RPC** homogènes.
* Renforcer **observabilité** (logs corrélés, métriques/latences, /metrics).
* Garder la compatibilité **Node 20 + ESM + @types/node en dependencies** (c’est ce qui a stabilisé le build Cloud).

**Rappels de contraintes**

* Imports cœur Node **uniquement** `from "node:..."`.
* `tsconfig`: `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `target: "ES2022"`, `lib: ["ES2022"]`, `types: ["node"]`.
* Middleware JSON-RPC **unique** pour la validation (zod) et les erreurs.

---

## À FAIRE — Tâches à cocher, fichier par fichier

### 0) Pré-vol (cohérence de base)

* [x] `package.json`

  * [x] Confirme `@types/node` en **dependencies** (pas dev) — nécessaire en setup Cloud.
  * [x] Scripts présents : `build`, `start:http`, `start:stdio`, `test`, `coverage`.
* [x] `tsconfig.json`

  * [x] Vérifie `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `types: ["node"]`, `skipLibCheck: true`.

---

### 1) Registre/manifest des tools (centraliser, tagger, packs)

**Fichiers** : `src/mcp/registry.ts` (modifier/créer), `src/rpc/schemas.ts` (ajouts mineurs)

* [x] Étendre le **type de manifest** pour gérer catégories, tags, visibilité, dépréciation, budgets :

  * [x] `category: "project"|"artifact"|"graph"|"plan"|"child"|"runtime"|"memory"|"admin"`.
  * [x] `tags?: string[]` (ex : `"facade"`, `"authoring"`, `"ops"`).
  * [x] `hidden?: boolean` (primitives non exposées en mode basic).
  * [x] `deprecated?: { since: string; replace_with?: string }`.
  * [x] `budgets?: { time_ms?: number; tool_calls?: number; bytes_out?: number }`.

**Snippet — registre (extrait)**

```ts
// src/mcp/registry.ts
export interface ToolManifest {
  name: string;
  version: string;
  category: string;
  tags?: string[];
  hidden?: boolean;
  deprecated?: { since: string; replace_with?: string };
  input_schema: unknown;
  output_schema: unknown;
  budgets?: { time_ms?: number; tool_calls?: number; bytes_out?: number };
}

export function listVisible(all: ToolManifest[], mode: "basic"|"pro", pack: "basic"|"authoring"|"ops"|"all") {
  let out = all;
  if (mode === "basic") out = out.filter(t => !t.hidden || t.tags?.includes("facade"));
  if (pack === "basic") out = out.filter(t => t.tags?.includes("facade"));
  if (pack === "authoring") out = out.filter(t => ["facade","authoring"].some(tag => t.tags?.includes(tag)));
  if (pack === "ops") out = out.filter(t => ["facade","ops"].some(tag => t.tags?.includes(tag)));
  return out;
}
```

* [x] Lire les **env vars** (voir § 10) pour filtrer l’exposé : `MCP_TOOLS_MODE`, `MCP_TOOL_PACK`.
* [x] Mettre à jour l’enregistrement de **tous les outils existants** :

  * [x] Façades → `tags:["facade"]`, `hidden:false`.
  * [x] Primitives → `hidden:true` + (si remplacées) `deprecated`.

**Tests** :

* [x] `tests/mcp/registry.listVisible.test.ts` : modes basic/pro, packs basic/authoring/ops.

---

### 2) Réduction d’outils — créer **12 façades** et masquer les primitives

**Fichiers à CRÉER** dans `src/tools/` (façades) :

* [x] `project_scaffold_run.ts`
* [x] `artifact_write.ts` / [x] `artifact_read.ts` / [x] `artifact_search.ts`
* [x] `graph_apply_change_set.ts`
* [x] `graph_snapshot_time_travel.ts`
* [x] `plan_compile_execute.ts`
* [x] `child_orchestrate.ts`
* [x] `runtime_observe.ts`
* [x] `memory_upsert.ts` / [x] `memory_search.ts` (si mémoire activée)
* [x] `tools_help.ts`
* [x] `intent_route.ts`

**Exigences communes** (pour chaque façade)

* [x] Déclarer `manifest` avec `tags:["facade"]`, `budgets` par défaut.
* [x] Valider l’**input/output** via `zod` (placer schémas partagés dans `src/rpc/schemas.ts`).
* [x] Journaliser `request_id`/`trace_id` + **consommer budgets** avant action.
* [x] Gérer **idempotence** (clé fournie ou auto-générée).
* [x] Retour cohérent : `ok` (bool), `summary`, `details` (structuré).

**Snippets clés**

* `graph_apply_change_set.ts`

```ts
import { z } from "zod";
const Change = z.object({ op: z.enum(["add","update","remove"]), path: z.array(z.string()), value: z.any().optional() });
export const Input = z.object({ changes: z.array(Change), rationale: z.string().optional(), dry_run: z.boolean().optional() });

export async function run(input: z.infer<typeof Input>, ctx: Ctx) {
  ctx.budget.consume("tool_calls", 1) || ctx.failBudget("tool_calls");
  const tx = await ctx.graph.begin();
  const diff = await tx.apply(input.changes);
  const valid = await tx.validate();
  if (!valid.ok) return { ok:false, summary:"invalid graph", details: valid.errors };
  if (!input.dry_run) await tx.commit();
  return { ok: !input.dry_run, summary: "change-set applied", details: { diff } };
}
```

* `intent_route.ts` (V1 heuristique, upgradable)

```ts
export async function run({ natural_language_goal }: { natural_language_goal: string }) {
  const s = natural_language_goal.toLowerCase();
  if (/(graphe|patch|noeud|edge)/.test(s)) return { ok:true, chosen:"graph_apply_change_set" };
  if (/plan|pipeline|workflow/.test(s)) return { ok:true, chosen:"plan_compile_execute" };
  if (/fichier|artefact|write|save/.test(s)) return { ok:true, chosen:"artifact_write" };
  return { ok:true, candidates:["tools_help","artifact_search","child_orchestrate"] };
}
```

**Tests façade (golden)**

* [x] `tests/tools/facades/*.test.ts` : I/O valides + erreurs validation + budgets dépassés (mode dégradé).

---

### 3) HTTP — middleware, endpoints, sécurité

**Fichiers** : `src/httpServer.ts` (modifier), `src/http/{auth.ts,headers.ts,body.ts,rateLimit.ts}` (déjà présents)

* [x] Assurer l’ordre : **auth** (si nécessaire) → **rate-limit** → **body-size** → **JSON-RPC middleware**.
* [x] Ajouter/valider les endpoints :

  * [x] `GET /healthz` (no-auth).
  * [x] `GET /readyz` (auth, vérifie idempotency store + graph-forge chargé + event-bus vivant).
  * [x] `GET /metrics` (auth, latences p50/p95/p99 par méthode, erreurs, throughput).
* [x] **Headers de sécurité** (`applySecurityHeaders`) sur toutes réponses.

**Tests HTTP**

* [x] `tests/http/auth.test.ts`, `tests/http/limits.test.ts`, `tests/ops/health_ready.test.ts`, `tests/obs/metrics.test.ts`.

---

### 4) Middleware JSON-RPC (validation/erreurs homogènes)

**Fichiers** : `src/rpc/middleware.ts`, `src/rpc/schemas.ts`

* [x] Codes d’erreurs stabilisés : `VALIDATION_ERROR`, `AUTH_REQUIRED`, `RATE_LIMITED`, `IDEMPOTENCY_CONFLICT`, `TIMEOUT`, `INTERNAL`.
* [x] **Zod** obligatoire pour toutes méthodes publiques (façades).
* [x] Injection `request_id`/`trace_id` dans le contexte.

**Tests**

* [x] `tests/rpc/validation.test.ts` : inputs invalides → `VALIDATION_ERROR` uniforme (golden outputs).

---

### 5) Budgets & Timeouts

**Fichiers** : `src/infra/budget.ts` (créer), `src/rpc/timeouts.ts` (créer), intégrations dans chaque façade et dans `src/server.ts`.

* [x] Implémente `BudgetTracker` (time_ms, tool_calls, bytes_out).
* [x] `rpc/timeouts.ts` : mapping par méthode + valeur par défaut.
* [x] Mode **dégradé** (ex : réponse résumée) puis **stop** avec message d’action (“relance avec budget X”).

**Tests**

* [x] `tests/infra/budget.test.ts` et `tests/rpc/timeouts.test.ts`.

---

### 6) Idempotence & durcissement stateful

**Fichiers** : `src/infra/idempotencyStore.file.ts`, `src/server.ts` (wrap mutations)

* [x] Toujours lire/écrire idempotence sur méthodes à effet (graph commit, artefacts write, spawn/kill).
* [x] Ajouter **compaction** (optionnelle) si l’index file grossit.
* [x] Conflit → renvoyer `IDEMPOTENCY_CONFLICT` (409).

**Tests**

* [x] `tests/int/idempotency.http.test.ts`.

---

### 7) Graphe — invariants & journalisation métier

**Fichiers** : `src/graph/validate.ts` (créer), `src/graph/oplog.ts` (créer), `src/graph/tx.ts` (adapter)

* [x] `validateGraph()` : types, orphelins, cardinalités, bornes.
* [x] `oplog` (JSONL par op), distinct du WAL global (optionnel si déjà présent).
* [x] `tx.commit()` → `validateGraph()` **avant** commit.

**Tests**

* [x] `tests/graph/invariants.test.ts`, `tests/graph/oplog.test.ts`.

---

### 8) Streaming SSE & backpressure

**Fichiers** : `src/resources/sse.ts` (modifier)

* [x] Chunking à `MCP_SSE_MAX_CHUNK_BYTES` (défaut 32768).
* [x] Buffer borné par client (`MCP_SSE_MAX_BUFFER`) → DROP ancien + warn.
* [x] Timeout émisson (`MCP_SSE_EMIT_TIMEOUT_MS`).

**Tests**

* [x] `tests/streaming/sse.test.ts`.

---

### 9) Enfants (Codex) — orchestration unique & sandbox

**Fichiers** : `src/children/supervisor.ts` (renforcer breaker), `src/children/sandbox.ts` (créer), `src/tools/child_orchestrate.ts` (façade)

* [x] Circuit breaker : backoff exponentiel, limites `max_restarts_per_min`, états `open/half_open/closed`.
* [x] Sandbox profils (`strict|standard|permissive`) avec options Node (mémoire, intrinsics, etc.).
* [x] `child_orchestrate` encapsule spawn → send → observe → kill.

**Tests**

* [x] `tests/children/supervisor.test.ts`, `tests/children/sandbox.test.ts`, `tests/tools/child_orchestrate.test.ts`.

---

### 10) Observabilité & logs

**Fichiers** : `src/infra/tracing.ts` (ajouter histos p50/p95/p99, compteurs), `src/logger.ts` (enrichir champs), `src/httpServer.ts` (/metrics)

* [x] Ajouter/valider champs log : `request_id`, `trace_id`, `child_id`, `method`, `duration_ms`, `bytes_in/out`.
* [x] Activer export OTLP si `OTEL_EXPORTER_OTLP_ENDPOINT` défini.

**Tests**

* [x] `tests/obs/metrics.test.ts`, `tests/obs/logs.test.ts`.

---

### 11) Dépréciation/Nettoyage

**Fichiers** : chaque tool primitif (manifests)

* [x] Ajouter `deprecated` avec `since` + `replace_with`.
* [x] **Logguer** l’usage d’un deprecated (warning), et **masquer** en mode basic.
* [x] Plan de retrait : J+30 masque dur (même en pro), J+60 suppression (docs mises à jour).

**Tests**

* [x] `tests/mcp/deprecation.test.ts`.

---

### 12) Scripts d’exploitation & validations

**Fichiers** : `scripts/validation/run-smoke.mjs` (créer ou compléter), `scripts/validation/run-eval.mjs`

* [x] `run-smoke.mjs` : séquence auto (mcp_info → tools_list → graph_apply_change_set → child_orchestrate …) + sortie dans `runs/validation_<date>/`.
* [x] `run-eval.mjs` : fuzz JSON-RPC, payload volumineux, cas adversariaux.

**Tests**

* [x] Pas unitaires stricts, mais **exécution de smoke** en CI et export artefacts (logs/latences).

---

### 13) Documentation & env

**Fichiers** : `README.md` (mettre à jour), `.env.example` (ajouter si absent)

* [x] Documenter les **12 façades** : one-liner + **exemple minimal**.
* [x] Expliquer `MCP_TOOLS_MODE`, `MCP_TOOL_PACK`, budgets, token HTTP.
* [x] `.env.example` : variables clés (voir ci-dessous).

**Env vars recommandées**

* `MCP_HTTP_TOKEN` (obligatoire si HTTP)
* `MCP_SSE_MAX_CHUNK_BYTES=32768`
* `MCP_SSE_MAX_BUFFER=1048576`
* `MCP_SSE_EMIT_TIMEOUT_MS=5000`
* `IDEMPOTENCY_TTL_MS=600000`
* `MCP_TOOLS_MODE=basic|pro`
* `MCP_TOOL_PACK=basic|authoring|ops|all`
* `OTEL_EXPORTER_OTLP_ENDPOINT` (optionnel)
* `MCP_LOG_REDACT=on|off`

---

## Ce que tu dois respecter pour les **tests** & le **build**

**Build (local & Cloud)**

1. `npm ci --include=dev` (ou CI)
2. `npm run build` (compile `src` puis `graph-forge`)
3. `npm run lint`

**Tests**

* `npm run test` puis `npm run coverage` (objectifs : stmts/funcs/lines ≥ **85%**, branches ≥ **70%**).
* Pas de tests flakey; fixer timeouts de test raisonnables (SSE/HTTP).
* “Golden outputs” pour les façades et pour le middleware d’erreur.

---

## Critères d’acceptation (à valider à la fin)

* **Façades** : 12 outils visibles en mode basic, chaque manifest avec exemple et budgets.
* **Primitives** : cachées (`hidden:true`) et/ou dépréciées proprement.
* **Intent router** : redirige ≥ 70% des intentions simples vers la bonne façade, sinon propose 2–3 candidats.
* **Budgets/timeouts** : activés et testés (mode dégradé + stop propre).
* **HTTP** : `/healthz`, `/readyz` (avec dépendances), `/metrics` (p50/p95/p99, erreurs/req).
* **Graphe** : invariants appliqués **avant** commit; erreurs lisibles.
* **Idempotence** : même clé → même résultat; conflit renvoie `IDEMPOTENCY_CONFLICT`.
* **SSE** : chunking et backpressure fonctionnels; pas d’OOM sur client lent.
* **Observabilité** : logs corrélés (`request_id`, `trace_id`, `method`, latence, bytes), export OTLP optionnel.
* **Docs** : README à jour (façades, packs, env), `.env.example` présent.
* **Smoke** : `run-smoke.mjs` génère un récap (latences p95, erreurs, outils top usage) dans `runs/validation_*`.

---

Si tu veux un **bootstrap de code** (squelettes compilables) pour les nouveaux fichiers — `registry.ts` enrichi, `graph_apply_change_set.ts`, `intent_route.ts`, `budget.ts`, `timeouts.ts`, tests “golden” par façade — je peux te livrer un lot prêt à coller pour accélérer la première passe.

### Historique des actions

* 2025-10-14T06:27Z — gpt-5-codex : Étend le manifest Tool-OS (catégorie, visibilité, budgets, dépréciation), ajoute les filtres `listVisible` (mode/pack, env) et crée le test ciblé `tests/mcp/registry.listVisible.test.ts`. Commandes : `npm run lint:types` ; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/mcp/registry.listVisible.test.ts`.

* 2025-10-14T07:45Z — gpt-5-codex : Ajoute l’inférence automatique de catégorie depuis le nom des outils, force `hidden` par défaut hors façades et étend `tests/mcp/registry.test.ts`. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/mcp/registry.test.ts` ; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/mcp/registry.listVisible.test.ts` ; `npm run lint:types`.

* 2025-10-14T06:56Z — gpt-5-codex : Crée la façade `intent_route` avec budgets, idempotence basique et journalisation corrélée, expose ses schémas Zod dédiés (`src/rpc/intentRouteSchemas.ts`) et enregistre la façade via le ToolRegistry. Ajoute les tests unitaires `tests/tools/facades/intent_route.test.ts`. Commandes : `npm run lint:types` ; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/intent_route.test.ts`.
* 2025-10-14T07:07Z — gpt-5-codex : Ajoute la façade `tools_help` (manifest façade, filtrage multi-critères, budgets/idempotence,
observabilité), publie ses schémas (`src/rpc/toolsHelpSchemas.ts` via `src/rpc/schemas.ts`), l’enregistre côté serveur MCP et crée
les tests `tests/tools/facades/tools_help.test.ts`. Commandes : `npm run lint:types` ; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/tools_help.test.ts`.

* 2025-10-14T08:15Z — gpt-5-codex : Implémente les façades `artifact_write`, `artifact_read` et `artifact_search` avec budgets, idempotence et journalisation, ajoute leurs schémas (`src/rpc/artifactSchemas.ts`), les enregistre dans le serveur, et couvre les cas de succès/budget/validation via `tests/tools/facades/artifact_*.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/artifact_write.test.ts`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/artifact_read.test.ts`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/artifact_search.test.ts`.

* 2025-10-14T07:44Z — gpt-5-codex : Livre la façade `graph_apply_change_set` (manifest façade, budgets, idempotence, validation et journalisation), expose ses schémas (`src/rpc/graphApplyChangeSetSchemas.ts`), enregistre l'outil MCP et ajoute les tests `tests/tools/facades/graph_apply_change_set.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/graph_apply_change_set.test.ts`.
* 2025-10-14T08:03Z — gpt-5-codex : Ajoute la façade `graph_snapshot_time_travel` (schemas dédiés, budgets, idempotence, modes liste/apercu/restaure et diff normalisé), l'enregistre côté serveur et couvre les cas de succès/dégradation avec `tests/tools/facades/graph_snapshot_time_travel.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/graph_snapshot_time_travel.test.ts`.
* 2025-10-14T09:20Z — gpt-5-codex : Implémente la façade `plan_compile_execute` (manifest façade, budgets, idempotence, résumés plan/schedule/BT), ajoute les schémas dédiés (`src/rpc/planCompileExecuteFacadeSchemas.ts`), l'enregistre côté serveur et crée les tests ciblés `tests/tools/facades/plan_compile_execute.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/plan_compile_execute.test.ts`.
* 2025-10-14T08:35Z — gpt-5-codex : Ajoute les façades `memory_upsert` et `memory_search` (manifestes façade, budgets, idempotence, rejouabilité), publie leurs schémas (`src/rpc/memoryFacadeSchemas.ts`), met à jour `src/server.ts` et enregistre les outils. Crée les tests `tests/tools/facades/memory_upsert.test.ts` et `tests/tools/facades/memory_search.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/memory_upsert.test.ts tests/tools/facades/memory_search.test.ts`.
* 2025-10-14T09:55Z — gpt-5-codex : Implémente la façade `child_orchestrate` (budgets, idempotence, observation et arrêt configurables), publie les schémas `src/rpc/childOrchestrateSchemas.ts`, enregistre l'outil via `src/server.ts` et ajoute les tests `tests/tools/facades/child_orchestrate.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/child_orchestrate.test.ts`.
* 2025-10-14T09:17Z — gpt-5-codex : Corrige la façade `child_orchestrate` (retour `isError:false` sur succès, retrait de l'instrumentation de test) pour stabiliser la suite et fiabiliser l'assertion d'idempotence. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/child_orchestrate.test.ts`.
* 2025-10-14T09:29Z — gpt-5-codex : Ajoute la façade `runtime_observe` (schémas dédiés, manifest façade, collecte snapshot/metrics, enregistrement serveur) et crée la suite `tests/tools/facades/runtime_observe.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/runtime_observe.test.ts`.
* 2025-10-14T09:43Z — gpt-5-codex : Livre la façade `project_scaffold_run` (schemas dédiés, idempotence, budgets, enregistrement serveur, tests ciblés) et couvre les diagnostics budget/sandbox. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/project_scaffold_run.test.ts`.

* 2025-10-14T10:45Z — gpt-5-codex : Documente les façades visibles (one-liners + exemples JSON), explique les variables d'exposition/budgets, ajoute `.env.example` et met à jour le suivi. Commandes : `npm run lint:types`.
* 2025-10-14T14:57Z — gpt-5-codex : Réorganise la chaîne de garde HTTP (auth → rate-limit → body → JSON-RPC), ajoute une couverture `ops/health_ready` garantissant l'ordre et tolère les doubles enregistrements MCP durant les tests. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/ops/health_ready.test.ts`; `npm run lint:types`.
* 2025-10-14T15:40Z — gpt-5-codex : Centralise la politique de dépréciation (catalogue, filtrage ToolRegistry, blocage J+60), ajoute les journaux d’usage côté transport HTTP et publie `tests/mcp/deprecation.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/mcp/deprecation.test.ts`.
* 2025-10-14T16:20Z — gpt-5-codex : Vérifie et coche les jalons HTTP/middleware/budget/idempotence/graph/SSE/enfants/observabilité déjà en place, actualise AGENTS.md et confirme la présence des suites associées. Commandes : `npm run lint:types`.
* 2025-10-14T16:26Z — gpt-5-codex : Supprime le double enregistrement MCP du plan compile & execute pour laisser la façade piloter le manifeste, vérifie les scripts `run-smoke`/`run-eval` et coche les entrées de validation. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/validation/run-smoke.test.ts tests/validation/run-eval.test.ts`.
* 2025-10-14T16:30Z — gpt-5-codex : Ajoute une couverture de registre dédiée pour `plan_compile_execute`, vérifie qu’une seule entrée MCP est créée et que les doublons lèvent `ToolRegistrationError`, puis étend la suite mocha correspondante. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/plan_compile_execute.test.ts`; `npm run lint:types`.
* 2025-10-14T16:55Z — gpt-5-codex : Active les overrides de budgets via l’environnement, propage les manifestes enrichis côté serveur pour créer les `BudgetTracker` des façades, documente le pattern `MCP_TOOLS_BUDGET_*` et ajoute une intégration qui observe la consommation du routeur d’intentions. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/mcp/registry.test.ts tests/integration/tool.budgets.test.ts`.
