----------
Voici la **feuille de route exhaustive** à destination de **l’agent** pour **consolider la version actuelle** (sans ajouter de nouvelles fonctionnalités).
Tu dois exécuter ces tâches **dans l’ordre**. À chaque bloc, lance `npm run build && npm run typecheck && npm run test`. N’opère **aucun** changement de comportement métier : refactor et durcissement seulement.

---

BRIEF À L’AGENT — objectifs, contraintes, réussite attendue

* Objectifs : code **plus robuste, lisible, typé, cohérent et testable**, en conservant exactement la même surface fonctionnelle.
* Contraintes :

  1. **Build** compile **uniquement `src/**`** (`tsconfig.json`).
  2. **Tests** en **TypeScript** uniquement, collectés avec Mocha via **tsx** limité aux `.ts`.
  3. **Aucune régression** sur les tests existants (comportement identique).
  4. **Node 20.x** (respect de `"engines"`).
* Réussite :

  * `npm run build` passe sans erreurs TS (avec options strictes).
  * `npm run typecheck` passe.
  * `npm run test` affiche TAP complet, taux de couverture ≥ existant, logs propres, pas de secret en clair.
  * Démarrage HTTP : 401 sans token (sauf `ALLOW_NOAUTH=1`), rate-limit effectif.

---

1. Typage strict : éliminer `any` et double casts (sans changer la logique)

* Objectif : réduire la dette de typage pour bénéficier pleinement du mode strict.
* Règles : préférer `unknown` + **type guards** et **unions discriminées**. Supprimer les `as unknown as`.
* Fichiers ciblés (ordre de priorité) :

  * [x] `src/orchestrator/runtime.ts`

    * [x] Remplacer les `any` (≈4) par des types précis ou `unknown` + predicates (`isX()`), selon la donnée.
    * [x] Supprimer le double cast identifié (1).
    * [x] Ajouter des types internes pour les événements si nécessaire (union discriminée `type: "..."`).
  * [x] `src/children/supervisor.ts` (≈4 `any`)

    * [x] `any` → `unknown` + raffinements ou interfaces locales.
  * [x] `src/executor/bt/nodes.ts` (≈4 `any`)

    * [x] Typage explicite des nœuds et contextes.
  * [x] `src/executor/bt/types.ts` (≈3 `any`, 1 double cast)

    * [x] Remplacer `any`, supprimer double cast, consolider les types des nœuds/états.
  * [x] `src/agents/metaCritic.ts` (≈3 `any`)

    * [x] Remplacer `any` par un type contractuel des entrées/sorties (interfaces locales).
  * [x] `src/executor/cancel.ts` (≈3 `any`) — même travail.
  * [x] `src/sim/sandbox.ts` (≈3 `any`) — même travail.
  * [x] `src/tools/planTools.ts` (≈3 `any`) — mêmes principes.
* Tests :

  * [x] Lancer `npm run typecheck` pour valider l’absence de nouvelles erreurs.
  * [x] `npm run test` doit rester inchangé en comportement (TAP identique).

2. TODO/FIXME : nettoyer le code source (pas les fixtures de tests)

* Objectif : aucun TODO/FIXME résiduel en **source**.
* Fichiers :

  * [x] `src/agents/metaCritic.ts` (~5 TODO/FIXME) — [x] résoudre ou créer des issues GitHub, puis supprimer du code.
  * [x] `src/agents/selfReflect.ts` (~2) — [x] idem.
* Tests/fixtures (ex. `src/agents/__tests__/selfReflect.fixtures.ts`) :

* [x] Conserver les marqueurs s’ils servent à tester la détection. Annoter clairement “usage test”.

3. Refactor structurel (sans modifier l’API ni le comportement)

* Objectif : réduire la complexité cyclomatique et clarifier les responsabilités.
* Règles : garder **exactement** la même API publique (exports), déplacer uniquement l’interne et corriger les chemins d’import.
* Fichiers à découper :

  * [x] `src/orchestrator/runtime.ts`

    * [x] Extraire :

      * [x] `src/orchestrator/eventBus.ts` (abonnements/émissions, types d’événements).
      * [x] `src/orchestrator/controller.ts` (boucle d’orchestration, transitions d’état).
      * [x] `src/orchestrator/logging.ts` (formatage log, enrichissements).
    * [x] Remplacer dans `runtime.ts` par des imports des nouveaux modules.
    * [x] **Sous-étapes** :

      * [x] Introduire des fonctions pures et **early returns** pour aérer.
      * [x] Ajouter des commentaires “Étape A/B/C” en tête de fonctions longues.
  * [x] `src/tools/graphTools.ts`

    * [x] Scinder en : `src/tools/graph/query.ts`, `src/tools/graph/mutate.ts`, `src/tools/graph/snapshot.ts`.
    * [x] Créer `src/tools/shared.ts` si duplication d’utilitaires de bas niveau.
    * [ ] `src/tools/planTools.ts`

    * [x] Scinder en : `src/tools/plan/validate.ts`, `src/tools/plan/choose.ts`.
    * [x] Réécrire longs `if/else` en fonctions dédiées (même logique).
  * [x] `src/tools/childTools.ts`

    * [x] Déplacer l’interaction récurrente avec les enfants dans `src/children/api.ts`.
* Tests :

  * [ ] Mettre à jour **uniquement** les chemins d’import dans les tests existants.
  * [ ] Interdire toute modification de scénario/attente.

4. Centralisation ENV (homogénéiser la lecture des variables)

* Objectif : lecture ENV uniforme (booléens, entiers, enums) avec valeurs par défaut **identiques** à l’existant.
* Ajout technique (refactor) :

  * [x] Créer `src/config/env.ts` avec :

    * [x] `readBool(name, def)` acceptant `"1"|"true"|"yes"` / `"0"|"false"|"no"`.
    * [x] `readInt(name, def)` (borné, `Number.isSafeInteger`).
    * [x] `readEnum(name, allowed, def)` (valeurs autorisées).
  * [x] Utiliser ces helpers à la place des parsings locaux dans :

    * [x] `src/httpServer.ts` (token, noauth, stateless, JSON, rate-limit).
    * [x] `src/orchestrator/*.ts` (timeouts, budgets).
    * [x] `src/monitor/dashboard.ts` (SSE buffers).
* Tests :

  * [x] Ajouter/adapter `tests/config/env.parse.test.ts` (table-driven) pour garantir la **même** interprétation que l’actuelle.
  * [x] `npm run test` doit rester vert (même comportement externe).

5. HTTP/JSON-RPC : cohérence d’erreur et logs d’accès

* Objectif : réponses d’erreur JSON-RPC uniformes et observable utiles en log.
* Fichier : `src/httpServer.ts`

  * [x] Introduire une petite fonction locale `jsonRpcError(code, message, data?)` **ou** utiliser celle déjà existante si présente ; remplacer les créations ad hoc.
  * [x] Vérifier `enforceBearerToken()` + `shouldAllowUnauthenticatedRequests()` : garder le 401 par défaut (sauf `ALLOW_NOAUTH=1`).
  * [x] S’assurer que chaque requête HTTP produit un log structuré (route, status, latence, client).
* Tests :

  * [x] `tests/http/http_auth.test.ts` — sans token → 401 ; avec token → 200 ; avec `ALLOW_NOAUTH=1` → 200.
  * [x] `tests/http/http_rate_limit.test.ts` — rafale vs flux régulier → 429/200 attendus.
  * [x] `tests/http/jsonrpc.errors.test.ts` — formes d’erreur (code, message).

6. Enfants & robustesse process

* Objectif : fail-safe, sans fuite ni zombie.
* Fichiers : `src/gateways/childProcess.ts`, `src/childRuntime.ts`

  * [x] Entourer spawn et IPC : handlers `error`, `exit`, `close` partout.
  * [x] Timeouts cohérents (reprendre EXACTES valeurs actuelles, appliquer selon helpers ENV).
  * [x] Nettoyer streams/handles dans tous les chemins d’échec (try/finally).
  * [x] Arrêt gracieux + **forcé** (kill) après délai dépassé.
* Tests :

  * [x] `tests/children/spawn-errors.test.ts` — crash simulé : cleanup + signalement.
  * [x] `tests/children/graceful-shutdown.test.ts` — arrêt ordonné puis forcé après timeout.

7. EventStore & mémoire

* Objectif : pas de croissance non bornée, sérialisation stable.
* Fichier : `src/events/eventStore.ts`

  * [x] Vérifier et documenter la politique d’éviction (si implémentée) ; sinon l’appliquer à l’identique à l’existant (pas de changement de valeurs).
  * [x] S’assurer d’une sérialisation stable (ordre de champs) pour des diffs lisibles.
* Tests :

  * [x] `tests/events/eventStore.retention.test.ts` — dépassement de N → éviction attendue.

8. Dashboard/Monitor (HTTP/SSE)

* Objectif : robustesse streaming et en-têtes.
* Fichier : `src/monitor/dashboard.ts`

  * [x] Vérifier en-têtes SSE, keep-alive, respect `MCP_SSE_MAX_BUFFER`.
  * [x] Gestion déconnexion client sans fuite.
* Tests :

  * [x] `tests/monitor/dashboard.http.test.ts` — readyz/metrics/SSE ; multiples clients ; buffer plein.

9. Registry & Tools (contrats et erreurs)

* Objectif : retours typés et erreurs explicites.
* Fichiers :

  * [x] `src/resources/registry.ts` — pas de `any`, erreurs claires si ressource inconnue.
  * [x] `src/tools/*` — normaliser la forme des retours et des erreurs (sans changer leur contenu attendu).
* Tests :

  * [x] `tests/resources/registry.test.ts` — chemins heureux/erreurs.

10. Imports Node et outillage

* Objectif : maintenir la propreté atteinte.
* Faits (à conserver) : aucun import Node sans `node:` dans `src/**`.
* Tâches :

  * [x] Lancer `npm run lint:node-builtins` et corriger si de nouveaux hits apparaissent.
  * [x] Lancer `npm run lint:dead-exports` et supprimer exports morts (ou justifier par commentaire).

11. Graph-Forge (vendored)

* Objectif : pas de bruit de build ; tests distincts si requis.
* Fichier : `graph-forge/tsconfig.json`

  * [x] S’assurer qu’il compile **son** sous-arbre en `graph-forge/dist`.
* Arbo : `.gitignore` exclut `graph-forge/test/**/*.js` — **OK**, à conserver.
* Tâches :

  * [x] Vérifier qu’aucun `.js` compilé de test n’est committé ; supprimer si présent.

12. Scripts d’environnement (Codex Cloud)

* Fichier principal : `scripts/setup-agent-env.sh`

  * [x] Conserver les `unset` des proxies NPM (haut du script).
  * [x] Conserver le **guard** `START_HTTP=1` + token/noauth.
  * [x] Conserver le `trap cleanup EXIT`.
  * [x] Passer `shellcheck` et corriger warnings si signalés.
* Validation :

  * [x] `env | grep -i npm_config | sort` — ne doit pas montrer de `http(s)_proxy`.
  * [x] Lancer install/build/tests : pas de warnings “Unknown env config http-proxy”.

13. CI et artefacts (stabilité et traçabilité)

* Objectif : exécution rapide et logs exploitables.
* Tâches :

  * [x] Runner Node 20.x.
  * [x] Cache npm basé sur `package-lock.json`.
  * [x] Étapes : `npm ci` → `npm run build` → `npm run typecheck` → `npm run test`.
  * [x] Stocker artefacts :

    * [x] TAP (`tap.txt` via `| tee artifacts/tap.txt`).
    * [x] Log unifié (`self-codex.test.log`).

14. Documentation courte de dev (sans ajouter de docs publiques)

* Objectif : faciliter la maintenance interne.
* Tâches :

  * [x] En tête de **chaque fichier refactorisé**, ajouter 2–3 lignes de commentaire décrivant le rôle.
  * [x] Mentionner dans `README` (section dev) : structure dossiers, commande de test, règles `node:` et dead-exports.

15. Conventions et hygiène

* Objectif : homogénéité durable.
* Tâches :

  * [x] `npm run lint` (ESLint flat) → fixer tous les warnings applicables.
  * [x] Confirmer que `.gitignore` contient `dist/`, `runs/`, `children/`, `graph-forge/dist/`, `graph-forge/test/**/*.js`.
  * [x] Supprimer tout code/commentaire mort et `console.log` résiduels.
  * [x] Commits small & atomic, messages **Conventional Commits** (`refactor:`, `test:`, `build:`…).

---

Ce qu’il faut savoir et respecter concernant **tests** et **build**

* Build : **uniquement `src/**`** via `tsconfig.json` (strict + options strictes).
* Tests : **TS only**, collectés par Mocha via `tsx` avec `TSX_EXTENSIONS=ts`. Aucun `.test.js`.
* Typecheck : `tsconfig.tests.json` (noEmit) couvre `tests/**` + `src/**`.
* Interdits : changement d’API publique, ajout de nouveaux endpoints, modification des messages d’erreur attendus.
* À chaque refactor, **ne jamais** modifier les assertions ; adapter seule la **localisation** des imports.

---

Critères d’acceptation finaux

* `npm run build` **OK**, zéro erreur TS.
* `npm run typecheck` **OK**, zéro erreur.
* `npm run test` **OK**, liste TAP complète et identique en comportement, couverture ≥ existant.
* **Aucun** `any` non justifié dans les fichiers listés ; **zéro** double cast `as unknown as`.
* **Aucun** TODO/FIXME en source.
* Serveur HTTP : 401 sans token (sauf `ALLOW_NOAUTH=1`), 429 quand le débit est dépassé ; logs d’accès présents et propres.
* Pas de `.js` compilés dans `graph-forge/test/`, pas d’import Node sans `node:`.

Exécute ces tâches **dans l’ordre**. Ne change pas la logique métier, seulement la structure, le typage et la robustesse.

---

### Historique récent
- 2025-10-23 · gpt-5-codex : Typage des schémas Behaviour Tree (`BehaviorTaskSchema`), remplacement des `z.any()` restants dans `planTools`, ajout du test `bt.tasks.schema-validation` et exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-23 · gpt-5-codex : Suppression du cast `as ZodTypeAny` côté introspection MCP, validation de l'absence de `any` dans `children/supervisor`, durcissement de la récursion `freezeDeep` sans `any`, ajout du test `mcp introspection helpers réconcilie les schémas` et exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-23 · gpt-5-codex : Typage explicite du registre des critères MetaCritic via un garde `isKnownCriterionId`, ajout de `resolveCriterionHandler`, couverture test pour `maintainability` et critères inconnus, `npm run build && npm run typecheck && npm run test` exécuté.
- 2025-10-23 · gpt-5-codex : Extraction des helpers `plan/choose` et `plan/validate`, ajout de tests unitaires ciblant la résolution des clones et la normalisation des corrélations, `npm run build && npm run typecheck && npm run test` exécuté.
- 2025-10-24 · gpt-5-codex : Typage fort du bus d'annulation (`EventEmitter`) via un tuple discriminant, extraction de `emitCancellationEvent`, ajout du test `executor cancellation events` couvrant les notifications `requested/already_cancelled`, puis exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Alignement des payloads d'événements (`pushEvent` ↔ `EventStorePayload`), harmonisation des unions `PromptEventPayload` et `AutoscalerEventPayload`, puis exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Raffinements typés du supervisor enfants (`isRecord`, fusion corrélations, timers unref) et ajout du test `transitions children back to idle once pong heartbeats are observed` avant `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Extraction du résumé causal dans `plan/summary`, refactor des fan-out/join helpers (`filterFanoutPlans`, `ensureFanoutJob`, `evaluateQuorumJoinPolicy`) et exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Finalisation du refactor runtime (délégation `createOrchestratorController`, imports `eventBus`/`logging`), mise à jour du roadmap et ajout d'un en-tête descriptif dans `orchestrator/logging.ts`.
- 2025-10-24 · gpt-5-codex : Centralisation de `MCP_HTTP_TOKEN` via `readOptionalString`, normalisation de `MCP_RUNS_ROOT` côté orchestrateur, mise à jour du roadmap et exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Encadrement des flux SSE du dashboard via `ResourceWatchSseBuffer`, ajout d'un tampon borné respectant `MCP_SSE_MAX_BUFFER`, test de backpressure (`monitor.dashboard streams`) et exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Factorisation des erreurs JSON-RPC via `jsonRpcError`, harmonisation des validations HTTP (`enforceBearerToken`, accès logs) et ajout d'un test ciblant le helper, puis exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Annoté les fixtures TODO "usage test", factorisé les helpers `withOptionalProperty`/`cloneDefinedRecord` dans `src/tools/shared.ts`, mis à jour graph/plan pour les utiliser et ajouté `tests/tools/shared.test.ts` après `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Durcissement du runtime enfant (`listeners`, `close` fallback, forçage SIGKILL), extraction des stubs partagés `tests/children/stubs.ts`, ajout du test `children/graceful-shutdown` et ré-exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Documenté la politique d’éviction de l’EventStore, ajouté la couverture `eventStore.retention` pour les files par type et relancé `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Renforcé le streaming SSE du dashboard via un tampon borné partagé, ajouté la gestion explicite du backpressure et créé `tests/monitor/dashboard.http.test.ts` pour valider en-têtes, snapshots initiaux et overflow.
- 2025-10-24 · gpt-5-codex : Normalisé les payloads textuels des façades via `formatToolResultTextPayload`, enrichi les erreurs du registry avec les détails `uri`, ajouté la couverture `resources/registry.test.ts` et exécuté `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Aligné les scripts lint (`lint:dead-exports`), vérifié la sous-arborescence graph-forge, passé
  `shellcheck` sur `setup-agent-env.sh`, capturé les artefacts CI (TAP + log) et enrichi la section dev du README
  avant d’exécuter `npm run lint` puis `npm run build && npm run typecheck && npm run test` sans avertissement de
  proxy npm.
