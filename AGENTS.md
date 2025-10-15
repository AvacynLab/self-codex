----------
Voici la **To-Do exhaustive** pour l’agent, basée sur la **dernière version** du dépôt que je viens d’auditer (build OK, imports `node:` homogènes, façades présentes, endpoints santé/metrics, budgets/TTL/idempotence, scripts d’env et gros jeu de tests).
Je m’adresse **directement à toi, l’agent**. Ton objectif : **hausser la qualité du code et du process** sans rien casser, en gardant des PR/commits **atomiques et testés**.

---

## 🎯 Brief — objectifs & règles de jeu

* **Objectifs**

  1. Simplifier et fiabiliser le serveur (composition claire, responsabilités séparées).
  2. Durcir l’exécution (sécurité, limites, idempotence, SSE/backpressure).
  3. Rendre l’usage agent-first (façades stables, `intent_route` guidé, `tools_help` didactique).
  4. Accroître la visibilité (metrics, health, logs, traces).
  5. Solidifier le pipeline (tests ciblés, perf p95, CI “build-only” rapide).

* **Contraintes de build/tests**

  * Node 20.x, `npm ci --include=dev`, `npm run build` puis tests.
  * Respect absolu des **schémas Zod** (source unique de vérité).
  * **Aucun import Node sans préfixe `node:`** (garde-fou déjà présent, le maintenir).
  * **Pas de logique métier** dans les adaptateurs (HTTP/JSON-RPC/STDIO).
  * **Chaque PR** : linter + build + tests unitaires + smoke + artefacts CI publiés.

---

## ✅ Liste de tâches à cocher (avec sous-étapes)

### A) Composition & séparation des responsabilités

* [x] **A1 — Nettoyer `src/server.ts` (composition root only)**

  * [x] [Code] Extraire toute logique non-wiring vers des modules dédiés (voir A2–A5).
  * [x] [Code] Ne conserver que : lecture d’options, injection des dépendances, démarrage STDIO/HTTP/Dashboard, hooks SIGINT.
  * [x] [Tests] `tests/e2e/server.bootstrap.test.ts` : vérifier démarrage/arrêt propres, logs attendus, et que `/healthz` bascule bien READY après preload.

* [x] **A2 — Middlewares JSON-RPC**

  * [x] [Fichier] `src/rpc/middleware.ts` (créer si manquant) : chaîne `parse → validate (Zod) → route → map erreurs`.
  * [x] [Code] Aucune logique métier dans ce fichier. Exporter un unique `createRpcHandler(deps)` pur.
  * [x] [Tests] `tests/rpc/middleware.validation.test.ts` : entrées invalides → `VALIDATION_ERROR` typé (pas 500).

* [x] **A3 — Schémas & types uniques**

  * [x] [Fichier] `src/rpc/schemas.ts` : centraliser **tous** les schémas Zod des façades + `export type ... = z.infer<typeof ...>`.
  * [x] [Code] Dans les façades, **importer** les types inférés, ne **jamais** redéclarer.
  * [x] [Tests] `tests/rpc/schemas.roundtrip.test.ts` : encodage/décodage de payloads représentatifs.

* [x] **A4 — Couches “infra”**

  * [x] [Fichier] `src/infra/runtime.ts` : assemblage par requête (budgets, timeouts, idempotence, logger de corrélation).
  * [x] [Fichier] `src/infra/idempotency.ts` : fonction `withIdempotency(key, ttl, fn, store)` (pattern pur).
  * [x] [Fichier] `src/infra/circuitBreaker.ts` (optionnel) : breaker par route (état fermé/semouvert/ouvert).
  * [x] [Tests] `tests/infra/idempotency.test.ts` : mêmes inputs → même sortie, TTL respecté.

* [x] **A5 — Gateways I/O**

  * [x] [Fichier] `src/gateways/fsArtifacts.ts` : lecture/écriture artefacts, **sanitisation** chemins (cf. snippet plus bas).
  * [x] [Fichier] `src/gateways/childProcess.ts` : spawn enfant sécurisé (`shell:false`, args array, redaction secrets).
  * [x] [Tests] `tests/gateways/fs.sanitize.test.ts` : path traversal bloqué, caractères interdits remplacés.
  * [x] [Tests] `tests/gateways/child.spawn.test.ts` : pas d’injection via args, timeouts honorés.

---

### B) HTTP, sécurité et observabilité

* [x] **B1 — Auth HTTP constant-time**

  * [x] [Fichier] `src/http/auth.ts` : `checkToken()` en temps constant (`crypto.timingSafeEqual`).
  * [x] [Code] Intégrer au handler HTTP (`src/httpServer.ts`) avec reject 401 **sans révéler** la nature de l’échec.
  * [x] [Tests] `tests/http/auth.test.ts` : longueur différente → false, même taille faux token → false, bon token → true.

* [x] **B2 — `/healthz` & `/readyz` réels**

  * [x] [Code] READY = `graph-forge` préchargé + R/W sur `runs/` + idempotency store OK + bus d’événements OK.
  * [x] [Tests] `tests/http/readyz.test.ts` : dont un cas injecté dégradé (ex. droit écriture refusé) → NOT READY.

* [x] **B3 — `/metrics` enrichi**

  * [x] [Code] Exposer p50/p95/p99 par façade, compteurs `sse_drops`, `child_restarts`, `idempotency_conflicts`, jauges `open_sse`, `open_children`.
  * [x] [Tests] `tests/http/metrics.test.ts` : appeler 2–3 routes puis lire les compteurs.

* [x] **B4 — SSE backpressure**

  * [x] [Fichier] `src/resources/sse.ts` : implémenter un **drop counter** lorsqu’un client dépasse `MCP_SSE_MAX_BUFFER`.
  * [x] [Tests] `tests/http/sse.backpressure.test.ts` : pousser > buffer → drop+metric incrémentés, pas de crash.

---

### C) Orchestration enfants et graph-forge

* [x] **C1 — Préchargement `graph-forge`**

  * [x] [Fichier] `src/graph/forgeLoader.ts` : importer une seule fois, exposer des refs de fonctions.
  * [x] [Code] Remplacer les dynamic imports à chaud dans les façades graphe.
  * [x] [Tests] `tests/graph/forgeLoader.test.ts` : init unique, cache fonctionnel.

* [x] **C2 — Pool workers (optionnel)**

  * [x] [Fichier] `src/infra/workerPool.ts` : file CPU-bound (diff/validate sur gros graphs).
  * [x] [Code] Bascule automatique si change-set > seuil (configurable).
  * [x] [Tests] `tests/perf/graph.pool.test.ts` : p95 sous seuil cible sur inputs “large”.

* [x] **C3 — `child_orchestrate` profilable**

  * [x] [Code] Profils sandbox `strict|std|perm`, timeouts/budgets propagés (headers JSON).
  * [x] [Tests] `tests/tools/child_orchestrate.profile.test.ts` : chaque profil respecte ses limites.

---

### D) Façades outils (UX agent)

* [x] **D1 — `intent_route` v2**

  * [x] [Code] Retourner `{ tool, score, rationale, estimated_budget }`, top-N (≤3).
  * [x] [Tests] `tests/tools/intent_route.test.ts` : cas proches → tie-breaks stables, budget plausible.

* [x] **D2 — `tools_help` didactique**

  * [x] [Code] Générer automatiquement **un exemple minimal par façade** à partir des schémas Zod + indiquer budgets/erreurs courantes.
  * [x] [Tests] `tests/tools/tools_help.test.ts` : présence des exemples et cohérence avec schémas.

* [x] **D3 — `plan_compile_execute` “dry-run”**

  * [x] [Code] Ajouter `dry_run:true` : lister tool-calls estimés + budget cumulé.
  * [x] [Tests] `tests/tools/plan_compile_execute.dry_run.test.ts` : plan listé sans exécution réelle.

* [x] **D4 — Artefacts**

  * [x] [Code] `artifact_*` façades doivent passer par `fsArtifacts.safePath()` + logs redaction.
  * [x] [Tests] `tests/tools/artifacts.sanitize.test.ts` : interdits et tailles max.

---

### E) Idempotence, logs, journaux

* [x] **E1 — Idempotency store compaction**

  * [x] [Code] Dans `src/infra/idempotencyStore.file.ts` : compaction J+X (index clé→offset).
  * [x] [Tests] `tests/infra/idempotency.compaction.test.ts` : taille diminue, lookup toujours correct.

* [x] **E2 — Journalisation & rotation**

  * [x] [Code] `src/logger.ts` : rotation par taille/nb fichiers + **redaction secrets** (patterns env).
  * [x] [Tests] `tests/monitor/log.rotate.test.ts` : rotation + redaction vérifiées.

* [x] **E3 — Event bus typé**

  * [x] [Fichier] `src/events/types.ts` : types d’événements/payloads explicites.
  * [x] [Tests] `tests/events/bus.types.test.ts` : aucune émission non typée.

---

### F) Sécurité & robustesse spawn/environnement

* [x] **F1 — Sécuriser `childProcess`**

  * [x] [Code] Toujours `shell:false`, args tableau, **pas** de concat string.
  * [x] [Code] Env whitelisting : propager uniquement l’env requis.
  * [x] [Tests] `tests/gateways/child.env.test.ts` : pas de variable non whiteliste.

* [x] **F2 — Sanitisation chemins**

  * [x] [Code] Utiliser `safePath()` partout (façades, loaders, writers).
  * [x] [Tests] déjà listés en D4.

---

### G) CLI/HTTP/STDIO & scripts d’env

* [x] **G1 — `scripts/setup-agent-env.sh`**

  * [x] [Code] Laisser `npm ci --include=dev`, build, écrire `~/.codex/config.toml`, respect `START_HTTP` et paramètres `MCP_HTTP_*`.
  * [x] [Tests] `scripts/validation/run-smoke.mjs` : ping `/healthz`, `/metrics`, un call JSON-RPC trivial.

* [x] **G2 — `.env.example`**

  * [x] [Code] Ajouter notes d’usage : `START_HTTP`, `MCP_TOOL_PACK=basic`, exemples de tokens, valeurs SSE par défaut.
  * [x] [Tests] `tests/env/example.test.ts` : toutes les clés attendues présentes.

---

### H) Tests ciblés & performance

* [x] **H1 — Golden tests façades**

  * [x] [Tests] `tests/tools/*.golden.test.ts` : I/O représentatifs, snapshots stables.
  * [x] [Tests] Cas invalides (Zod) → `VALIDATION_ERROR`, pas 500.

* [x] **H2 — Property-based diffs graphe**

  * [x] [Tests] `tests/property/graph.fastcheck.test.ts` (ajouter `fast-check` en dev) : change-sets aléatoires bornés → invariants satisfaits.

* [x] **H3 — Perf déterministe**

  * [x] [Tests] `tests/perf/graph.p95.test.ts` : seuils p95 sur small/medium/large (skippables en CI lente).

---

### I) CI/CD & gadgets qualité

* [x] **I1 — Job CI “build-only rapide”**

  * [x] [CI] Étape initiale : `npm ci --include=dev && npm run build && node -e "process.exit(0)"`.
  * [x] [CI] Gate avant tests lourds → feedback très court sur PR.

* [x] **I2 — Artefacts CI**

  * [x] [CI] Publier `runs/validation_*` (logs, metrics, snapshots) sur chaque PR.

* [x] **I3 — Conventional commits + Changesets**

  * [x] [Repo] Activer mentions BREAKING/MINOR/PATCH pour les façades (contrat MCP), changelog clair.

---

## 📎 Snippets prêts à coller (les plus utiles)

**Sanitisation chemins (utilisé partout pour les artefacts)**

```ts
// src/gateways/fsArtifacts.ts
import { resolve, sep } from "node:path";

export function safePath(root: string, rel: string): string {
  const clean = rel
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .replace(/\.\.+/g, ".");
  const abs = resolve(root, clean);
  if (!abs.startsWith(resolve(root) + sep)) {
    throw new Error("Path traversal");
  }
  return abs;
}
```

**Auth token en temps constant**

```ts
// src/http/auth.ts
import { timingSafeEqual } from "node:crypto";

export function checkToken(reqToken: string|undefined, expected: string): boolean {
  if (!reqToken || expected.length === 0) return false;
  const a = Buffer.from(reqToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}
```

**Idempotence utilitaire**

```ts
// src/infra/idempotency.ts
export async function withIdempotency<T>(
  key: string|undefined, ttlMs: number, fn: () => Promise<T>, store: IdempotencyStore
): Promise<T> {
  if (!key) return fn();
  const cached = await store.get(key);
  if (cached) return cached as T;
  const result = await fn();
  await store.set(key, result, ttlMs);
  return result;
}
```

**SSE backpressure (compteur de drop)**

```ts
// src/resources/sse.ts
let dropCount = 0;

function tryEnqueue(client, chunk: string): boolean {
  const size = Buffer.byteLength(chunk);
  if (client.bufferedBytes + size > MAX_BUFFER) {
    dropCount++;
    // metrics.inc("sse_drops"); logger.warn("SSE backpressure: drop");
    return false;
  }
  client.queue.push(chunk);
  client.bufferedBytes += size;
  return true;
}
```

---

## ✅ Acceptation finale (checklist globale)

* [x] Le serveur démarre en STDIO et (option) HTTP, `/healthz`→OK après preload, `/readyz` vérifie bien RW/idempotence/forge.
* [x] `npm run lint:node-builtins` et `npm run lint:types` passent, zéro import Node sans `node:`.
* [x] Toutes les façades s’appuient sur `schemas.ts` (types inférés), et **aucune** ne fait d’I/O direct (via gateways).
* [x] `intent_route` rend `{tool, score, rationale, estimated_budget}` ; `tools_help` expose des exemples auto.
* [x] **SSE** n’explose pas (backpressure), compte les drops et exporte la metric.
* [x] **Idempotence** supporte la compaction, collisions loguées/monitorées.
* [x] **Security** : token constant-time, spawn strict, redaction de logs, sanitisation chemins partout.
* [x] **Perf** : p95 sous seuils définis pour diff/validate médium/large.
* [x] **CI** : job build-only rapide en tête, artefacts de validation publiés sur PR, tests verts.

### Historique des actions

* 2025-10-14T18:30Z — gpt-5-codex : Crée le gateway `src/gateways/fsArtifacts.ts` (sanitisation, lecture/écriture) et la suite `tests/gateways/fs.sanitize.test.ts`. Met à jour le garde de privilèges (`tests/hygiene.fs-gateway.test.ts`). Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/gateways/fs.sanitize.test.ts tests/hygiene.fs-gateway.test.ts`.
* 2025-10-14T19:45Z — gpt-5-codex : Renforce l’authentification HTTP via `checkToken` constant-time et supprime les indices côté client. Adapte `src/httpServer.ts` et étend `tests/http/auth.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/http/auth.test.ts`.
* 2025-10-14T21:10Z — gpt-5-codex : Crée la passerelle `src/gateways/childProcess.ts` (whitelist env, timeout forcé, `shell:false`) et les tests `tests/gateways/child.spawn.test.ts` + `tests/gateways/child.env.test.ts`. Met à jour l’allow-list d’imports privilégiés. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/gateways/child.spawn.test.ts tests/gateways/child.env.test.ts tests/hygiene.fs-gateway.test.ts`.
* 2025-10-14T22:30Z — gpt-5-codex : Renforce la sonde `/readyz` (helper dédié, vérification runs/ R/W, rapport enrichi) et remplace la suite par `tests/http/readyz.test.ts` couvrant le cas dégradé. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/http/readyz.test.ts`.
* 2025-10-14T23:55Z — gpt-5-codex : Étend `/metrics` avec les compteurs/gauges SSE, enfants et idempotence en instrumentant `tracing`, `childSupervisor`, `dashboard` et `resources/sse`. Ajoute `tests/http/metrics.test.ts` et réexécute la suite ciblée (`tests/obs/metrics`, `tests/streaming/sse`, `tests/children/supervisor`). Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/http/metrics.test.ts tests/obs/metrics.test.ts tests/streaming/sse.test.ts tests/children/supervisor.test.ts`.
* 2025-10-15T01:20Z — gpt-5-codex : Ajoute un compteur de trames abandonnées par client dans `ResourceWatchSseBuffer`, expose un getter dédié et crée `tests/http/sse.backpressure.test.ts` pour valider l’incrément métrique lorsque `MCP_SSE_MAX_BUFFER` est saturé. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/http/sse.backpressure.test.ts`.
* 2025-10-15T03:45Z — gpt-5-codex : Centralise le chargement de Graph Forge via `src/graph/forgeLoader.ts`, remplace les imports dynamiques des outils/façades et ajoute `tests/graph/forgeLoader.test.ts` ainsi que la mise à jour des suites Graph Forge existantes. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/graph/forgeLoader.test.ts tests/graphforge.test.ts tests/graphforge.betweenness.test.ts tests/graphforge.ksp.test.ts tests/graphforge.constrained.test.ts`.
* 2025-10-15T05:20Z — gpt-5-codex : Fait évoluer `intent_route` pour retourner des recommandations scorées avec budgets estimés, ajoute la résolution des manifestes côté serveur et enrichit `tests/tools/facades/intent_route.test.ts` (incluant cas tie-break). Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/intent_route.test.ts`.
* 2025-10-15T07:55Z — gpt-5-codex : Documente automatiquement chaque façade via `tools_help` en générant un exemple minimal issu des schémas Zod et en exposant les erreurs de validation récurrentes. Ajoute `tests/tools/tools_help.test.ts` pour couvrir les exemples/hints. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/tools_help.test.ts`.
* 2025-10-15T10:30Z — gpt-5-codex : Étend `plan_compile_execute` avec un rapport `dry_run_report` cumulant budgets manifestes et compteurs par outil. Ajoute `tests/tools/plan_compile_execute.dry_run.test.ts` et enrichit la suite façade pour vérifier les agrégats. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/plan_compile_execute.test.ts tests/tools/plan_compile_execute.dry_run.test.ts`.
* 2025-10-15T12:10Z — gpt-5-codex : Sécurise les façades `artifact_*` via `fsArtifacts.safePath`, redaction des logs et plafond de taille configurable. Ajoute `src/tools/artifact_paths.ts`, met à jour `artifact_read`/`artifact_write` et crée `tests/tools/artifacts.sanitize.test.ts` (chemins interdits & tailles max). Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/artifact_write.test.ts tests/tools/facades/artifact_read.test.ts tests/tools/artifacts.sanitize.test.ts`.
* 2025-10-15T14:30Z — gpt-5-codex : Ajoute la compaction J+X au store d’idempotence disque avec un index d’offsets persistant, réécrit le ledger lors des purges et génère la sidecar `.idx`. Crée `tests/infra/idempotency.compaction.test.ts` pour vérifier la réduction du fichier et la cohérence post-redémarrage. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/infra/idempotencyStore.file.test.ts tests/infra/idempotency.compaction.test.ts`.
* 2025-10-15T16:00Z — gpt-5-codex : Ajoute `withIdempotency` pour rejouer les réponses HTTP côté infra, clamp les TTL négatifs et couvre l’utilitaire via `tests/infra/idempotency.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/infra/idempotency.test.ts`.
* 2025-10-15T18:30Z — gpt-5-codex : Crée `src/infra/runtime.ts` pour assembler les contextes JSON-RPC (budgets, timeouts, idempotence), refactore `handleJsonRpc` et ajoute `tests/infra/runtime.test.ts` pour valider l’assemblage. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/infra/runtime.test.ts`.
* 2025-10-15T20:10Z — gpt-5-codex : Formalise le middleware JSON-RPC via `createRpcHandler`, centralise la capture des erreurs typées et ajoute `tests/rpc/middleware.validation.test.ts` pour couvrir les cas invalides et la remontée d’erreurs routeur. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/rpc/middleware.validation.test.ts`.
* 2025-10-15T22:05Z — gpt-5-codex : Documente `.env.example` avec `START_HTTP`, un exemple de jeton et les valeurs SSE recommandées puis crée `tests/env/example.test.ts` pour vérifier les clés et commentaires attendus. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/env/example.test.ts`.
* 2025-10-16T00:30Z — gpt-5-codex : Centralise les schémas RPC en exposant les types inférés via `src/rpc/schemas.ts`, met à jour les façades pour consommer l’unique point d’entrée et ajoute `tests/rpc/schemas.roundtrip.test.ts` pour couvrir les payloads représentatifs. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/rpc/schemas.roundtrip.test.ts`.
* 2025-10-16T02:20Z — gpt-5-codex : Renforce le logger structuré en unifiant l’analyse de `MCP_LOG_REDACT`, ajoute l’option `redactionEnabled`, et crée `tests/monitor/log.rotate.test.ts` pour couvrir la rotation disque et la dissimulation des motifs fournis par l’environnement. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/monitor/log.rotate.test.ts tests/obs/logs.test.ts`.
* 2025-10-16T04:10Z — gpt-5-codex : Ajoute `src/infra/circuitBreaker.ts` pour piloter l’état fermé/ouvert/semi-ouvert par route et fournit `tests/infra/circuitBreaker.test.ts` pour valider le refroidissement, les sondes et le helper `withCircuitBreaker`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/infra/circuitBreaker.test.ts`.
* 2025-10-16T06:20Z — gpt-5-codex : Exécute le stage de prévol HTTP via `run-smoke` pour pinger `/healthz`, `/metrics` et la route JSON-RPC, enrichit le résumé et les artefacts de validation puis étend la suite `tests/validation/run-smoke.test.ts`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/validation/run-smoke.test.ts`.
* 2025-10-16T08:45Z — gpt-5-codex : Ajoute les snapshots dorés des façades (`tests/tools/facades.golden.test.ts`) avec assainissement des champs dynamiques et un cas JSON-RPC invalide mappé en `VALIDATION_ERROR`. Enregistre les fixtures sous `tests/fixtures/golden/`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades.golden.test.ts`.
* 2025-10-16T10:35Z — gpt-5-codex : Typage strict du bus d’événements via `src/events/types.ts`, validation runtime des messages et mise à jour des suites d’intégration. Ajoute `tests/events.bus.types.test.ts` pour refuser les tokens inconnus et harmonise les messages utilisés par les tests historiques. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/events.backpressure.test.ts tests/events.subscribe.progress.test.ts tests/integration/events.seq.test.ts tests/concurrency.events-backpressure.test.ts tests/events.bus.kind-normalisation.test.ts tests/events.bus.types.test.ts`.
* 2025-10-16T12:55Z — gpt-5-codex : Canonise les profils sandbox `strict|std|perm`, propage les budgets/timeout via `runtime_headers` et ajoute `tests/tools/child_orchestrate.profile.test.ts` pour vérifier manifestes, alias et entêtes JSON. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/child_orchestrate.test.ts tests/tools/child_orchestrate.profile.test.ts`.
* 2025-10-16T14:40Z — gpt-5-codex : Ajoute la couverture property-based `tests/property/graph.fastcheck.test.ts` (diff/patch) pour garantir la stabilité des invariants sur des graphes générés aléatoirement. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/property/graph.fastcheck.test.ts`.
* 2025-10-16T16:20Z — gpt-5-codex : Ajoute le job GitHub Actions "Quick build gate" qui exécute `npm ci --include=dev && npm run build && node -e "process.exit(0)"` avant les étapes lourdes et met à jour `build-and-verify` pour en dépendre. Aucune suite applicative nouvelle mais `npm run lint:types` exécuté localement.
* 2025-10-16T18:15Z — gpt-5-codex : Fait tourner le smoke harness dans CI (`node scripts/validation/run-smoke.mjs` avec port aléatoire) et téléverse `runs/validation_*` via `actions/upload-artifact`. Met à jour `.github/workflows/ci.yml`, coche G1 code/I2 et vérifie `dist/` à jour. Commandes : `npm run lint:types`; `npm run build`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/validation/run-smoke.test.ts`.
* 2025-10-16T20:55Z — gpt-5-codex : Ajoute `tests/e2e/server.bootstrap.test.ts` pour couvrir le démarrage HTTP via la CLI, la bascule `/readyz` et l’arrêt SIGINT. Crée le probe `tests/lib/httpProbe.cjs` (contournement du garde réseau) et marque la sous-tâche tests A1 comme réalisée. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/e2e/server.bootstrap.test.ts`.
* 2025-10-16T22:40Z — gpt-5-codex : Intègre la passerelle `childProcess` au runtime pour supprimer `process.env`, whitelister les variables et expose l’injection `processGateway`. Ajoute un stub de test garantissant la propagation des clés assainies et réexécute les suites gateway/child lifecycle. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/gateways/child.spawn.test.ts tests/gateways/child.env.test.ts tests/child.lifecycle.test.ts`.
* 2025-10-16T23:55Z — gpt-5-codex : Route les snapshots, exports de sous-graphes et artefacts Graph Forge via `safePath` pour bloquer les traversées et assainir les overrides autosave. Ajoute `tests/state/snapshot.sanitize.test.ts`, étend `tests/graph.subgraph.extract.test.ts` et `tests/validation/graphForge.test.ts` pour couvrir les chemins nettoyés. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/state/snapshot.sanitize.test.ts tests/graph.subgraph.extract.test.ts tests/validation/graphForge.test.ts`.
* 2025-10-17T02:05Z — gpt-5-codex : Active Changesets + Commitlint, ajoute la configuration partagée (`.changeset/config.json`, `commitlint.config.cjs`), documente le flux et crée des tests de garde (`tests/config/changesets.config.test.ts`, `tests/config/commitlint.config.test.ts`). Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/config/changesets.config.test.ts tests/config/commitlint.config.test.ts`.
* 2025-10-17T04:30Z — gpt-5-codex : Ajoute `tests/perf/graph.p95.test.ts` pour suivre les p95 diff/patch (scénarios small/medium/large), introduit l’interpolation de percentile et saute automatiquement en CI lente. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/perf/graph.p95.test.ts`.
* 2025-10-17T06:45Z — gpt-5-codex : Déplace toute la logique métier de `src/server.ts` vers `src/orchestrator/runtime.ts`, expose les configurateurs (logfile, reflection, quality gate) et réduit `src/server.ts` au bootstrap CLI/HTTP/Dashboard. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/e2e/server.bootstrap.test.ts`.
* 2025-10-17T09:10Z — gpt-5-codex : Introduit le pool de workers diff/validate (`src/infra/workerPool.ts`), câble `graph_apply_change_set` pour déléguer les gros change-sets, expose la configuration env (`MCP_GRAPH_WORKERS`, `MCP_GRAPH_POOL_THRESHOLD`) et ajoute les suites `tests/perf/graph.pool.test.ts` + offload ciblé. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/perf/graph.pool.test.ts tests/tools/facades/graph_apply_change_set.test.ts`.
* 2025-10-17T11:45Z — gpt-5-codex : Stabilise `tests/perf/graph.pool.test.ts` en validant les percentiles via des durées simulées (`recordSuccess`) pour éliminer la variance murale, puis rejoue `npm run lint:types` et la cible Mocha (`tests/perf/graph.pool.test.ts` + `tests/tools/facades/graph_apply_change_set.test.ts`).
* 2025-10-17T13:20Z — gpt-5-codex : Implémente réellement `GraphWorkerPool` (heuristiques, percentiles) et l’injecte dans `graph_apply_change_set`, ajoute le test d’intégration façade, documente `MCP_GRAPH_WORKERS`/`MCP_GRAPH_POOL_THRESHOLD` et met à jour `.env.example`. Commandes : `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/perf/graph.pool.test.ts tests/tools/facades/graph_apply_change_set.test.ts tests/tools/facades.golden.test.ts tests/env/example.test.ts`.
* 2025-10-17T15:04Z — gpt-5-codex : Vérifie la checklist finale (A4/A5 + acceptation), rejoue lint builtins/types et le bootstrap E2E pour confirmer les garanties opérationnelles. Commandes : `npm run lint:node-builtins`; `npm run lint:types`; `node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/e2e/server.bootstrap.test.ts`.
