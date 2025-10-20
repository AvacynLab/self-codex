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

* [ ] Passer `any` → `unknown` + **type guards** lorsque nécessaire.
  * [x] `src/eval/runner.ts` : introduction de gardes `extractTraceId`/`isCostMetadata` + tests `tests/eval/runner.test.ts`.
  * [x] `src/tools/graph_apply_change_set.ts` : enregistrement sans transtypage via extension de `GraphOperation.kind`.
* [ ] Typages précis pour événements, plans, artefacts (unions discriminées).

## 7.2 Supprimer transtypages lourds

* [ ] Éviter `as unknown as T` en introduisant **interfaces communes** ou **narrowing** via predicates.
  * ✅ Progression : les suites `tests/tools/facades/*.test.ts` s'appuient désormais sur des charges utiles typées sans double transtypage.
  * [x] `src/tools/tools_help.ts` : extraction d'helpers pour enums/union et suppression des doubles transtypages.
  * [x] `src/events/bus.ts` : spécialiser l'itérateur async pour supprimer les transtypages terminaux (`IteratorReturnResult<void>`).
  * [x] Suites `tests/graphforge*.test.ts` : mutualiser le chargement typé via `tests/helpers/graphForge.ts` pour éliminer les casts manuels.
  * [x] `tests/http/jsonrpc.errors.test.ts` : remplacer le stub ad hoc par `RecordingLogger` + garde `expectRecord` pour éviter `as unknown as`.
  * [x] `src/executor/cancel.ts` : rendre le handle nullable durant l'initialisation et ajouter `tests/executor/cancel.test.ts` pour garantir qu'aucune valeur `null` n'est exposée.
  * [x] `tests/mcp/deprecation.test.ts` : basculer sur `RecordingLogger` + helper dédié pour retirer les doubles transtypages.
  * [x] `tests/events.bus.types.test.ts` & `tests/events/bus.types.test.ts` : introduire `coerceToEventMessage` afin de simuler les appels JavaScript dynamiques sans `as unknown as`.
  * [x] `tests/helpers/http.ts` : instancier un véritable `IncomingMessage` via `Socket` + `IncomingMessage` et injecter les charges utiles sans `as unknown as` tout en ajoutant une suite dédiée.
  * [x] `tests/runtime.timers.test.ts` : stubber les minuteurs globaux via Sinon et réutiliser de vrais handles pour supprimer les doubles transtypages.
  * [x] `tests/plan.join.vote.integration.test.ts` : introduire `PlanChildSupervisor` et un stub typé + `RecordingLogger` pour supprimer `as unknown as`.
  * [x] `tests/rpc/*.test.ts` : utiliser `coerceToJsonRpcRequest` afin de supprimer les doubles transtypages et documenter l'intention.
  * [x] `tests/rpc/timeouts.test.ts` : exposer un registre JSON-RPC typé via `__rpcServerInternals` pour bannir `as unknown as` lors de l'injection de handlers.
  * [x] `src/infra/workerPool.ts` & `tests/infra/workerPool.resilience.test.ts` : introduire `GraphWorkerLike` + l'override `workerScriptUrl` pour supprimer les casts `as unknown as` restants et documenter l'injection test.
  * [x] `tests/helpers/planContext.ts` + suites `tests/plan*.test.ts` et `tests/cancel.random-injection.test.ts` : factoriser la construction du `PlanToolContext`, fournir un logger espion commun et retirer les `as unknown as` restants côté plan/comportement.
* [ ] **Tests** : compiler en `--noEmit` (script `typecheck`) → **0 erreurs**.

## 7.3 Activer options strictes (cf. §1.1) et corriger

* [ ] Corriger **retours implicites**; supprimer **locaux/paramètres non utilisés**; compléter **branches switch**.

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

* [ ] **Normaliser** les retours (forme, erreurs typées).
* [x] **Facto** helpers communs dans `src/tools/shared.ts` (refactor pur).
* [ ] **Tests** : maintenir scénarios existants; ajuster imports.

---

# 13) Mémoire & Valeurs (interne, sans ajout de capacité)

## 13.1 `src/values/valueGraph.ts` / `src/memory/vectorMemory.ts`

* [ ] **Vérifier** bornes (tailles max, éviction, poids).
* [ ] **Tests** : exercices de bornage (pas d’allocations non bornées).

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

* [ ] **Supprimer** blocs commentés obsolètes, `console.log` résiduels, TODO périmés (remplacés par tickets).

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
- [ ] Journalisation vérifiée : pas de fuite de secrets, redaction activée lorsque des tokens sont manipulés.

#### Conventions & documentation

- [x] Imports Node préfixés par `node:` et modules ESM cohérents (`type: module`).
- [x] Pas de nouveaux `any`/`as unknown as` : privilégier `unknown` + type guards et unions discriminées.
- [ ] README, docs et messages d'erreur mis à jour quand le comportement observable change.
- [x] Cette feuille `AGENTS.md` actualisée : cases pertinentes cochées, historique mis à jour (≤50 entrées), instructions obsolètes retirées.

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
- 2025-10-20 · gpt-5-codex : introduit `GraphWorkerLike` pour typer les fakes du pool d'ouvriers, ajouté l'override optionnel `workerScriptUrl` pour les suites et mis à jour `tests/infra/workerPool.resilience.test.ts` afin de supprimer les `as unknown as`. `npm run build`, `npm run typecheck`, `npm run test` exécutés (1217 tests verts).
- 2025-10-20 · gpt-5-codex : ajouté `tests/types/scriptGlobals.d.ts` pour typer les globaux des scripts, retapé `tests/scripts.setup-environment.test.ts`, `tests/scripts.maintenance.test.ts` et `tests/scripts.validate-run.test.ts` avec des guards explicites, élargi `tsconfig.tests.json` aux `.d.ts` et ajusté `tests/tsconfig.consistency.test.ts` en conséquence. Nettoyé `/tmp` avant la relance et capturé `npm run build`, `npm run typecheck`, `npm run test` (1217 tests verts).
- 2025-10-20 · gpt-5-codex : remplacé les stubs des tests HTTP par des implémentations concrètes (`EventStore`, `FileIdempotencyStore`) pour `tests/http/bootstrap.runtime.test.ts`, retiré les derniers `as unknown as` dans `tests/http/bootstrap.runtime.test.ts` et `tests/http/limits.test.ts`, et noté l'utilisation de répertoires temporaires pour le store. `npm run build`, `npm run typecheck`, `npm run test` exécutés.
- 2025-10-20 · gpt-5-codex : resserré `graph-forge/tsconfig.json` (include/exclude dédiés), ajouté `tests/graphforge.build-isolation.test.ts` et la suite `graph-forge/test/graph-model.test.ts` exécutée via `npm run test:graph-forge`, puis documenté la commande dans le README. `npm run build`, `npm run typecheck`, `npm run test`, `npm run test:graph-forge` rejoués.
- 2025-10-20 · gpt-5-codex : refactoré `tests/runtime.timers.test.ts` pour stubber les minuteurs via `sinon.stub(globalThis, …)`, réutiliser de vrais handles issus des minuteurs natifs et documenter la délégation afin de supprimer les `as unknown as`. `npm run build`, `npm run typecheck`, `npm run test` exécutés (1216 tests verts).
- 2025-10-19 · gpt-5-codex : centralisé les overrides enfants (`MCP_CHILDREN_ROOT`, commande/args, sandbox) via `resolveChildrenRootFromEnv`/`resolveSandboxDefaults`, ajouté le log structuré `child_sandbox_profile_configured`, et introduit la suite `tests/runtime.child-env-overrides.test.ts` pour couvrir racine/commande/args/budgets. `npm run build`, `npm run typecheck`, `npm run test` verts.
- 2025-10-19 · gpt-5-codex : ajouté `spawnTimeoutMs` pour relayer le `timeoutMs` des gateways, converti les aborts en `ChildProcessTimeoutError` via un race avec le signal, documenté le contrat `dispose()` et introduit la couverture `tests/children/spawn-errors.test.ts` (timeout réel). `npm run build`, `npm run typecheck`, `npm run test` exécutés.
- 2025-10-19 · gpt-5-codex : synchronisé `EventStore` sur la limite globale (éviction map par job, suppression des buffers vides) et ajouté `tests/events/eventStore.retention.test.ts` pour couvrir les trims globaux et les réductions dynamiques. `npm run build`, `npm run typecheck`, `npm run test` : OK.
- 2025-10-19 · gpt-5-codex : renforcé `src/monitor/dashboard.ts` avec un buffer SSE borné (logs `dashboard_sse_*`, flush asynchrone, libération sûre) en s'appuyant sur `ResourceWatchSseBuffer`, exposé `clientCount()` pour le suivi et ajouté `tests/monitor/dashboard.http.test.ts` + `tests/monitor/dashboard.sse.test.ts` pour couvrir headers, métriques, multi-clients et timeouts. `npm run build`, `npm run typecheck`, `npm run test` verts.
- 2025-10-19 · gpt-5-codex : fiabilisé `tests/monitor.dashboard.streams.test.ts` en ajoutant l'attente asynchrone des snapshots et un parsing compatible avec les entêtes `id/event` générés par `ResourceWatchSseBuffer`; `waitForSseEvents` documente la nouvelle attente côté tests. `npm run build`, `npm run typecheck`, `npm run test` exécutés jusqu'au bout.
- 2025-10-19 · gpt-5-codex : harmonisé la configuration enfant via `read*` dans `src/orchestrator/runtime.ts` (racine, commande, args, budgets), exposé les résolveurs d'env à `__envRuntimeInternals`, journalisé `child_sandbox_profile_configured` et ajouté `tests/runtime.child-env-overrides.test.ts`. `npm run build`, `npm run typecheck`, `npm run test` : OK.
- 2025-10-19 · gpt-5-codex : aligné le workflow CI (`.github/workflows/ci.yml`) sur la feuille de route : séquence explicite `npm ci`/`npm run build`/`npm run typecheck`/`npm run test`, Node 20.x, cache npm piloté par `package-lock.json`, artefacts TAP + `self-codex.test.log`. `npm run build`, `npm run typecheck`, `npm run test` rejoués localement pour contrôle.
- 2025-10-19 · gpt-5-codex : introduit ESLint + Prettier (`eslint.config.js`, `tsconfig.eslint.json`, `.prettierrc.json`), ajouté `lint:eslint` dans `package.json`, installé `eslint` + `@typescript-eslint/*`, et couvert la configuration via `tests/lint/eslint.config.test.ts`. `npm run build`, `npm run typecheck`, `npm run test`, `npm run lint:eslint` exécutés localement.
- 2025-10-19 · gpt-5-codex : fiabilisé `tests/lint/eslint.config.test.ts` en pointant vers un fixture réel (`tests/lint/__fixtures__/lint-target.ts`), préchauffé le programme TypeScript partagé et allongé le timeout pour éviter les erreurs fatales/timeout; ajouté l'étape CI `npm run lint`. Vérifié `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`.
- 2025-10-20 · gpt-5-codex : renforcé `.gitignore` en couvrant les artefacts `graph-forge`, les journaux et les répertoires runtime, ajouté le test d'hygiène `tests/hygiene.gitignore.patterns.test.ts`, et documenté dans le README la structure du dépôt ainsi que les familles de variables d'environnement issues de `.env.example`. `npm run test` relancé pour valider la nouvelle garde.
- 2025-10-20 · gpt-5-codex : activé par défaut la rédaction des journaux (`parseRedactionDirectives` → enabled quand la variable est absente), ajusté les tests de directives et introduit `tests/logs/redaction.test.ts` pour couvrir la garde par défaut et la désactivation explicite. `npm run test` exécuté avec les dépendances de lint installées (`npm install --include=dev`).
- 2025-10-20 · gpt-5-codex : restauré le comportement opt-in de la rédaction (`parseRedactionDirectives`), ajusté les suites `tests/logs/redaction.test.ts` et `tests/monitor/log.redactionDirectives.test.ts` pour refléter les toggles et mis à jour la documentation (`README.md`, `AGENTS.md`). `npm run test` exécuté pour confirmer la non-régression.
- 2025-10-20 · gpt-5-codex : centralisé la politique de snapshots du graphe sur `readOptionalInt`, exposé `__graphTxInternals` pour les tests et ajouté `tests/graph/tx.snapshot-policy.env.test.ts` afin de couvrir les overrides env (positifs, désactivation, valeurs invalides). `npm run test` rejoué pour valider.
- 2025-10-20 · gpt-5-codex : unifié `respondWithJsonRpcError` pour couvrir les persistances idempotentes et ajouté `tests/http/jsonrpc.errors.test.ts` afin de vérifier la sérialisation/ journalisation des erreurs HTTP JSON-RPC. `npm run build`, `npm run typecheck`, `npm run test` verts après installation des dépendances de lint.
- 2025-10-20 · gpt-5-codex : vérifié la disparition des lectures `process.env` résiduelles dans `src/orchestrator/**` et `src/monitor/**`, coché la tâche d'encadrement spawn/IPC, et restructuré `AGENTS.md` avec une checklist technique récurrente (qualité, couverture, conventions) pour guider les prochaines passes.
- 2025-10-20 · gpt-5-codex : stabilisé la sérialisation de `EventStore`, ajouté l'index par `kind` avec journalisation dédiée et livré `tests/events/indexing.test.ts` pour couvrir la rétention et la copie défensive des résultats.

- 2025-10-20 · gpt-5-codex : extrait `src/tools/graphTools.ts` en modules `graph/mutate.ts`, `graph/query.ts`, `graph/snapshot.ts`, introduit `src/tools/shared.ts` pour la déduplication et mis à jour la feuille de route.
- 2025-10-20 · gpt-5-codex : corrigé `tests/orchestrator/logging.helpers.test.ts` pour utiliser un message du catalogue (`prompt`), vérifié les imports orchestrator inutilisés via `npm run typecheck` et relancé `npm run build`, `npm run typecheck`, `npm run test` (verts) pour confirmer la résolution du test en échec dans le Memento.
- 2025-10-20 · gpt-5-codex : déplacé `src/childSupervisor.ts` dans `src/children/supervisor.ts`, extrait les helpers de journalisation dans `src/orchestrator/logging.ts` et mis à jour tous les imports/tests associés. Corrigé les régressions TypeScript sur `graph/*` (`normaliseCostConfig`, edges optionnelles, import inutilisé) et relancé `npm run build`, `npm run typecheck`, `npm run test` (verts) pour valider le refactor.
- 2025-10-20 · gpt-5-codex : déplacé `src/graphState.ts` vers `src/graph/state.ts`, ajusté les imports/tests associés et ajouté un commentaire de module pour rappeler l’objectif du snapshot partagé. `npm run build`, `npm run typecheck`, `npm run test` exécutés après refactor.
- 2025-10-20 · gpt-5-codex : restauré la parité du contrôleur JSON-RPC (injection d’identifiants outils, normalisation `tools/call`, propagation des timeouts) et refermé les régressions `mcp_info`/timeouts. `npm run build`, `npm run typecheck`, `npm run test` verts.
- 2025-10-20 · gpt-5-codex : extrait le bus d’événements orchestrateur dans `src/orchestrator/eventBus.ts`, connecté `runtime.ts` au nouvel assembleur et ajouté `tests/orchestrator/eventBus.test.ts` pour couvrir la publication et la libération des ponts.
- 2025-10-20 · gpt-5-codex : extrait la validation des outils de planification dans `src/tools/plan/validate.ts`, déplacé la résolution des clones/agrégations dans `src/tools/plan/choose.ts`, simplifié `src/tools/planTools.ts` et ajouté `tests/tools/plan.choose.test.ts` pour couvrir la normalisation des plans, des votes et des résumés enfants. `npm run build`, `npm run typecheck`, `npm run test` exécutés pour valider la refactorisation.
- 2025-10-20 · gpt-5-codex : extrait les connecteurs enfants vers `src/children/api.ts`, réduit `src/tools/childTools.ts` aux schémas et
reexports, et repointé `src/orchestrator/runtime.ts` pour utiliser le nouvel API. `npm run build`, `npm run typecheck`, `npm run test`
exécutés pour contrôler la non-régression.
- 2025-10-20 · gpt-5-codex : restauré `src/children/api.ts` (boucles, Contract-Net, sandbox, budgets), réaligné `handleChildBatchCreate` sur `BulkOperationError`, corrigé les reexports de `src/tools/childTools.ts` et ajusté `src/orchestrator/runtime.ts` sur `ChildSendRequest`. `npm run build`, `npm run typecheck`, `npm run test` : OK.
- 2025-10-20 · gpt-5-codex : spécialisé `ResourceReadResult` en union discriminée, ajouté `tests/resources/registry.test.ts` pour couvrir les erreurs `ResourceNotFoundError` et les clones défensifs, et synchronisé `docs/mcp-api.md`. `npm run build`, `npm run typecheck`, `npm run test` exécutés pour valider.
- 2025-10-20 · gpt-5-codex : réactivé la rédaction par défaut (`parseRedactionDirectives`), documenté les opt-out (`off`/valeur vide) et étendu `tests/logs/redaction.test.ts` pour couvrir défaut, désactivation et activation explicite. `npm run build`, `npm run typecheck`, `npm run test` rejoués pour confirmer la non-régression.
- 2025-10-20 · gpt-5-codex : renommé l'export orchestrateur en `childProcessSupervisor` (pour lever l'ambiguïté avec la classe), mis à jour les imports/tests associés, documenté l'agrégateur (`AggregateResult`) sans `any` résiduel et protégé `httpServer` contre les statuts 413 via un garde typé. `npm run build`, `npm run typecheck`, `npm run test` exécutés.
- 2025-10-20 · gpt-5-codex : renforcé `src/eval/runner.ts` avec des gardes de type (`extractTraceId`, `isCostMetadata`) pour éliminer les `as any`, couvert les cas d'erreur et de métadonnées alternatives dans `tests/eval/runner.test.ts`, et étendu `GraphOperation.kind` à `graph_apply_change_set` afin de retirer les transtypages côté `src/tools/graph_apply_change_set.ts`. `npm run build`, `npm run typecheck`, `npm run test` rejoués.
- 2025-10-20 · gpt-5-codex : spécialisé l'itérateur de `EventBus.subscribe()` pour retourner `IteratorReturnResult<void>` lorsque le flux se termine, gelé le résultat terminal pour éviter les mutations et ajouté `tests/events/bus.stream.test.ts` afin de couvrir la fermeture via `close()` et `return()`. `npm run build`, `npm run typecheck`, `npm run test` exécutés après refactor.
- 2025-10-20 · gpt-5-codex : typé `loadGraphForge` et les helpers `graph/runtime.ts` en s'appuyant sur les déclarations Graph Forge, supprimé les transtypages `as unknown as`, ajouté la couverture `tests/graph/forgeLoader.test.ts` et élargi `tsconfig.json` pour embarquer les `.d.ts`. `npm run build`, `npm run typecheck`, `npm run test`, `npm run test:unit -- --grep graph/forgeLoader` exécutés.
- 2025-10-20 · gpt-5-codex : retiré les `as unknown as` de `src/tools/tools_help.ts` via des helpers dédiés (enum/discriminant), étendu `tests/tools/tools_help.test.ts` pour couvrir enums natifs et unions, et réaligné `tsconfig.json` sur l'`include` attendu. `npm run build`, `npm run typecheck`, `npm run test` exécutés après refactor.
- 2025-10-20 · gpt-5-codex : remplacé le stub manuel du logger dans `tests/events/indexing.test.ts` par une sous-classe `RecordingLogger` de `StructuredLogger` afin d'éliminer le transtypage `as unknown as`, documenté l'intention et vérifié que les évictions sont toujours tracées en mémoire. `npm run build`, `npm run typecheck`, `npm run test` exécutés et verts.
- 2025-10-20 · gpt-5-codex : factorisé `RecordingLogger` dans `tests/helpers/recordingLogger.ts`, migré `tests/eventStore.test.ts` pour l'utiliser et retirer les transtypages `as unknown as`, et réutilisé le helper côté index. `npm run build`, `npm run typecheck`, `npm run test` relancés pour confirmer.
- 2025-10-20 · gpt-5-codex : mutualisé le chargement Graph Forge via `tests/helpers/graphForge.ts`, mis à jour les suites `tests/graphforge*.test.ts` pour supprimer les doubles casts, et aligné `tests/http/jsonrpc.errors.test.ts` sur `RecordingLogger` avec une garde `expectRecord`. `npm run build`, `npm run typecheck`, `npm run test` exécutés pour valider.
- 2025-10-20 · gpt-5-codex : supprimé le `as unknown as` restant dans `src/executor/cancel.ts`, enregistré le handle après initialisation et ajouté `tests/executor/cancel.test.ts` pour garantir l'exposition d'un handle complet (build/typecheck/tests verts).
- 2025-10-20 · gpt-5-codex : remplacé les stubs logger des dépréciations MCP par `RecordingLogger`, introduit `coerceToEventMessage` dans les suites `tests/events*.bus.types.test.ts` pour supprimer les doubles transtypages et purgé les entrées d'historique les plus anciennes afin de rester sous le seuil des 50 blocs. `npm run build`, `npm run typecheck`, `npm run test` exécutés et verts.
- 2025-10-20 · gpt-5-codex : exposé `getRegisteredToolMap` pour accéder au registre MCP sans cast, retapé l'inscription des outils avec des callbacks liés, enrichi `SandboxRegistry` avec un clone profond typé (Maps/Sets inclus) et aligné les suites (`tests/mcp/*.test.ts`, `tests/tools/facades/plan_compile_execute.test.ts`, `tests/sim.sandbox.test.ts`) sur le helper partagé. `npm run build`, `npm run typecheck`, `npm run test` exécutés (1214 tests verts).
- 2025-10-20 · gpt-5-codex : remplacé les flux `Readable.from` typés à la volée dans `tests/helpers/http.ts` par un `IncomingMessage` réel construit à partir d'un `Socket`, ajouté `tests/helpers/http.helpers.test.ts` pour valider les entêtes normalisés et la lecture du corps, et relancé `npm run build`, `npm run typecheck`, `npm run test` (1216 tests verts).
- 2025-10-20 · gpt-5-codex : spécialisé le contexte plan sur `PlanChildSupervisor`, remplacé les doubles transtypages `as unknown as` dans `tests/plan.join.vote.integration.test.ts`, `tests/rpc/*.test.ts` et `tests/rpc/timeouts.test.ts`, exposé `__rpcServerInternals` pour enregistrer des handlers JSON-RPC en test, ajouté le helper `tests/helpers/jsonRpc.ts`, réutilisé `RecordingLogger`, et relancé `npm run build`, `npm run typecheck`, `npm run test` (1217 tests verts).
- 2025-10-20 · gpt-5-codex : retiré les derniers `as unknown as` ciblés dans `tests/graph.export.test.ts` via des garde-fous runtime et unifié l'accès aux snapshots JSON, simulé la charge initiale du Contract-Net pour couvrir les pénalités de charge sans accès internes et ajouté des assertions sur les API publiques dans `tests/coord.contractnet.pheromone-bounds.test.ts`. `npm run build`, `npm run typecheck`, `npm run test` exécutés (1217 tests verts).
- 2025-10-20 · gpt-5-codex : introduit `tests/helpers/planContext.ts` pour centraliser les stubs `PlanToolContext`, migré les suites `tests/plan.dry-run.test.ts`, `tests/plan.bt*.test.ts`, `tests/flakiness.plan-run-reactive-repeat.test.ts` et `tests/cancel.random-injection.test.ts` vers le helper partagé et supprimé les derniers `as unknown as` associés. `npm run build`, `npm run typecheck`, `npm run test` exécutés (1217 tests verts).
