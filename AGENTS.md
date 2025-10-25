----------
Voici ta **checklist exhaustive** à destination de l’agent, basée sur la dernière archive et mon audit. On ne **rajoute** aucune feature : on **consolide** (typage, refactor, robustesse, tests, build). Exécute les blocs **dans l’ordre**. Après **chaque** bloc : `npm run build && npm run typecheck && npm run test`. Ne modifie jamais l’API publique ni les messages d’erreur attendus.

# Brief à l’agent — objectifs, contraintes, réussite

* Objectifs : base **solide, lisible, typée, testable et cohérente** sans changer le comportement métier.
* Contraintes :

  * Build : **uniquement `src/**`** (TS strict).
  * Tests : **TypeScript uniquement**, Mocha + tsx **limité aux `.ts`** (`TSX_EXTENSIONS=ts`).
  * Type-check des tests via `tsconfig.tests.json` (noEmit).
  * Node : 20.x (aligné `engines`).
* Réussite : `build/typecheck/test` **verts**, TAP complet, couverture ≥ actuelle, HTTP 401 par défaut sans token (sauf `MCP_HTTP_ALLOW_NOAUTH=1`), rate-limit effectif (429), logs d’accès structurés, aucun secret en clair.

---

## 0) Hygiène de repo & préambule

* [x] Supprimer toute extraction locale obsolète (dossiers temporaires d’archives).
* [x] Vérifier présence et validité de : `package-lock.json`, `package.json`, `tsconfig.json`, `tsconfig.tests.json`, `eslint.config.js`, `.gitignore`.
* [x] S’assurer que la version de Node en CI/Cloud est **20.x**.

---

## 1) Build & TypeScript (configuration)

**Fichier : `tsconfig.json`**

* [x] Confirmer : `"rootDir":"src"`, `"outDir":"dist"`, `"module":"ESNext"`, `"target":"ES2022"`, `"moduleResolution":"Bundler"`, `"strict":true`, `"skipLibCheck":true`.
* [x] Options strictes doivent être **actives** : `"noUnusedLocals":true`, `"noUnusedParameters":true`, `"noImplicitReturns":true`, `"noFallthroughCasesInSwitch":true`, `"exactOptionalPropertyTypes":true`.
* [x] `include:["src/**/*.ts"]` ; `exclude:["tests","**/*.test.*","**/*.spec.*","dist","node_modules"]`.
* [x] Corriger le **code** si ces options soulèvent des erreurs (ne **désactive** rien).

**Fichier : `tsconfig.tests.json`**

* [x] Vérifier :

  ```json
  { "extends":"./tsconfig.json", "compilerOptions":{ "noEmit": true, "rootDir": "." }, "include": ["tests/**/*.ts", "src/**/*.ts"] }
  ```

**Fichier : `graph-forge/tsconfig.json`**

* [x] Compiler **uniquement** le sous-arbre `graph-forge/**` vers `graph-forge/dist` (aucune fuite vers `src`/`tests`).

---

## 2) Scripts NPM & invariants d’exécution

**Fichier : `package.json` (scripts)**

* [x] Laisser/vérifier :

  * `"build": "tsc -p tsconfig.json && tsc -p graph-forge/tsconfig.json"`
  * `"typecheck": "tsc -p tsconfig.tests.json --noEmit"`
  * `"test:unit": "cross-env TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts \"tests/**/*.test.ts\""`
  * `"test": "npm run build --silent && npm run typecheck && npm run test:unit"`
  * `"engines": { "node": ">=20 <21" }`
* [x] **TSX_EXTENSIONS=ts** doit rester présent (évite les parse errors des `.js`).

---

## 3) Scripts d’environnement (Codex/Cloud)

**Fichier : `scripts/setup-agent-env.sh`**

* [x] Au début : neutraliser les conf npm pouvant omettre les devDeps et les proxies :

  * `unset NPM_CONFIG_PRODUCTION`, `unset NPM_CONFIG_OMIT`
  * `unset NPM_CONFIG_HTTP_PROXY`, `unset NPM_CONFIG_HTTPS_PROXY`, `unset npm_config_http_proxy`, `unset npm_config_https_proxy`
* [x] `NODE_ENV=development` **scopé** aux commandes `npm/npx` (éviter l’export global).
* [x] **Guard HTTP** : si `START_HTTP=1` et **pas** de `MCP_HTTP_TOKEN` et `MCP_HTTP_ALLOW_NOAUTH!=1` ⇒ `exit 3`.
* [x] `trap cleanup EXIT` : tuer le serveur HTTP lancé en fond et supprimer le PID file.
* [x] Passer **shellcheck** et corriger les warnings.
* [x] Sanity check : `env | grep -i npm_config` ne doit pas contenir de `http(s)_proxy`.

---

## 4) Nettoyage TODO/FIXME (source uniquement)

* [x] `src/agents/metaCritic.ts` — **6** marqueurs (autour des lignes ~171, 291–292, 384–385 + 1 autre)

* [x] Pour chacun : soit corriger **maintenant**, soit créer une **issue** et **supprimer** le marqueur du code.
* [x] `src/agents/selfReflect.ts` — **4** marqueurs (dont ~126–127)

* [x] Même traitement.
* [x] `src/agents/__tests__/selfReflect.fixtures.ts` — **4** marqueurs **de test** (11–14)

* [x] Les **laisser** (servant au scénario), ajouter un commentaire “utilisé par les tests”.

---

## 5) Typage strict — élimination des `any` & double casts

**Règles générales**

* Remplacer `any` par des **unions discriminées** ou `unknown` + **type guards** (`isX()`).
* Supprimer les `as unknown as` par **narrowing** (prédicats/raffinements).
* Ne pas changer les signatures/exports publics.

**Cibles prioritaires** (traiter dans cet ordre)

* [x] `src/orchestrator/runtime.ts`

  * [x] Remplacer `any` par des types locaux/unions ; introduire `type` internes pour les événements (mêmes champs qu’actuel).
  * [x] Éliminer tout double cast.
* [x] `src/children/supervisor.ts` — [x] typer états/contrats (plus de `any`).
* [x] `src/executor/bt/nodes.ts` — [x] typer contextes/nœuds.
* [x] `src/executor/bt/types.ts` — [x] préciser union d’états, supprimer double cast.
* [x] `src/agents/metaCritic.ts`, `src/executor/cancel.ts`, `src/sim/sandbox.ts`, `src/tools/planTools.ts` — [x] même travail.

**Validation**

* [x] `npm run typecheck` (0 erreur).
* [x] `npm run test` (comportement identique).

---

## 6) Refactor structurel (sans toucher l’API)

**Objectif** : baisser la complexité cyclomatique, clarifier responsabilités. **Même surface** (exports identiques).

* [x] `src/orchestrator/runtime.ts`

  * [x] Extraire l’interne en modules dédiés :

    * `src/orchestrator/eventBus.ts` (abonnements/émissions, types d’événements)
    * `src/orchestrator/controller.ts` (boucle, transitions)
    * `src/orchestrator/logging.ts` (formatage/enrichissements logs)
  * [x] Réexporter depuis `runtime.ts` pour **préserver** l’API existante.
* [x] `src/tools/graphTools.ts`

  * [x] Scinder en `src/tools/graph/query.ts`, `src/tools/graph/mutate.ts`, `src/tools/graph/snapshot.ts`.
  * [x] Mutualiser utilitaires communs dans `src/tools/shared.ts` (refactor pur).
* [x] `src/tools/planTools.ts`

  * [x] Scinder en `src/tools/plan/validate.ts` & `src/tools/plan/choose.ts`.
  * [x] Remplacer gros blocs conditionnels par petites fonctions pures (early returns).
* [x] `src/tools/childTools.ts`

  * [x] Déplacer les connecteurs récurrents vers `src/children/api.ts`.

**Tests**

* [x] Adapter **uniquement** les **chemins d’import** dans les tests existants.
* [x] Ne pas modifier les scénarios/attendus.

---

## 7) ENV — lecture homogène (refactor pur)

**Fichier à (créer/)compléter** : `src/config/env.ts`

* [x] `readBool(name, def)` — accepte `"1"|"true"|"yes"` / `"0"|"false"|"no"`.
* [x] `readInt(name, def)` — borné (`Number.isSafeInteger`).
* [x] `readEnum(name, allowed, def)` — valide une valeur dans un ensemble.

**Remplacer les parsings dispersés** par ces helpers dans :

* [x] `src/httpServer.ts` (auth/token/noauth/stateless/json, rate-limit)
* [x] `src/orchestrator/*` (timeouts/budgets)
* [x] `src/monitor/dashboard.ts` (SSE buffers)

**Tests**

* [x] `tests/config/env.parse.test.ts` — tests table-driven (variantes “truthy/falsey”), **mêmes valeurs** qu’actuellement.

---

## 8) HTTP/JSON-RPC — erreurs uniformes & logs d’accès

**Fichier : `src/httpServer.ts`**

* [x] Centraliser la création d’erreurs JSON-RPC : petite factory `jsonRpcError(code, message, data?)` (ou utiliser l’existante si déjà là).
* [x] `enforceBearerToken()` / `shouldAllowUnauthenticatedRequests()` : **401 par défaut** ; bypass **uniquement** via `MCP_HTTP_ALLOW_NOAUTH=1`.
* [x] Log d’accès **structuré** par requête (route, status, latence, client).

**Tests**

* [x] `tests/http/http_auth.test.ts` — sans token → **401** ; avec token → 200 ; `ALLOW_NOAUTH=1` → 200.
* [x] `tests/http/http_rate_limit.test.ts` — rafale vs flux régulier (429/200).
* [x] `tests/http/jsonrpc.errors.test.ts` — forme (code/message/data).

---

## 9) Process enfants — robustesse & cleanup

**Fichiers : `src/gateways/childProcess.ts`, `src/childRuntime.ts`**

* [x] Handlers `error`, `exit`, `close` systématiques (spawn/IPC).
* [x] Timeouts lus via `config/env.ts`.
* [x] `try/finally` pour fermer streams/handles dans tous les chemins (éviter fuites).
* [x] Arrêt **gracieux** puis **forcé** (kill) après délai.

**Tests**

* [x] `tests/children/spawn-errors.test.ts` — crash simulé : cleanup + propagation d’erreur.
* [x] `tests/children/graceful-shutdown.test.ts` — arrêt ordonné puis forcé au timeout.

---

## 10) EventStore — rétention & sérialisation stable

**Fichier : `src/events/eventStore.ts`**

* [x] Documenter et garantir la **politique d’éviction** (pas de croissance illimitée).
* [x] Sérialisation **stable** (ordre de champs) pour des diffs lisibles.

**Tests**

* [x] `tests/events/eventStore.retention.test.ts` — dépasser N ⇒ éviction attendue ; pagination stable.

---

## 11) Dashboard / SSE — bords & buffers

**Fichier : `src/monitor/dashboard.ts`**

* [x] En-têtes SSE corrects, keep-alive, respect `MCP_SSE_MAX_BUFFER`.
* [x] Déconnexions clients gérées sans fuite.

**Tests**

* [x] `tests/monitor/dashboard.http.test.ts` — readyz/metrics/SSE, multiples clients, buffer plein.

---

## 12) Registry & Tools — contrats explicites

**Fichiers**

* [x] `src/resources/registry.ts` — types explicites ; erreurs claires si ressource absente (zéro `any`).
* [x] `src/tools/*` — normaliser la **forme** des retours/erreurs (même sémantique qu’actuelle), factoriser utilitaires communs dans `src/tools/shared.ts` si nécessaire.

**Tests**

* [x] `tests/resources/registry.test.ts` — chemins heureux + cas d’erreur.

---

## 13) Imports Node, exports morts, lint

* [x] `npm run lint:node-builtins` → corriger toute régression : **toujours** `from 'node:xxx'`.
* [x] `npm run lint:dead-exports` → supprimer exports morts (ou commentaire “utilisé indirectement pour X”).
* [x] `npm run lint` → corriger les warnings applicables (sans changer la logique).

---

## 14) Vendored `graph-forge` — pas de bruit inutile

* [x] `graph-forge/tsconfig.json` OK et isolé.
* [x] `.gitignore` doit exclure `graph-forge/dist/` et `graph-forge/test/**/*.js`.
* [x] Supprimer tout `.js` de test versionné dans `graph-forge/test/` s’il en reste (ne devrait pas).

---

## 15) CI & Artefacts

* [x] Pipelines : `npm ci` → `npm run build` → `npm run typecheck` → `npm run test`.
* [x] Node 20.x ; cache npm basé sur `package-lock.json`.
* [x] Publier les artefacts :

  * [x] Rapport TAP complet (`| tee artifacts/tap.txt`)
  * [x] `self-codex.test.log` (journal de test agrégé)

---

## 16) Documentation développeur minimale

* [x] En tête de chaque fichier **refactorisé**, 2–3 lignes sur la responsabilité du module.
* [x] `README` (section dev) : structure des dossiers, commandes, règles `node:` et dead-exports, cycle `build/typecheck/test`.
* [x] Si présent, `AGENTS.md` → transformer en **checklist technique** (qualité, couverture, conventions), pas en prose vague.

---

## Critères d’acceptation finaux

* [x] `npm run build` ✅ — 0 erreur TS (strict).
* [x] `npm run typecheck` ✅ — 0 erreur.
* [x] `npm run test` ✅ — TAP complet, couverture ≥ actuelle, pas de secrets en clair.
* [x] **Aucun** import Node sans préfixe `node:`.
* [x] **Aucun** test `.js` versionné.
* [x] **Aucun** `any` non justifié dans les fichiers listés ; **zéro** `as unknown as`.
* [x] **Aucun** TODO/FIXME en **source** (hors fixtures de test annotées).
* [x] HTTP : 401 par défaut sans token, bypass **uniquement** `MCP_HTTP_ALLOW_NOAUTH=1`, 429 au dépassement, logs d’accès présents et propres.

Tu appliques cette liste **point par point**, en verrouillant chaque passe avec `build → typecheck → test`. Au bout du chemin, on garde exactement le même produit… mais la base est **sensiblement plus stricte, claire et maintenable**.

### Historique
- 2025-10-27 · gpt-5-codex : Réinitialisation du fichier `AGENTS.md` selon les directives utilisateur.
- 2025-10-27 · gpt-5-codex : Blocs 0 et 1 revalidés (configurations TS/tsconfig) sans modifications supplémentaires.
- 2025-10-27 · gpt-5-codex : Bloc 2 vérifié (scripts npm, invariants) puis exécution `build → typecheck → test` (`8fc9bf`, `5ff1cb`, `41ae0f`).
- 2025-10-27 · gpt-5-codex : Bloc 3 finalisé (`scripts/setup-agent-env.sh` durci + shellcheck). Vérifications `npm run build` (`deba51`), `npm run typecheck` (`42795b`), `npm run test` (`fd08e4`).
- 2025-10-27 · gpt-5-codex : Bloc 4 complété (nettoyage TODO/FIXME des agents + annotation fixture). Vérifications `npm run build` (`23e4f3`), `npm run typecheck` (`0c546e`), `npm run test` (`147ee0`).
- 2025-10-27 · gpt-5-codex : Bloc 5 vérifié (audit typage strict : runtime, supervisor, BT, metaCritic, cancel, sandbox, plan tools). Vérifications `npm run build` (`760fcb`), `npm run typecheck` (`f5c762`), `npm run test` (`08c109`).
- 2025-10-27 · gpt-5-codex : Bloc 13 complété (lint node-builtins/dead-exports + lint agrégé). Vérifications `npm run lint:node-builtins` (`9186b3`), `npm run lint:dead-exports` (`a072fe`), `npm run lint` (`c941d1`). Pipeline `build → typecheck → test` relancé (`e50b4b`, `2a30a9`, `e1b74d`).

- 2025-10-27 · gpt-5-codex : Blocs 6 à 16 validés (refactors orchestrateur/outils, env helpers, HTTP/SSE, registry, CI & docs). Vérifications `npm run build` (`17b733`), `npm run typecheck` (`a360e8`), `npm run test` (`9bcbf9`).
- 2025-10-27 · gpt-5-codex : Documentation renforcée sur les modules `src/tools/graph/*` (en-têtes descriptifs) pour refléter le refactor et faciliter les maintenances futures.
