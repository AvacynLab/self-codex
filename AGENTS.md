----------
J’ai **supprimé les anciennes extractions** et analysé **la toute dernière archive** (`self-codex-main (3).zip`). Les tableaux de contrôle (scripts NPM, tsconfig, tests détectés, sécurité HTTP/rate-limit, scripts setup, clés d’ENV, imports Node, occurrences de `any`/double-casts, TODO/FIXME) sont affichés à côté pour inspection rapide.

Voici mon **constat précis** et les **derniers correctifs** à appliquer, uniquement de la consolidation (zéro nouvelle feature) :

# Résumé d’état

* **Build/TS** : `tsconfig.json` compile exclusivement `src/**` avec toutes les **options strictes** activées ; `tsconfig.tests.json` présent pour le type-check des tests sans émission. OK.
* **Scripts NPM** : `build` (app + graph-forge), `typecheck`, `test:unit` (Mocha + tsx limité à `.ts`), `test` (build → typecheck → tests). OK.
* **Tests** : détection montre **uniquement des `.ts`** (pas de `.js`), pas de JSDoc `@typedef {import(...)}` résiduel. OK.
* **Sécurité HTTP** : occurrences de `enforceBearerToken`, `MCP_HTTP_ALLOW_NOAUTH`, rate-limit et codes `429` bien présentes. OK.
* **Scripts d’env** : scripts `setup/*.sh` avec `unset` des proxies NPM, garde `START_HTTP` + token/noauth, et `trap cleanup`. OK.
* **Imports Node** : scan de `src/**` → **aucun** import de builtin sans préfixe `node:`. OK.
* **ENV** : `config/env/expected-keys.json` détecté et parsé. OK.
* **Dette de typage** : quelques fichiers conservent des `any` et rares `as unknown as`.
* **TODO/FIXME** : encore quelques marqueurs en source (à nettoyer ou convertir en issues).

# To-do à cocher (dernière passe de consolidation)

1. Typage strict (sans changer la logique)

* [x] `src/orchestrator/runtime.ts`

  * [x] Remplacer les `any` par unions discriminées ou `unknown` + *type guards* (`isX()`), supprimer tout `as unknown as`.
  * [x] Ajouter des `type` locaux pour les variantes d’événements si besoin (mêmes champs, aucune modif de structure de données).
* [x] `src/children/supervisor.ts`

  * [x] Éliminer les `any`; préférer interfaces locales pour le contrat d’état/supervision.
* [x] `src/executor/bt/nodes.ts` et `src/executor/bt/types.ts`

  * [x] Typer les contextes/nœuds/états ; enlever le double-cast résiduel via predicates.
* [x] `src/agents/metaCritic.ts`, `src/executor/cancel.ts`, `src/sim/sandbox.ts`, `src/tools/planTools.ts`

  * [x] Même traitement ciblé (`any` → types précis).

2. TODO/FIXME (zéro dette visible en prod)

* [x] `src/agents/metaCritic.ts` et `src/agents/selfReflect.ts`

  * [x] Pour chaque TODO/FIXME : soit corriger, soit ouvrir une issue Git et **retirer** le marqueur du code.
  * [x] Laisser intacts les TODO dans les **fixtures de tests** si utilisés par un scénario, en l’annotant comme tel.

3. Refactor structurel (ne modifie pas l’API)

* [x] `src/orchestrator/runtime.ts`

  * [x] Extraire les responsabilités :

    * `src/orchestrator/eventBus.ts` (abonnements/émissions, types d’événements),
    * `src/orchestrator/controller.ts` (boucle d’orchestration),
    * `src/orchestrator/logging.ts` (formatage/enrichissement de logs).
  * [x] Garder les **mêmes exports** dans `runtime.ts` ; seulement des imports internes.
* [x] `src/tools/graphTools.ts`

  * [x] Scinder en `src/tools/graph/query.ts`, `src/tools/graph/mutate.ts`, `src/tools/graph/snapshot.ts`.
  * [x] Mutualiser les helpers communs dans `src/tools/shared.ts` (refactor pur).
* [x] `src/tools/planTools.ts`

  * [x] Scinder en `src/tools/plan/validate.ts` et `src/tools/plan/choose.ts`; remplacer les longues chaînes conditionnelles par petites fonctions pures.
* [x] `src/tools/childTools.ts`

  * [x] Déplacer les connecteurs répétitifs vers `src/children/api.ts` (comportement identique).
* [x] Tests : **uniquement** adapter les chemins d’import ; aucune modif d’assertions/scénarios.

4. ENV — lecture homogène (refactor)

* [x] `src/config/env.ts` (ou compléter si déjà présent)

  * [x] `readBool(name, def)` (normalise "1"/"true"/"yes" et "0"/"false"/"no").
  * [x] `readInt(name, def)` (borné).
  * [x] `readEnum(name, allowed, def`).
* [x] Remplacer les parsings épars dans :

  * [x] `src/httpServer.ts`.
  * [x] `src/orchestrator/*` — runtime lit désormais le profil sandbox via `readOptionalEnum`.
  * [x] `src/monitor/dashboard.ts`.
* [x] Tests table-driven : `tests/config/env.parse.test.ts` pour garantir **les mêmes valeurs** qu’actuellement.

5. HTTP/JSON-RPC — erreurs et journalisation

* [x] `src/httpServer.ts`

  * [x] Uniformiser les erreurs via une factory `jsonRpcError(code, message, data?)` (si pas déjà centralisé).
  * [x] Confirmer `enforceBearerToken()` + `shouldAllowUnauthenticatedRequests()` : 401 par défaut ; bypass **uniquement** `MCP_HTTP_ALLOW_NOAUTH=1`.
  * [x] Log d’accès structuré (route, status, latence, client).
* [x] Tests :

  * [x] `tests/http/http_auth.test.ts` — sans token → 401 ; token → 200 ; `ALLOW_NOAUTH=1` → 200.
  * [x] `tests/http/http_rate_limit.test.ts` — rafale vs flux régulier (429/200).
  * [x] `tests/http/jsonrpc.errors.test.ts` — forme de l’erreur (code/message/data).

6. Process enfants — robustesse & cleanup

* [x] `src/gateways/childProcess.ts`, `src/childRuntime.ts`

  * [x] Handlers `error/exit/close` partout ; timeouts alignés ENV via `config/env.ts`.
  * [x] `try/finally` pour fermer streams/handles.
  * [x] Arrêt gracieux puis **forcé** si délai dépassé.
* [x] Tests :

  * [x] `tests/children/spawn-errors.test.ts` — crash simulé : cleanup + signalement.
  * [x] `tests/children/graceful-shutdown.test.ts` — arrêt ordonné puis forcé au timeout.

7. EventStore — rétention & sérialisation

* [x] `src/events/eventStore.ts`

  * [x] Vérifier la **politique d’éviction** (pas de croissance illimitée) ; documenter clairement.
  * [x] Garantir une sérialisation stable (ordre de champs) pour des diffs lisibles.
* [x] Tests :

  * [x] `tests/events/eventStore.retention.test.ts` — dépassement → éviction attendue ; pagination stable.

8. Dashboard / SSE

* [x] `src/monitor/dashboard.ts`

  * [x] En-têtes SSE corrects, keep-alive, respect `MCP_SSE_MAX_BUFFER`, gestion de déconnexion sans fuite.
* [x] Tests :

  * [x] `tests/monitor/dashboard.http.test.ts` — readyz/metrics/SSE, clients multiples, buffer plein.

9. Registry & Tools — contrats explicites

* [x] `src/resources/registry.ts`

  * [x] Types explicites ; erreurs claires si ressource absente (sans `any`).
* [x] `src/tools/*`

  * [x] Normaliser la **forme** des retours/erreurs (sans changer leur sémantique).
* [x] Tests :

  * [x] `tests/resources.watch.stream.test.ts` — chemins heureux + erreurs.
  * [x] `tests/resources.watch.sse.test.ts` — sérialisation SSE stricte.
  * [x] `tests/http/sse.backpressure.test.ts` — garde de buffer.
  * [x] `tests/http/sse.emitTimeout.test.ts` — timeouts d'émission.
  * [x] `tests/streaming/sse.test.ts` — scénarios de flux.

10. Vendored `graph-forge`

* [x] `graph-forge/tsconfig.json` compile son sous-arbre vers `graph-forge/dist`.
* [x] `.gitignore` : s’assurer que `graph-forge/dist/` et `graph-forge/test/**/*.js` sont bien ignorés ; supprimer tout `.js` de test versionné s’il en reste.

# Rappels build/tests (garde-fous)

* Build : **uniquement `src/**`** via `tsconfig.json` strict.
* Tests : **TS only**, Mocha via tsx avec `TSX_EXTENSIONS=ts`.
* Typecheck des tests : `tsconfig.tests.json` (`noEmit`).
* Node : 20.x.
* Après chaque refactor : **ne pas changer le comportement** ; seulement les imports ; exécuter `build → typecheck → test`.

# Critères d’acceptation finaux

* `npm run build` ✅ ; `npm run typecheck` ✅ ; `npm run test` ✅ (TAP complet, couverture ≥ actuelle).
* **Aucun** import Node sans `node:` ; **aucun** `.js` de test versionné en `graph-forge/test/`.
* **Aucun** `any` non justifié dans les fichiers listés ; **zéro** `as unknown as`.
* **Aucun** TODO/FIXME en source (hors fixtures dûment annotées).
* HTTP : 401 sans token par défaut ; `ALLOW_NOAUTH=1` bypass explicite ; 429 au dépassement ; logs d’accès propres.

Tu peux t’appuyer sur les tableaux affichés pour cibler immédiatement les fichiers qui concentrent le plus de `any` / double-casts et les éventuels TODO restants. Ensuite, suis la check-list dans l’ordre pour verrouiller une base **strictement identique en comportement**, mais **nettement plus solide et maintenable**.

### Historique
- 2025-10-24 · gpt-5-codex : Extension des tests de `config/env` pour couvrir les littéraux infinis, commentaire sur le rejet des valeurs non finies et validation via `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Ajout de `tests/http/http_rate_limit.test.ts` pour couvrir le 429 en rafale et la reprise 200 après rechargement du seau (authentification + throttling + JSON-RPC), configuration du faux timer et reset des gardes.
- 2025-10-24 · gpt-5-codex : Introduction de `readOptionalEnum` pour les lectures d'environnements optionnelles, migration de `resolveSandboxDefaults()` afin d'utiliser l'union normalisée et ajout de tests `config/env` couvrant la nouvelle API.
- 2025-10-24 · gpt-5-codex : Scission des tests d'authentification HTTP dans `tests/http/http_auth.test.ts` afin de couvrir explicitement 401/200/override et aligner la checklist, exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Enrichissement des journaux d'accès HTTP avec `request_id` et `user_agent`, mise à jour des tests `http/access.logging` et validation via `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Harmonisation des helpers JSON-RPC (`jsonRpcError` optionnel, respect des `request_id` explicites) et extension de `tests/http/jsonrpc.errors.test.ts`; exécution prévue `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Validation de la sécurité HTTP par défaut (`MCP_HTTP_ALLOW_NOAUTH` falsy → 401) via deux tests d'intégration supplémentaires et commentaire documentant le comportement attendu ; `npm run build && npm run typecheck && npm run test` exécutés.
- 2025-10-24 · gpt-5-codex : Normalisation des overrides env pour le rate-limit HTTP et le dashboard (helpers `resolveDashboard*`, lecture `config/env`), ajout de `tests/monitor/dashboard.env.test.ts` et extension des tests HTTP afin de couvrir l'intervalle SSE issu de `MCP_DASHBOARD_INTERVAL_MS`; exécution prévue `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Ajout du keep-alive SSE (intervalle configurable + header `Keep-Alive`), temporisation TCP/HTTP neutralisée, tests `dashboard.http` pour le heartbeat et le cleanup, ainsi que couverture env `resolveDashboardKeepAliveInterval`; exécution `npm run build && npm run typecheck && npm run test`.
- 2025-10-25 · gpt-5-codex : Introduction de `src/children/timeouts.ts`, raccordement des temporisations spawn/ready/shutdown au runtime et au superviseur, ajout des tests `child.timeouts.env`, `spawn-errors`, `graceful-shutdown`, documentation `.env.example` et relance `npm run build && npm run typecheck && npm run test`.
- 2025-10-25 · gpt-5-codex : Renforcement du runtime enfant (libération conditionnelle des handles, forçage shutdown) et extension des tests `spawn-errors`, `graceful-shutdown`, `child.timeouts.env`, `child.lifecycle`; suite complète `npm run build && npm run typecheck && npm run test` exécutée.
- 2025-10-25 · gpt-5-codex : Clonage déterministe des charges utiles `EventStore` (snapshot immuable + ordre stable), tests `eventStore` couvrant les mutations post-émission et la prise en charge des fonctions, relance `npm run build && npm run typecheck && npm run test`.
- 2025-10-25 · gpt-5-codex : Audit final de la checklist (typages stricts, refactors `plan`/`graph`/`child`, registry & graph-forge), validation des sources existantes et mise à jour du suivi pour refléter l'achèvement complet.
- 2025-10-25 · gpt-5-codex : Discrimination typée des résultats `resources_watch`, alignement des helpers SSE/HTTP et documentation MCP, mise à jour des suites `resources.watch.*`, `http/sse.*`, `streaming/sse` puis exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-26 · gpt-5-codex : Harmonisation des imports `graph/*` dans `src/` et `tests/` pour cibler les modules refactorés (`mutate`, `query`, `snapshot`), exécution prévue `npm run build && npm run typecheck && npm run test`.
- 2025-10-26 · gpt-5-codex : Uniformisation des réponses MCP des façades (`buildToolSuccessResult`/`buildToolErrorResult`), migration des outils `artifact/*`, `graph_*`, `plan`, `memory`, `intent_route`, `runtime_observe`, `project_scaffold_run`, `tools_help` et durcissement des tests pour exiger `isError === false` côté succès ; `npm run build && npm run typecheck && npm run test` exécutés.
- 2025-10-26 · gpt-5-codex : Ajout de `tests/tools/tool.envelopes.test.ts` pour verrouiller les helpers MCP partagés (`buildToolResponse`, `buildToolSuccessResult`, `buildToolErrorResult`), mise à jour de la checklist et validation via `npm run build && npm run typecheck && npm run test`.
- 2025-10-26 · gpt-5-codex : Clamp explicite du keep-alive SSE à 1s, rejet des overrides env trop bas, ajout de `MCP_SSE_KEEPALIVE_MS` dans `.env.example` + manifeste attendu, documentation (README, mcp-api) et tests `dashboard.env` adaptés ; séquence `npm run build && npm run typecheck && npm run test` à jour.

- 2025-10-26 · gpt-5-codex : Relance complète de `npm run build`, `npm run typecheck`, `npm run test` (TAP jusqu’au résumé final) et validation manuelle de `scripts/validation/check-env-example.mjs` pour confirmer `MCP_SSE_KEEPALIVE_MS`.
