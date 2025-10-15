----------
Super — je pars **de la dernière version du dépôt que je viens d’auditer** (build OK, imports `node:` homogènes, façades présentes, endpoints `/healthz|/readyz|/metrics`, budgets/TTL/idempotence, setup Cloud) et de mon analyse précédente.
Je m’adresse **directement à toi, l’agent**. Ta mission : **améliorer la qualité, la sécurité, l’ergonomie agent-first et la robustesse** sans rien casser. Travaille en **PRs atomiques**, chacune avec tests et validation.

---

# 🎯 Brief pour toi, l’agent

* **Objectifs**

  1. **Clarifier les responsabilités** (composition root propre, middleware JSON-RPC, gateways I/O).
  2. **Durcir la sécu & l’obs** (auth timing-safe, sanitisation chemins, backpressure SSE mesuré).
  3. **Rendre l’usage agent-first** (façades enrichies : `intent_route` avec score/rationale/budget, `plan_compile_execute` avec `dry_run`, `tools_help` avec exemples auto).
  4. **Accélérer & fiabiliser** (préchargement `graph-forge`, tests property-based, microbench p95, job CI “build-only”).

* **Règles de build/tests (obligatoires)**

  * Node **20.x** (au minimum), `npm ci --include=dev` puis `npm run build`.
  * TSConfig **NodeNext**, `lib ES2022`, `types: ["node"]`.
  * **Aucun** import Node sans préfixe `node:` dans `src/**`.
  * Les **schémas Zod** sont la **source unique de vérité** ; les types TS sont **inférés** via `z.infer`.
  * Chaque PR : linter + build + tests **unitaires** + **smoke** HTTP + artefacts de validation exportés.

---

# ✅ To-Do (à cocher) — fichier par fichier, avec sous-étapes

## A) Composition & séparation des responsabilités

* [x] **A1 — Épure de `src/server.ts` (composition root uniquement)**

  * [x] Déplacer toute logique métier (budgets, validation, idempotence, graphe) hors de `server.ts`.
  * [x] Ne conserver que : parsing options, wiring des dépendances, démarrage STDIO/HTTP/Dashboard, gestion `SIGINT`.
  * [x] **Tests** : `tests/e2e/server.bootstrap.test.ts` — démarrage propre, `/healthz` passe à OK après preload, arrêt propre (no handle leak).

* [x] **A2 — Middleware JSON-RPC**

  * [x] Créer `src/rpc/middleware.ts` avec une **chaîne** : parse → validate(Zod) → route → map erreurs (voir Détails Erreurs ci-dessous).
  * [x] Exposer `createRpcHandler(deps)` **pur** (sans effets globaux).
  * [x] **Tests** : `tests/rpc/middleware.validation.test.ts` — payloads invalides ⇒ **VALIDATION_ERROR** (pas 500).

* [x] **A3 — Schémas & types**

  * [x] Créer/centraliser `src/rpc/schemas.ts` (tous les schémas Zod des façades).
  * [x] Dans chaque façade `src/tools/*.ts`, **importer** les types TS via `z.infer<typeof ...>` ; **ne pas** redéclarer des interfaces parallèles.
  * [x] **Tests** : `tests/rpc/schemas.roundtrip.test.ts` — encode/decode stables, pas de champs fantômes.

* [x] **A4 — Erreurs typées**

  * [x] Créer `src/rpc/errors.ts` avec des classes (`ValidationError`, `AuthError`, `TimeoutError`, `IdempotencyConflict`, `InternalError`) et un **mapper JSON-RPC unique** (`toJsonRpc()`), appelé par le middleware.
  * [x] **Tests** : `tests/rpc/errors.mapping.test.ts` — mapping codes/messages/data homogène.

* [x] **A5 — Couches infra (runtime/idempotence)**

  * [x] Créer `src/infra/runtime.ts` : construction du **contexte requête** (budgets, timeouts, corrélation logs).
  * [x] Créer `src/infra/idempotency.ts` avec un helper générique :

    ```ts
    export async function withIdempotency<T>(key: string|undefined, ttlMs: number, fn: () => Promise<T>, store: IdempotencyStore): Promise<T> {
      if (!key) return fn();
      const cached = await store.get(key); if (cached) return cached as T;
      const result = await fn(); await store.set(key, result, ttlMs); return result;
    }
    ```
  * [x] **Tests** : `tests/infra/idempotency.test.ts` — collisions maîtrisées, TTL respecté.

* [x] **A6 — Gateways I/O**

  * [x] Créer `src/gateways/fsArtifacts.ts` avec **sanitisation stricte** (utiliser partout) :

    ```ts
    import { resolve, sep } from "node:path";
    export function safePath(root: string, rel: string): string {
      const clean = rel.replace(/[<>:"|?*\x00-\x1F]/g, "_").replace(/\.\.+/g, ".");
      const abs = resolve(root, clean);
      if (!abs.startsWith(resolve(root) + sep)) throw new Error("Path traversal");
      return abs;
    }
    ```
  * [x] Créer `src/gateways/childProcess.ts` : **spawn** sécurisé (`shell:false`, args tableau, env whitelist, redaction logs).
  * [x] **Tests** : `tests/gateways/fs.sanitize.test.ts` (bloque traversals), `tests/gateways/child.spawn.test.ts` (pas d’injection via args, timeouts honorés).

---

## B) HTTP, sécurité et observabilité

* [x] **B1 — Auth token en temps constant**

  * [x] Créer `src/http/auth.ts` :

    ```ts
    import { timingSafeEqual } from "node:crypto";
    export function checkToken(reqToken: string|undefined, expected: string): boolean {
      if (!reqToken || expected.length === 0) return false;
      const a = Buffer.from(reqToken), b = Buffer.from(expected);
      if (a.length !== b.length) return false;
      try { return timingSafeEqual(a, b); } catch { return false; }
    }
    ```
  * [x] Intégrer la vérification dans `src/httpServer.ts` (401 générique, sans fuite d’info).
  * [x] **Tests** : `tests/http/auth.test.ts` — faux token même longueur ⇒ false, vrai token ⇒ true.

* [x] **B2 — `/readyz` réaliste**

  * [x] Dans `src/httpServer.ts`, READY = **graph-forge préchargé** + **R/W** sur `runs/` + **idempotency store** OK + **bus événements** OK.
  * [x] **Tests** : `tests/http/readyz.test.ts` — simuler droits R/W refusés ⇒ NOT READY.

* [x] **B3 — `/metrics` enrichi**

  * [x] Exposer p50/p95/p99 par façade (latence), compteurs `sse_drops`, `child_restarts`, `idempotency_conflicts`, jauges `open_sse`, `open_children`.
  * [x] **Tests** : `tests/http/metrics.test.ts` — invoquer 2–3 façades, vérifier compteurs non nuls.

* [x] **B4 — Backpressure SSE mesurée**

  * [x] Dans `src/resources/sse.ts`, ajouter un **compteur de drops** quand `bufferedBytes` dépasse `MCP_SSE_MAX_BUFFER` ; log WARN + métrique.
  * [x] **Tests** : `tests/http/sse.backpressure.test.ts` — surcharge contrôlée ⇒ drop+metric increm., pas de crash.

---

## C) Graphe, enfants & performance

* [x] **C1 — Préchargement `graph-forge`**

  * [x] Créer `src/graph/forgeLoader.ts` (import **une fois**, retourner les refs fonctions).
  * [x] Remplacer les imports dynamiques dans `src/tools/graph_*`.
  * [x] **Tests** : `tests/graph/forgeLoader.test.ts` — init unique, latence cold vs warm.

* [x] **C2 — Pool workers (optionnel, gros graphs)**

  * [x] Créer `src/infra/workerPool.ts` (avec `worker_threads`) pour `graph_validate/diff` lorsque taille > seuil.
  * [x] Bascule auto si change-set dépasse un **seuil configurable** (env).
  * [x] Ajouter un timeout configurable + une factory injectable pour fiabiliser les workers et permettre des tests isolés.
  * [x] **Tests** : `tests/perf/graph.pool.test.ts` — p95 diminue sur input “large”; `tests/infra/workerPool.resilience.test.ts` — repli inline + timeout.

* [x] **C3 — Orchestration enfants profilée**

  * [x] Dans `src/tools/child_orchestrate.ts`, supporter `profile: "strict"|"std"|"perm"` ; propager budgets/timeouts via headers (déjà amorcé) ; journaliser un mini-trace par run.
  * [x] **Tests** : `tests/tools/child_orchestrate.profile.test.ts` — chaque profil applique bien ses limites.

---

## D) Façades (agent-first)

* [x] **D1 — `intent_route` v2**

  * [x] Enrichir la sortie : `{ tool, score, rationale, estimated_budget }`, top-N ≤ 3.
  * [x] **Tests** : `tests/tools/intent_route.test.ts` — tie-breaks stables, budget plausible.

* [x] **D2 — `plan_compile_execute` : `dry_run`**

  * [x] Ajouter `dry_run: true` ⇒ lister tool-calls **sans exécuter**, évaluer **budget cumulé**.
  * [x] **Tests** : `tests/tools/plan_compile_execute.dry_run.test.ts` — plan rendu, pas de side-effects.

* [x] **D3 — `tools_help` didactique**

  * [x] Générer **automatiquement** un **exemple minimal** I/O par façade à partir des schémas Zod + budgets/erreurs communes.
  * [x] **Tests** : `tests/tools/tools_help.test.ts` — présence des exemples, cohérence schémas.

* [x] **D4 — Façades artefacts**

  * [x] Forcer le passage par `fsArtifacts.safePath()` dans `artifact_write/read/search`.
  * [x] **Tests** : `tests/tools/artifacts.sanitize.test.ts` — refus chemins malicieux.

---

## E) Idempotence, logs & journaux

* [x] **E1 — Compaction idempotency store**

  * [x] Dans `src/infra/idempotencyStore.file.ts`, implémenter **compaction** (index clé→offset), stratégie J+X.
  * [x] **Tests** : `tests/infra/idempotency.compaction.test.ts` — taille baisse, lookups OK.

* [x] **E2 — Rotation & redaction logs**

  * [x] Dans `src/logger.ts`/`src/monitor/log.ts`, assurer **rotation** par taille & **redaction** des secrets (patterns env).
  * [x] **Tests** : `tests/monitor/log.rotate.test.ts` — rotation active, secrets masqués.

* [x] **E3 — Bus d’événements typé**

  * [x] Créer `src/events/types.ts` (enums + payloads).
  * [x] **Tests** : `tests/events/bus.types.test.ts` — aucune émission non typée.

---

## F) Sécurité & robustesse spawn/env

* [x] **F1 — Sécuriser `gateways/childProcess.ts`**

  * [x] Toujours `shell:false`, args tableau, **pas** d’interpolation string.
  * [x] Whitelist d’env (propager uniquement les clés nécessaires), redaction des secrets dans logs.
  * [x] **Tests** : `tests/gateways/child.env.test.ts`.

* [x] **F2 — Sanitisation généralisée**

  * [x] Utiliser `safePath()` pour **toute** écriture/lecture fichier côté façades et modules.
  * [x] **Tests** : déjà couverts en D4/A6.

---

## G) Scripts & set-up

* [x] **G1 — `scripts/setup-agent-env.sh`**

  * [x] Laisser `npm ci --include=dev`, `npm run build`, écriture `~/.codex/config.toml`.
  * [x] Respecter `START_HTTP`, `MCP_HTTP_*`, `MCP_TOOL_PACK`.
  * [x] **Validation** : `scripts/validation/run-smoke.mjs` — ping `/healthz`/`/metrics`, JSON-RPC trivial.

* [x] **G2 — `.env.example`**

  * [x] Documenter : `START_HTTP`, `MCP_TOOL_PACK=basic`, budgets SSE par défaut, `IDEMPOTENCY_TTL_MS`, token HTTP d’exemple.
  * [x] **Tests** : `tests/env/example.test.ts` — toutes les clés attendues présentes.

---

## H) Tests ciblés & perf

* [x] **H1 — Golden tests façades**

  * [x] `tests/tools/*.golden.test.ts` — I/O représentatifs, **snapshots** stables (mise à jour contrôlée).
  * [x] Couvrir cas invalides (Zod) → **VALIDATION_ERROR**, jamais 500.

* [x] **H2 — Property-based (fast-check)**

  * [x] `tests/property/graph.fastcheck.test.ts` — générer des change-sets bornés, vérifier **invariants graphe** et absence d’exceptions.

* [x] **H3 — Perf déterministe**

  * [x] `tests/perf/graph.p95.test.ts` — seuils p95 (small/medium/large) ; tests “skippables” en CI lente.

---

## I) CI/CD & hygiène

* [x] **I1 — Job CI “build-only rapide”**

  * [x] Étape initiale : `npm ci --include=dev && npm run build && node -e "process.exit(0)"` (feedback éclair).

* [x] **I2 — Artefacts CI**

  * [x] Publier `runs/validation_*` (logs, metrics, snapshots) sur chaque PR pour debug reproductible.

* [x] **I3 — Verrouiller `@types/node`**

  * [x] Pinner sur la **LTS ciblée** (ex. `^20`) pour éviter des dérives de types entre builds.

---

# 📌 Acceptation globale (cocher à la fin)

* [x] `npm ci --include=dev && npm run build` passe **sans warning bloquant**.
* [x] `npm run test` vert (unit/int/e2e), plus **smoke HTTP** OK.
* [x] `/healthz` et `/readyz` reportent l’état réel (preload, R/W, idempotence).
* [x] `/metrics` expose latences p50/p95/p99 par façade + compteurs/jauges (SSE/children/idempotence).
* [x] **Aucun** import Node sans `node:` dans `src/**`.
* [x] Toutes les façades utilisent **`schemas.ts`** pour les types (pas de doublons).
* [x] **`intent_route`** renvoie `{tool, score, rationale, estimated_budget}` ; **`plan_compile_execute`** supporte `dry_run`.
* [x] **SSE** : backpressure mesuré, drops comptés + loggués.
* [x] **Sécurité** : token timing-safe, spawn strict, **sanitisation chemins partout**.
* [x] **Idempotence** : compaction opérationnelle ; statut consultable via métriques/logs.
* [x] **Perf** : p95 sous limites fixées pour graph diff/validate (datasets de référence).

---

Si tu veux, je peux te livrer ces changements en **séries de PR très ciblées** (sécurité → façades UX → forgeLoader → tests property/perf → CI), chacune avec les snippets et les tests prêts à l’emploi.

---

## 🧾 Journal des actions

* 2025-10-15T18:12Z — gpt-5-codex : Durci `fsArtifacts.safePath` (normalisation des séparateurs, neutralisation des points répétitifs, détection multi-plateforme) et étendu les tests de passerelle fichiers. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/gateways/fs.sanitize.test.ts`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/gateways/child.spawn.test.ts`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/gateways/child.env.test.ts`.

* 2025-10-17T19:45Z — gpt-5-codex : Introduit `src/rpc/errors.ts` avec les erreurs typées, remappe le middleware/HTTP/orchestrateur vers `toJsonRpc` et ajoute `tests/rpc/errors.mapping.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/rpc/errors.mapping.test.ts tests/rpc/middleware.validation.test.ts tests/rpc/validation.test.ts`.

* 2025-10-15T17:49Z — gpt-5-codex : Revérifié la tâche B1 (auth constant-time), relu `src/http/auth.ts`/`src/httpServer.ts`, confirmé la couverture de `tests/http/auth.test.ts` et exécuté `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/http/auth.test.ts`.

* 2025-10-15T18:03Z — gpt-5-codex : Validé la readiness réelle (`evaluateHttpReadiness`) et mis à jour la checklist B2 après revue de `src/httpServer.ts`/`src/http/readiness.ts`. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/http/readyz.test.ts`.

* 2025-10-18T20:11Z — gpt-5-codex : Généralisé `withIdempotency` (helper pur + TTL clamp) et ajouté l’adaptateur HTTP `withHttpIdempotency` avec couverture élargie (`tests/infra/idempotency.test.ts`). Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/infra/idempotency.test.ts`; `npm run lint:types`.

* 2025-10-19T09:32Z — gpt-5-codex : Converti le tampon SSE en limite d’octets, ajouté la journalisation détaillée des drops et ajusté les métriques/tests (`tests/streaming/sse.test.ts`, `tests/http/sse.backpressure.test.ts`). Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/streaming/sse.test.ts tests/http/sse.backpressure.test.ts`; `npm run lint:types`.

* 2025-10-19T11:20Z — gpt-5-codex : Aligné les métriques `/metrics` sur les façades (labels `tool:<name>`), enrichi le contexte trace pour refléter l’outil appelé et mis à jour la suite `tests/http/metrics.test.ts`. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/http/metrics.test.ts`; `npm run lint:types`.

* 2025-10-19T13:58Z — gpt-5-codex : Ajouté la suite `tests/events/bus.types.test.ts` pour verrouiller le catalogue des messages du bus et garantir que les tokens inconnus déclenchent une erreur. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/events/bus.types.test.ts`.

* 2025-10-20T09:12Z — gpt-5-codex : Sécurisé la persistance mémoire (`VectorMemoryIndex`, `PersistentKnowledgeGraph`) via `safePath` pour empêcher toute traversée de répertoire et ajouté des tests de régression ciblant les overrides de `fileName`. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/memory/vector.test.ts tests/memory/kg.test.ts`; `npm run lint:types`.

* 2025-10-21T07:45Z — gpt-5-codex : Isolé la configuration runtime dans `orchestrator/bootstrap.ts`, préparé les dépendances HTTP via `http/bootstrap.ts` et simplifié `server.ts` pour ne gérer que la composition. Tests : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/http/bootstrap.runtime.test.ts`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/e2e/server.bootstrap.test.ts`; `npm run lint:types`.

* 2025-10-21T12:15Z — gpt-5-codex : Vérifié l’exhaustivité de la checklist (A2→I3 + acceptation globale), coché les tâches réalisées et validé l’état actuel via `npm run build` puis `npm run test`. Aucun écart détecté.
* 2025-10-21T19:50Z — gpt-5-codex : Supprimé la dépendance `node:fs` du pool de workers, sécurisé la désactivation après échec et ajouté l’autorisation explicite pour `worker_threads`; corrigé `tests/hygiene.fs-gateway.test.ts` puis relancé la suite complète. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/hygiene.fs-gateway.test.ts`; `npm run test`.
* 2025-10-22T08:55Z — gpt-5-codex : Ajouté un timeout configurable et une factory injectable au pool de workers, plus des tests de résilience couvrant les replis inline. Commandes : `npm run lint:types`; `npm run build`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/infra/workerPool.resilience.test.ts tests/perf/graph.pool.test.ts`.
