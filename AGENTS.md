Voici ta **liste de tâches à cocher**, agent, basée sur l’état *réel* du dépôt actuel que j’ai audité et sur les constats précédents. Elle est organisée **fichier par fichier**, avec objectifs, sous-étapes, extraits de code quand c’est utile, et critères d’acceptation. Suis l’ordre. N’efface pas le lockfile. Ne change pas le modèle ESM/NodeNext. Utilise Node ≥ 20.

---

# Brief à l’agent (lis-moi avant d’agir)

* Objectif : garantir un **build reproductible et fiable en environnement Cloud**, maintenir la **cohérence des imports `node:`**, sécuriser le **serveur MCP HTTP**, et **couvrir** par des tests e2e les points critiques (auth, idempotence, enfants, graphes, logs, timeouts).
* Contraintes :

  * Conserver `tsconfig.json` en **NodeNext** avec `types: ["node"]`.
  * `@types/node` **reste en `dependencies`** (choix robuste Cloud).
  * **Ne pas** modifier `package-lock.json` sauf si explicitement demandé.
  * Les tests doivent pouvoir tourner localement et en CI avec **npm ci**.
* Règles build/tests :

  * Build officiel : `npm ci && npm run build`.
  * Node ≥ 20.
  * Pas d’option npm qui omet les devDeps au build (ou prévoir fallback `npx typescript`).
  * Les nouveaux tests : **tap/mocha + tsx**, pas de dépendances exotiques.

---

# Tâches à cocher (avec sous-étapes et critères d’acceptation)

## 1) `scripts/setup-agent-env.sh` — rendre le setup infaillible

* [x] **Mettre à jour le script** pour neutraliser toute config npm qui omettrait les devDeps et prévoir un fallback `npx typescript` si `tsc` n’est pas dans le PATH.

  * Sous-étapes :

    * [x] Ajouter neutralisation : `unset NPM_CONFIG_PRODUCTION`, `unset NPM_CONFIG_OMIT`, `export NODE_ENV=development`, `npm ci --include=dev`.
    * [x] Vérifier la présence de `node_modules/@types/node` (doit être là car en `dependencies`, mais garde le check).
    * [x] Si `node_modules/.bin/tsc` est absent, utiliser `npx --yes typescript tsc` pour compiler (fallback).
    * [x] Corriger le commentaire en tête (ce repo a **@types/node en dependencies**, pas en devDeps).
  * **Snippet (remplacer la partie install/build)** :

    ```bash
    # Neutralise toute config npm qui omet les devDeps
    unset NPM_CONFIG_PRODUCTION || true
    unset NPM_CONFIG_OMIT || true
    export NODE_ENV=development

    echo "🔧 npm ci (inclut devDeps et respecte lockfile)"
    npm ci --include=dev

    echo "🧪 Vérification @types/node"
    if [[ ! -d node_modules/@types/node ]]; then
      echo "⚠️ @types/node absent — installation de secours"
      npm install @types/node@^20 --no-save --no-package-lock
    fi

    echo "🏗️ Build"
    if [[ -x node_modules/.bin/tsc ]]; then
      npm run build
    else
      npx --yes typescript tsc && npx --yes typescript tsc -p graph-forge/tsconfig.json
    fi
    ```
  * **Critères d’acceptation** :

    * `npm ci` ne saute plus les devDeps même si l’environnement les omet par défaut.
    * `dist/server.js` est présent après setup sur un environnement vierge.
    * Le commentaire du script ne mentionne plus “Mode A = devDeps” pour `@types/node`.

## 2) `package.json` — scripts utilitaires “portable” (sans casser l’existant)

* [x] **Ajouter** un script de secours pour build portable.

  * Sous-étapes :

    * [x] Ajouter :

      ```json
      "build:portable": "node -e \"process.exit(require('fs').existsSync('node_modules/.bin/tsc')?0:1)\" || npx --yes typescript tsc && npx --yes typescript tsc -p graph-forge/tsconfig.json"
      ```
    * [x] Ne pas modifier `dependencies` / `devDependencies` existants (tu as déjà `@types/node` en `dependencies` → bien).
  * **Critères d’acceptation** :

    * `npm run build:portable` fonctionne sur un env qui a omis `tsc`.
    * Aucun changement au lockfile.

## 3) `tsconfig.json` (racine) — audit et verrouillage

* [x] **Confirmer** les options actuelles : `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `lib: ["ES2022"]`, `types: ["node"]`, `exclude: ["dist", "node_modules", "tests"]`.
* [x] **Ne rien changer** si déjà conforme (c’est le cas).
* **Critères d’acceptation** :

  * `tsc --showConfig` reflète bien ces options.

## 4) `graph-forge/tsconfig.json` — cohérence

* [x] **S’assurer** qu’il `extends` le tsconfig racine et laisse `declaration: false`.
* [x] **Ne rien changer** si déjà conforme (c’est le cas).
* **Critères d’acceptation** :

  * La compilation de `graph-forge` se fait par le `npm run build` racine sans options ad hoc supplémentaires.

## 5) Imports Node — garde-fou automatique

* [x] **Créer** un test de lint minimal qui échoue si un import non préfixé `node:` réapparaît.

  * Fichier : `tests/lint/imports_node_prefix.test.ts`
  * Contenu (exemple) :

    ```ts
    import { strict as assert } from "node:assert";
    import { readFileSync } from "node:fs";
    import { join } from "node:path";

    function scanFile(content: string): string[] {
      const patterns = [
        /from\s+"crypto"/g,
        /from\s+"fs\/promises"/g,
        /from\s+"fs"/g,
        /from\s+"http"/g,
        /from\s+"url"/g,
        /from\s+"events"/g,
        /from\s+"assert"/g,
        /from\s+"util"/g,
        /from\s+"timers(\/promises)?"/g
      ];
      const hits: string[] = [];
      for (const rx of patterns) {
        if (rx.test(content)) hits.push(rx.source);
      }
      return hits;
    }

    describe("imports node: prefix", () => {
      it("no non-prefixed core imports", () => {
        const root = join(process.cwd(), "src");
        const glob = require("node:fs").readdirSync;
        const files: string[] = [];
        const walk = (p: string) => {
          for (const f of require("node:fs").readdirSync(p, { withFileTypes: true })) {
            const full = join(p, f.name);
            if (f.isDirectory()) walk(full);
            else if (f.isFile() && f.name.endsWith(".ts")) files.push(full);
          }
        };
        walk(root);
        const offenders: {file:string; hits:string[]}[] = [];
        for (const f of files) {
          const c = readFileSync(f, "utf8");
          const h = scanFile(c);
          if (h.length) offenders.push({ file: f, hits: h });
        }
        assert.equal(offenders.length, 0, "Found non-prefixed core imports: " + JSON.stringify(offenders, null, 2));
      });
    });
    ```
  * **Critères d’acceptation** :

    * Le test échoue si quelqu’un réintroduit `from "fs"` au lieu de `from "node:fs"`.

## 6) `scripts/verify-env.mjs` — vérification pré-test (optionnel mais utile)

* [x] **Ajouter** un script Node simple qui vérifie les prérequis et imprime un JSON de santé.

  * Fichier : `scripts/verify-env.mjs`
  * Contenu (résumé) :

    ```js
    import { existsSync } from "node:fs";
    import { resolve } from "node:path";

    const out = {
      node: process.version,
      hasTypesNode: existsSync(resolve("node_modules/@types/node")),
      hasTSC: existsSync(resolve("node_modules/.bin/tsc")),
      tsconfig: existsSync(resolve("tsconfig.json")),
      lockfile: existsSync(resolve("package-lock.json"))
    };
    console.log(JSON.stringify(out, null, 2));
    ```
  * **Critères d’acceptation** :

    * `node scripts/verify-env.mjs` produit un JSON conforme et **hasTypesNode: true**.

## 7) Tests e2e HTTP — Auth Bearer & stateless

* [x] **Ajouter** `tests/e2e/http_auth.test.ts`

  * Sous-étapes :

    * [x] Sans `Authorization` → **401** attendu si `MCP_HTTP_TOKEN` est défini.
    * [x] Avec `Authorization: Bearer <token>` → **200**, `mcp_info` OK.
  * **Critères d’acceptation** :

    * Test passe localement (lance le serveur en child process pendant le test) et en CI (port configurable via env).

* [x] **Ajouter** `tests/e2e/http_stateless.test.ts`

  * Sous-étapes :

    * [x] Vérifier que sans session persistante, un call `tools_list` fonctionne et que les limites envoyées via en-tête (si prévu) sont bien prises en compte.
  * **Critères d’acceptation** :

    * On observe la réponse attendue sans état serveur.

## 8) Tests e2e Idempotence

* [x] **Ajouter** `tests/e2e/idempotency.test.ts`

    * Sous-étapes :

      * [x] Envoyer 2× la même requête `tx_begin` avec le même `Idempotency-Key`.
      * [x] Les 2 réponses doivent partager le même `id`/`effect` (pas de duplication d’état).
  * **Critères d’acceptation** :

    * Les deux réponses sont **identiques** sur les champs idempotents.

## 9) Enfants (instances Codex) — spawn/attach/send/kill

* [x] **Ajouter** `tests/e2e/children_codex.test.ts`

  * Sous-étapes :

    * [x] `child_spawn_codex` avec limites CPU/Mem/Wall légères.
    * [x] `child_attach` puis `child_send` (prompt simple) → réponse OK.
    * [x] `child_set_limits` pour provoquer un **dépassement** volontaire (timeout / budget) → évènement “limit” attendu.
    * [x] `child_kill` → enfant disparu, ressources libérées.
  * **Critères d’acceptation** :

    * Tous les appels réussissent et les événements sont observables (journalisés).

## 10) Transactions & graphes — basiques et erreurs contrôlées

* [x] **Ajouter** `tests/e2e/graph_tx.test.ts`

  * Sous-étapes :

    * [x] `tx_begin` → `graph_diff` (aucun changement) → `tx_commit`.
    * [x] `tx_begin` → `graph_patch` (ajout 2 nœuds + 1 arête) → `graph_diff` → `tx_commit`.
    * [x] `tx_begin` → `graph_patch` invalide → **400** attendu → `tx_rollback`.
  * **Critères d’acceptation** :

    * Les diffs reflètent exactement les opérations.
    * L’erreur invalide est bien mappée en 400 avec message utile.

## 11) Autosave & forge

* [x] **Ajouter** `tests/e2e/autosave_forge.test.ts`

  * Sous-étapes :

    * [x] `graph_state_autosave start` → attendre 2 ticks → `stop` → plus de ticks.
    * [x] `graph_forge_analyze` sur graphe jouet → diagnostics valides.
  * **Critères d’acceptation** :

    * On observe au moins 2 entrées d’autosave, puis l’arrêt.

## 12) Logs & redaction

* [x] **Ajouter** `tests/e2e/log_redaction.test.ts`

  * Sous-étapes :

    * [x] Lancer avec `MCP_LOG_FILE` et `MCP_LOG_REDACT=on`.
    * [x] Envoyer un input contenant un “secret” (ex. API_KEY=...);
    * [x] Lire le log → **le secret n’y figure pas** en clair (attendu : masquage).
  * **Critères d’acceptation** :

    * Aucune occurrence brute du secret dans le log.

## 13) Timeouts & annulations

* [x] **Ajouter** `tests/e2e/timeout_cancel.test.ts`

  * Sous-étapes :

    * [x] Déclencher une opération volontairement longue avec un timeout court → statut `timeout`.
    * [x] Tester `op_cancel` pendant l’exécution → `cancelled` et nettoyage correct.
  * **Critères d’acceptation** :

    * Les statuts finaux sont conformes et la ressource est libérée.

## 14) Concurrence & verrous

* [x] **Ajouter** `tests/e2e/locks_concurrency.test.ts`

  * Sous-étapes :

    * [x] Processus A : prendre un verrou (implicite si ton API le permet) / commencer une tx.
    * [x] Processus B : tentative d’écriture → doit échouer/bloquer clairement.
  * **Critères d’acceptation** :

    * Le message d’erreur indique bien la cause (verrou / conflit).

## 15) `tests/setup.ts` — variables d’environnement de test

* [x] **Vérifier/ajouter** l’injection d’ENV pour les tests e2e (ports, token, chemins runs/logs).

  * Sous-étapes :

    * [x] Valeurs par défaut :

      * `MCP_HTTP_HOST=127.0.0.1`
      * `MCP_HTTP_PORT=8765`
      * `MCP_HTTP_PATH=/mcp`
      * `MCP_HTTP_JSON=on`
      * `MCP_HTTP_STATELESS=yes`
      * `MCP_HTTP_TOKEN=test-token`
      * `MCP_RUNS_ROOT=runs`
      * `MCP_LOG_FILE=/tmp/self-codex.test.log`
    * [x] Au `before()` global, démarrer/arrêter le serveur si nécessaire (child process).
  * **Critères d’acceptation** :

    * Les tests e2e n’ont pas besoin d’étapes manuelles.

## 16) Génération d’artefacts de validation (dossier runs/)

* [x] **Outillage** pour sérialiser **chaque** requête/réponse HTTP en `.jsonl` et les événements en `.jsonl`.

  * Sous-étapes :

    * [x] Créer `scripts/record-run.mjs` (client MCP minimal) pour enchaîner `mcp_info`, `tools_list`, puis une série d’appels (echo, tx, graph, enfants) et écrire dans `runs/validation_<DATE-ISO>/{inputs,outputs,events,logs,artifacts,report}`.
  * **Critères d’acceptation** :

    * Un répertoire `runs/validation_...` complet est produit, archivable.

## 17) README.md — précisions finales

* [x] **Mettre à jour** la section “Build” et “Environnement Cloud”.

  * Sous-étapes :

    * [x] Préciser : `npm ci && npm run build` (Node ≥ 20).
    * [x] Mentionner `@types/node` en **dependencies** (robustesse Cloud).
    * [x] Expliquer l’option `build:portable` et le setup script.
    * [x] Mentionner les variables d’env utiles (`MCP_HTTP_*`, `MCP_LOG_*`, `MCP_*_ROOT`, `MCP_QUALITY_*`, `IDEMPOTENCY_TTL_MS`).
  * **Critères d’acceptation** :

    * Un nouveau venu peut builder et tester sans aide externe.

## 18) (Optionnel) CI de base

* [x] **Ajouter** un workflow GitHub Actions minimal : build + unit tests.

  * Sous-étapes :

    * [x] Node 20.x, `actions/setup-node`, `npm ci`, `npm run build`, `npm run test:unit`.
  * **Critères d’acceptation** :

    * Le badge passe au vert sur PR standards.

---

# Notes importantes pour toi, agent (tests/build)

* Toujours lancer : `rm -rf node_modules dist && npm ci && npm run build`.
* Si l’environnement omet `tsc`, `npm run build:portable` ou le fallback du setup prend le relais.
* **Ne pas changer** l’ESM/NodeNext, ni repasser aux imports non préfixés.
* **N’ajoute pas** de dépendances lourdes pour les tests e2e : reste sur `mocha/chai/tsx`.
* **Tous les nouveaux tests** doivent être **déterministes** et **ne pas dépendre d’Internet**.
* Pour les tests HTTP, rends port/host/path/token **configurables via ENV** et documente les valeurs par défaut.
* Journalise proprement (redaction on) et place les journaux d’exécution dans `runs/validation_*/logs/`.

---

Si tu veux, je peux aussi te fournir un squelette **client MCP HTTP** (Node) pour la sérialisation `.jsonl` des requêtes/réponses afin d’alimenter automatiquement `runs/validation_*`.

---

### Historique des actions

* 2025-10-12T03:30Z — gpt-5-codex : Mise à jour du setup script (neutralisation npm + fallback tsc), ajout de `build:portable`, création du test lint `imports_node_prefix`, ajout de `scripts/verify-env.mjs`, exécution de `npm ci --include=dev`, `npm run build` et `npm run test:unit` (succès).
* 2025-10-12T09:55Z — gpt-5-codex : Vérification des tsconfig (test de cohérence `tests/tsconfig.consistency.test.ts`), confirmation des options NodeNext, exécution de `rm -rf node_modules dist && npm ci --include=dev`, `npm run build`, `npm run test:unit`, `node scripts/verify-env.mjs` (succès).
* 2025-10-12T10:05Z — gpt-5-codex : Ajout du harnais HTTP enfant (`tests/helpers/httpServerHarness.ts`), remplacement des tests HTTP auth/stateless avec lancement en sous-processus et capture des en-têtes (`tests/e2e/http_auth.test.ts`, `tests/e2e/http_stateless.test.ts`), amélioration du bootstrap de test (`tests/setup.ts`) avec variables par défaut, garde réseau loopback et démarrage auto optionnel, mise à jour de multiples suites e2e pour reconnaître le mode `loopback-only`, exécution de `npm ci --include=dev`, `npm run build`, `npm run test:unit` (succès).
* 2025-10-12T10:16Z — gpt-5-codex : Création de `tests/e2e/idempotency.test.ts` validant la rejouabilité HTTP de `tx_begin` avec clé partagée, ajustement de `AGENTS.md`, exécution de `npm ci --include=dev`, `npm run build`, `npm run test:unit` (succès).
* 2025-10-12T11:30Z — gpt-5-codex : Ajout de `tests/e2e/children_codex.test.ts` couvrant le cycle spawn/attach/send/limits/kill avec le runner factice, configuration d’un environnement process-backed temporaire, vérification des événements `child.limits.updated` et `child_exit`, mise à jour de `AGENTS.md`.
* 2025-10-12T12:45Z — gpt-5-codex : Création de `tests/e2e/graph_tx.test.ts` validant les transactions HTTP (commit sans mutation, patch concurrent et rollback après échec), mise à jour de la checklist.
* 2025-10-12T13:30Z — gpt-5-codex : Ajout de `tests/e2e/timeout_cancel.test.ts` couvrant les timeouts et `op_cancel` via HTTP, mise à jour de la checklist, exécution de `npm run build`, `npm ci --include=dev`, `npm run test:unit` (succès après installation de `tsx`).
* 2025-10-12T14:15Z — gpt-5-codex : Ajout de `tests/e2e/locks_concurrency.test.ts` validant le blocage des patchs concurrents et la libération du verrou, mise à jour de `AGENTS.md`, exécution de `npm run build`, `npm ci --include=dev`, `npm run test:unit` (succès).
* 2025-10-12T15:10Z — gpt-5-codex : Création de `tests/e2e/autosave_forge.test.ts` couvrant l’émission des ticks autosave et l’analyse Graph Forge via HTTP, nettoyage automatique des artefacts temporaires, mise à jour de la checklist, exécution de `npm run build`, `npm ci --include=dev`, `npm run test:unit` (succès après réinstallation de `tsx`).
* 2025-10-12T16:30Z — gpt-5-codex : Ajout de `scripts/record-run.mjs` pour capturer les requêtes/réponses HTTP en `.jsonl`, création du test `tests/scripts.record-run.test.ts`, mise à jour de `README.md` (sections Build & Environnement Cloud), exécution de `npm run build` et `npm run test:unit` (succès).
* 2025-10-12T17:10Z — gpt-5-codex : Création du workflow GitHub Actions (`.github/workflows/ci.yml`) assurant `npm ci`, `npm run build` et `npm run test:unit` sur Node.js 20, mise à jour de la checklist.
* 2025-10-12T18:05Z — gpt-5-codex : Ajout du test e2e `tests/e2e/log_redaction.test.ts` démarrant le serveur HTTP avec `MCP_LOG_FILE`/`MCP_LOG_REDACT`, injection d’un secret synthétique dans `child_send`, vérification que le log contient `[REDACTED]` sans fuite du secret, exécution de `npm run build` et `npm run test:unit` (succès).
* 2025-10-12T19:45Z — gpt-5-codex : Harmonisation du garde-fou réseau pour laisser les suites HTTP tourner en loopback (`tests/setup.ts`), réécriture du test `tests/000.offline.guard.test.ts` pour utiliser les hooks communs et vérifier `fetch`, exécution de `npm run build` et `npm run test:unit`.
* 2025-10-12T20:30Z — gpt-5-codex : Ajout du runner `scripts/run-http-e2e.mjs` et du script npm `test:e2e:http`, couverture unitaire associée, documentation de la commande dans le README et extension du workflow CI avec un job HTTP loopback.
* 2025-10-12T21:15Z — gpt-5-codex : Mise à jour de `scripts/verify-env.mjs` (contrôle Node ≥ 20 et détection du loader `tsx`), ajout du test `tests/scripts.verify-env.test.ts`, documentation Build enrichie, exécution de `npm run build` et `npm run test:unit` (succès).
* 2025-10-12T23:30Z — gpt-5-codex : Ajout du guide de dépannage HTTP (`docs/mcp-http-troubleshooting.md`), vérification des journaux existants (`runs/http-*.log`, `runs/logs/server/orchestrator.jsonl`) pour confirmer `http_listening`.
