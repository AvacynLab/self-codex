----------
Voici ta **liste de tâches exhaustive et hiérarchisée (à cocher)**, **adressée directement à toi, Agent**, pour **développer** et **intégrer** le moteur de recherche LLM basé sur **SearxNG**, avec extraction **unstructured.io**, **injection graphe de connaissances** et **RAG**, dans le projet existant (orchestrateur MCP).
Chaque tâche précise **quoi faire**, **où (fichier par fichier)**, **avec sous-étapes**, ainsi que **les exigences tests & build** à respecter.

---

## 🎯 Brief (lis ça d’abord)

**Objectif général**
Tu vas créer un **module de recherche multimodal isolé** (comme le module Graph), basé sur **SearxNG** (instance **self-hosted**), qui :

1. interroge SearxNG,
2. télécharge les contenus (HTML/PDF/Images…),
3. les **structure** via **unstructured.io**,
4. **alimente le graphe** (triples + provenance) et **le RAG** (chunks + embeddings),
5. expose des **MCP tools** (`search.run`, `search.index`, `search.status`),
6. est **observé**, **budgetisé**, **sécurisé**, et **testé** e2e.

**Correctifs attendus / contraintes**

* Respecte l’ESM, TS strict, `exactOptionalPropertyTypes`, budgets/timeout, idempotence HTTP, logs structurés, events `EventStore`.
* Pas de `undefined` dans les sorties publiques ; **clés omises** uniquement.
* Déduplique contenus/segments ; limite la taille téléchargée ; **respect robots.txt** (si activé).
* **Self-host SearxNG** + **unstructured server** via **docker-compose** (dev & CI).
* **Tests unitaires, intégration, e2e** (avec mocks et avec containers réels).
* Intégration Dashboard : SSE live, métriques p50/p95/p99.

---

## 🧭 Plan global (phases)

* [x] **A. Infrastructure** : docker-compose (SearxNG + Unstructured + Server), env, settings.yml
* [x] **B. Module `src/search`** : clients, pipeline, ingestion Graph/RAG, cache
* [x] **C. Tools MCP** : `search.run`, `search.index`, `search.status` + registry
* [x] **D. Intégration orchestrateur** : runtime, events, dashboard
* [x] **E. Sécurité/Robots/Rate-limit**
* [ ] **F. Tests** (unit, integ, e2e), fixtures, coverage, CI *(reste : exécution docker réelle + suivi couverture/CI)*
* [x] **G. Docs & Runbook**
* [ ] **H. Nettoyage & vérifs finales** *(reste : fumée docker + validations manuelles)*

---

## A) Infrastructure : SearxNG & Unstructured (self-host)

### `docker/docker-compose.search.yml` **(NOUVEAU)**

* [x] Crée un compose dédié avec 3 services : `searxng`, `unstructured`, `server`.

  * [x] `searxng`

    * [x] Image : `searxng/searxng:latest`
    * [x] Volumes : `./searxng/settings.yml:/etc/searxng/settings.yml:ro`
    * [x] Ports : `127.0.0.1:8080:8080`
    * [x] Healthcheck : `GET /healthz` (ou page d’accueil), interval 10s, retries 6
    * [x] Resources : limites CPU/RAM (éviter OOM en CI)
  * [x] `unstructured`

    * [x] Image : `quay.io/unstructured-io/unstructured-api:latest`
    * [x] Ports : `127.0.0.1:8000:8000`
    * [x] Healthcheck : `POST /general/v0/general` (ping minimal)
  * [x] `server`

    * [x] Build : Dockerfile existant du serveur MCP
    * [x] Depends_on : `searxng`, `unstructured` (condition: service_healthy)
    * [x] Env : variables `SEARCH_*`, `UNSTRUCTURED_*` (cf. config)
* [x] Ajoute un **réseau bridge interne** (ex: `search_net`) pour isoler.
* [x] Cible `dev` et `ci` (fichiers override si besoin).

### `docker/searxng/settings.yml` **(NOUVEAU)**

* [x] Configure `engines` pertinents (general/news/images/files/science/it), `categories`, `safe_search=0` (ou 1 selon besoin), `tokens`, `retries`.
* [x] Désactive/active engines selon conformité (pas d’APIs non licenciées).
* [x] Active `result_proxy` si souhaité (utile pour fetch via proxy interne).
* [x] `server: { secret_key: "…" }` (monté via secret en prod).

### `env/.env.example` **(MODIFIER/CRÉER)**

* [x] Ajouter :

  * [x] `SEARCH_SEARX_BASE_URL=http://searxng:8080`
  * [x] `SEARCH_SEARX_API_PATH=/search`
  * [x] `SEARCH_SEARX_TIMEOUT_MS=15000`
  * [x] `SEARCH_SEARX_ENGINES=bing,ddg,wikipedia,arxiv,github` *(exemple)*
  * [x] `SEARCH_SEARX_CATEGORIES=general,news,images,files`
  * [x] `UNSTRUCTURED_BASE_URL=http://unstructured:8000`
  * [x] `UNSTRUCTURED_TIMEOUT_MS=30000`
  * [x] `UNSTRUCTURED_STRATEGY=hi_res`
  * [x] `SEARCH_FETCH_TIMEOUT_MS=20000`
  * [x] `SEARCH_FETCH_MAX_BYTES=15000000`
  * [x] `SEARCH_FETCH_UA=CodexSearchBot/1.0`
  * [x] `SEARCH_INJECT_GRAPH=true`
  * [x] `SEARCH_INJECT_VECTOR=true`

---

## B) Module `src/search` (isolé, comme `graph/`)

> Tous ces fichiers sont **NOUVEAUX** à moins d’exister déjà.

### `src/search/types.ts`

* [x] Implémente **types pivot** : `SearxResult`, `RawFetched`, `StructuredSegment`, `StructuredDocument`.
* [x] **Sous-tâches**

  * [x] `StructuredSegment.kind` (title/paragraph/list/table/figure/caption/code/meta)
  * [x] `StructuredDocument.provenance` (engines, categories, searxQuery)
  * [x] Pas de champs `undefined` dans les types publics.

### `src/search/config.ts`

* [x] Centralise **env** et valeurs par défaut (cf. `.env.example`).
* [x] **Sous-tâches**

  * [x] Parser `engines`/`categories` (CSV → array sans vides).
  * [x] Export `SearchConfig` (searx, unstructured, fetch, pipeline).

### `src/search/searxClient.ts`

* [x] Client **SearxNG JSON** (`format=json`).
* [x] **Sous-tâches**

  * [x] `searxQuery(q, {categories, engines, count})`
  * [x] Validation stricte de la réponse (zod).
  * [x] Timeout, headers (auth bearer si configuré), retries basiques (2).

### `src/search/downloader.ts`

* [x] Téléchargement HTTP **robuste** (follow, clampsize, type sniff).
* [x] **Sous-tâches**

  * [x] `fetchUrl(url)` → `RawFetched` (headers normalisés, `contentType` sans charset)
  * [x] `computeDocId(url, headers)` → SHA256(url+ETag+Last-Modified)
  * [x] Option **robots.txt** (si activé dans config)
  * [x] Rejets : `status >= 400`, contenus > `maxContentBytes`.

### `src/search/extractor.ts`

* [x] Client **unstructured.io** (endpoint `/general/v0/general`).
* [x] **Sous-tâches**

  * [x] Multipart upload du **buffer** téléchargé, `strategy=hi_res` (param)
  * [x] Mapping éléments → `StructuredSegment` (incl. page, bbox, meta)
  * [x] Détection **langue** (lib simple : tinyld)
  * [x] Gestion images/PDF/HTML (laisser faire unstructured; passer `content_type`).

### `src/search/normalizer.ts`

* [x] **Nettoyage** & **dédup**.
* [x] **Sous-tâches**

  * [x] `finalizeDocId(doc)` (remplace `id: 'tmp'`)
  * [x] `deduplicateSegments(doc)` (hash `(kind|text.trim)`).

### `src/search/ingest/toKnowledgeGraph.ts`

* [x] Ingestion **doc → triples** (Document type, title, source, language, provenance).
* [x] **Sous-tâches**

  * [x] Appelle `knowledge/knowledgeGraph.ts`: `upsertTriple`, `withProvenance`.
  * [x] `mentions` (MVP) via `extractKeyTerms(doc)` ; prévoir hook NER/LLM plus tard.
  * [x] **Provenance** obligatoire (sourceUrl, fetchedAt).

### `src/search/ingest/toVectorStore.ts`

* [x] Ingestion **chunks → embeddings**.
* [x] **Sous-tâches**

  * [x] Sélectionne segments `paragraph|title|list`, `.trim()`
  * [x] Chunking par tokens si util dispo (`memory/chunking.ts`)
  * [x] `embedText({ idHint, text, metadata })` → `memory/vector.ts`.

### `src/search/pipeline.ts`

* [x] Orchestrateur **end-to-end** (query → fetch → extract → normalize → ingest).
* [x] **Sous-tâches**

  * [x] `runSearchJob(params)` : émet events `search:*` sur `eventStore`.
  * [x] Respect `maxResults`, parallélismes (`parallelFetch`, `parallelExtract`).
  * [x] Catch/emit `search:error { url, error }` et continue.

### `src/search/cache/contentCache.ts` *(optionnel, recommandé)*

* [x] Clé: `url + (etag|last-modified)` ; TTL par **domaine** ; backoff sur 4xx/5xx.

### `src/search/metrics.ts`

* [x] Intègre `infra/tracing.ts` : histogrammes `p50/p95/p99` pour `searxQuery`, `fetchUrl`, `extractWithUnstructured`, `ingest*`.

### `src/search/index.ts`

* [x] Façade d’export (unique point d’entrée du module).

---

## C) Tools MCP (exposition contrôlée)

### `src/tools/search_run.ts` **(NOUVEAU)**

* [x] Tool **`search.run`** (zod input, budgets, description).
* [x] Appelle `runSearchJob`.
* [x] **Retour** : `{ ok, count, docs:[{id,url,title,language}] }`.
* [x] **Tests** : mock clients + snapshot réponse.

### `src/tools/search_index.ts` **(NOUVEAU)**

* [x] Tool **`search.index`** (ingérer URL(s) directes sans Searx).
* [x] Boucle `fetch → extract → normalize → ingest`.
* [x] **Retour** : `{ ok, docs:[{id,url,title}] }`.

### `src/tools/search_status.ts` **(NOUVEAU)**

* [x] Tool **`search.status`** (si jobs persistent) ; sinon renvoie non implémenté proprement.

### `src/mcp/registry.ts` **(EXISTANT, MODIFIER)**

* [x] Enregistre les 3 tools dans **pack** (`authoring` ou `ops`).
* [x] **Budgets**: `timeMs`, `toolCalls`, `bytesOut` ; **tags** (`search`,`web`,`ingest`,`rag`).
* [x] **Docs** : title/description clairs + exemples d’appel.

---

## D) Intégration orchestrateur & observabilité

### `src/orchestrator/runtime.ts` **(EXISTANT, MODIFIER)**

* [x] Injecte le module `search/` dans la composition (si pattern déjà en place).
* [x] Passe `eventStore`, `logger`, `tracing` au pipeline.
* [x] Ajoute teardown propre si ressources (rien de spécial attendu côté clients HTTP).

### `src/eventStore.ts` **(EXISTANT, MODIFIER)**

* [x] Ajoute **kinds** : `search:job_started`, `search:doc_ingested`, `search:error`, `search:job_completed`.
* [x] Stabilise la **sérialisation JSON** (clés ordonnées si votre infra le requiert).

### `src/monitor/dashboard.ts` **(EXISTANT, MODIFIER)**

* [x] **Panneaux** :

  * [x] File jobs (en cours/terminés) + docs/min + erreurs par type
  * [x] Heatmap domaines les plus consultés
  * [x] Latence moyenne par `contentType` (HTML/PDF/Image)

### `src/http/*` **(EXISTANT, VÉRIFIER)**

* [x] Si tools exposés via HTTP, s’assurer :

  * [x] **Idempotence** (clé = hash(query,categories,engines,maxResults))
  * [x] **Rate-limit** dédié `search.*`.

---

## E) Sécurité, conformité & robustesse

* [x] **User-Agent** explicite (`SEARCH_FETCH_UA`).
* [x] **robots.txt** (si activé) + **throttle** par domaine.
* [x] **Max bytes** strict (15MB par défaut).
* [x] **Timeouts** cohérents (fetch/extract/job).
* [x] **Redaction** des secrets dans logs. *(tests runtime optional contexts ✅)*
* [x] **Allow-list** des env injectées si exec enfant (pas prévu ici).
* [x] **Provenance** obligatoire sur triples.
* [x] **Conformité** licences engines Searx (désactiver ceux à risque).

---

## F) Tests (tu dois les écrire et les faire passer)

> Suis les **contraintes build/tests** en fin de document.

### Unitaires (Mocha + TS)

#### `test/unit/search/searxClient.spec.ts`

* [x] Mock réponses SearxNG (cas OK / schema invalide / timeout / 500).
* [x] Vérifie **zod parsing**, params de requête (engines/categories/count).

#### `test/unit/search/downloader.spec.ts`

* [x] Content-type sniff, clamp taille, follow redirects, erreurs 4xx/5xx.
* [x] `computeDocId` (ETag, Last-Modified) — golden tests.

#### `test/unit/search/extractor.spec.ts`

* [x] Mock **unstructured** (éléments variés : title/paragraph/list/table/figure).
* [x] Mapping vers `StructuredSegment`, détection langue.

#### `test/unit/search/normalizer.spec.ts`

* [x] Déduplication segments, finalisation id.

#### `test/unit/search/ingest.toKnowledgeGraph.spec.ts`

* [x] Appels `upsertTriple` + `withProvenance` (spies).
* [x] `mentions`: extraction tokens fréquents (stopwords FR/EN basiques).

#### `test/unit/search/ingest.toVectorStore.spec.ts`

* [x] Découpage, appel `embedText` par chunk avec metadata.

#### `test/unit/search/pipeline.spec.ts`

* [x] Pipeline heureux (tout OK) + cas d’erreur isolée (un URL échoue), vérifie **events** émis.

### Intégration (sans containers réels)

* [x] Mocks HTTP **SearxNG** & **Unstructured** (nock).
* [x] `search.run` tool : entrée → docs ingérés → vérifie appels Graph/RAG.

### E2E (avec `docker-compose.search.yml`)

*⚠️* La suite s'exécute uniquement si `SEARCH_E2E_ALLOW_RUN=1` (automatiquement défini par `npm run test:e2e:search`). Sans ce flag,
 elle se mettra en `SKIP` pour éviter les faux négatifs lorsque Docker/Unstructured ne sont pas disponibles.

* [ ] Lancer **searxng + unstructured + server**.
* [ ] Appeler `search.run { query: "site:arxiv.org LLM 2025 filetype:pdf", categories:["files","general"], maxResults:4 }`.
* [ ] Attendre complétion → vérifier :

  * [ ] au moins 1 doc ingéré dans **graphe** (triples Document + provenance).
  * [ ] au moins 1 embedding dans **vector store** avec metadata correcte.
  * [ ] events dans **dashboard** (ou endpoint JSON de stats).

### Couverture & qualité

* [x] **Coverage global ≥ 85%**, `src/search/*` ≥ 90%.
* [x] Pas de tests flakys (timeouts stables, retries mockés).
* [x] Tests typés strict (no `any` implicite, `exactOptionalPropertyTypes` respecté).

---

## G) Documentation & Runbook

### `docs/search-module.md` **(NOUVEAU)**

* [x] Overview, architecture, schémas.
* [x] Variables d’env + valeurs par défaut.
* [x] Exemples d’appels `search.run`/`search.index`.
* [x] Stratégies de **re-crawl** (ETag, TTL par domaine).
* [x] Limites connues (images OCR lourdes, PDFs scannés).
* [x] **Playbook incident** (unstructured down, searxng rate-limited).

### `CHANGELOG.md` **(MODIFIER)**

* [x] Ajoute entrée `feature: search llm searxng`.

---

## H) Nettoyage & vérifications finales

* [x] Enlève **placeholders**/TODO non traités ou ouvre tickets.
* [x] Pas de `console.log` brut → **logger** central.
* [x] Vérifie **exact optional** (aucun `undefined` exposé).
* [x] Vérifie **budgets** tools (`timeMs`, `bytesOut`, `toolCalls`).
*⚠️* **Smoke test** local (compose up, `search.run`, dashboard OK). *(script `npm run smoke:search` prêt ; reste bloqué sans Docker dans l'environnement agent)*

---

# 📁 Détail **fichier par fichier** (avec objectifs & attentes de tests)

> **NOUVEAUX**

* [x] `src/search/types.ts` — **Objectif** : contrat pivot des données.

  * **Attendu tests** : types utilisés sans `any`, pas d’`undefined` en sortie.

* [x] `src/search/config.ts` — **Objectif** : config centralisée, valeurs par défaut sûres.

  * **Attendu tests** : parsing CSV, numériques, booléens ; fallback OK.

* [x] `src/search/searxClient.ts` — **Objectif** : requêter SearxNG proprement.

  * **Attendu tests** : zod schema, erreurs réseau, params q/cat/engines.

* [x] `src/search/downloader.ts` — **Objectif** : fetching robuste (clamp, type).

  * **Attendu tests** : redirects, status 404/500, clamp, content-type.

* [x] `src/search/extractor.ts` — **Objectif** : mapper unstructured → segments.

  * **Attendu tests** : diversité éléments, langue, erreurs 5xx.

* [x] `src/search/normalizer.ts` — **Objectif** : id stable, dédup segments.

  * **Attendu tests** : collisions évitées, dédup correcte.

* [x] `src/search/ingest/toKnowledgeGraph.ts` — **Objectif** : triples + provenance.

  * **Attendu tests** : appels `upsertTriple` exacts, présence provenance.

* [x] `src/search/ingest/toVectorStore.ts` — **Objectif** : embeddings avec metadata.

  * **Attendu tests** : nombre de chunks, metadata complète (docId,url,title,language,fetchedAt).

* [x] `src/search/pipeline.ts` — **Objectif** : orchestration + events.

  * **Attendu tests** : séquence d’appels, events `search:*`, résilience sur erreurs URL.

* [x] `src/search/metrics.ts` — **Objectif** : timers/histogrammes branchés.

  * **Attendu tests** : counters incrémentés, labels corrects.

* [x] `src/search/index.ts` — **Objectif** : export public propre.

  * **Attendu tests** : import unique depuis ailleurs compile.

* [x] `src/tools/search_run.ts` — **Objectif** : tool MCP principal.

  * **Attendu tests** : validation input, budgets, retour docs.

* [x] `src/tools/search_index.ts` — **Objectif** : ingestion directe URL(s).

  * **Attendu tests** : liste d’URL, erreurs isolées, retours agrégés.

* [x] `src/tools/search_status.ts` — **Objectif** : introspection jobs (si persistés).

  * **Attendu tests** : job not found / job done.

* [x] `docker/docker-compose.search.yml` — **Objectif** : dev & CI e2e.

  * **Attendu tests** : healthchecks OK, services up avant e2e.

* [x] `docker/searxng/settings.yml` — **Objectif** : engines sains.

  * **Attendu tests** : requêtes simples retournent résultats.

* [x] `docs/search-module.md` — **Objectif** : runbook complet.

  * **Attendu** : explicite, reproductible.

> **EXISTANTS (à MODIFIER)**

* [x] `src/mcp/registry.ts` — **Objectif** : enregistrer les 3 tools avec budgets/tags.

  * **Attendu tests** : `tools help` liste bien search.* avec metadata.

* [x] `src/orchestrator/runtime.ts` — **Objectif** : injecter module search et wiring `eventStore/tracing`.

  * **Attendu tests** : pas de régression sur autres modules, hooks OK.

* [x] `src/eventStore.ts` — **Objectif** : nouveaux kinds `search:*` stabilisés.

  * **Attendu tests** : sérialisation stable (ordre clé), SSE fonctionne.

* [x] `src/monitor/dashboard.ts` — **Objectif** : panneaux search.

  * **Attendu tests** : endpoints JSON renvoient stats ; UI affiche docs/min & erreurs.

* [x] `knowledge/knowledgeGraph.ts` — **Objectif** : garantir `upsertTriple` + `withProvenance`.

  * **Attendu tests** : triplets persistés, duplication évitée.

* [x] `memory/vector.ts` — **Objectif** : `embedText` stable, capacity caps respectées.

  * **Attendu tests** : taille index plafonnée, recherche par similarité OK.

---

## 🧪 Exigences **Tests & Build** (à respecter partout)

**Build**

* [x] Node **≥ 20**, ESM strict, TS **strict** + `exactOptionalPropertyTypes: true`.
* [x] `npm run build` compile sans warn ; **aucun** `any` implicite.
* [x] Pas de dépendances non déclarées ; imports Node en `node:`.
* [x] `graph-forge` / workers : inchangés (pas d’impact).

**Lint & qualité**

* [x] Lint passe (règles hygiène existantes). *(commandé le 2025-11-12 via `npm run lint`)*
* [x] Aucune clé optionnelle exposant `undefined` dans JSON public.
* [x] JSON stable (ordre des champs si nécessaire côté EventStore).

**Tests**

* [x] **Unit ≥ 90%** sur `src/search/*`, **Global ≥ 85%**. *(confirmé via `npm run coverage` le 2025-11-13)*
* [x] **Intégration** : mocks HTTP (`nock`) pour SearxNG/Unstructured.
* [x] **E2E** : `docker-compose.search.yml` — script unique `npm run test:e2e:search`.
* [ ] **CI** : job dédié qui monte compose, attend health, lance tests, publie couverture & logs.

**Observabilité**

* [x] Tracing : latences `searxQuery`, `fetchUrl`, `extractWithUnstructured`, `ingest*`.
* [x] EventStore : `search:job_*`, `search:error` ; Dashboard affiche tendances.

**Sécurité & conformité**

* [x] **robots.txt** (si activé), throttle, user-agent.
* [x] Auth bearer vers SearxNG si requis par env (prod).
* [x] Redaction logs (en-têtes sensibles).
* [x] Respect licences engines (désactiver ceux qui posent problème).

---

## ✅ Mini scénario de validation (manuel)

* [ ] Lancer `docker compose -f docker/docker-compose.search.yml up -d`
* [ ] Appeler `search.run` avec :

```json
{
  "query": "benchmarks LLM multimodal 2025 filetype:pdf",
  "categories": ["files","general","images"],
  "maxResults": 6,
  "fetchContent": true,
  "injectGraph": true,
  "injectVector": true
}
```

* [ ] Observer :

  * [ ] ≥1 doc dans graphe (triples + provenance)
  * [ ] ≥1 embedding en vector store
  * [ ] Dashboard: docs/min > 0, erreurs = 0, latences raisonnables

---

Si tu coches ces cases dans l’ordre, on obtient un **moteur de recherche LLM** **robuste**, **intégré proprement**, **observé** et **testé**, prêt pour l’orchestration multi-agents.
---

### Historique Agent (2025-10-31)
- Extension du pipeline avec ingestion directe (`ingestDirect`) et factorisation du traitement fetch/extract/ingest pour réutilisation par les façades.
- Ajout des tools `search.index` et `search.status`, des schémas RPC associés et des tests de façade couvrant succès, budgets épuisés et validation.
- Tests exécutés : `npm run typecheck` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/pipeline.test.ts tests/tools/facades/search_index.test.ts tests/tools/facades/search_status.test.ts` ✅.
### Historique Agent (2025-11-01)
- Intégration du pipeline search dans l'orchestrateur (config env, clients, enregistrements des tools `search.*`).
- Ajout du panneau search au dashboard (file jobs, domaines, latence contenu) avec export testable.
- Mise à jour des manifests/budgets search et des tests ciblés (dashboard, golden tools).

### Historique Agent (2025-11-02)
- Rédaction du runbook `docs/search-module.md` (architecture, configuration, exemples d'usage, stratégies d'exploitation).
- Création de l'entrée `feature: search llm searxng` dans `CHANGELOG.md` pour tracer l'arrivée du module de recherche.
- Tests exécutés : `npm run typecheck` ✅.

### Historique Agent (2025-11-03)
- Mise en place d'un throttle par domaine dans le downloader (`SEARCH_FETCH_DOMAIN_DELAY_MS`) et extension des exemples d'env/expected keys.
- Ajout du test d'intégration `tests/integration/search/search_run.integration.test.ts` avec mocks HTTP `nock` couvrant l'ingestion Graph/RAG et instrumentation.
- Déclaration de la dépendance `nock` et mise à jour des checklists associées.
- Tests exécutés : `npm run typecheck` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/downloader.test.ts tests/integration/search/search_run.integration.test.ts` ✅.

### Historique Agent (2025-11-04)
- Création du script `scripts/run-search-e2e.mjs` orchestrant le `docker-compose` dédié puis l'exécution ciblée du test e2e search.
- Ajout du test `tests/e2e/search/search_run.e2e.test.ts` (serveurs stub Searx + contenu, pipeline réel avec unstructured) et du script `npm run test:e2e:search`.
- Mise à jour de la checklist AGENTS (case E2E) et exécution : `npm run test:e2e:search` ⚠️ (docker absent → suite ignorée proprement), `npm run typecheck` ✅.

### Historique Agent (2025-11-05)
- Ajout du cache de contenu (`src/search/cache/contentCache.ts`) avec TTL par domaine, backoff 4xx/5xx et clonage des payloads.
- Extension de la configuration fetch (env, docs, expected keys) + support du backoff côté downloader (`DownloadBackoffError`) et tests associés.
- Tests exécutés : `npm run typecheck` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/downloader.test.ts tests/unit/search/cache/contentCache.test.ts` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/config.test.ts` ✅.

### Historique Agent (2025-11-06)
- Renforcement de l'idempotence des façades `search.run`/`search.index` via une clé déterministe (hash des paramètres structurants) lorsqu'aucune clé n'est fournie.
- Ajout d'un limiteur HTTP dédié `search.*` (env `MCP_HTTP_SEARCH_RATE_LIMIT_*`), tests intégration rate-limit, et documentation du comportement.
- Tests exécutés : `npm run typecheck` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/search_run.test.ts tests/tools/facades/search_index.test.ts tests/http/http_rate_limit.test.ts` ❌ (échec transform esbuild/TLA, limitation environnementale).

### Historique Agent (2025-11-07)
- Ajout des variables d'environnement optionnelles `SEARCH_SEARX_AUTH_TOKEN`, `SEARCH_SEARX_MAX_RETRIES` et `UNSTRUCTURED_API_KEY` dans les templates `.env`, avec synchronisation des clés attendues.
- Vérification de la configuration et documentation mise à jour dans `AGENTS.md` (cases auth bearer/tests unitaires search marquées complètes).
- Tests exécutés : `npm run typecheck` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/config.test.ts` ✅.

### Historique Agent (2025-11-08)
- Facteur le fast-path HTTP pour charger `server.ts` de manière paresseuse, contournant l'échec esbuild sur `await` de haut niveau tout en conservant les hooks idempotence/logs.
- Ajout d'un repli contrôlé lorsque le contrôleur n'est pas initialisé et documentation des traces debug, puis installation des dépendances manquantes (`tinyld`) afin que l'import dynamique réussisse en test.
- Tests exécutés : `npm run typecheck` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/search_run.test.ts tests/tools/facades/search_index.test.ts tests/http/http_rate_limit.test.ts` ✅.

### Historique Agent (2025-11-09)
- Revue complète du backlog search : cases globales mises à jour, sections sécurité/tests annotées, et historique réduit à <50 lignes pour les prochains agents.
- Vérification infrastructure/observabilité (compose, dashboard, registry) et documentation des tâches restantes (CI, logs sensibles, fumée docker).
- Tests exécutés : `npm run build` ✅.

### Historique Agent (2025-11-10)
- Mise en place de la redaction automatique des secrets search (token Searx/unstructured) via la configuration runtime et expose des helpers internes pour tests.
- Ajout d'un collecteur de tokens dans la config search + tests unitaires garantissant le dédoublonnage/trim.
- Tests exécutés : `npm run typecheck` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/config.test.ts` ✅ ; tentative `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/orchestrator/runtime.optional-contexts.test.ts` ❌ (limitation esbuild sur top-level await malgré correctif précédent).

### Historique Agent (2025-11-11)
- Factorisation de l'initialisation du runtime orchestrateur (`runtimeReady`) pour supprimer les `await` de haut niveau et protéger l'accès aux outils/pipelines tant que l'initialisation n'est pas terminée.
- Mise à jour des façades JSON-RPC/serveur pour attendre l'initialisation, rafraîchissement du test `runtime.optional-contexts` et import des secrets search dans la redaction des logs.
- Tests exécutés : `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/orchestrator/runtime.optional-contexts.test.ts` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/tools/facades/search_run.test.ts tests/tools/facades/search_index.test.ts tests/http/http_rate_limit.test.ts` ✅ ; `npm run typecheck` ✅.

### Historique Agent (2025-11-12)
- Ajout d'un garde-fou `SEARCH_E2E_ALLOW_RUN` : la suite `tests/e2e/search/search_run.e2e.test.ts` se met en SKIP par défaut et ne s'exécute qu'à travers `npm run test:e2e:search` qui active le flag et orchestre Docker.
- Documentation `docs/search-module.md` mise à jour pour refléter le nouveau comportement, et checklist AGENTS annotée pour éviter les faux négatifs en environnement sans Docker.
- Tests exécutés : `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/e2e/search/search_run.e2e.test.ts` ✅ (SKIP attendu) ; `npm run lint` ✅.

### Historique Agent (2025-11-13)
- Relance complète de la couverture (`npm run coverage`) afin de valider le nouveau garde agrégé `scripts/checkSearchCoverage.ts` (>90 % sur `src/search/*`).
- Nettoyage du dossier `coverage/` et mise à jour de la checklist (case couverture) pour refléter la confirmation.
- Tests exécutés : `npm run coverage` ✅ (incluant `node --import tsx scripts/checkSearchCoverage.ts`).

### Historique Agent (2025-11-14)
- Réinstallation des dépendances de développement (`npm install --include=dev`) pour restaurer `tinyld` absent lors de la couverture complète.
- Exécution de `npm run coverage` ✅ confirmant 91.16 % global et 92.64 % sur `src/search/*` (script `scripts/checkSearchCoverage.ts`).
- Commandes exécutées supplémentaires : `npm install` (résolution modules manquants).

### Historique Agent (2025-11-15)
- Factorisation du pilotage Docker dans `scripts/lib/searchStack.ts`, conversion du runner e2e en TypeScript et ajout du script fumée `scripts/run-search-smoke.ts`.
- Ajout du validateur `assessSmokeRun`, de tests unitaires (`tests/scripts/searchStack.test.ts`, `tests/scripts/searchSmokePlan.test.ts`) et de la commande `npm run smoke:search` documentée.
- Tests exécutés : `npm run lint` ✅ ; `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/scripts/searchStack.test.ts tests/scripts/searchSmokePlan.test.ts` ✅.

