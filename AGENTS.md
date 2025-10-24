----------
Voici la **feuille de route détaillée** (à cocher) destinée **à toi, agent**, pour **consolider** la version actuelle — sans ajouter de nouvelles fonctionnalités.
Travaille **dans cet ordre**. Après **chaque** bloc, exécute `npm run build && npm run typecheck && npm run test`. Tu ne modifies **jamais** le comportement métier (refactor/typage/robustesse uniquement).

---

## BRIEF — objectifs, contraintes, critères de réussite

**Objectifs.** Obtenir un code **plus robuste, lisible, typé, cohérent et testable**, en conservant exactement la même surface fonctionnelle (mêmes exports/outils/endpoints, mêmes messages d’erreur attendus par les tests).

**Contraintes build/tests.**

* Build : **uniquement `src/**`** via `tsconfig.json` (strict + options strictes).
* Tests : **TypeScript uniquement**, collectés par Mocha via **tsx** limité aux `.ts` (`TSX_EXTENSIONS=ts`).
* Type-check des tests via `tsconfig.tests.json` (`noEmit: true`).
* Node 20.x (conforme à `engines`).

**Réussite.**

* `npm run build` OK sans erreur TypeScript.
* `npm run typecheck` OK.
* `npm run test` (TAP) OK, couverture ≥ actuelle, aucune fuite de secrets, logs lisibles.
* Serveur HTTP : 401 sans token (sauf `MCP_HTTP_ALLOW_NOAUTH=1`), 429 si dépassement du débit, logs d’accès structurés.

---

## 0) Préambule & hygiène de repo

* [x] Supprimer toute extraction/artefact local antérieur (dossier d’analyse), conserver le dépôt propre.
* [x] Vérifier présence de `package-lock.json`, `package.json`, `tsconfig.json`, `tsconfig.tests.json`, `eslint.config.js`, `.gitignore`.
* [x] Node 20.x actif (CI/Cloud et local).

---

## 1) Build & TS — vérifier/renforcer la config

**Fichier : `tsconfig.json`**

* [x] Confirmer :

  * `compilerOptions`: `"module":"ESNext"`, `"target":"ES2022"`, `"moduleResolution":"Bundler"`, `"strict":true`, `"skipLibCheck":true`, `"rootDir":"src"`, `"outDir":"dist"`.
  * Options strictes **activées** : `"noUnusedLocals":true`, `"noUnusedParameters":true`, `"noImplicitReturns":true`, `"noFallthroughCasesInSwitch":true`, `"exactOptionalPropertyTypes":true`.
  * `include:["src/**/*.ts"]`, `exclude:["tests","**/*.test.*","**/*.spec.*","dist","node_modules"]`.
* [x] Corriger **le code** si ces options révèlent des erreurs (ne **désactive** rien).

**Fichier : `tsconfig.tests.json`**

* [x] Confirmer :

  ```json
  { "extends":"./tsconfig.json", "compilerOptions":{ "noEmit": true, "rootDir": "." }, "include": ["tests/**/*.ts", "src/**/*.ts"] }
  ```

**Fichier : `graph-forge/tsconfig.json`**

* [x] Compiler **son** sous-arbre vers `graph-forge/dist` ; aucune fuite vers `src`/`tests`.

---

## 2) Scripts NPM — invariants d’exécution

**Fichier : `package.json` (scripts)**

* [x] Vérifier/laisser :

  * `"build": "tsc -p tsconfig.json && tsc -p graph-forge/tsconfig.json"`
  * `"typecheck": "tsc -p tsconfig.tests.json --noEmit"`
  * `"test:unit": "cross-env TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts \"tests/**/*.test.ts\""`
  * `"test": "npm run build --silent && npm run typecheck && npm run test:unit"`
  * `"engines": { "node": ">=20 <21" }`
* [x] **TSX_EXTENSIONS=ts** doit être présent (évite les parse errors sur `.js`).

---

## 3) Lint & analyses statiques — maintenir la propreté

**Fichiers : `eslint.config.js`, `tsconfig.eslint.json`**

* [x] Lancer `npm run lint` et corriger les warnings pertinents (sans changer la logique métier).
* [x] Lancer `npm run lint:node-builtins` → **aucun** import Node sans préfixe `node:` dans `src/**` (conserver cet invariant).
* [x] Lancer `npm run lint:dead-exports` → supprimer les exports morts ou documenter la raison (si nécessaire pour compat).

---

## 4) Typage strict — éliminer `any` et les double-casts

**Règles.** Remplacer `any` par des types précis ou `unknown` + *type guards* ; supprimer `as unknown as` via *narrowing*. Aucune création d’API publique nouvelle.

**Fichiers & sous-étapes :**

* [x] `src/orchestrator/runtime.ts`

  * [x] Remplacer les `any` par des unions discriminées/documentées.
  * [x] Supprimer tout `as unknown as` en introduisant des predicates `isX(...)`.
  * [x] Ajouter types locaux/`type` pour les événements internes (mêmes formes qu’actuel).
* [x] `src/children/supervisor.ts` — même traitement (remplacer `any`, clarifier types).
* [x] `src/executor/bt/nodes.ts` — typer contextes et nœuds (interfaces/`type`).
* [x] `src/executor/bt/types.ts` — remplacer `any`, enlever le double cast, préciser unions de states.
* [x] `src/agents/metaCritic.ts`, `src/executor/cancel.ts`, `src/sim/sandbox.ts`, `src/tools/planTools.ts` — même principe.
* [x] `src/utils/object.ts` — supprimer le double cast `as unknown as` via des garde-fous typés et ajouter un test ciblé.
* [x] `src/tools/tools_help.ts` — retirer le cast tuple `any` en exploitant l’API typée et couvrir les exemples par un test dédié.

**Vérif :**

* [x] `npm run typecheck` → 0 erreur.
* [x] `npm run test` → comportement identique.

---

## 5) TODO/FIXME — code source propre

**Fichiers :**

* [x] `src/agents/metaCritic.ts` — résoudre ou créer des issues puis **supprimer** les TODO/FIXME.
* [x] `src/agents/selfReflect.ts` — idem.
* [x] Laisser intacts les TODO des **fixtures de tests** qui servent aux scénarios (ex. `src/agents/__tests__/selfReflect.fixtures.ts`) avec un commentaire clarifiant “usage test”.

---

## 6) Refactor structurel — sans toucher l’API ni les comportements

**Objectif.** Réduire la complexité cyclomatique et clarifier les responsabilités. On **déplace**/découpe, on **n’ajoute rien**.

**Fichiers & sous-étapes :**

* [x] `src/orchestrator/runtime.ts` → extraire :

  * [x] `src/orchestrator/eventBus.ts` (abonnements/émissions, types d’événements).
  * [x] `src/orchestrator/controller.ts` (boucle, transitions d’état).
  * [x] `src/orchestrator/logging.ts` (formatage/enrichissement logs).
  * [x] Remplacer l’interne de `runtime.ts` par des imports — **mêmes exports** qu’avant.
* [x] `src/tools/graphTools.ts`

  * [x] Scinder en `src/tools/graph/query.ts`, `src/tools/graph/mutate.ts`, `src/tools/graph/snapshot.ts`.
  * [x] Mutualiser les helpers dans `src/tools/shared.ts` si duplication (refactor pur).
* [x] `src/tools/planTools.ts`

  * [x] Scinder en `src/tools/plan/validate.ts` et `src/tools/plan/choose.ts`.
  * [x] Remplacer `if/else` profonds par petites fonctions pures.
* [x] `src/tools/childTools.ts`

  * [x] Déplacer connecteurs récurrents vers `src/children/api.ts` (mêmes comportements).

**Tests :**

* [x] Ne modifier que les **chemins d’import** dans les tests existants.
* [x] `npm run test` doit rester vert, TAP identique en intentions.

---

## 7) ENV — lecture centralisée & homogène (refactor pur)

**Fichier (à créer/compléter) : `src/config/env.ts`**

* [x] Implémenter :

  * [x] `readBool(name, def)` : normalise `"1"|"true"|"yes"` / `"0"|"false"|"no"`.
  * [x] `readInt(name, def)` : borné, `Number.isSafeInteger`.
  * [x] `readEnum(name, allowed, def)` : valeurs autorisées.
* [x] Remplacer les parsings ENV **dispersés** par ces helpers dans :

  * [x] `src/httpServer.ts` (auth token/noauth/stateless/json, rate-limit).
  * [x] `src/orchestrator/*` (timeouts/budgets).
  * [x] `src/monitor/dashboard.ts` (SSE buffers).

**Tests :**

* [x] `tests/config/env.parse.test.ts` (table-driven) : chaînes variantes → valeurs attendues **identiques** à l’actuel.

---

## 8) HTTP/JSON-RPC — cohérence d’erreur & logs d’accès

**Fichier : `src/httpServer.ts`**

* [x] Utilitaire **local** (ou commun existant) : `jsonRpcError(code, message, data?)` — uniformiser.
* [x] `enforceBearerToken()` / `shouldAllowUnauthenticatedRequests()` : 401 par défaut ; `ALLOW_NOAUTH=1` seul cas permissif.
* [x] Log d’accès **structuré** par requête (route, status, latence, client).

**Tests :**

* [x] `tests/http/http_auth.test.ts` — sans token → 401 ; avec token → 200 ; `ALLOW_NOAUTH=1` → 200.
* [x] `tests/http/http_rate_limit.test.ts` — rafale vs flux régulier (429/200).
* [x] `tests/http/jsonrpc.errors.test.ts` — forme d’erreur (code/message/data).

---

## 9) Process enfants — robustesse et cleanup

**Fichiers :** `src/gateways/childProcess.ts`, `src/childRuntime.ts`

* [x] Handlers `error`, `exit`, `close` partout où spawn/IPC.
* [x] Timeouts pilotés par ENV **via** `src/config/env.ts`.
* [x] `try/finally` pour fermer streams/handles.
* [x] Arrêt **gracieux** puis **forcé** (kill) après délai.

**Tests :**

* [x] `tests/children/spawn-errors.test.ts` — crash simulé : cleanup + signalement.
* [x] `tests/children/graceful-shutdown.test.ts` — arrêt ordonné puis forcé au timeout.

---

## 10) EventStore — rétention & stabilité

**Fichier : `src/events/eventStore.ts`**

* [x] Vérifier/rendre explicite la **politique d’éviction** (pas de croissance non bornée).
* [x] Sérialisation **stable** (ordre de champs) pour diffs lisibles.

**Tests :**

* [x] `tests/events/eventStore.retention.test.ts` — dépasser N → éviction attendue, pagination stable.

---

## 11) Dashboard / SSE — bords & buffers

**Fichier : `src/monitor/dashboard.ts`**

* [x] En-têtes SSE corrects, keep-alive, respect `MCP_SSE_MAX_BUFFER`.
* [x] Déconnexions clients gérées sans fuite.

**Tests :**

* [x] `tests/monitor/dashboard.http.test.ts` — readyz/metrics/SSE, multiples clients, buffer plein.

---

## 12) Registry & Tools — contrats & erreurs typées

**Fichiers :**

* [x] `src/resources/registry.ts` — types explicites, erreurs claires si ressource absente (pas de `any`).
* [x] `src/tools/*` — normaliser la **forme** des retours/erreurs (sans changer le contenu attendu).

**Tests :**

* [x] `tests/resources/registry.test.ts` — chemins heureux + erreurs.

---

## 13) Vendored `graph-forge` — pas de bruit de build

**Fichier : `graph-forge/tsconfig.json`**

* [x] Compiler son sous-arbre vers `graph-forge/dist`.

**Arbo & ignore**

* [x] `.gitignore` exclut `graph-forge/dist/` et `graph-forge/test/**/*.js` — vérifier qu’aucun `.js` de test n’est committé (supprimer si trouvé).

---

## 14) Script d’environnement (Codex Cloud)

**Fichier : `scripts/setup-agent-env.sh`**

* [x] Conserver tout en tête :

  * [x] `unset NPM_CONFIG_PRODUCTION`, `unset NPM_CONFIG_OMIT`
  * [x] `unset NPM_CONFIG_HTTP_PROXY`, `unset NPM_CONFIG_HTTPS_PROXY`, et variantes en minuscule
* [x] **Scoper** `NODE_ENV=development` aux commandes `npm/npx` (pas global).
* [x] **Guard** : si `START_HTTP=1` et pas de token, et `MCP_HTTP_ALLOW_NOAUTH!=1` → `exit 3`.
* [x] `trap cleanup EXIT` → tue le process HTTP et supprime le PID file.
* [x] `chmod +x` ; passer **shellcheck** et corriger warnings.

**Sanity check :**

* [x] `env | grep -i npm_config | sort` → pas de `http(s)_proxy`.
* [x] `npm ci && npm run build && npm run test` → pas de warning “Unknown env config http-proxy”.

---

## 15) CI & artefacts

* [x] CI sur **Node 20.x**.
* [x] Cache npm (clé sur `package-lock.json`).
* [x] Étapes : `npm ci` → `npm run build` → `npm run typecheck` → `npm run test`.
* [x] Artefacts :

  * [x] TAP complet via `| tee artifacts/tap.txt`.
  * [x] `self-codex.test.log` archivé.

---

## 16) Documentation développeur minimale

* [x] En tête de **chaque fichier refactorisé**, 2–3 lignes de commentaire de rôle/responsabilité.
* [x] `README` (section dev) : structure dossiers, commandes, règles `node:` et dead-exports, cycle `build/typecheck/test`.
* [x] Si `AGENTS.md` existe : l’orienter en **checklist technique** (qualité, couverture, conventions), pas en prose diffuse.

---

## 17) Conventions & hygiène

* [x] `npm run lint` : zéro warning bloquant.
* [x] `.gitignore` : vérifier `dist/`, `runs/`, `children/`, `graph-forge/dist/`, `graph-forge/test/**/*.js`.
* [x] Supprimer code/commentaires morts, `console.log` résiduels.
* [x] Commits atomiques ; messages **Conventional Commits** (`refactor:`, `test:`, `build:`, `chore:`).

---

## Critères d’acceptation (finaux)

* [x] `build/typecheck/test` **verts** avec options strictes, TAP détaillé, couverture ≥ actuelle.
* [x] **Aucun** import Node sans `node:` ; **aucun** `.js` de test versionné dans `graph-forge/test/`.
* [x] **Aucun** `any` non justifié dans les fichiers listés ; **aucun** double cast `as unknown as`.
* [x] **Aucun** TODO/FIXME en **source** (hors fixtures explicitement documentées).
* [x] HTTP : 401 par défaut sans token, `ALLOW_NOAUTH=1` bypass, 429 au dépassement, logs d’accès présents et propres.
* [x] Refactors appliqués sans modification d’API/behaviour (les tests existants restent valides, seuls les imports ont bougé).

---

Tu suis ce plan, étape par étape, en verrouillant chaque passe par le triptyque `build → typecheck → test`. À la fin, on conserve exactement le même produit, mais la base est **plus stricte, plus claire et plus facile à maintenir**.

- 2025-10-24 · gpt-5-codex : Renforcement de `readInt` avec un garde `Number.isSafeInteger`, ajout du test de régression correspondant et exécution de `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Vérification et coche des sections 6 à 17 (refactors orchestrateur/graph/tools/child, centralisation ENV, HTTP/JSON-RPC, scripts et CI), revue des critères finaux et exécution de `npm run build && npm run typecheck && npm run test` pour confirmer la stabilité.
### Historique récent
- 2025-10-24 · gpt-5-codex : Suppression du cast `any` sur les tuples de `tools_help`, ajout du test de façade couvrant les tuples et validation via `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Audit des modules runtime/supervisor/metaCritic/cancel/sandbox/planTools pour confirmer l’absence de `any`/double cast, vérification de l’EventStore et du dashboard SSE, exécution de `npm run build && npm run typecheck && npm run test` pour valider la suite complète.
- 2025-10-24 · gpt-5-codex : Réinitialisation du roadmap, vérification des prérequis (Node 20, fichiers clés), exécution de `npm run lint` et du triptyque `npm run build && npm run typecheck && npm run test` pour valider l’état de base.
- 2025-10-24 · gpt-5-codex : Durcissement de `omitUndefinedDeep` avec des gardes typés, ajout d’un test garantissant le retour d’un nouveau tableau et exécution du triptyque `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Renforcement du typage de `executor/bt/types.ts` via des gardes structurels, suppression du cast explicite, ajout d’un test de schéma et exécution du triptyque `npm run build && npm run typecheck && npm run test`.
- 2025-10-24 · gpt-5-codex : Factorisation du comptage des statuts dans `executor/bt/nodes.ts`, ajout de tests ciblant les politiques parallèles et validation par le triptyque `npm run build && npm run typecheck && npm run test`.
