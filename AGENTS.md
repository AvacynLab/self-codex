----------
Voici la **feuille de route détaillée** (à cocher) destinée à **l’agent IA** pour **consolider** la base actuelle sans introduire de nouvelles fonctionnalités. Elle couvre **code, tests, build, scripts et CI**, avec sous-étapes et références **fichier par fichier**. À exécuter **dans l’ordre** (haut = plus prioritaire).

---

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
* [ ] **Remplacer** les parsings ENV **dispersés** (ex. `httpServer.ts`, `orchestrator/bootstrap.ts`, `monitor/dashboard.ts`) par ces helpers.

  * [x] `src/httpServer.ts` (ratelimit + `MCP_HTTP_ALLOW_NOAUTH`).
  * [ ] `src/orchestrator/bootstrap.ts` (progression : `src/orchestrator/runtime.ts` utilise désormais `readInt/readBool` pour les overrides + tests dédiés; reste bootstrap & dashboard).
  * [ ] `src/monitor/dashboard.ts`.
  * [x] `src/resources/sse.ts` (buffers/chunks/timeouts via helpers + tests env).
  * [x] `src/paths.ts`, `src/state/wal.ts`, `src/state/snapshot.ts`, `src/http/bootstrap.ts`, `src/mcp/registry.ts` → overrides `MCP_RUNS_ROOT`/`MCP_CHILDREN_ROOT` centralisés via `readOptionalString` + tests `tests/config/runsRoot.env.test.ts`.
  * [x] `src/tools/childTools.ts`, `src/tools/toolRouter.ts`, `src/learning/lessonPrompts.ts`, `src/rpc/timeouts.ts`, `src/infra/tracing.ts`, `src/bridge/fsBridge.ts`, `src/logger.ts` → parsings centralisés (`readBool`/`readOptionalInt`/`readOptionalString`) + suites `tests/child.spawn.http-descriptor.test.ts`, `tests/tools/toolRouter.env.test.ts`, `tests/rpc/timeouts.env.test.ts`, `tests/infra/tracing.otlp-env.test.ts`, `tests/learning/lessonPrompts.test.ts`.
  * [x] `src/config/env.ts` accepte désormais `allowEmpty` pour les chaînes; `src/orchestrator/runtime.ts` alimente `MEM_BACKEND` et les options de rotation (`MCP_LOG_*`) via les helpers partagés + `tests/config/env.parse.test.ts` couvre le cas vide explicite.
* [x] **Tests** : `tests/config/env.parse.test.ts` — table-driven (chaînes variantes → valeur attendue).

---

# 5) Gestion erreurs & robustesse

## 5.1 `src/gateways/childProcess.ts` + `src/childRuntime.ts`

* [ ] **Encadrer** spawn/IPC :

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

* [ ] `src/orchestrator/runtime.ts`

  * **Extraire** :

    * `src/orchestrator/eventBus.ts` (bus/abonnements),
    * `src/orchestrator/controller.ts` (boucle d’orchestration),
    * `src/orchestrator/logging.ts` (formatage/structure des logs).
  * **Remplacer** les `any` par des types locaux; **early returns**; **sous-fonctions**.
  * **Tests** : déplacer/adapter tests d’intégration existants pour pointer les nouveaux modules.

* [ ] `src/tools/graphTools.ts`

  * **Segmenter** par familles : `graph/mutate.ts`, `graph/query.ts`, `graph/snapshot.ts`.
  * Mutualiser utilitaires communs dans `src/tools/shared.ts` (purement **refactor**).
  * **Tests** : mapper 1:1 les tests existants sur les nouveaux modules (aucun test supprimé).

* [ ] `src/tools/planTools.ts`

  * **Extraire** décisions/validation dans `src/tools/plan/validate.ts` & `plan/choose.ts`.
  * **Réduire** complexité cyclomatique (switch/if imbriqués → fonctions ciblées).
  * **Tests** : inchangés côté comportement ; ajuster imports.

* [ ] `src/tools/childTools.ts`

  * **Déplacer** connecteurs enfant (actions récurrentes) dans `src/children/api.ts`.
  * **Factoriser** gestion d’erreur et retries (utilitaires communs).

## 6.2 Arborescence logique

* [ ] **Déplacer** `src/childSupervisor.ts` → `src/children/supervisor.ts` (si non déjà fait).
* [ ] **Déplacer** `src/graphState.ts` → `src/graph/state.ts`.
* [ ] **Renommer** si ambiguïté (ex. `childSupervisor` côté orchestrateur vs enfant).

---

# 7) TypeScript : typage strict & nettoyages

## 7.1 Éliminer `any` évitables

* [ ] Passer `any` → `unknown` + **type guards** lorsque nécessaire.
* [ ] Typages précis pour événements, plans, artefacts (unions discriminées).

## 7.2 Supprimer transtypages lourds

* [ ] Éviter `as unknown as T` en introduisant **interfaces communes** ou **narrowing** via predicates.
* [ ] **Tests** : compiler en `--noEmit` (script `typecheck`) → **0 erreurs**.

## 7.3 Activer options strictes (cf. §1.1) et corriger

* [ ] Corriger **retours implicites**; supprimer **locaux/paramètres non utilisés**; compléter **branches switch**.

---

# 8) HTTP/JSON-RPC : cohérence et tests

## 8.1 Réponses d’erreur unifiées

* [ ] Dans `src/httpServer.ts`, centraliser `jsonRpcError(code, message, data?)`.
* [ ] **Remplacer** toutes créations ad-hoc par cet utilitaire.
* [ ] **Tests** : `tests/http/jsonrpc.errors.test.ts` — codes et messages attendus.

## 8.2 Log d’accès & métriques

* [ ] **S’assurer** que chaque requête HTTP logue un **événement structuré** (latence, route, status).
* [ ] **Tests** : vérifier présence du log via `EventStore`.

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

* [ ] **Sérialisation stable** (ordre des champs) pour diff plus lisibles.
* [ ] **Index** par `jobId`, `kind` (si déjà en mémoire, au moins doc claire des structures).
* [ ] **Tests** : `tests/events/indexing.test.ts` — recherche par `jobId`/`kind` cohérente.

---

# 11) Monitor/Dashboard

## 11.1 `src/monitor/dashboard.ts`

* [x] **Endpoints** : vérifier statuts HTTP, content-types, SSE headers.
* [x] **Défauts sûrs** si options manquantes.
* [x] **Tests** : `tests/monitor/dashboard.http.test.ts` — readyz/metrics/SSE basiques.

---

# 12) Registry & Tools

## 12.1 `src/resources/registry.ts`

* [ ] **Types** explicites pour ressources; **aucun `any`**; retour d’erreur clair si ressource absente.
* [ ] **Tests** : `tests/resources/registry.test.ts`.

## 12.2 `src/tools/*`

* [ ] **Normaliser** les retours (forme, erreurs typées).
* [ ] **Facto** helpers communs dans `src/tools/shared.ts` (refactor pur).
* [ ] **Tests** : maintenir scénarios existants; ajuster imports.

---

# 13) Mémoire & Valeurs (interne, sans ajout de capacité)

## 13.1 `src/values/valueGraph.ts` / `src/memory/vectorMemory.ts`

* [ ] **Vérifier** bornes (tailles max, éviction, poids).
* [ ] **Tests** : exercices de bornage (pas d’allocations non bornées).

---

# 14) Logging & Redaction

## 14.1 `src/logger.ts` (ou module équivalent)

* [ ] **Redaction** activée par défaut (`MCP_LOG_REDACT=true`).
* [ ] **Tests** : `tests/logs/redaction.test.ts` — pas de secrets en clair.

---

# 15) Graph-Forge (vendored)

## 15.1 `graph-forge/tsconfig.json`

* [ ] **Confirmer** compilation uniquement de son sous-arbre vers `graph-forge/dist`.
* [ ] **Tests** : conserver **node:test** actuels OU exposer script séparé `npm run test:graph-forge` (sans l’intégrer au build app).
* [ ] **.gitignore** : **ne pas** committer les `.js` compilés de test; générer à la volée si besoin.

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

* [ ] Vérifier : `dist/`, `runs/`, `children/`, `*.log`, `graph-forge/dist/`, `graph-forge/test/**/*.js`.

## 17.3 Code mort

* [ ] **Supprimer** blocs commentés obsolètes, `console.log` résiduels, TODO périmés (remplacés par tickets).

---

# 18) Documentation

## 18.1 README & docs

* [ ] **Archiver** la structure (dossiers & rôles), **options ENV** (résumé de `.env.example`).
* [ ] **AGENTS.md** : transformer le texte en **checklist technique** claire (qualité, couverture, conventions).

---

# Critères de validation (acceptation)

* [x] `npm run build` : OK, **sans** erreurs TS (avec options strictes). (Exécuté localement le 2025-10-19 — voir artefacts `tmp/build.log`.)
* [x] `npm run typecheck` : OK. (Exécuté localement le 2025-10-19 — voir `tmp/typecheck.log`.)
* [x] `npm run test` : TAP **lisible**, couverture ≥ seuils actuels, **pas** de fuite de secrets. (Exécuté localement le 2025-10-19 — sortie `tmp/test.log` avec 1183 tests verts.)
* [ ] Démarrage HTTP sécurisé : 401 sans token, OK avec token (ou `ALLOW_NOAUTH=1` explicit).
* [ ] Aucune régression fonctionnelle (tests existants **inchangés** en comportement).
* [ ] Images Docker de runtime **allégées** (si Dockerfile géré ici : devDeps non copiées en prod).

---

## Remarques finales à l’agent

* Chaque **refactor** doit être accompagné d’un **déplacement des tests** et d’un **type-check** strict.
* **Aucune API** ni échange de données n’est modifié côté surface; seules les **internes** (structure, noms de fichiers, helpers) évoluent.
* Commits **atomiques** avec message conventional-commits (`refactor:`, `test:`, `build:`…), et **changesets** si nécessaire.

Exécute ces tâches **dans l’ordre**. À chaque étape, lance `npm run build && npm run typecheck && npm run test` pour verrouiller la non-régression avant de poursuivre.
----------

### Historique

- 2025-10-18 · gpt-5-codex : activé `noUnused*`, `noImplicitReturns`, `noFallthroughCasesInSwitch`; corrigé les importations et paramètres inutilisés (`src/*`, `tests/*`), ajusté les helpers (graph/tools, rpc, server) et documenté le blocage `exactOptionalPropertyTypes`. `npm run build`, `npm run typecheck`, `npm run test` tous verts.
- 2025-10-19 · gpt-5-codex : validé la configuration TypeScript principale (`rootDir`, `outDir`, `module`, `target`, `moduleResolution`, `include`, `exclude`) et la configuration de type-check des tests; forcé `engines.node` sur la plage `>=20 <21` et confirmé la présence de `TSX_EXTENSIONS=ts` dans les scripts. Exécuté `npm run build`, `npm run typecheck`, `npm run test` pour contrôler la non-régression.
- 2025-10-19 · gpt-5-codex : durci `scripts/setup-agent-env.sh` (neutralisation npm pré-commande, `NODE_ENV` scoping, garde HTTP, cleanup PID) et ajouté les tests `tests/scripts/setup-agent-env.test.ts` pour couvrir proxy guard, exit 3 et trap. Shellcheck indisponible (contrôle manuel). `npm run build`, `npm run typecheck`, `npm run test` : OK.
- 2025-10-19 · gpt-5-codex : contrôlé l'absence de suites `.js`, relu `enforceBearerToken`/`enforceRateLimit`, uniformisé le log `http_access` via `publishHttpAccessEvent` (logger + EventStore) et étendu `tests/http/access.logging.test.ts`. `npm run build`, `npm run typecheck`, `npm run test` passés après changements.
- 2025-10-19 · gpt-5-codex : durci `src/http/rateLimit.ts` avec un parseur booléen tolérant, enrichi la configuration HTTP via `refreshRateLimiterFromEnv`, et couvert le seau de jetons via des tests (burst court, longue pause, env). `tests/http/limits.test.ts` enrichi pour les scénarios env/refill. `npm run build`, `npm run typecheck`, `npm run test` verts.
- 2025-10-19 · gpt-5-codex : centralisé le parsing d'environnement dans `src/config/env.ts`, branché `httpServer.ts` et `http/rateLimit.ts` sur les nouveaux helpers (booléens et numériques) et ajouté `tests/config/env.parse.test.ts` ainsi que des assertions supplémentaires côté rate limit. `npm run build`, `npm run typecheck`, `npm run test` exécutés après refactor.
- 2025-10-19 · gpt-5-codex : migré `src/orchestrator/runtime.ts` vers `readBool/readNumber`, branché `src/resources/sse.ts` sur `readInt` (chunks/buffers/timeouts) et renforcé `tests/streaming/sse.test.ts`, `tests/http/sse.backpressure.test.ts`, `tests/http/sse.emitTimeout.test.ts` pour couvrir les overrides env. `npm run build`, `npm run typecheck`, `npm run test` : OK.
- 2025-10-19 · gpt-5-codex : remplacé les parsings env restants du runtime (idempotency, vector index, retriever, thought graph, pool) par `readInt/readBool`, exposé `__envRuntimeInternals` et ajouté `tests/runtime.env-overrides.test.ts` pour couvrir les cas positifs/négatifs. `npm run build`, `npm run typecheck`, `npm run test` verts.
- 2025-10-19 · gpt-5-codex : ajouté `readString/readOptionalString` pour unifier les overrides textuels, migré `paths.ts`, `state/wal.ts`, `state/snapshot.ts`, `http/bootstrap.ts` et `mcp/registry.ts` vers les helpers et introduit `tests/config/runsRoot.env.test.ts` (trim/fallback). `tests/config/env.parse.test.ts` couvre désormais les chaînes. `npm run build`, `npm run typecheck`, `npm run test` : OK.
- 2025-10-19 · gpt-5-codex : migré les outils et observabilité (`childTools`, `toolRouter`, `lessonPrompts`, `rpc/timeouts`, `infra/tracing`, `bridge/fsBridge`, `logger`) vers `src/config/env.ts`, ajouté des tests ciblés (`tests/tools/toolRouter.env.test.ts`, `tests/rpc/timeouts.env.test.ts`, `tests/infra/tracing.otlp-env.test.ts`, cas supplémentaires dans `tests/child.spawn.http-descriptor.test.ts` et `tests/learning/lessonPrompts.test.ts`). `npm run build`, `npm run typecheck`, `npm run test` tous verts.
- 2025-10-19 · gpt-5-codex : étendu `readString`/`readOptionalString` avec `allowEmpty`, aligné les overrides `MEM_BACKEND` et `MCP_LOG_*` sur les helpers partagés, et enrichi `tests/config/env.parse.test.ts` pour couvrir la préservation des chaînes vides. `npm run build`, `npm run typecheck`, `npm run test` exécutés et verts.
- 2025-10-19 · gpt-5-codex : renforcé `createChildProcessGateway` avec un listener `close` idempotent, branché `startChildRuntime` sur les handles `SpawnedChildProcess` et ajouté `tests/children/spawn-errors.test.ts` + assertions dans `tests/gateways/child.spawn.test.ts` pour couvrir les nettoyages. `npm run build`, `npm run typecheck`, `npm run test` exécutés jusqu'au bout.
- 2025-10-19 · gpt-5-codex : centralisé les overrides enfants (`MCP_CHILDREN_ROOT`, commande/args, sandbox) via `resolveChildrenRootFromEnv`/`resolveSandboxDefaults`, ajouté le log structuré `child_sandbox_profile_configured`, et introduit la suite `tests/runtime.child-env-overrides.test.ts` pour couvrir racine/commande/args/budgets. `npm run build`, `npm run typecheck`, `npm run test` verts.
- 2025-10-19 · gpt-5-codex : ajouté `spawnTimeoutMs` pour relayer le `timeoutMs` des gateways, converti les aborts en `ChildProcessTimeoutError` via un race avec le signal, documenté le contrat `dispose()` et introduit la couverture `tests/children/spawn-errors.test.ts` (timeout réel). `npm run build`, `npm run typecheck`, `npm run test` exécutés.
- 2025-10-19 · gpt-5-codex : synchronisé `EventStore` sur la limite globale (éviction map par job, suppression des buffers vides) et ajouté `tests/events/eventStore.retention.test.ts` pour couvrir les trims globaux et les réductions dynamiques. `npm run build`, `npm run typecheck`, `npm run test` : OK.
- 2025-10-19 · gpt-5-codex : renforcé `src/monitor/dashboard.ts` avec un buffer SSE borné (logs `dashboard_sse_*`, flush asynchrone, libération sûre) en s'appuyant sur `ResourceWatchSseBuffer`, exposé `clientCount()` pour le suivi et ajouté `tests/monitor/dashboard.http.test.ts` + `tests/monitor/dashboard.sse.test.ts` pour couvrir headers, métriques, multi-clients et timeouts. `npm run build`, `npm run typecheck`, `npm run test` verts.
- 2025-10-19 · gpt-5-codex : fiabilisé `tests/monitor.dashboard.streams.test.ts` en ajoutant l'attente asynchrone des snapshots et un parsing compatible avec les entêtes `id/event` générés par `ResourceWatchSseBuffer`; `waitForSseEvents` documente la nouvelle attente côté tests. `npm run build`, `npm run typecheck`, `npm run test` exécutés jusqu'au bout.
- 2025-10-19 · gpt-5-codex : harmonisé la configuration enfant via `read*` dans `src/orchestrator/runtime.ts` (racine, commande, args, budgets), exposé les résolveurs d'env à `__envRuntimeInternals`, journalisé `child_sandbox_profile_configured` et ajouté `tests/runtime.child-env-overrides.test.ts`. `npm run build`, `npm run typecheck`, `npm run test` : OK.
- 2025-10-19 · gpt-5-codex : aligné le workflow CI (`.github/workflows/ci.yml`) sur la feuille de route : séquence explicite `npm ci`/`npm run build`/`npm run typecheck`/`npm run test`, Node 20.x, cache npm piloté par `package-lock.json`, artefacts TAP + `self-codex.test.log`. `npm run build`, `npm run typecheck`, `npm run test` rejoués localement pour contrôle.
- 2025-10-19 · gpt-5-codex : introduit ESLint + Prettier (`eslint.config.js`, `tsconfig.eslint.json`, `.prettierrc.json`), ajouté `lint:eslint` dans `package.json`, installé `eslint` + `@typescript-eslint/*`, et couvert la configuration via `tests/lint/eslint.config.test.ts`. `npm run build`, `npm run typecheck`, `npm run test`, `npm run lint:eslint` exécutés localement.
- 2025-10-19 · gpt-5-codex : fiabilisé `tests/lint/eslint.config.test.ts` en pointant vers un fixture réel (`tests/lint/__fixtures__/lint-target.ts`), préchauffé le programme TypeScript partagé et allongé le timeout pour éviter les erreurs fatales/timeout; ajouté l'étape CI `npm run lint`. Vérifié `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`.
