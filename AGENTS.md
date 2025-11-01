## 🎯 Brief (lis-moi d’abord)

**Objectifs attendus**

1. Renforcer la **robustesse** du moteur Search (SearxNG → fetch → unstructured → normalisation → KG/Vector), réduire la dette (URLs canonisées, sniff MIME, conditional GET, NFC), consolider les **erreurs typées** et la **télémétrie**.
2. **Unifier la journalisation**: n’avoir **qu’un seul** dossier de validation (`validation_run` **ou** `validation_runs`) et y consigner **100%** des artefacts d’exécutions.
3. Garder l’**infra SearxNG** self-host et Unstructured opérationnelles, sans régression.
4. **Tests** solides (unit/int/E2E) et **build** strict (TS strict, `exactOptionalPropertyTypes`, Node ≥ 20), **zéro `undefined`** dans les JSON publics.

---

## 🧱 Contraintes build & tests (à respecter partout)

* **Node ≥ 20** obligatoire (ESM, `fetch` natif, `AbortController`).
* **TypeScript strict** + `exactOptionalPropertyTypes: true`. Tous les retours JSON publics **omettent** les clés absentes (ne jamais renvoyer `undefined`).
* **Erreurs typées** : `{ code: string; message: string; details?: unknown }`.
* **Logs** via logger structuré (pas de `console.*`) avec **redaction** des secrets.
* **Budgets/Timeouts** outillés dans les Tools MCP ; **idempotence** (clé de requête stable).
* **Tests** : mocks réseaux (`nock`), **sans sleeps**, fake timers si nécessaire ; snapshots **stabilisés** (strip des timestamps/`fetchedAt`/`tookMs`).
* **Couverture**: ≥ **90%** sur `src/search/**`, ≥ **85%** global.

---

## A) Infrastructure SearxNG & Unstructured (vérif + petites retouches)

* [x] `docker/docker-compose.search.yml`

  * [x] Vérifier que les services `searxng`, `unstructured`, `server` ont des **healthchecks** stables (timeout raisonnables, retries).
  * [x] Confirmer le **réseau privé** `search_net` et les **limites CPU/RAM** en CI.
  * [x] (Si absent) commenter **clairement** l’usage ou non du `result_proxy`.

* [x] `docker/searxng/settings.yml`

  * [x] Repasser sur la **liste d’engines** activés (retirer ceux non pertinents/licences douteuses).
  * [x] S’assurer que **categories** incluent au minimum `general,news,images,files`.
  * [x] Documenter `safe_search` (0 en dev, 1 en prod si besoin).

* [x] `env/.env.example`

  * [x] Vérifier la présence et les defaults de :

    * [x] `SEARCH_SEARX_BASE_URL`, `SEARCH_SEARX_API_PATH=/search`, `SEARCH_SEARX_TIMEOUT_MS`
    * [x] `SEARCH_SEARX_ENGINES`, `SEARCH_SEARX_CATEGORIES`
    * [x] `UNSTRUCTURED_BASE_URL`, `UNSTRUCTURED_TIMEOUT_MS`, `UNSTRUCTURED_STRATEGY`
    * [x] `SEARCH_FETCH_TIMEOUT_MS`, `SEARCH_FETCH_MAX_BYTES`, `SEARCH_FETCH_UA`
    * [x] `SEARCH_INJECT_GRAPH`, `SEARCH_INJECT_VECTOR`
    * [x] `SEARCH_FETCH_RESPECT_ROBOTS` (mettre **true** en prod recommandée)
    * [x] `SEARCH_PARALLEL_FETCH`, `SEARCH_PARALLEL_EXTRACT`, `SEARCH_MAX_RESULTS`

---

## B) Normalisation et téléchargement — **noyau Search** (fichier par fichier)

### `src/search/searxClient.ts`

* [x] **Canonicalisation d’URL (NOUVEAU)**

  * [x] Avant toute déduplication :

    * [x] retirer `#fragment`.
    * [x] supprimer les paramètres **tracking** (`utm_*`, `ref`, `fbclid`, etc.).
    * [x] **trier** alphabétiquement les query params restants.
  * [x] Mapper au client les champs **hétérogènes** → `publishedAt`, `mime` (faire la **conversion ici**).
* [x] **Retry sélectif + backoff**

  * [x] Retries sur `429/502/503/504` uniquement, **pas** sur `4xx` classiques.
  * [x] **Jitter** dans le backoff.
* [x] **Timeout** via `AbortController` (déjà en place) → vérifier les chemins d’erreur.
* [x] **Tests**

  * [x] Ajouter des cas sur **canonicalisation** (`utm_*`, fragments, ordre des params).
  * [x] Tests retries (1–2 tentatives) et abort.

### `src/search/downloader.ts`

* [x] **Streaming + coupe dure** (déjà présent) → **ajouter** un **sniff MIME par signature** :

  * [x] PDF `%PDF-`, JPEG `\xFF\xD8`, PNG `\x89PNG`, ZIP `PK\x03\x04` (au minimum).
  * [x] Utiliser ce sniff uniquement si `content-type` **absent/incohérent**.
* [x] **Conditional GET (NOUVEAU)**

  * [x] Si `ETag` ou `Last-Modified` connus pour l’URL : envoyer `If-None-Match` / `If-Modified-Since`.
  * [x] Si 304 : retourner proprement un objet `RawFetched` **annoté** (`notModified: true`) et **éviter** de repasser l’extraction.
* [x] **DocId stable**

  * [x] Fallback si pas d’`ETag`/`LM` : hash `(url + premier 1KB de contenu)` pour stabiliser.
* [x] **Tests**

  * [x] Cas **MIME trompeur** : header `text/html` mais PDF réel → sniff détecte PDF.
  * [x] Cas **304** : ETag/LM produisent un non-téléchargement, pipeline respecte `notModified`.

### `src/search/extractor.ts`

* [x] **Chemin unique** d’appel Unstructured (déjà OK) → **passer la langue détectée comme hint** quand dispo.
* [x] **Cap de pages PDF** (NOUVEAU)

  * [x] Si `contentType=application/pdf` et doc volumineux → extraire **max N pages** (ex. 40) et poser `metadata.truncated=true`.
* [x] **Tests**

  * [x] Cas PDF long : assert `truncated=true`.
  * [x] Mapping segments complet (title/list/table/figure/caption/code).

### `src/search/normalizer.ts`

* [x] **Unicode NFC (NOUVEAU)**

  * [x] `text = text.normalize('NFC').replace(/\s+/g,' ').trim()` **avant** hash & dédup.
* [x] **Dédup par hash**

  * [x] Clé = `kind + '|' + hash(text_normalized)` (pas de clés immenses en RAM).
* [x] **Titre fallback**

  * [x] Si `doc.title` vide, utiliser **le 1er segment `kind='title'`**.
* [x] **Tests**

  * [x] Cas accents combinés (NFD) vs NFC → doivent dédupliquer.
  * [x] Cas titres absents → fallback depuis segment.

---

## C) Ingestion KG / Vector

### `src/search/ingest/toKnowledgeGraph.ts`

* [x] **Débouncer local** (Set) sur `(s,p,o)` avant `upsertTriple`.
* [x] **Mentions**

  * [x] Stoplist FR/EN **réutilisable** dans le fichier, `minLength≥3`, `minFreq≥2`.
* [x] **Tests**

  * [x] Triples **non dupliqués** dans une même run.
  * [x] Mentions filtrées (peu de bruit).

### `src/search/ingest/toVectorStore.ts`

* [x] **Chunking “titre + paragraphe” (NOUVEAU)**

  * [x] Si un `title` < 10 tokens est immédiatement suivi d’un `paragraph`, **fusionner** (chunk plus informatif).
* [x] **Skip des doublons successifs** (hash des chunks).
* [x] **Metadata** : `language` forcée en **lower-case**.
* [x] **Tests**

  * [x] Vérifier fusion titre+para.
  * [x] Vérifier skip chunk dupliqué N/N+1.
  * [x] Vérifier `metadata.language` en lower-case.

---

## D) Orchestration, Events & Télémétrie

### `src/search/pipeline.ts`

* [x] **Concurrence contrôlée**

  * [x] Utiliser le **semaphore/p-limit existant** pour `fetch` et `extract` (éviter les bursts).
* [x] **Taxonomie des erreurs** (stabiliser)

  * [x] `network_error | robots_denied | max_size_exceeded | extract_error | ingest_error`.
* [x] **jobId**

  * [x] Générer `jobId = hash(arguments)` ; **inclure** dans `search:*` events et résultats Tools.
* [x] **Events légers**

  * [x] Ne pas embarquer de payload volumineux (segments) dans `eventStore.emit`.
* [x] **Tests**

  * [x] `allSettled` sur batchs ; erreurs classées ; `jobId` propagé ; événements ordonnés.

### `src/search/metrics.ts`

* [x] **Labels stables**

  * [x] `{ step, contentType, domain }` (**jamais l’URL**).
* [x] **Buckets** log-échelle (50ms → 20s).
* [x] **Tests**

  * [x] Vérifier l’enregistrement de chaque étape (searx/fetch/extract/ingest*).

---

## E) Tools MCP & Registry

### `src/tools/search_run.ts`

* [x] **Schéma strict**

  * [x] zod `.strict()` + defaults (`maxResults.default(6)`).
* [x] **Sortie stable**

  * [x] `{ ok:true, jobId, count, docs, warnings? }` → `warnings` **omis** si vide.
  * [x] **Propager** `budgetUsed` si dispo, sans dépasser `bytesOut`.
* [x] **Tests**

  * [x] Snapshot **après strip** des champs volatils.

### `src/tools/search_index.ts`

* [x] **Normaliser l’input**

  * [x] `url` string **→** `urls: string[]`.
* [x] **Partials**

  * [x] Retour `{ ok:true, docs, errors? }` (omets si vide).
* [x] **Tests**

  * [x] Cas multi-URL, plus une qui échoue → `errors` présent, `docs` partiels.

### `src/tools/search_status.ts`

* [x] **Not implemented typé**

  * [x] `{ ok:false, code:'not_implemented', message:'...' }`.
* [x] **Tests**

  * [x] Snapshot stable.

### `src/mcp/registry.ts` (ou le routeur central si ailleurs)

* [x] **Tags & budgets**

  * [x] `tags: ['search','web','ingest','rag']`.
  * [x] Élargir `timeMs` (ex. 90s) si gros PDFs.
* [x] **Help concis**

  * [x] Un **exemple JSON** **monoligne** par tool.

---

## F) EventStore & Dashboard

### `src/eventStore.ts`

* [x] **Versionner** `payload` des `search:*` : `payload.version = 1`.
* [x] **Tronquer** `error.message` > 1000 chars.
* [x] **Sérialisation stable** (ordre des clés si ton diff tooling le requiert).
* [x] **Tests**

  * [x] Vérifier redaction et taille max.

### `src/monitor/dashboard.ts`

* [x] **Debounce SSE** 250–500ms si rafales.
* [x] **Cap Top domaines** (ex. top 20).
* [x] *(Optionnel)* endpoint `/api/search/summary` JSON si besoin scripting.
* [x] **Tests**

  * [x] Rend correctement avec un grand nombre d’événements.

---

## G) Knowledge & Memory

### `src/knowledge/knowledgeGraph.ts`

* [x] **Idempotence locale** lors d’un même run (Set) pour `(s,p,o)`.
* [x] **Provenance** : éviter les duplications identiques sur `withProvenance`.
* [x] **Tests**

  * [x] Triple identique dans une même transaction → 1 seule écriture.

### `src/memory/vector.ts`

* [x] **Cap par doc** (si déjà présent, s’assurer qu’il s’applique aux runs Search).
* [x] **Metadata** : verifier `docId` non vide, langue lower-case.
* [x] **Tests**

  * [x] Respect du cap ; recherche par similarité fonctionne.

---

## H) Scripts & exécution

### `scripts/setup-environment.mjs` (ou `scripts/setup-agent-env.sh`)

* [x] **Fail fast Node ≥ 20** (arrêter si version trop basse).
* [x] **Warn** si `SEARCH_SEARX_BASE_URL` ou `UNSTRUCTURED_BASE_URL` **absents**.
* [x] **Dossiers runtime** : créer `./validation_run` (ou variante retenue) + `./children`.
* [x] **Pointer les logs** par défaut sur `./validation_run/logs/self-codex.log`.
* [x] **Supprimer** toute référence obsolète à `START_MCP_BG` si réellement non utilisée (sinon documenter). *(Toujours utilisée pour l'orchestration en arrière-plan — documentation ajoutée dans `docs/validation-run-runtime.md`.)*

### `scripts/run-search-e2e.ts` / `scripts/run-search-smoke.ts` / `scripts/validate-run.mjs`

* [x] Remplacer **toute écriture** vers des chemins historiques (`runs/…`) par le **dossier de validation retenu** (voir section I).
* [x] Créer systématiquement `input.json`, `response.json`, `events.ndjson`, `timings.json`, `errors.json`, `kg_changes.ndjson`, `vector_upserts.json`, `server.log` dans **chaque scénario**.
* [x] **Tests**: adapter les assertions de chemins.

---

## I) **Unification du dossier de validation** (IMPORTANT)

* [x] **Choisir** la convention finale :

  * [x] **Option A** : `validation_run/` (singulier)
  * [ ] **Option B** : `validation_runs/` (pluriel) *(n/a après migration)*
    → **Choisis une seule et unique** option.

* [x] **Supprimer le doublon**

  * [x] Si tu gardes `validation_run/` :

    * [x] **Déplacer/merger** tout le contenu utile de `validation_runs/` vers `validation_run/`.
    * [x] **Supprimer** le dossier `validation_runs/`.
  * [ ] Si tu gardes `validation_runs/` :

    * [ ] **Déplacer/merger** `validation_run/` → `validation_runs/`.
    * [ ] **Supprimer** `validation_run/`.

* [ ] **Rendre cohérents** tous les pointeurs

  * [x] Mettre à jour `MCP_RUNS_ROOT` dans `.env.example` et dans les **scripts** pour viser **le dossier retenu**.
  * [x] Rechercher/remplacer dans le code/tests/doc : références à l’ancien nom (aucune occurrence restante en dehors de cette tâche).
  * [x] **Vérifier** en E2E qu’**100%** des artefacts sont produits dans le dossier conservé.

* [x] **Tests**

  * [x] Mettre à jour les tests qui valident la présence des fichiers de run (chemins).
  * [x] Ajouter un test de **non-existence** de l’ancien dossier après la migration.

---

## J) Tests supplémentaires / durcissement

* [x] **Unitaires**

  * [x] searxClient : propriété **canonicalisation** (jeu de paramètres générés), retries, abort.
  * [x] downloader : sniff signatures, conditional GET (304), clamp taille.
  * [x] extractor : `truncated=true` sur PDF gros, mapping complet.
  * [x] normalizer : NFC, dédup hash, fallback titre.
  * [x] ingest KG/Vector : debounce triples, fusion titre+para, skip chunk dupliqué.
  * [x] pipeline : error kinds, jobId, events légers, `allSettled`.

* [x] **Intégration**

  * [x] `search.run` avec mocks réseaux : vérifier docs ingérés, erreurs **classées**, `jobId` dans la réponse.

* [x] **E2E**

  * [x] Compose up, exécuter au moins S01 / S05 / S06, vérifier **idempotence**, **robots/size**, et **artefacts** sous le **dossier de validation choisi**.

* [x] **Couverture**

  * [x] Vérifier ≥90% sur `src/search/**`, ≥85% global.
  * [x] Stabiliser les snapshots (strip des champs volatils).

---

## K) Documentation & Changelog

* [x] `docs/search-module.md`

  * [x] Ajouter un **encadré** sur la canonicalisation d’URL, le sniff MIME et le conditional GET.
  * [x] Préciser la **convention retenue** du dossier de validation et les **fichiers attendus**.

* [x] `CHANGELOG.md`

  * [x] Entrée `improvement: search robustness (URL canonicalization, MIME sniff, conditional GET, NFC); validation folder unified`.

---

## ✅ Critères d’acceptation (avant close)

* [x] Build **OK** (Node ≥ 20, TS strict, aucun warning notable).
* [x] `search.run` (S01) : ≥ 1 doc ingéré, embeddings présents, events `search:*`, artefacts complets dans le **dossier de validation retenu**.
* [x] S05 (replay) : **zéro duplication** (mêmes `docId`).
* [x] S06 (robots/size) : erreurs **classées** et non bloquantes.
* [x] Dashboard : métriques par étape (searx/fetch/extract/ingest*) cohérentes, labels stables.
* [x] **Un seul** dossier de validation dans le repo (l’autre **supprimé**), tous scripts & tests **pointent** dessus.
* [x] Couverture atteinte (≥90% `src/search/**`, ≥85% global).

---

Si tu veux, je peux ensuite te fournir un **patch groupé** (diff par fichier) appliquant exactement ces changements, et un **script unique** qui exécute S01→S10 et consolide `summary.json` dans **le** dossier de validation retenu.

---

### Historique

- 2025-10-31 : ✅ Downloader sniff MIME + conditional GET (304 annoté) + commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/downloader.test.ts`.
- 2025-10-31 : ✅ README.md et docs/mcp-http-troubleshooting.md alignés sur la convention `validation_run/` (suppression des références `runs/`).
- 2025-10-31 : ✅ `npm run test -- tests/validation-runs.response-summary.test.ts` exécuté (build + typecheck + suite complète).
- 2025-10-31 : ✅ Tests unitaires `searxClient` étendus (canonicalisation, non-retry 4xx, timeout abort) + commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/searxClient.test.ts`.
- 2025-10-31 : ✅ Pipeline `jobId` haché + taxonomie d'erreurs stabilisée + façades `search.run`/`search.index` retournant le nouvel identifiant ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/pipeline.test.ts tests/tools/facades/search_run.test.ts tests/tools/facades/search_index.test.ts`.
- 2025-10-31 : ✅ Extractor langue hint + cap PDF stabilisé (segments overflow ignorés) ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/extractor.test.ts`.
- 2025-10-31 : ✅ Normalizer NFC + hash de dédup + fallback titre ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/normalizer.test.ts`.
- 2025-10-31 : ✅ Ingestion KG dédoublée (Set) + vector store fusion titre/paragraphe validées ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/ingest.toKnowledgeGraph.test.ts tests/unit/search/ingest.toVectorStore.test.ts`.
- 2025-10-31 : ✅ Pipeline p-limit + façades search.* (snapshots + meta help) ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/pipeline.test.ts tests/tools/facades/search_run.test.ts tests/tools/facades/search_index.test.ts tests/tools/facades/search_status.test.ts`.
- 2025-10-31 : ✅ Script setup-environment → dossiers runtime `validation_run/` + `children/`, valeur par défaut `MCP_LOG_FILE`, avertissements Searx/Unstructured ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/scripts.setup-environment.test.ts`.
- 2025-10-31 : ✅ EventStore payload versionné + troncature message `search:error` validées ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/eventStore.test.ts`.
- 2025-10-31 : ✅ Search metrics labels `{step,contentType,domain}` + SSE broadcast debounce testés ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/metrics.test.ts tests/monitor.dashboard.streams.test.ts`.
- 2025-11-02 : ✅ Migration automatique `validation_runs/` → `validation_run/`, documentation des gardes (canonicalisation, sniff MIME, conditional GET) et ajout du test de non-régression ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/validationRun.layout.test.ts`.
- 2025-11-02 : ✅ Intégration `search.run` (pipeline réel + mocks réseau) couvrant ingestion, avertissements typés et `jobId` déterministe ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/integration/search/search_run.integration.test.ts`.
- 2025-11-02 : ✅ Garde d’idempotence `(s,p,o)` pour le Knowledge Graph + tests `withProvenance` renforcés, couverture vectorielle sur `document_id`/`docId` et docId vide ignoré ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/knowledge/knowledgeGraph.test.ts tests/unit/memory/vector.test.ts`.
- 2025-11-02 : ✅ Ajout du test de charge `monitor/dashboard` garantissant le cap des domaines top 20 et la stabilité des métriques search ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/monitor.dashboard.streams.test.ts`.
- 2025-11-02 : ✅ Scripts `run-search-e2e.ts` et `run-search-smoke.ts` persistants vers `validation_run/` (artefacts complets) + helper `scripts/lib/searchArtifacts.ts` + test `searchArtifacts`; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/scripts/searchArtifacts.test.ts`.
- 2025-11-02 : ✅ Santé `docker-compose.search.yml` (healthcheck Node pour `server`, réseau interne, proxy documenté) + env defaults Searx alignés (`mojeek`, robots.txt) ; commande `npm run test -- tests/scripts.setup-environment.test.ts`.
- 2025-11-02 : ✅ Test e2e artefacts (`S91_search_e2e`) garantissant l'écriture complète sous `validation_run/` ; commande `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/scripts.run-search-e2e.test.ts`.
- 2025-11-02 : ✅ E2E pipeline `search_run.e2e` couvrant ingestion S01, idempotence S05 (docIds stables, KG sans duplication) et erreurs robots/taille S06 ; commande `TSX_EXTENSIONS=ts SEARCH_E2E_ALLOW_RUN=1 MCP_TEST_ALLOW_LOOPBACK=yes node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/e2e/search/search_run.e2e.test.ts`.

- 2025-11-02 : ✅ Couverture complète (`npm run coverage`) confirmant ≥90 % sur `src/search/**`, ≥85 % global et snapshots stables ; commande `npm run coverage`.
- 2025-11-02 : ✅ Documentation de `START_MCP_BG` (mise à jour scripts/setup-agent-env.sh + docs/validation-run-runtime.md) ; commande `npm run test -- tests/scripts.setup-environment.test.ts`.
- 2025-11-02 : ✅ Retrait du script obsolète `scripts/initValidationRun.ts` (code mort) et vérification `npm run lint`.
- 2025-11-02 : ✅ Suppression des artefacts morts `tmp_before.txt` et dossiers `tmp/` suivis, mise à jour de la garde d’hygiène, puis exécution `npm run test -- tests/hygiene.todo-scan.test.ts`.
- 2025-11-02 : ✅ Nettoyage des exports obsolètes (`listArtifacts`, `formatChildMessages`, types `PromptVariablesInput`/`ToolSuccess`/`ToolError` et alias ID génériques) ; commande `npm run lint:dead-exports`.
- 2025-11-02 : ♻️ Purge des alias inutilisés (cancellation, fsArtifacts, tracing, MCP info), restauration du helper `fail()` canonique et réduction de l'allowlist des exports morts ; commande `npm run lint:dead-exports`.
- 2025-11-02 : ✅ Retrait de `registerLessonRegression`, de l'alias `DashboardStigmergyRow` et du writer `writeArtifactFile`, nettoyage README/allowlist corrélés ; commandes `npm run lint:dead-exports` et `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/learning/lessonsRegressions.test.ts`.
- 2025-11-02 : ✅ Ajout de `p-limit` comme dépendance runtime, retrait des alias TypeScript morts (BT inputs, planner inputs, RPC buildJsonRpcErrorResponse/JsonRpcValidationError), ré-annotation du pipeline `p-limit` et nettoyage de l'allowlist ; commandes `npm run lint:dead-exports` et `npm run test -- tests/planner/compile.test.ts`.
