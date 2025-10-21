----------
Voici la **feuille de route détaillée** (à cocher) destinée à **l’agent IA** pour **consolider** la base actuelle sans introduire de nouvelles fonctionnalités. Elle couvre **code, tests, build, scripts et CI**, avec sous-étapes et références **fichier par fichier**. À exécuter **dans l’ordre** (haut = plus prioritaire).

---

# Chantier en cours — `exactOptionalPropertyTypes`

Suivi granulaire des tâches engagées pour préparer l'activation de `exactOptionalPropertyTypes`.

- [x] Nettoyer les profils sandbox enfant via `omitUndefinedEntries` dans `src/orchestrator/runtime.ts`.
- [x] Couvrir le comportement du superviseur enfant avec un test dédié `tests/child.supervisor.sandbox-config.test.ts`.
- [x] Balayer les autres occurrences de `?? undefined` dans `src/orchestrator/runtime.ts` (`rg "\?\? undefined" src/orchestrator/runtime.ts`).
- [x] Ajouter des tests ciblant `pushEvent` avec `jobId`/`childId` `null` ou omis.
- [x] Étendre le nettoyage aux autres modules orchestrateur identifiés lors de la recherche.
- [x] Corriger les assertions CLI `knowledge`/`plans` pour viser `result.summaryPath` via le résultat imbriqué.
- [x] Omettre les identifiants de boucle indéfinis dans `handleChildSend` et couvrir le stub superviseur.
- [x] Purger les résumés validation (`children`, `robustness`, `finalReport`) pour omettre les clés `undefined` et couvrir les cas sans transcript/idempotency.
- [x] Balayer les `?? undefined` restants hors validation (executor, mcp registry, tools) avant d'activer `exactOptionalPropertyTypes`.

# BRIEF À L’AGENT — objectifs & règles

**Objectifs**

* Stabiliser le build, fiabiliser l’exécution, homogénéiser les conventions TypeScript/ESM, renforcer la robustesse (erreurs, timeouts, ressources), et **réduire la dette technique** (duplication, fichiers massifs, typage lâche).
* Ne **rien ajouter** côté fonctionnalités : on **refactorise**, **renomme**, **déplace**, **nettoie**, **renforce les tests**.

**Règles tests & build**

* Le **build** TypeScript compile **uniquement `src/**`**.
* Les **tests** sont **100% TypeScript**, **type-checkés** via `tsconfig.tests.json`, exécutés par **Mocha** via **tsx** limité aux `.ts`.
* **Aucune** inclusion de tests en `tsconfig.json` (build).
* **Couverture** : maintenir (ou mieux) les seuils actuels; ajouter des tests lorsqu’un refactor touche du code exécuté.
* **ESM** : imports Node **avec préfixe `node:`** ; pas de CommonJS résiduel.
* **Pas de changements fonctionnels** dans la logique métier (refactor seul).

## Suivi — Event bus typé (2025-10-21)

- [x] Ajuster `tests/events.bus.kind-normalisation.test.ts` pour refléter les payloads structurés (fait 2025-10-21).
- [x] Balayer les suites vérifiant `event.data` afin de confirmer les nouvelles formes (fait 2025-10-21).
- [x] Typé les payloads autoscaler et scheduler dans `EventPayloadMap` et aligné les tests de souscription (fait 2025-10-21).
- [x] Typé les payloads JSON-RPC dans `EventPayloadMap` et harmonisé `recordJsonRpcObservability` côté runtime/controller (fait 2025-10-21).
- [x] Typé les payloads du superviseur enfant (limits & breaker) dans `EventPayloadMap` et renforcé les tests bus/enfants (fait 2025-10-21).
- [x] Typé les payloads `introspection_probe` et `alive` dans `EventPayloadMap`, ajouté la couverture dédiée et validé le stockage brut (fait 2025-10-21).
- [x] Typé les payloads `plan`, `prompt`, `aggregate`, `status`, `bt_run`, `scheduler` et `autoscaler` dans `EventPayloadMap` et étendu `tests/events/bus.types.test.ts` pour couvrir ces formes (fait 2025-10-21).

---

# 1) Build & Config TypeScript

## 1.1 `tsconfig.json` (build app seulement)

* [x] **Vérifier/renforcer** :

  * `"rootDir": "src"`, `"outDir": "dist"`, `"module": "ESNext"`, `"target": "ES2022"`, `"moduleResolution": "Bundler"`, `"strict": true`, `"skipLibCheck": true`.
  * `"include": ["src/**/*.ts"]`
  * `"exclude": ["tests", "**/*.test.*", "**/*.spec.*", "dist", "node_modules"]`
* [x] **Activer** checks stricts supplémentaires :

  * [x] `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"noImplicitReturns": true`, `"noFallthroughCasesInSwitch": true`.
  * [ ] `"exactOptionalPropertyTypes": true` (bloqué : l'activation déclenche >400 erreurs réparties dans 100+ fichiers — nécessite un chantier dédié avec refactors massifs).
* [x] **Corriger le code** si ces options révèlent des erreurs (voir sections refactor & typage).

## 1.2 `tsconfig.tests.json` (type-check tests)

* [x] Vérifier :

  ```json
  {
    "extends": "./tsconfig.json",
    "compilerOptions": { "noEmit": true, "rootDir": "." },
    "include": ["tests/**/*.ts", "src/**/*.ts"]
  }
  ```
* [x] Si des tests `.js` subsistent (ne devrait pas) → **renommer** en `.ts` + corriger les imports/typages.

## 1.3 `package.json` — scripts

* [x] Vérifier/ajuster :

  ```json
  {
    "scripts": {
      "build": "tsc -p tsconfig.json && tsc -p graph-forge/tsconfig.json",
      "typecheck": "tsc -p tsconfig.tests.json --noEmit",
      "test:unit": "cross-env TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts \"tests/**/*.test.ts\"",
      "test": "npm run build --silent && npm run typecheck && npm run test:unit"
    },
    "engines": { "node": ">=20 <21" }
  }
  ```
* [x] **Confirmer** que `TSX_EXTENSIONS=ts` est présent (évite les parse errors de tsx sur `.js`).
* [x] **Node** en CI/Cloud : **20.x** (conforme `engines`).

---

# 2) Scripts d’environnement

## 2.1 `scripts/setup-codex.sh`

* [x] **S’assurer** que les lignes de **neutralisation proxy** sont en place **avant** le premier `npm` :

  ```bash
  unset NPM_CONFIG_PRODUCTION || true
  unset NPM_CONFIG_OMIT       || true
  unset NPM_CONFIG_HTTP_PROXY   || true
  unset NPM_CONFIG_HTTPS_PROXY  || true
  unset npm_config_http_proxy   || true
  unset npm_config_https_proxy  || true
  ```
* [x] **Limiter** `NODE_ENV=development` **au scope des commandes npm/npx** (pas global).
* [x] **Guard HTTP** : si `START_HTTP=1` et pas de `MCP_HTTP_TOKEN` **et** `MCP_HTTP_ALLOW_NOAUTH!=1` → **exit 3** (sécurité).
* [x] **trap cleanup** pour tuer le serveur HTTP de fond et supprimer `/tmp/mcp_http.pid` à la fin.
* [x] **chmod +x** et **shellcheck** (si dispo) → corriger éventuels warnings. (shellcheck indisponible dans l’environnement courant — contrôle manuel effectué.)

---

# 3) Sécurité HTTP & serveurs

## 3.1 `src/httpServer.ts`

* [x] **Relire** la logique `enforceBearerToken()` :

  * 401 JSON-RPC par défaut si pas de token, sauf `MCP_HTTP_ALLOW_NOAUTH=1`.
  * Réponses d’erreur **JSON-RPC** homogènes (code, message) + content-type correct.
* [x] **Uniformiser** les logs (clé `http_access`, ip/route/status/latency).
* [x] **Tests** : `tests/http/http_auth.test.ts`, `tests/http/http_rate_limit.test.ts`

  * Sans token → 401 ; avec `ALLOW_NOAUTH=1` → 200 ; dépassement débit → 429.
  * Vérifier **stateless** JSON-RPC si `--http-stateless yes`.

## 3.2 `src/http/rateLimit.ts`

* [x] **Paramétrage** via env existante (`MCP_HTTP_RATE_LIMIT_*`).
* [x] **Tests** : taux, fenêtre, reset ; cas limites (burst court, longue rafale).

---

# 4) Centralisation configuration & ENV

## 4.1 `src/serverOptions.ts` + usages dispersés

* [x] **Créer/compléter** un module central `src/config/env.ts` :

  * [x] Fonctions : `readBool(name, def)`, `readInt(name, def)`, `readEnum(name, allowed, def)`, etc.
  * [x] **Interpréter** uniformément `"0"|"false"|"no"` et `"1"|"true"|"yes"`.
* [x] **Remplacer** les parsings ENV **dispersés** (ex. `httpServer.ts`, `orchestrator/bootstrap.ts`, `monitor/dashboard.ts`) par ces helpers.

  * [x] `src/httpServer.ts` (ratelimit + `MCP_HTTP_ALLOW_NOAUTH`).
  * [x] `src/orchestrator/bootstrap.ts` — ne lit plus directement `process.env`; vérifié via `rg "process\.env" src/orchestrator`.
  * [x] `src/monitor/dashboard.ts` — ne dépend plus des variables d'environnement globales; contrôlé via `rg "process\.env" src/monitor`.
  * [x] `src/resources/sse.ts` (buffers/chunks/timeouts via helpers + tests env).
  * [x] `src/paths.ts`, `src/state/wal.ts`, `src/state/snapshot.ts`, `src/http/bootstrap.ts`, `src/mcp/registry.ts` → overrides `MCP_RUNS_ROOT`/`MCP_CHILDREN_ROOT` centralisés via `readOptionalString` + tests `tests/config/runsRoot.env.test.ts`.
  * [x] `src/tools/childTools.ts`, `src/tools/toolRouter.ts`, `src/learning/lessonPrompts.ts`, `src/rpc/timeouts.ts`, `src/infra/tracing.ts`, `src/bridge/fsBridge.ts`, `src/logger.ts` → parsings centralisés (`readBool`/`readOptionalInt`/`readOptionalString`) + suites `tests/child.spawn.http-descriptor.test.ts`, `tests/tools/toolRouter.env.test.ts`, `tests/rpc/timeouts.env.test.ts`, `tests/infra/tracing.otlp-env.test.ts`, `tests/learning/lessonPrompts.test.ts`.
  * [x] `src/config/env.ts` accepte désormais `allowEmpty` pour les chaînes; `src/orchestrator/runtime.ts` alimente `MEM_BACKEND` et les options de rotation (`MCP_LOG_*`) via les helpers partagés + `tests/config/env.parse.test.ts` couvre le cas vide explicite.
  * [x] `src/graph/tx.ts` — la politique de snapshots lit `MCP_GRAPH_SNAPSHOT_*` via `readOptionalInt` et reste alignée avec l'ancien comportement (`tests/graph/tx.snapshot-policy.env.test.ts`).
* [x] **Tests** : `tests/config/env.parse.test.ts` — table-driven (chaînes variantes → valeur attendue).

---

# 5) Gestion erreurs & robustesse

## 5.1 `src/gateways/childProcess.ts` + `src/childRuntime.ts`

* [x] **Encadrer** spawn/IPC :

  * [x] Gestion `error`, `exit`, `close`; propagation d’erreur à l’orchestrateur; **timeout** sur opérations bloquantes.
  * [x] Nettoyage handles/streams à la fin (éviter fuites).
  * [x] Couvrir la propagation de timeout lorsque l’enfant dépasse `timeoutMs` sur un cas réel (à ajouter).
  * [x] Documenter l’interaction entre gateways custom dont `dispose()` retire les listeners et le fait de ne pas appeler `dispose()` après un spawn réussi.
* [x] **Tests** : `tests/children/spawn-errors.test.ts` — simuler un crash enfant, vérifier **cleanup** et **log**.
  * [x] `tests/gateways/child.spawn.test.ts` vérifie l’enregistrement/suppression du listener `close`.

## 5.2 `src/events/eventStore.ts`

* [x] **Limiter** mémoire (éviction, tailles max) **déjà prévue** → vérifier l’application réelle partout où c’est lu.
* [x] **Tests** : `tests/events/eventStore.retention.test.ts` — insérer N+X events → **éviction** correcte, pagination stable.

## 5.3 `src/monitor/dashboard.ts`

* [x] **SSE / buffers** : respecter `MCP_SSE_MAX_BUFFER`; flush/keep-alive; gestion d’erreurs réseau.
* [x] **Tests** : `tests/monitor/dashboard.sse.test.ts` — clients multiples, buffer plein, déconnexion.
* [x] **Compat tests historiques** : `tests/monitor.dashboard.streams.test.ts` adapté au buffer SSE borné (attente asynchrone des `data:` et parsing des frames `id/event`).

---

# 6) Réduction de duplication & découpage modules massifs

## 6.1 Fichiers volumineux (à **refactoriser sans changer la logique**)

* [x] `src/orchestrator/runtime.ts`

  * **Extraire** :

    * [x] `src/orchestrator/eventBus.ts` (bus/abonnements),
    * [x] `src/orchestrator/controller.ts` (boucle d’orchestration),
    * [x] `src/orchestrator/logging.ts` (formatage/structure des logs).
  * **Remplacer** les `any` par des types locaux; **early returns**; **sous-fonctions**.
  * **Tests** : déplacer/adapter tests d’intégration existants pour pointer les nouveaux modules.

* [x] `src/tools/graphTools.ts`

  * **Segmenter** par familles : `graph/mutate.ts`, `graph/query.ts`, `graph/snapshot.ts`.
  * [x] Mutualiser utilitaires communs dans `src/tools/shared.ts` (purement **refactor**).
  * **Tests** : mapper 1:1 les tests existants sur les nouveaux modules (aucun test supprimé).

* [x] `src/tools/planTools.ts`

  * [x] **Extraire** décisions/validation dans `src/tools/plan/validate.ts` & `plan/choose.ts`.
  * [x] **Réduire** complexité cyclomatique (switch/if imbriqués → fonctions ciblées).
  * [x] **Tests** : inchangés côté comportement ; ajuster imports.

* [x] `src/tools/childTools.ts`

  * **Déplacer** connecteurs enfant (actions récurrentes) dans `src/children/api.ts`.
  * **Factoriser** gestion d’erreur et retries (utilitaires communs).

## 6.2 Arborescence logique

* [x] **Déplacer** `src/childSupervisor.ts` → `src/children/supervisor.ts` (si non déjà fait).
* [x] **Déplacer** `src/graphState.ts` → `src/graph/state.ts`.
* [x] **Renommer** si ambiguïté (ex. `childSupervisor` côté orchestrateur vs enfant).

---

# 7) TypeScript : typage strict & nettoyages

## 7.1 Éliminer `any` évitables

* [x] Passer `any` → `unknown` + **type guards** lorsque nécessaire.
  * [x] `src/eval/runner.ts` : introduction de gardes `extractTraceId`/`isCostMetadata` + tests `tests/eval/runner.test.ts`.
  * [x] `src/tools/graph_apply_change_set.ts` : enregistrement sans transtypage via extension de `GraphOperation.kind`.
* [x] Typages précis pour événements, plans, artefacts (unions discriminées).

## 7.2 Supprimer transtypages lourds

* [x] Éviter `as unknown as T` en introduisant **interfaces communes** ou **narrowing** via predicates.
  * ✅ Progression : les suites `tests/tools/facades/*.test.ts` s'appuient désormais sur des charges utiles typées sans double transtypage.
  * [x] `src/tools/tools_help.ts` : extraction d'helpers pour enums/union et suppression des doubles transtypages.
  * [x] `src/events/bus.ts` : spécialiser l'itérateur async pour supprimer les transtypages terminaux (`IteratorReturnResult<void>`).
  * [x] Suites `tests/graphforge*.test.ts` : mutualiser le chargement typé via `tests/helpers/graphForge.ts` pour éliminer les casts manuels.
  * [x] `tests/http/jsonrpc.errors.test.ts` : remplacer le stub ad hoc par `RecordingLogger` + garde `expectRecord` pour éviter `as unknown as`.
  * [x] `src/orchestrator/runtime.ts` : introduit `toStructuredContent` pour typer les réponses outillées et étendre les interfaces (`rag`, `tx`, autoscaler) avec `Record<string, unknown>`.
  * [x] `src/orchestrator/runtime.ts` : remplace les casts directs sur `server.server` et Graph Forge par des helpers typés (`getRegisteredToolMap`, `normaliseGraphForgeModule`) et couvre l'absence de registre via `tests/mcp.info-capabilities.test.ts`.
  * [x] `src/executor/cancel.ts` : rendre le handle nullable durant l'initialisation et ajouter `tests/executor/cancel.test.ts` pour garantir qu'aucune valeur `null` n'est exposée.
  * [x] `tests/mcp/deprecation.test.ts` : basculer sur `RecordingLogger` + helper dédié pour retirer les doubles transtypages.
  * [x] `tests/events.bus.types.test.ts` & `tests/events/bus.types.test.ts` : introduire `coerceToEventMessage` afin de simuler les appels JavaScript dynamiques sans `as unknown as`.
  * [x] `tests/helpers/http.ts` : instancier un véritable `IncomingMessage` via `Socket` + `IncomingMessage` et injecter les charges utiles sans `as unknown as` tout en ajoutant une suite dédiée.
  * [x] `tests/int/idempotency.http.test.ts` : typer les requêtes/réponses via `HttpResponseLike` et `RecordingLogger` afin de supprimer les `as any` résiduels sur la voie HTTP.
  * [x] `tests/runtime.timers.test.ts` : stubber les minuteurs globaux via Sinon et réutiliser de vrais handles pour supprimer les doubles transtypages.
  * [x] `tests/plan.join.vote.integration.test.ts` : introduire `PlanChildSupervisor` et un stub typé + `RecordingLogger` pour supprimer `as unknown as`.
  * [x] `tests/rpc/*.test.ts` : utiliser `coerceToJsonRpcRequest` afin de supprimer les doubles transtypages et documenter l'intention.
  * [x] `tests/rpc/timeouts.test.ts` : exposer un registre JSON-RPC typé via `__rpcServerInternals` pour bannir `as unknown as` lors de l'injection de handlers.
  * [x] `src/infra/workerPool.ts` & `tests/infra/workerPool.resilience.test.ts` : introduire `GraphWorkerLike` + l'override `workerScriptUrl` pour supprimer les casts `as unknown as` restants et documenter l'injection test.
  * [x] `tests/helpers/planContext.ts` + suites `tests/plan*.test.ts` et `tests/cancel.random-injection.test.ts` : factoriser la construction du `PlanToolContext`, fournir un logger espion commun et retirer les `as unknown as` restants côté plan/comportement.
  * [x] `tests/events.bridges.test.ts`, `tests/plan.run-reactive.test.ts`, `tests/e2e.plan.hier-reactive.test.ts` : introduire `ChildRuntimeEventSource` et des contrats `Autoscaler`/`Supervisor` pour éliminer les doubles transtypages.
  * [x] `tests/plan.fanout-join.test.ts` & `tests/bulk.bb-graph-child-stig.test.ts` : réutiliser les stubs typés (`createStubChildSupervisor`) et l'index public du superviseur pour supprimer les derniers `as unknown as` restants dans ces suites.
  * [x] `tests/child.spawn.ready-timeout.test.ts`, `tests/e2e/http-server.test.ts`, `tests/obs/metrics.test.ts` : instancier des superviseurs et requêtes HTTP typés pour éliminer les doubles transtypages, documenter les stubs runtime et s'appuyer sur les helpers existants.
  * [x] `src/monitor/dashboard.ts`, `tests/monitor.dashboard*.test.ts`, `tests/helpers/http.ts` : introduire `DashboardHttpResponse` pour typer le routeur HTTP du dashboard, moderniser les stubs de réponse/requests et supprimer les `as unknown as` résiduels tout en documentant l'enrichissement des helpers.
  * [x] `src/mcp/jsonRpcInternals.ts`, `src/orchestrator/controller.ts`, `tests/http.jsonrpc.fast-path.test.ts`, `tests/integration/jsonrpc.observability.test.ts`, `tests/e2e/http_stateless.test.ts`, `tests/e2e/child.http.test.ts` : mutualiser l'accès typé au registre JSON-RPC du serveur MCP et supprimer les transtypages `as unknown as` associés.
  * [x] `tests/planner/compile.test.ts`, `tests/tools/facades.golden.test.ts`, `tests/server.tools.errors.test.ts` : aligner les contextes plan/façades sur `createPlanToolContext`, supprimer les doubles casts et typer les helpers de nettoyage JSON.
* [x] `tests/prompts.test.ts`, `tests/router.modelRouter.test.ts`, `tests/e2e.*.consensus*.test.ts`, `tests/perf/scheduler.bench.ts` : remaining casts `as unknown as` à migrer vers des helpers typés (planifiés). (Prompts/router/perf nettoyés ; `tests/e2e.contract-net.consensus.mcp.test.ts` s'appuie désormais sur `ChildRuntimeContract` et `createStubChildRuntime`.)
  * [x] `tests/plan.fanout-join.test.ts`, `tests/e2e.rewrite.recovery.test.ts`, `tests/e2e.stigmergy.autoscaling.test.ts`, `tests/idempotency.replay.test.ts`, `tests/bulk.bb-graph-child-stig.test.ts`, `tests/quality.scoring.test.ts` : adoption de `ChildSupervisorContract`, des stubs partagés et de `createPlanToolContext` pour éliminer les `as unknown as` résiduels et fiabiliser les assertions.
  * [x] `tests/causal.integration.bt-scheduler.test.ts` : recycler `createPlanToolContext` et un logger structuré afin de supprimer le cast `{} as ChildSupervisor` et garantir des horodatages déterministes dans la stigmergie de test.
* [x] **Tests** : compiler en `--noEmit` (script `typecheck`) → **0 erreurs**.

## 7.3 Activer options strictes (cf. §1.1) et corriger

* [x] Corriger **retours implicites**; supprimer **locaux/paramètres non utilisés**; compléter **branches switch**.
  * ✅ 2025-10-21 : retiré les suppressions lint restantes sur les doublures de processus enfant en consommant explicitement les paramètres inutilisés ; typecheck et suites ciblées verts.

---

# 8) HTTP/JSON-RPC : cohérence et tests

## 8.1 Réponses d’erreur unifiées

* [x] Dans `src/httpServer.ts`, centraliser `jsonRpcError(code, message, data?)`.
* [x] **Remplacer** toutes créations ad-hoc par cet utilitaire.
* [x] **Tests** : `tests/http/jsonrpc.errors.test.ts` — codes et messages attendus.

## 8.2 Log d’accès & métriques

* [x] **S’assurer** que chaque requête HTTP logue un **événement structuré** (latence, route, status).
* [x] **Tests** : vérifier présence du log via `EventStore`.

---

# 9) Enfants & Sandboxing

## 9.1 `src/children/*` & `src/childRuntime.ts`

* [x] **Timeouts** cohérents (ENV → helpers config).
  * `src/orchestrator/runtime.ts` lit désormais `MCP_CHILDREN_ROOT`/`MCP_CHILD_COMMAND`/`MCP_CHILD_ARGS` via `read*` + helpers `resolveSandboxDefaults`, avec log `child_sandbox_profile_configured` et budgets dérivés (`resolveRequestBudgetLimits`).
  * **Tests** : `tests/runtime.child-env-overrides.test.ts` couvre racine enfants, commande/args, sandbox et budgets.
* [x] **Arrêt gracieux** + **forcé** avec délais; vérifier **zombie-kill** dans `trap` du script.
  * `ChildRuntime.shutdown` couvert par la nouvelle suite ciblée.
* [x] **Tests** : `tests/children/graceful-shutdown.test.ts`.

## 9.2 Sandboxing profils

* [x] Vérifier application de `MCP_CHILD_SANDBOX_PROFILE` : loguer le profil appliqué au démarrage.
  * Log structuré ajouté et exposé via `__envRuntimeInternals`.
* [x] **Tests** : `tests/children/sandbox.profile.test.ts` — modes strict/standard/permissive (mêmes comportements qu’actuellement).

---

# 10) EventStore & Replay

## 10.1 `src/events/eventStore.ts`

* [x] **Sérialisation stable** (ordre des champs) pour diff plus lisibles.
* [x] **Index** par `jobId`, `kind` (si déjà en mémoire, au moins doc claire des structures).
* [x] **Tests** : `tests/events/indexing.test.ts` — recherche par `jobId`/`kind` cohérente.

---

# 11) Monitor/Dashboard

## 11.1 `src/monitor/dashboard.ts`

* [x] **Endpoints** : vérifier statuts HTTP, content-types, SSE headers.
* [x] **Défauts sûrs** si options manquantes.
* [x] **Tests** : `tests/monitor/dashboard.http.test.ts` — readyz/metrics/SSE basiques.

---

# 12) Registry & Tools

## 12.1 `src/resources/registry.ts`

* [x] **Types** explicites pour ressources; **aucun `any`**; retour d’erreur clair si ressource absente.
* [x] **Tests** : `tests/resources/registry.test.ts`.

## 12.2 `src/tools/*`

* [x] **Normaliser** les retours (forme, erreurs typées).
* [x] **Facto** helpers communs dans `src/tools/shared.ts` (refactor pur).
* [x] **Tests** : maintenir scénarios existants; ajuster imports.

---

# 13) Mémoire & Valeurs (interne, sans ajout de capacité)

## 13.1 `src/values/valueGraph.ts` / `src/memory/vectorMemory.ts`

* [x] **Vérifier** bornes (tailles max, éviction, poids).
* [x] **Tests** : exercices de bornage (pas d’allocations non bornées).

---

# 14) Logging & Redaction

## 14.1 `src/logger.ts` (ou module équivalent)

* [x] **Redaction** activée par défaut (`MCP_LOG_REDACT=true`).
* [x] **Tests** : `tests/logs/redaction.test.ts` — pas de secrets en clair.

---

# 15) Graph-Forge (vendored)

## 15.1 `graph-forge/tsconfig.json`

* [x] **Confirmer** compilation uniquement de son sous-arbre vers `graph-forge/dist`.
* [x] **Tests** : conserver **node:test** actuels OU exposer script séparé `npm run test:graph-forge` (sans l’intégrer au build app).
* [x] **.gitignore** : **ne pas** committer les `.js` compilés de test; générer à la volée si besoin.

---

# 16) CI & Artefacts

## 16.1 Workflow

* [x] Jobs : `npm ci` → `npm run build` → `npm run typecheck` → `npm run test`. (Workflow `ci.yml` exécute ces étapes explicitement; la commande `npm run test` garde la séquence complète et produit le TAP.)
* [x] **Node 20**. (`actions/setup-node@v4` est fixé sur `20.x`.)
* [x] **Cache** npm basé sur `package-lock.json`. (`cache: npm` dans `setup-node` exploite `package-lock.json`.)
* [x] **Artefacts** : TAP (`tap.txt`) + `self-codex.test.log`. (Étapes `Upload TAP report` et `Upload unit test log` dans `ci.yml`.)

---

# 17) Conventions & Hygiène

## 17.1 ESLint/Prettier (outil de style — pas de logique)

* [x] Ajouter/maintenir ESLint TS + règles de base; Prettier si souhaité. (`eslint.config.js`, `tsconfig.eslint.json`, `.prettierrc.json`, script `lint:eslint`, dépendances `eslint` + `@typescript-eslint/*`; couverture par `tests/lint/eslint.config.test.ts`).
* [x] **CI** : job `npm run lint` (fail si non conforme). (Étape "Run lint suite" ajoutée au workflow `ci.yml`, exécute `npm run lint` après la phase typecheck.)

## 17.2 `.gitignore`

* [x] Vérifier : `dist/`, `runs/`, `children/`, `*.log`, `graph-forge/dist/`, `graph-forge/test/**/*.js`.

## 17.3 Code mort

* [x] **Supprimer** blocs commentés obsolètes, `console.log` résiduels, TODO périmés (remplacés par tickets).

---

# 18) Documentation

## 18.1 README & docs

* [x] **Archiver** la structure (dossiers & rôles), **options ENV** (résumé de `.env.example`).
* [x] **AGENTS.md** : transformer le texte en **checklist technique** claire (qualité, couverture, conventions).

### 18.1.1 Checklist technique (à relire avant chaque livraison)

> Checklist récurrente : coche ces cases pendant ta session pour t'assurer qu'aucun point n'est oublié, puis laisse-les décochées lorsqu'une vérification reste à faire pour la prochaine passe.

#### Qualité du code

- [x] Double relecture du diff : vérifier que chaque changement répond bien à la feuille de route et qu'aucune fonctionnalité nouvelle n'est introduite.
- [x] Aucun `console.log`, bloc commenté obsolète ou TODO résiduel dans `src/**` et `tests/**`.
- [x] Commentaires/docstrings ajoutés ou rafraîchis pour expliquer l'intention, les invariants et la signification des variables critiques.
- [x] Gestion d'erreur et timeouts revus : propagation claire, ressources libérées, pas de promesse en suspens.

#### Couverture & tests

- [x] Tests mis à jour ou ajoutés pour chaque logique touchée (unitaires, intégration, snapshots, bench si pertinent).
- [x] `npm run build`, `npm run typecheck` et `npm run test` exécutés localement et verts avant commit.
- [x] Cas limites explicitement couverts (valeurs extrêmes d'ENV, erreurs réseau, timeouts, concurrency) ou documentés.
- [x] Journalisation vérifiée : pas de fuite de secrets, redaction activée lorsque des tokens sont manipulés.

#### Conventions & documentation

- [x] Imports Node préfixés par `node:` et modules ESM cohérents (`type: module`).
- [x] Pas de nouveaux `any`/`as unknown as` : privilégier `unknown` + type guards et unions discriminées.
- [x] README, docs et messages d'erreur mis à jour quand le comportement observable change.
- [x] Cette feuille `AGENTS.md` actualisée : cases pertinentes cochées, historique mis à jour (≤50 entrées), instructions obsolètes retirées.

---

# Critères de validation (acceptation)

* [x] `npm run build` : OK, **sans** erreurs TS (avec options strictes). (Exécuté localement le 2025-10-19 — voir artefacts `tmp/build.log`.)
* [x] `npm run typecheck` : OK. (Exécuté localement le 2025-10-19 — voir `tmp/typecheck.log`.)
* [x] `npm run test` : TAP **lisible**, couverture ≥ seuils actuels, **pas** de fuite de secrets. (Exécuté localement le 2025-10-19 — sortie `tmp/test.log` avec 1183 tests verts.)
* [x] Démarrage HTTP sécurisé : 401 sans token, OK avec token (ou `ALLOW_NOAUTH=1` explicit).
* [x] Aucune régression fonctionnelle (tests existants **inchangés** en comportement).
* [x] Images Docker de runtime **allégées** (si Dockerfile géré ici : devDeps non copiées en prod).

---

## Remarques finales à l’agent

* Chaque **refactor** doit être accompagné d’un **déplacement des tests** et d’un **type-check** strict.
* **Aucune API** ni échange de données n’est modifié côté surface; seules les **internes** (structure, noms de fichiers, helpers) évoluent.
* Commits **atomiques** avec message conventional-commits (`refactor:`, `test:`, `build:`…), et **changesets** si nécessaire.

Exécute ces tâches **dans l’ordre**. À chaque étape, lance `npm run build && npm run typecheck && npm run test` pour verrouiller la non-régression avant de poursuivre.
----------

-### Historique
- 2025-10-21 · gpt-5-codex : confirmé la purge des `?? undefined` hors validation, relancé `npm run test` jusqu'au trailer TAP (1283/1283 verts) et mis à jour la checklist/historique `AGENTS.md`.
- 2025-10-21 · gpt-5-codex : retiré les `?? undefined` des résumés validation (children, robustness, final report), ajouté les tests garantissant l'omission des transcripts/idempotency absents et mis à jour la checklist `exactOptionalPropertyTypes`. Commandes exécutées : `npm run build`, `npm run typecheck`, `npm run test`.
- 2025-10-21 · gpt-5-codex : assaini `handleChildSend` pour retirer les `taskId` indéfinis, ajouté les tests de boucle sur un
  superviseur simulé et confirmé `npm run build`, `npm run typecheck`, `npm run test`.
- 2025-10-21 · gpt-5-codex : corrigé les tests `knowledgeCli`/`plansCli` pour viser `result.summaryPath` sur le résultat imbriqué et
  relancé `npm run build`, `npm run typecheck`, `npm run test` (suite verte, 1280 tests). Commandes exécutées : `npm run build`,
  `npm run typecheck`, `npm run test`.
- 2025-10-21 · gpt-5-codex : aligné `createOrchestratorController` sur `coerceNullToUndefined`, ajouté le test
  `tests/events/controller.optional-fields.test.ts` pour capturer l'observabilité JSON-RPC et confirmé la persistance
  des journaux. Commandes exécutées : `npm run build`, `npm run typecheck`, `npm run test`.
- 2025-10-21 · gpt-5-codex : remplacé chaque `?? undefined` du runtime par `coerceNullToUndefined`, exposé `__eventRuntimeInternals.pushEvent` et ajouté la suite `tests/events/pushEvent.optional-fields.test.ts` pour couvrir les identifiants optionnels. Commandes exécutées : `npm run build`, `npm run typecheck`, `npm run test`.
- 2025-10-21 · gpt-5-codex : nettoyé les defaults sandbox du runtime avec `omitUndefinedEntries`, ajouté le test `tests/child.supervisor.sandbox-config.test.ts` et confirmé `npm run build`, `npm run typecheck`, `npm run test`. Commandes exécutées : `npm run build`, `npm run typecheck`, `npm run test`.
- 2025-10-21 · gpt-5-codex : relancé `npm run test` jusqu'au trailer TAP après la passe optional-field interrompue ; 1266 tests verts confirmés. Commande exécutée : `npm run test`.
- 2025-10-21 · gpt-5-codex : introduit `omitUndefinedEntries` pour préparer `exactOptionalPropertyTypes`, migré `planTools` et le résumé robustesse vers ce helper afin d’omettre les champs indéfinis, et ajouté `tests/utils/object.test.ts`. Commandes exécutées : `npm run build`, `npm run typecheck`, `npm run test`.
- 2025-10-21 · gpt-5-codex : préparé les phases de validation (robustesse, sécurité, transactions) à l’option `exactOptionalPropertyTypes` en retirant les affectations `undefined`, en ajoutant des spreads conditionnels dans les runners/CLI et en couvrant les omissions attendues via `tests/validation/*`. Commandes exécutées : `npm run typecheck`, `npm run test:unit -- --grep "robustness validation"`, `npm run test:unit -- --grep "validation run setup"`, `npm run test:unit -- --grep "security validation"`, `npm run test:unit -- --grep "transactions phase runner"`.
- 2025-10-21 · gpt-5-codex : élargi les contrats coordination (blackboard, contract-net, consensus) pour accepter explicitement `undefined`, mis à jour les tests ciblés et préparé la bascule `exactOptionalPropertyTypes`. Commandes exécutées : `npm run build`, `npm run typecheck`, `npm run test:unit -- --grep "coordination blackboard"`, `npm run test:unit -- --grep "coordination contract-net"`, `npm run test:unit -- --grep "coordination consensus"`.
- 2025-10-21 · gpt-5-codex : borné ValueGraph et la vector memory, ajouté les tests `tests/values.graph.configuration.test.ts`, `tests/memory/vector.test.ts`, `tests/runtime.env-overrides.test.ts` et validé `npm run typecheck`, `npm run test:unit -- --grep "vector memory index"`, `npm run test:unit -- --grep "value graph"`.
- 2025-10-21 · gpt-5-codex : documenté les plafonds ValueGraph/Vecteur dans le README (section "Garde-fous runtime") et vérifié `npm run typecheck`.
- 2025-10-21 · gpt-5-codex : ajouté la suite d'intégration HTTP sur la sécurité (401 par défaut, happy-path token, bypass explicite) et fiabilisé le cleanup `child_orchestrate`. Commandes exécutées : `npm run build`, `npm run typecheck`, `npm run test`.
- 2025-10-21 · gpt-5-codex : supprimé les suppressions ESLint `send` sur les doublures `ChildProcess`, consommé explicitement les arguments et couvert via `npm run typecheck`, `npm run test:unit -- --grep "childProcess.spawn"`, `npm run test:unit -- --grep "spawn error handling"`.
- 2025-10-21 · gpt-5-codex : remplacé les `console.log` restants des micro-benchs par `writeCliOutput` avec tests dédiés. Commandes exécutées : `npm run build`, `npm run typecheck`, `npm run test`.
- 2025-10-21 · gpt-5-codex : étendu la suite de rédaction des journaux (masquage imbriqué, directives env/regex) et sécurisé `tests/lint/eslint.config.test.ts`. Commande exécutée : `CI=true npm run test`.
- 2025-10-21 · gpt-5-codex : allégé l'image Docker de runtime via `npm prune --omit=dev`, documenté la démarche et verrouillé via `tests/build/dockerfile.test.ts`. Commandes exécutées : `npm run build`, `npm run typecheck`, `npm run test`.
