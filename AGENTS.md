----------
Voici un plan d’action exhaustif, adressé à un agent IA, basé sur les analyses précédentes et sur la structure du dépôt. Il liste précisément ce qu’il faut **corriger / ajouter / supprimer / modifier**, avec des **sous-étapes hiérarchisées** et des **objectifs clairs**. Les chemins et fichiers mentionnés suivent la cartographie que tu as sous les yeux.

# Brief à l’agent (objectifs et contraintes)

**Objectif principal**
Mettre l’orchestrateur au “niveau prod” en complétant le **statut des jobs de recherche** (`search.status`) avec persistance durable et instrumentation, sans régression sur : transports, outils MCP, idempotence, budgets, mémoire, graphes, observabilité.

**Objectifs secondaires (robustesse & DX)**

* Verrouiller la **reproductibilité** (idempotence + `validation_run/`) et la **sécurité par défaut** (auth, redaction, rate-limits).
* Couvrir les bords opérationnels via des **tests unitaires**, **property-based** et **E2E** (HTTP + STDIO).
* S’assurer que le **build** produit les artefacts `graph-forge/dist/*` et n’importe **pas** de `.ts` en runtime prod.

**Contraintes tests & build (à respecter strictement)**

* **TypeScript strict** avec `exactOptionalPropertyTypes`; **aucune** clé `undefined` en JSON (omission > `undefined`).
* **Node** : `>= 20 < 21`, **npm >= 9`.
* Runner tests : **mocha/chai** + **fast-check** (pour propriétés).
* Lint : **ESLint (flat)** + **Prettier** + **commitlint** (CI doit échouer si non conforme).
* Build : `npm run build` compile `src/` **et** `graph-forge/` ; aucune importation de `.ts` en prod hors bundler/loader dédié.
* Dossier d’artefacts : **`validation_run/`** — création contrôlée, quotas et redaction actifs dans les tests E2E.
* **Sécurité** : HTTP off par défaut, Bearer requis si on l’active, rate-limits actifs (généraux + spé “search”).
* **Idempotence** : clés stables, TTL configurable, tests de concurrence.

---

# Checklist à cocher — par fichiers (avec sous-étapes)

## 1) Module Search — statut des jobs & persistance

### 1.1 `src/search/jobStore.ts` — **Nouveau**

* [x] Définir l’**interface** `SearchJobStore` :

  * [x] `create(job: JobMeta): Promise<void>`
  * [x] `update(jobId: string, patch: Partial<JobState>): Promise<void>`
  * [x] `get(jobId: string): Promise<JobRecord | null>`
  * [x] `list(filter?: ListFilter): Promise<JobRecord[]>` (par statut/âge/tag)
  * [x] `gc(now: number): Promise<number>` (retourne nb d’entrées purgées)
* [x] Types : `JobMeta` (id déterministe, query normalisée, budget), `JobState` (`pending|running|completed|failed`, timestamps, résumé, erreurs), `JobRecord` (meta + state + provenance).
* [x] Invariants : id non-vide, horodatages croissants, état terminal immuable.

### 1.2 `src/search/jobStoreMemory.ts` — **Nouveau**

* [x] Implémentation **in-memory** (Map) conforme à l’interface.
* [x] **RW-lock** ou section critique (Node single-thread, mais anticiper worker threads).
* [x] `gc` par TTL (env, défaut 7j).

### 1.3 `src/search/jobStoreFile.ts` — **Nouveau**

* [x] Persistance **JSONL** sous `validation_run/search/jobs/`.
* [x] Écriture **append-only** + **index en mémoire** pour lecture rapide.
* [x] **fsync** optionnel derrière un batcher (env) pour amortir IO.
* [x] **Lock de fichier** best-effort (advisory lock) pour éviter corruption concurrente.
* [x] `gc` : création d’un **segment** compacté (nouveau fichier) puis **swap atomique**.

### 1.4 `src/search/index.ts` — **Modifier**

* [ ] **Injection** du `SearchJobStore` (via `serverOptions`/DI).
* [ ] Émission d’événements `search:job_created`, `search:job_started`, `search:job_progress`, `search:job_completed|failed`.
* [ ] Si idempotence “hit”, **ne pas recréer** le job, mais renvoyer le `job_id` existant.

### 1.5 `src/search/pipeline.ts` — **Modifier**

* [ ] **Hook** en début : `create(job)` + état `pending → running`.
* [ ] **Étapes** : Searx → download → extract → ingest → synthèse (résumé, métriques p50/p95/p99).
* [ ] **Mises à jour partielles** (`update`) après chaque phase avec timestamps.
* [ ] **Finalisation** : `completed` (résumé + artefacts) ou `failed` (pile d’erreurs redacted).
* [ ] **Idempotence** : si doc déjà ingéré, marquer `skipped: true` dans le résumé.

### 1.6 `src/tools/search_status.ts` — **Créer ou compléter**

* [ ] Exposer MCP `search.status`:

  * [x] Entrées : `job_id` **ou** filtres (`status`, `tag`, `since`, `limit`).
  * [x] Sorties : `JobRecord | JobRecord[]`, sans `undefined`.
  * [x] Validation **zod** stricte, messages d’erreur JSON-RPC normalisés.

### 1.7 `src/serverOptions.ts` — **Modifier**

* [ ] Ajouter variables :

  * [x] `MCP_SEARCH_STATUS_PERSIST` (`memory|file`, défaut `file`).
  * [x] `MCP_SEARCH_JOB_TTL_MS` (défaut 7 jours).
  * [x] `MCP_SEARCH_JOURNAL_FSYNC` (`always|interval|never`, défaut `interval`).
* [x] Charger/valider ces options et **instancier** le `JobStore` correspondant.

### 1.8 `src/http/readiness.ts` — **Modifier**

* [x] Vérifier **writability** du dossier `validation_run/search/jobs/` **si** store fichier actif.
* [x] Renvoyer `reason` explicite si échec.

### 1.9 `src/monitor/dashboard.ts` — **Modifier**

* [ ] Ajouter un **pane “Search Jobs”** : top N récents, filtres par statut, SSE en direct.
* [ ] Lier aux artefacts sous `validation_run/`.

### 1.10 Tests search/status

* [x] `tests/search/jobStore.memory.spec.ts` — unitaire

  * [ ] CRUD, transitions valides/invalides, TTL/GC, concurrence simulée.
* [x] `tests/search/jobStore.file.spec.ts` — unitaire

  * [x] Append-only, recovery après crash (relecture JSONL), compaction, lock.
* [x] `tests/search/status.tool.spec.ts` — unitaire (zod + shapes)
* [ ] `tests/search/run-status.e2e.spec.ts` — E2E

  * [ ] `search.run` → `search.status(job_id)` jusqu’à `completed`.
  * [ ] Cas idempotence (deuxième `run` retourne le même `job_id`).
  * [ ] Mode HTTP (auth Bearer) **et** STDIO.

---

## 2) Transports HTTP, Auth & Rate-limit

### 2.1 `src/http/rateLimit.ts` — **Modifier**

* [ ] **Seau dédié** “search” distinct du global (RPS + burst séparés).
* [ ] En-tête de réponse `X-RateLimit-*` (global & search si pertinent).
* [ ] Tests : `tests/http/rateLimit.search.spec.ts` (E2E burst → 429 contrôlé).

### 2.2 `src/http/auth.ts` — **Revue**

* [ ] Comparaison **constant-time** (déjà présente) + tests sur cas bizarres (espaces, casing).
* [ ] `tests/http/auth.bearer.spec.ts`.

### 2.3 `src/http/readiness.ts` — **Compléments**

* [ ] Inclure dans `/readyz` : état JobStore, état `graph-forge` chargé, permission d’écriture artefacts.
* [ ] `tests/http/readyz.spec.ts`.

---

## 3) Idempotence, budgets & concurrence

### 3.1 `src/infra/idempotency*.ts` — **Revue/Compléments**

* [ ] Tests de **collision** volontaire d’ID (normalisation d’URL stricte).
* [ ] TTL expiré → suppression contrôlée (logs + artefacts conservés).
* [ ] `tests/infra/idempotency.cases.spec.ts`.

### 3.2 `src/search/downloader.ts` — **Tests supplémentaires**

* [ ] Canonicalisation d’URL : suppression `utm_*`, `fbclid`, tri des query params.
* [ ] **MIME-sniff** par signature binaire (PDF/JPEG/PNG/ZIP) — tests sur fixtures.
* [ ] Respect **robots.txt** si activé : `tests/search/robots.spec.ts`.

### 3.3 `src/infra/budget.ts` — **Revue**

* [ ] Budgets temps / tool_calls / bytes_out appliqués à `search.run`.
* [ ] Tests property-based : ne jamais dépasser **bytes_out** en cas d’erreur multiligne.

---

## 4) Mémoire (vecteur + KG) & RAG

### 4.1 `src/memory/vectorMemory.ts` — **Modifier**

* [ ] Paramétrer capacité via `MCP_MEMORY_VECTOR_MAX_DOCS` (défaut 4096).
* [ ] Politique d’éviction **documentée** (LRU/Size), logs d’éviction.
* [ ] `tests/memory/vector.capacity.spec.ts` (saturation contrôlée).

### 4.2 `src/memory/retriever.ts` — **Revue**

* [ ] Retrievers hybrides (cosinus + lexical/BM25 si activé) — tests de **rangs** stables.
* [ ] `tests/memory/retriever.hybrid.spec.ts`.

### 4.3 Outils RAG : `src/tools/ragTools.ts` — **Tests**

* [ ] `rag_ingest`/`rag_query` conservent **provenance** et **tags**.
* [ ] Aucune fuite d’`undefined` ; `tests/tools/rag.tools.spec.ts`.

---

## 5) Graphes & Graph-Forge

### 5.1 `graph-forge/` — **Build & loader**

* [ ] Vérifier que `npm run build` produit **`graph-forge/dist/index.js`** + maps.
* [ ] **Interdire** l’import direct de `graph-forge/src/*.ts` en prod (fallback testé seulement en dev).
* [ ] `tests/graph/loader.spec.ts` : échoue si `dist/` absent en prod.

### 5.2 `src/graph/validate.ts`, `src/graph/state.ts`, `src/graph/tx.ts` — **Tests**

* [ ] Invariants (acyclicité si requise, contraintes métier), **WAL/Tx** atomicité.
* [ ] Snapshots périodiques : respect `MCP_GRAPH_SNAPSHOT_*`.
* [ ] `tests/graph/invariants.spec.ts`, `tests/graph/tx.atomicity.spec.ts`.

### 5.3 Outils graph : `src/tools/graph_*` — **Tests**

* [ ] `graph_apply_change_set`, `graph_snapshot_time_travel`, `graphDiffTools` — E2E sur petit graphe.
* [ ] Export **Mermaid/DOT/GraphML** valide (fichiers sous `validation_run/graphs/*`).

---

## 6) Outils MCP & Router

### 6.1 `src/tools/tools_help.ts` — **Modifier**

* [ ] Afficher `search.status` (nouveau) dans la liste d’aide.
* [ ] Tests : `tests/tools/help.spec.ts` (contient le nouvel outil).

### 6.2 `src/tools/toolRouter.ts` — **Revue**

* [ ] Router top-k : priorité aux outils `search.*` pour requêtes web ; tests de **routing**.

---

## 7) Enfants/Agents & Autoscaler

### 7.1 `src/agents/autoscaler.ts` — **Tests**

* [ ] Seuils de latence/backlog -> variations de taille de pool bornées.
* [ ] Hystérésis pour éviter oscillations ; `tests/agents/autoscaler.spec.ts`.

### 7.2 `src/guard/loopDetector.ts` — **Tests**

* [ ] Détection faux positifs/faux négatifs sur chaînes d’événements contrôlées.

---

## 8) Observabilité & Redaction

### 8.1 `src/logger.ts` — **Tests**

* [ ] Redaction de secrets (Authorization, Cookie, tokens) + **motifs custom** via `MCP_LOG_REDACT`.
* [ ] `tests/infra/logger.redaction.spec.ts`.

### 8.2 `src/eventStore.ts`, `src/monitor/*` — **Tests**

* [ ] SSE buffer circulaire, reprise en **replay** depuis offset.
* [ ] `tests/monitor/sse.replay.spec.ts`.

---

## 9) Artefacts & Validation-run

### 9.1 `src/tools/artifact_*` — **Revue/Tests**

* [ ] `artifact_write` respecte `MCP_MAX_ARTIFACT_BYTES` (erreur cohérente si dépassement).
* [ ] Parcours `artifact_paths` ne fuit pas en dehors de `validation_run/`.
* [ ] `tests/tools/artifact.safety.spec.ts`.

### 9.2 `docs/validation-run-*.md` — **Doc**

* [ ] Ajouter section **“search jobs journal”** (layout JSONL, compaction, TTL).
* [ ] Lien croisé avec `/readyz`.

---

## 10) Configuration & DX

### 10.1 `.env.example` — **Modifier**

* [x] Ajouter : `MCP_SEARCH_STATUS_PERSIST`, `MCP_SEARCH_JOB_TTL_MS`, `MCP_SEARCH_JOURNAL_FSYNC`.
* [x] Ajouter commentaires clairs (valeurs par défaut, implications).

### 10.2 `package.json` — **Vérifier/Modifier**

* [ ] `build` compile **`graph-forge/`** (tsc séparé ou references).
* [ ] Scripts utiles : `start:stdio`, `start:http`, `start:dashboard`, `test`, `lint`, `format`.
* [ ] Champs `engines` : Node 20.x, npm 9+ (déjà présents ; réaffirmer).

### 10.3 CI (workflow) — **Créer/Modifier**

* [ ] Jobs : **lint → build → test** (unit + e2e), cache npm.
* [ ] Matrice : Linux Node 20.x.
* [ ] Échec si : imports `.ts` en prod, `undefined` détecté dans JSON serialisé (test script dédié).

---

## 11) Sécurité HTTP (exposition optionnelle)

### 11.1 `src/http/bootstrap.ts` — **Revue**

* [ ] **Stateless** option gérée ; en-têtes de sécurité (no-sniff, frame-ancestors, etc.).
* [ ] `tests/http/headers.spec.ts`.

---

## 12) Scénarios de bout en bout (régression)

### 12.1 `scenarios/search_rag_baseline.yaml` — **Nouveau**

* [ ] Pipeline : `search.run` → ingestion → `rag_query` → assertions (top-k non vide, provenance).
* [ ] Générer rapport sous `validation_run/scenarios/search_rag_baseline/`.

### 12.2 `tests/e2e/scenarios.search_rag.spec.ts` — **E2E**

* [ ] Exécuter la campagne, vérifier artefacts & métriques (p50/p95/p99 présents).

---

# Définition de la “done-ness” (acceptation)

* [ ] `search.status` disponible et documenté ; **JobStore** mémoire + fichier opérationnels.
* [ ] `/readyz` échoue proprement si le journal de jobs n’est pas inscriptible.
* [ ] **Aucune** importation `.ts` de `graph-forge` en prod ; `dist/` requis par tests.
* [ ] Tous les nouveaux tests passent (unit, property-based, E2E HTTP & STDIO).
* [ ] **Aucune** fuite de secrets en logs ; **aucun** `undefined` dans les JSON émis.
* [ ] Build reproductible ; artefacts dans `validation_run/` conformes (chemins, tailles, redaction).
* [ ] L’outil `tools_help` affiche `search.status`.
* [ ] CI verte sur lint/build/tests ; rate-limits “search” en vigueur (tests 429).

---

# Notes d’implémentation (raccourcis utiles)

* **ID de job** : dériver d’une concaténation stable `(normalizedQuery + options + searxCategory + timestampFloor)` → hash (ex. xxhash/sha256) **après** canonicalisation des URLs cibles si incluse.
* **Journal JSONL** : lignes immuables, `update` = append d’un patch horodaté ; **compaction** recrée le dernier état par job.
* **Redaction** : appliquer aux messages d’erreur de `downloader`/`extractor` (en-têtes HTTP, URLs avec tokens).
* **Tests E2E** : préférer entrées “no-network” en mock/sandbox lorsque possible ; si SearxNG local, fixer une fixture d’index.

---

Ce plan te donne le périmètre, les fichiers exacts à toucher, et l’ordre logique pour livrer sans régression : **Search Job Status d’abord**, puis **tests & readiness**, ensuite **robustesse & DX**. Une fois le lot 1 validé, on verrouille les lots 2–4 en itérant sur la CI.

---

### Historique

- 2025-11-02 : ✅ Interface `SearchJobStore` + implémentation mémoire (mutex, TTL) + tests unitaires (`tests/unit/search/jobStore.memory.test.ts`) ; commandes `npm run build` puis `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/jobStore.memory.test.ts`.
- 2025-11-02 : ✅ Implémentation `FileSearchJobStore` (journal JSONL, fsync batch, lock best-effort, compaction TTL) + export public + tests unitaires (`tests/unit/search/jobStore.file.test.ts`).
- 2025-11-02 : ✅ Façade `search.status` (filtres, sérialisation des JobRecord, erreurs persistences) + options `MCP_SEARCH_*` et DI runtime (`loadSearchJobStoreOptions`, `instantiateSearchJobStore`) + tests (`tests/serverOptions.parse.test.ts`, `tests/search/status.tool.test.ts`) ; commandes `npm run build` puis `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/serverOptions.parse.test.ts tests/search/status.tool.test.ts`.
- 2025-11-02 : ✅ Readiness HTTP enrichi (vérification du journal search, snapshot runtime) + variables `.env.example` documentées ; tests `tests/http/readyz.test.ts`, `tests/http/bootstrap.runtime.test.ts`, build `npm run build`.
