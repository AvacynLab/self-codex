----------
Voici ta **feuille de route** exhaustive, agent. Elle est basée sur la dernière version du dépôt que j’ai auditée, et sur les axes d’amélioration identifiés (sécurité HTTP, idempotence persistée, supervision des enfants, observabilité, graphes, backpressure, validation JSON-RPC, packaging/ops).
Chaque item est actionnable, avec sous-étapes et extraits quand c’est utile. Exécute-la **fichier par fichier**.

---

# Brief (lis-moi avant de commencer)

**Objectifs attendus**

* Rendre le serveur MCP **robuste** (sécurité, idempotence persistée, supervision), **observable** (traces, métriques, logs corrélés), et **scalable** (backpressure, timeouts, limites).
* Durcir l’HTTP (token sureté temporelle, limites de taille, rate-limit), **sans casser** le transport STDIO.
* Solidifier les graphes (journal d’opérations, invariants, préparation multi-éditeurs).
* Centraliser la validation et les erreurs JSON-RPC (réponses homogènes).
* Garder le build/CI simple : **Node 20**, `npm ci --include=dev`, `tsc && tsc -p graph-forge`.

**Règles build & tests (à respecter strictement)**

* Build : `npm ci --include=dev && npm run build` (ou fallback `npx typescript tsc …` via `scripts/setup-agent-env.sh`).
* Types : `@types/node` **en dependencies** (pas dev) ; **Imports Node** toujours `from "node:…"` (jamais `"fs"` nu).
* Lint TS : `npm run lint` doit passer (incluant `lint:node-builtins` si présent).
* Tests : ajoute des **unitaires**, **intégration** HTTP, et quelques tests **property-based** pour les graphes.
  Cible : **coverage ≥ 85%** statements/functions/lines ; pas de flakiness.
* Artefacts : écris les entrées/sorties JSON-RPC et logs de validation dans `runs/validation_<date>/…`.

---

# To-do détaillée (avec cases à cocher)

## 1) Durcissement HTTP

### 1.1 Auth – comparaison en temps constant

* [x] **Créer** `src/http/auth.ts`

  ```ts
  import { timingSafeEqual } from "node:crypto";

  export function tokenOk(reqToken: string | undefined, required: string): boolean {
    if (!reqToken) return false;
    const a = Buffer.from(reqToken);
    const b = Buffer.from(required);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  ```
* [x] **Brancher** dans `src/httpServer.ts` (là où le token est vérifié) : remplacer la comparaison simple par `tokenOk`.

### 1.2 Limite de taille des requêtes

* [x] **Créer** `src/http/body.ts`

  ```ts
  import type { IncomingMessage } from "node:http";
  import { Buffer } from "node:buffer";

  export async function readJsonBody(req: IncomingMessage, maxBytes = 1 << 20) { // 1 MiB
    const bufs: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > maxBytes) throw Object.assign(new Error("Payload Too Large"), { status: 413 });
      bufs.push(b);
    }
    const raw = Buffer.concat(bufs).toString("utf8");
    return JSON.parse(raw);
  }
  ```
* [x] **Utiliser** `readJsonBody` dans `src/httpServer.ts` pour décoder le body JSON-RPC.

### 1.3 Rate-limit léger (token-bucket en mémoire)

* [x] **Créer** `src/http/rateLimit.ts`

  ```ts
  const buckets = new Map<string, { tokens: number; ts: number }>();

  export function rateLimitOk(key: string, rps = 10, burst = 20) {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, ts: now };
    const refill = ((now - b.ts) / 1000) * rps;
    b.tokens = Math.min(burst, b.tokens + refill);
    b.ts = now;
    if (b.tokens < 1) { buckets.set(key, b); return false; }
    b.tokens -= 1; buckets.set(key, b); return true;
  }
  ```
* [x] **Appeler** dans `src/httpServer.ts` en début de requête (clé = IP + chemin), renvoyer 429 sinon.

### 1.4 Entêtes de sécurité et corrélation

* [x] **Créer** `src/http/headers.ts`

  ```ts
  import { randomUUID } from "node:crypto";

  export function applySecurityHeaders(res: import("node:http").ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
  }
  export function ensureRequestId(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const rid = (req.headers["x-request-id"] as string) || randomUUID();
    res.setHeader("x-request-id", rid);
    return rid;
  }
  ```
* [x] **Intégrer** dans `src/httpServer.ts` (début de handler).

### 1.5 Tests HTTP

* [x] **Créer** `tests/http/auth.test.ts` : token correct/incorrect, temps constant (au moins fonctionnel).
* [x] **Créer** `tests/http/limits.test.ts` : 413 sur >1MiB, 429 sur dépassement rate-limit.
* [x] **Créer** `tests/http/headers.test.ts` : présence `x-request-id` et headers de sécurité.

---

## 2) Idempotence **persistée**

### 2.1 Store interface + implémentation fichiers

* [x] **Créer** `src/infra/idempotencyStore.ts`

  ```ts
  export interface IdempotencyStore {
    get(key: string): Promise<{ status: number; body: string } | null>;
    set(key: string, status: number, body: string, ttlMs: number): Promise<void>;
    purge?(now?: number): Promise<void>;
  }
  ```
* [x] **Créer** `src/infra/idempotencyStore.file.ts` (JSONL + index mémoire simple).

  * Fichier : `runs/idempotency/index.jsonl` (lignes `{key, status, body, exp}`).
  * Au démarrage : charger les lignes non expirées en map.
  * `set()` : append JSONL + MAJ map.
  * `purge()` : supprimer/compacter périodiquement (optionnel V1).

### 2.2 Raccordement serveur

* [x] **Modifier** `src/server.ts` :

  * [x] **Instancier** un `FileIdempotencyStore` quand HTTP stateless est actif.
  * Dans chaque **méthode à effet** (tx, patch, spawn child…), si `Idempotency-Key` fourni :

    * [x] `get()` → si hit, renvoyer immédiatement la réponse stockée ;
    * [x] sinon exécuter, puis `set()` avec `ttlMs = parseInt(process.env.IDEMPOTENCY_TTL_MS ?? "600000", 10)`.

    > Rejeu effectué au niveau de la passerelle HTTP : le cache persiste les réponses JSON-RPC complètes pour toutes les méthodes à effet.

### 2.3 Tests idempotence

* [x] **Créer** `tests/infra/idempotencyStore.file.test.ts` : set/get, TTL, redémarrage rechargé.
* [x] **Créer** `tests/int/idempotency.http.test.ts` : deux POST identiques avec même header → même résultat/ID/latence raccourcie.

---

## 3) Supervision des enfants (stratégies + circuit breaker)

### 3.1 Circuit breaker

* [x] **Créer** `src/infra/circuitBreaker.ts`

  * États : closed → open (après N erreurs), cooldown → half-open → closed sur succès.
  * Paramètres : `failThreshold`, `cooldownMs`, `halfOpenMaxInFlight`.

### 3.2 Supervisor

* [x] **Créer** `src/children/supervisor.ts`

  * Stratégie **one-for-one** avec **backoff exponentiel** (min/max).
  * Politique : si breaker **open**, refuser spawn/attach (erreur claire).
* [x] **Intégrer** dans `src/childSupervisor.ts` et pipeline existant (spawn/kill/limits).

### 3.3 Tests

* [x] **Créer** `tests/children/supervisor.test.ts` : enchaînement d’échecs → backoff, ouverture breaker, réouverture après cooldown.

---

## 4) Observabilité (traces, métriques, logs corrélés)

### 4.1 Traces/métriques internes

* [x] **Créer** `src/infra/tracing.ts`

  * Générer `trace_id` / `span_id`.
  * Timer par méthode JSON-RPC → métriques latences p50/p95, counts/err.
* [x] **Exposer** `/metrics` (si HTTP actif) en texte simple (format minimal maison) **protégé par token**.

### 4.2 Logs enrichis

* [x] **Modifier** `src/logger.ts` pour inclure `request_id`, `trace_id`, `child_id`, `method`, `duration_ms`, `bytes_in/out`.
* [x] **Vérifier** rotation et redaction `MCP_LOG_REDACT=on`.

### 4.3 Tests

* [x] **Créer** `tests/obs/metrics.test.ts` : check compteurs après une rafale d’appels.
* [x] **Créer** `tests/obs/logs.test.ts` : structure JSON attendue.

---

## 5) Graphes : op-log + invariants

### 5.1 Journal d’opérations

* [x] **Créer** `src/graph/oplog.ts`

  * `append(op: GraphOperation, txId: string, ts: number)` → écrit JSONL `runs/oplog/YYYYMMDD.log`.
* [x] **Brancher** dans la pipeline TX (`tx_begin`, `graph_patch`, `tx_commit/rollback`) : logguer toutes les mutations.

### 5.2 Invariants

* [x] **Créer** `src/graph/validate.ts` (zod/valibot) :

  * Noeuds/arêtes obligatoires, types/labels, **interdictions** de boucles/isolés selon règles, tailles bornées.
* [x] **Appeler** **avant** `tx_commit` ; rejeter TX avec **400** si violation (message précis).

### 5.3 Tests graphes

* [x] **Créer** `tests/graph/oplog.test.ts` : contenu JSONL correct, rotation journalière.
* [x] **Créer** `tests/graph/invariants.test.ts` : cas OK/KO.
* [x] **Créer** `tests/graph/property.test.ts` : (optionnel) *fast-check* pour générer des séquences de patchs et vérifier invariants.

---

## 6) Backpressure & streaming

### 6.1 SSE chunking & limites

* [x] **Modifier** `src/resources/sse.ts` :

  * **Chunker** les messages > `MCP_SSE_MAX_CHUNK_BYTES` (env, défaut 32 KiB).
  * Buffer borné par client, drop ancien si dépassement (et loggge un warning).
  * Timeout d’emit par client (env, défaut 5s).

### 6.2 Timeouts/limites par méthode

* [x] **Créer** `src/rpc/timeouts.ts` : mapping `method → timeoutMs` + bornes.
* [x] **Appliquer** globalement dans le dispatcher JSON-RPC.

### 6.3 Tests

* [x] **Créer** `tests/streaming/sse.test.ts` : payload volumineux → chunking, pas de blocage ; clients lents → pas d’OOM.

---

## 7) Middleware JSON-RPC (validation + erreurs homogènes)

### 7.1 Couche de validation centrale

* [x] **Créer** `src/rpc/middleware.ts`

  * Parse `jsonrpc`, `id`, `method`, `params`.
  * Valider `params` via schéma `zod` *par méthode*.
  * Encapsuler `try/catch` → retourner `{ code, message, data:{request_id, hint} }` propres.

### 7.2 Schémas

* [x] **Créer** `src/rpc/schemas.ts` : exports `zod` pour chaque méthode publique.
* [x] **Brancher** dans le routeur existant.

### 7.3 Tests

* [x] **Créer** `tests/rpc/validation.test.ts` : paramètres manquants/mal typés → **400/-32602** JSON-RPC ; message clair.

---

## 8) Packaging & opérations

### 8.1 Endpoints santé

* [x] **Ajouter** `/healthz` (no-auth), renvoyant `{ok:true}` si boucle event + GC accessibles.
* [x] **Ajouter** `/readyz` (auth), vérifie charge `graph-forge`, disponibilité idempotency store, file d’évènements non saturée.

### 8.2 Docker (facultatif mais recommandé)

* [x] **Créer** `Dockerfile` multi-stage :

  * stage **builder** : `npm ci --include=dev && npm run build`.
  * stage **runtime distroless** : copier `dist/` + `node_modules` prod + `graph-forge/dist`.
* [x] **Créer** `.dockerignore` : `node_modules`, `runs`, `tests`, etc.

### 8.3 Tests

* [x] **Créer** `tests/ops/healthz.test.ts` et `tests/ops/readyz.test.ts`.
* [ ] (CI) Build image, lancer container, ping santé (si pipeline disponible).

---

## 9) DX / Validation automatisée

### 9.1 Script de validation bout-en-bout

* [x] **Créer** `scripts/validation/run-smoke.mjs`

  * Enchaîne : `mcp_info` → `tools_list` → `tx_begin` → `graph_patch` → `tx_commit` → `child_spawn_codex` → `child_send` → `child_kill`.
  * Écrit **chaque requête/réponse** dans `runs/validation_<date>/inputs|outputs/*.jsonl` + un `summary.md` (latences p50/p95, codes, tailles).

### 9.2 Script de contraintes

* [x] **Créer** `scripts/checks.mjs` :

  * Vérifie imports `node:` only, absence de dépendances non utilisées, tailles de bundle raisonnables.

---

# Modifs précises existantes (raccordements)


* `src/httpServer.ts` :

  * [x] Intégrer `applySecurityHeaders`, `ensureRequestId`, `rateLimitOk`, `readJsonBody`, `tokenOk`.
  * [x] En cas d’erreur, retourner JSON-RPC error **homogène** (via middleware).

* `src/server.ts` :

  * [x] Instancier `IdempotencyStore` (fichier) si HTTP stateless.
  * [x] Autour des méthodes **à effet** : **wrap idempotence** (get/set).

    > La persistance est centralisée dans `startHttpServer` : les réponses JSON-RPC complètes sont rejouées avant d’invoquer les handlers effet.
  * [x] Émettre `trace_id`/`request_id` vers `logger`.

* `src/logger.ts` :

  * [x] Ajouter champs de corrélation, tailles, durées.
  * [x] Conserver rotation & redaction.

* `src/resources/sse.ts` :

  * [x] Implémenter chunking & limites.

* `src/graph/*.ts` :

  * [x] Appeler `validateGraph()` avant commit.
  * [x] Écrire l’op-log pour toutes mutations.

* `src/childSupervisor.ts` :

  * [x] S’appuyer sur `children/supervisor.ts` + `circuitBreaker`.

* `src/rpc/*` :

  * [x] Ajouter `middleware.ts` + `schemas.ts` ; centraliser la validation.

---

# Échantillons de tests (point de départ)

**`tests/http/limits.test.ts`**

```ts
import { expect } from "chai";
import { postJson } from "../helpers/http"; // écris un helper

describe("HTTP limits", () => {
  it("rejects >1MiB payload with 413", async () => {
    const big = "x".repeat(1_200_000);
    const res = await postJson("/mcp", big, { token: process.env.MCP_HTTP_TOKEN! });
    expect(res.status).to.equal(413);
  });
});
```

**`tests/rpc/validation.test.ts`**

```ts
import { expect } from "chai";
import { rpc } from "../helpers/rpc";

describe("JSON-RPC validation", () => {
  it("fails with structured error when params invalid", async () => {
    const r = await rpc("graph_patch", { not_expected: 1 });
    expect(r.error?.code).to.be.oneOf([-32602, 400]);
    expect(r.error?.data?.request_id).to.be.a("string");
  });
});
```

**`tests/graph/invariants.test.ts`**

```ts
import { expect } from "chai";
import { begin, patch, commit } from "../helpers/graph";

describe("Graph invariants", () => {
  it("rejects commit on invalid graph", async () => {
    await begin();
    await patch({ edges: [{ from:"A", to:"A" }] }); // boucle si interdite
    const res = await commit();
    expect(res.status).to.equal(400);
  });
});
```

---

# Validation finale (critères d’acceptation)

* [x] **Build** passe (loc/Cloud) : `npm ci --include=dev && npm run build`.
* [x] **Lint** passe : `npm run lint`.
* [x] **Tests** passent (unit + int) ; **coverage ≥ 85%**.
* [x] **HTTP** :

  * [x] 401 si token manquant/mauvais ;
  * [x] 413 > 1MiB ; 429 si rafale ;
  * [x] `x-request-id` et headers sécurité présents.
* [x] **Idempotence** : même `Idempotency-Key` → même résultat, même ID ; survive au redémarrage.
* [x] **Enfants** : breaker/open sur n fautes, backoff ; recovery après cooldown.
* [x] **Observabilité** : `/metrics` exposé (auth), logs corrélés avec `request_id` ; p95 dispo.
* [x] **Graphes** : op-log JSONL écrit ; invariants appliqués avant commit.
* [x] **SSE** : payloads chunkés, pas d’OOM avec clients lents.
* [x] **/healthz** (no-auth) et **/readyz** (auth) répondent correctement.
* [x] `scripts/validation/run-smoke.mjs` produit `runs/validation_<date>/…` complet.

---

Tu peux commencer par **1) HTTP** et **2) Idempotence**, ce sont les leviers de robustesse immédiats, puis enchaîner **3) Supervision**, **4) Observabilité**, **5) Graphes**.
Si tu souhaites, je peux te fournir des **patchs minimaux** (diff) pour initialiser chaque nouveau fichier listé ci-dessus.

### Historique des actions

* 2025-10-13T01:00Z — gpt-5-codex : Durcissement HTTP (auth constant-time, limites body/ratelimit, entêtes sécurité) et tests http (auth/limits/headers, fast-path). Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/http/**/*.test.ts" "tests/http.jsonrpc.fast-path.test.ts"`.
* 2025-10-13T01:19Z — gpt-5-codex : Idempotence persistée (store fichier JSONL, raccordement HTTP stateless, replay complet) + tests `infra/idempotencyStore.file.test.ts` & `int/idempotency.http.test.ts`. Commande : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/infra/idempotencyStore.file.test.ts" "tests/int/idempotency.http.test.ts"`.
* 2025-10-13T02:05Z — gpt-5-codex : Supervision enfants (circuit breaker, supervisor one-for-one, intégration `childSupervisor`, tests de backoff/cooldown). Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/children/supervisor.test.ts"`; `npm run lint`.
* 2025-10-13T02:20Z — gpt-5-codex : Observabilité HTTP/JSON-RPC (tracing AsyncLocalStorage, `/metrics`, logger enrichi) + tests `tests/obs/**/*.test.ts`, `tests/logger.test.ts`. Commandes : `npm run lint`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/obs/**/*.test.ts"`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/logger.test.ts`.
* 2025-10-13T02:31Z — gpt-5-codex : Backpressure SSE (chunking, buffer borné, timeouts) + tests `tests/streaming/sse.test.ts`, `tests/resources.watch.sse.test.ts`. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/streaming/sse.test.ts"`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/resources.watch.sse.test.ts"`.
* 2025-10-13T03:30Z — gpt-5-codex : Journal d’opérations et validation graphes (oplog JSONL, `validateGraph` + intégration tx/batch/patch) avec tests `tests/graph/oplog.test.ts`, `tests/graph/invariants.test.ts`, `tests/graph/property.test.ts`. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/graph/oplog.test.ts" "tests/graph/invariants.test.ts" "tests/graph/property.test.ts"`; `npm run lint`.
* 2025-10-13T03:24Z — gpt-5-codex : Endpoints `/healthz` & `/readyz`, Docker packaging, DX scripts. Tests `tests/ops/healthz.test.ts`, `tests/ops/readyz.test.ts`; commandes : `npm run lint`, `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/ops/**/*.test.ts"`, `node scripts/checks.mjs`.
* 2025-10-13T03:45Z — gpt-5-codex : Middleware JSON-RPC (schemas agrégés, validation centralisée, erreurs homogènes) + tests `tests/rpc/validation.test.ts`. Commandes : `npm run lint`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/rpc/validation.test.ts`.
* 2025-10-13T03:48Z — gpt-5-codex : Ajustements post-middleware (timestamps graphes, schémas tools HTTP, corrélations observabilité, allow-list FS/HTTP) + couverture complète. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter spec --file tests/setup.ts tests/http.jsonrpc.fast-path.test.ts`, `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter spec --file tests/setup.ts tests/integration/jsonrpc.observability.test.ts`, `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter spec --file tests/setup.ts tests/hygiene.fs-gateway.test.ts`, `npm run lint`, `npm run coverage`.
* 2025-10-13T04:47Z — gpt-5-codex : Budgets timeout JSON-RPC (module `src/rpc/timeouts.ts`, intégration dispatcher, logs) + test d’enforcement `tests/rpc/timeouts.test.ts` et régressions observabilité. Commandes : `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/rpc/timeouts.test.ts`, `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts "tests/obs/**/*.test.ts"`, `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/integration/jsonrpc.observability.test.ts`, `npm run lint`.
* 2025-10-13T04:58Z — gpt-5-codex : Validation finale (build, lint, couverture complète) — commandes : `npm ci --include=dev`, `npm run build`, `npm run lint`, `npm run coverage`.
* 2025-10-13T05:17Z — gpt-5-codex : Stabilisation du smoke-run (`scripts/validation/run-smoke.mjs`) avec activation des features MCP, graphe de base connecté, contournement des enfants HTTP et test dédié `tests/validation/run-smoke.test.ts`. Commandes : `node scripts/validation/run-smoke.mjs`, `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/validation/run-smoke.test.ts`.
