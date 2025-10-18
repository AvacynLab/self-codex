-------------

Voici la **liste corrective** à transmettre à l’agent pour remettre une base **saine, fiable, maintenable**. Suis l’ordre, coche à mesure. Adresse directe à toi, agent 👇

## 1) Build TypeScript : séparer build/app et tests (corrige TS6059)

* [x] `tsconfig.json` (build **app only**)

  * `compilerOptions`:

    ```json
    {
      "module": "ESNext",
      "target": "ES2022",
      "moduleResolution": "Bundler",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "rootDir": "src",
      "outDir": "dist"
    }
    ```
  * `include`: `["src/**/*.ts"]`
  * `exclude`: `["tests", "**/*.test.*", "**/*.spec.*"]`
* [x] Créer `tsconfig.tests.json` (type-check des tests, sans émettre)

  ```json
  {
    "extends": "./tsconfig.json",
    "compilerOptions": { "noEmit": true, "rootDir": "." },
    "include": ["tests/**/*.ts", "src/**/*.ts"]
  }
  ```
* [x] `graph-forge/tsconfig.json` : vérifier qu’il compile **uniquement** son sous-arbre et sort en `graph-forge/dist` (pas de fuite vers `src` ni `tests`).

## 2) Scripts npm : cycle propre (build → typecheck → test)

* [x] `package.json` – scripts

  ```json
  {
    "scripts": {
      "build": "tsc -p tsconfig.json && tsc -p graph-forge/tsconfig.json",
      "typecheck": "tsc -p tsconfig.tests.json --noEmit",
      "test:unit": "cross-env TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts \"tests/**/*.test.ts\"",
      "test": "npm run build --silent && npm run typecheck && npm run test:unit"
    }
  }
  ```

  * Raison : `TSX_EXTENSIONS=ts` évite que **tsx** touche les `.js`.
  * Le glob des tests devient **TS only** pour homogénéité.

## 3) Migration tests → TypeScript (fiabilité & lisibilité TAP)

* [x] Renommer `tests/monitor.dashboard.test.js` → `tests/monitor.dashboard.test.ts`.
* [x] Remplacer les `@typedef {import(...)}…` par des `import type` :

  ```ts
  import type { IncomingMessage, ServerResponse } from "node:http";
  import type { LogEntry } from "../src/logger.js";
  import type { DashboardSnapshot } from "../src/monitor/dashboard.js";
  import type { ChildShutdownResult } from "../src/childRuntime.js";
  ```
* [x] Rechercher/convertir tout test `.js` restant ; bannir les `@typedef {import(...)}…` dans `tests/**/*`.
* [x] Conserver `tests/setup.ts` (hermétique : RNG seed + blocage réseau). Ne pas le modifier.

## 4) CI & exécution : garantir un run stable et verbeux

* [x] CI : utiliser **Node 20.x** (tsx compatible).
* [x] Étapes CI : `npm ci` → `npm run build` → `npm run typecheck` → `npm run test`.
* [x] Sauvegarder en artefact : `self-codex.test.log` + sortie TAP (rediriger `> artifacts/tap.txt` en plus du stdout si besoin d’historique).

## 5) Script d’environnement (fourni) : garder tel quel, mais rendre le build insensible aux tests

* [x] Ne **rien** changer au script bash d’install/démarrage. Le fix vient du **tsconfig** (les tests ne sont plus inclus dans le build).
* [x] Nettoyer les warnings NPM “Unknown env config http-proxy” si `.npmrc` surcharge :

  * Si présent, retirer de `.npmrc` les lignes `http-proxy=` / `https-proxy=` ou les rendre valides.

## 6) Sécurité & runtime (vérifs rapides)

* [x] `src/httpServer.ts` : laisser l’exigence de `MCP_HTTP_TOKEN` (safe-by-default).
* [x] `START_HTTP=1` + token en prod (comme affiché dans ta capture d’env).
* [x] Taux limite actif (`src/http/rateLimit.ts`) + tests `tests/http/limits.test.ts` verts.

## 7) Hygiène du dépôt

* [x] Ne jamais committer `dist/` sauf artefacts de release ; vérifier `.gitignore`.
* [x] S’assurer que `runs/` et `children/` sont créés à l’exécution (pas en repo).

---

### Critères d’acceptation

* `npm run build` passe sans **TS6059** ni autres erreurs.
* `npm run test` affiche une **liste TAP complète** (ok/not ok), plus de “Parse error … tsx …”.
* CI verte sur Node 20 (build + typecheck + unit).
* Les endpoints HTTP testés (auth, rate-limit, readyz) restent verts.

---

### Historique

- 2025-10-18 · gpt-5-codex : réaligné `tsconfig.json` sur ESNext/Bundler, créé `tsconfig.tests.json`, ajusté scripts `package.json`, converti la CI GitHub Actions (artefacts TAP + log) et mis à jour la documentation/tests (`tests/tsconfig.consistency.test.ts`, README). Les alertes npm `Unknown env config http-proxy` persistent car injectées par l’environnement (pas de `.npmrc` local).
- 2025-10-18 · gpt-5-codex : corrigé `tests/hygiene.dashboard.unicode-separators.test.ts` pour cibler la version TypeScript et relancé le pipeline `npm run build / typecheck / test` (passage avec `npm_config_http_proxy=` pour contourner le warning d’env). Vérifié que `tests/setup.ts`, les garde-fous HTTP/token/rate-limit et l’hygiène `dist/`, `runs/`, `children/` restent conformes.
- 2025-10-18 · gpt-5-codex : renforcé `tests/tsconfig.consistency.test.ts` afin de verrouiller les options `graph-forge/tsconfig.json` (root/out dir + include) et `tsconfig.tests.json` (héritage, `noEmit`, `rootDir`, includes). Relancé `npm run build`, `npm run typecheck` et `npm run test:unit` (clearing `dist/` avant commit).
- 2025-10-18 · gpt-5-codex : complété les assertions sur `tsconfig.json` (target, rootDir, outDir, strict, esModuleInterop, skipLibCheck, include). Vérifié la checklist via `npm run build`, `npm run typecheck` et `npm run test` (avec artefact TAP généré) avant validation.
- 2025-10-18 · gpt-5-codex : supprimé les doublons `.test.js` dans `graph-forge/test`, ajouté un garde automatique dans `tests/tsconfig.consistency.test.ts` pour empêcher la réintroduction de suites JavaScript et relancé `npm run build`, `npm run typecheck`, `npm run test` (tout vert).
- 2025-10-18 · gpt-5-codex : migré les tests Graph Forge dans `tests/graph-forge/`, renforcé `tests/hygiene.todo-scan.test.ts` pour gérer les répertoires supprimés, mis à jour le garde `tsconfig` et validé `npm run build`, `npm run typecheck`, `npm run test` (1130 suites).
- 2025-10-18 · gpt-5-codex : vérification de la checklist (build/typecheck/test) après installation complète des devDeps (`npm install --include=dev`) afin d'assurer la disponibilité de `cross-env`. Les commandes `npm run build`, `npm run typecheck`, `npm run test` repassent en vert dans cet environnement (`NODE_ENV=production`).
- 2025-10-18 · gpt-5-codex : revalidation complète de la checklist : exécution de `npm install --include=dev` (pour garantir `cross-env`), puis `npm run build`, `npm run typecheck`, `npm run test` (avec `npm_config_http_proxy=` / `npm_config_https_proxy=`) – tous verts, aucun écart détecté.
