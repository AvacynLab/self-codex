----------
Voici ta **liste de tâches exhaustive et hiérarchisée, à cocher**, **adressée directement à toi, Agent**, pour **créer, intégrer et valider** le moteur de recherche LLM (SearxNG + unstructured.io) dans le dépôt actuel (`self-codex-main`). Je m’appuie sur l’arborescence réelle du repo et sur nos spécifications précédentes.
Objectif : livrer un module `src/search/**` isolé, des tools MCP `search.*`, une infra **self-host** SearxNG + Unstructured (docker), l’ingestion dans **KnowledgeGraph** et **VectorMemory**, l’observabilité, et une batterie de **tests** (unit/int/e2e) en conformité avec la toolchain (Node ≥ 20, ESM, TS strict, exactOptionalPropertyTypes, Mocha+tsx).

---

## 🎯 Brief (lis ça d’abord)

**Objectifs attendus (résumé)**
Tu vas :

1. Implémenter le **module `src/search/**`** (client SearxNG, téléchargement, extraction via unstructured, normalisation, ingestion KG + VectorMemory, métriques).
2. Exposer **3 tools MCP** : `search.run`, `search.index`, `search.status`, et les **enregistrer** via `src/mcp/registry.ts`.
3. Ajouter une **infra self-host** : `docker/docker-compose.search.yml` (services `searxng`, `unstructured`, `server`) + `docker/searxng/settings.yml`.
4. Étendre l’**observabilité** : nouveaux events/métriques visibles dans le **dashboard**.
5. Écrire des **tests unitaires, d’intégration, et E2E** (mocks HTTP et avec containers réels).
6. Mettre à jour les **docs** et **.env.example**.

**Contraintes de qualité / build**

* **TypeScript strict** + `exactOptionalPropertyTypes: true` (déjà actif dans `tsconfig.json`) : ne jamais exposer `undefined` dans les sorties publiques (préférer **omission** des clés).
* Respect des **budgets/timeout** outillés (côté controller/registry), **idempotence** HTTP, **rate limiting** (si exposé via HTTP).
* **Imports Node** en `node:` pour ESM (conventions existantes).
* **Tests** : Mocha + tsx (`npm run test`, `npm run test:int`, `npm run test:e2e`). Viser **≥90%** de couverture sur `src/search/**` et **≥85%** global.
* **Observabilité** : tracer les étapes critiques (Searx, fetch, extract, ingest) et émettre des events **stables** et diffables.

---

## A) Infrastructure : SearxNG & Unstructured (self-host)

> Nouveaux fichiers (dans `docker/`), adoption CI/dev.

* [x] **Créer** `docker/docker-compose.search.yml`

  * [x] Service `searxng` (image `searxng/searxng:latest`)

    * [x] Ports : `127.0.0.1:8080:8080`
    * [x] Volume : `./searxng/settings.yml:/etc/searxng/settings.yml:ro`
    * [x] Healthcheck HTTP (ex: `/healthz` ou page d’accueil)
  * [x] Service `unstructured` (image `quay.io/unstructured-io/unstructured-api:latest`)

    * [x] Ports : `127.0.0.1:8000:8000`
    * [x] Healthcheck minimal (POST `/general/v0/general` ping)
  * [x] Service `server` (build depuis Dockerfile du projet)

    * [x] `depends_on` avec `condition: service_healthy` pour `searxng` et `unstructured`
    * [x] Variables d’env (cf. `.env.example` à compléter)
  * [x] **Réseau** dédié (bridge interne) `search_net`
  * [x] **Ressources** : limites CPU/RAM raisonnables (éviter OOM en CI)

* [x] **Créer** `docker/searxng/settings.yml`

  * [x] Configurer **engines** pertinents (p.ex. `bing`, `ddg`, `wikipedia`, `arxiv`, `github`, …)
  * [x] Configurer **categories** (au minimum : `general,news,images,files`)
  * [x] `safe_search` selon besoin (0/1), `retries`, `result_proxy` si requis
  * [x] Clés/secret côté prod via secret/env (ne rien commiter de sensible)

* [x] **Mettre à jour** `env/.env.example`

  * [x] `SEARCH_SEARX_BASE_URL=http://searxng:8080`
  * [x] `SEARCH_SEARX_API_PATH=/search`
  * [x] `SEARCH_SEARX_TIMEOUT_MS=15000`
  * [x] `SEARCH_SEARX_ENGINES=bing,ddg,wikipedia,arxiv,github`
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

## B) Nouveau module isolé : `src/search/**`

> Tous les fichiers suivants sont **nouveaux** et doivent respecter les conventions ESM/TS strictes du repo.

### B1. Types & Config

* [x] **Créer** `src/search/types.ts`

  * [x] `SearxResult` : `{ url:string; title?:string; snippet?:string; engine?:string; category?:string; publishedAt?:string; mime?:string }`
  * [x] `RawFetched` : `{ url; status; headers; contentType?; body:Buffer; fetchedAt }`
  * [x] `StructuredSegment` : `{ kind:'title'|'paragraph'|'list'|'table'|'figure'|'caption'|'code'|'meta'; text?; page?; bbox?; meta? }`
  * [x] `StructuredDocument` : `{ id; url; source; contentType; language?; title?; publishedAt?; fetchedAt; metadata; segments; provenance:{ engines?; categories?; searxQuery? } }`
  * [x] **Aucun `undefined` exporté** dans les objets publics (omets les clés absentes)

* [x] **Créer** `src/search/config.ts`

  * [x] Lire/normaliser env → `SearchConfig` (searx, unstructured, fetch, pipeline)
  * [x] Parser `engines/categories` CSV en `string[]` (ignore vides)

### B2. Clients & Étapes du pipeline

* [x] **Créer** `src/search/searxClient.ts`

  * [x] `searxQuery(q,{categories,engines,count}) => Promise<SearxResult[]>`
  * [x] Requête `format=json`, zod pour valider `results[]`, timeouts, bearer optionnel, 1–2 retries

* [x] **Créer** `src/search/downloader.ts`

  * [x] `fetchUrl(url) => RawFetched` (follow, `content-type` sans charset, clamp taille max, erreurs 4xx/5xx)
  * [x] `computeDocId(url, headers) => sha256(url+etag+last-modified)`
  * [x] Respect `SEARCH_FETCH_UA`, option **robots.txt** si tu ajoutes le contrôle

* [x] **Créer** `src/search/extractor.ts`

  * [x] `extractWithUnstructured(raw, {url,title?,engines?,categories?}) => StructuredDocument`
  * [x] Appel API Unstructured `/general/v0/general` (multipart), `strategy` configurable
  * [x] Mapper éléments → `StructuredSegment` (page, bbox, meta)
  * [x] Détection **langue** (lib simple), propagation `contentType`
  * [x] **Ne pas** exposer de `undefined` : champs optionnels omis

* [x] **Créer** `src/search/normalizer.ts`

  * [x] `finalizeDocId(doc)` : remplace `id` par `computeDocId`
  * [x] `deduplicateSegments(doc)` : déduplique via `(kind|text.trim)`

### B3. Ingestion vers KG + VectorMemory

* [x] **Créer** `src/search/ingest/toKnowledgeGraph.ts`

  * [x] Utiliser la **classe** `KnowledgeGraph` existante (`src/knowledge/knowledgeGraph.ts`) → méthode **`insert`**
  * [x] Insérer le nœud Document (type `Document`, `dc:title`, `dc:source` (URL), `dc:language`) avec **provenance** (sourceUrl, fetchedAt)
  * [x] MVP : ajouter des `mentions` basées sur termes clés extraits (stopwords basiques)
  * [x] Prévoir un hook ultérieur NER/LLM (non activé par défaut)

* [x] **Créer** `src/search/ingest/toVectorStore.ts`

  * [x] Utiliser `VectorMemoryIndex` (`src/memory/vector.ts`) → méthode **`upsert`**
  * [x] Sélectionner segments `paragraph|title|list`, normaliser, chunker si util existant (sinon naïf)
  * [x] `metadata` : `{ docId, url, title, language, fetchedAt }`, tags vides au départ
  * [x] **Pas** d’accès à des embeddings externes : on reste sur l’index texte→TF-IDF du repo

### B4. Orchestrateur de pipeline + métriques

* [x] **Créer** `src/search/pipeline.ts`

  * [x] `runSearchJob({ query, categories?, engines?, maxResults?, fetchContent?, injectGraph?, injectVector? })`
  * [x] Étapes : `searxQuery` → pick top K → `fetchUrl` → `extractWithUnstructured` → `finalizeDocId` → `deduplicateSegments` → ingestion KG + Vector
  * [x] **Émettre des events** via `EventStore` (voir section D)
  * [x] Gérer les erreurs URL individuellement (continuer le job)
  * [x] Retourner `{ results:[…], docs:[{id,url,title,language}] }`

* [x] **Créer** `src/search/metrics.ts`

  * [x] Intégration `infra/tracing.ts` pour mesurer latences p50/p95/p99 des fonctions : `searxQuery`, `fetchUrl`, `extractWithUnstructured`, `ingestToGraph`, `ingestToVector`

* [x] **Créer** `src/search/index.ts`

  * [x] Export centralisé des symboles du module

* [x] **(Optionnel recommandé)** `src/search/cache/contentCache.ts`

  * [x] Cache disque par URL + (etag|last-modified), TTL par domaine, backoff sur 4xx/5xx

---

## C) Tools MCP : exposition contrôlée

> S’inspirer du style des tools existants dans `src/tools/**`. Utiliser zod, budgets, `buildToolSuccessResult`.

* [x] **Créer** `src/tools/search_run.ts`

  * [x] Entrée (zod) : `{ query:string; categories?:string[]; engines?:string[]; maxResults?:number(1..50); fetchContent?:boolean; injectGraph?:boolean; injectVector?:boolean }`
  * [x] Budgets init : `{ timeMs: 60_000, toolCalls: 4, bytesOut: 512_000 }` (ajuste si besoin)
  * [x] Appeler `runSearchJob` et **retourner** `{ ok:true, count, docs:[{id,url,title,language}] }` via helper de succès
  * [x] **Ne pas** renvoyer de blobs ; **pas** d’`undefined`

* [x] **Créer** `src/tools/search_index.ts`

  * [x] Entrée : `{ url:string | string[]; title?:string; injectGraph?:boolean; injectVector?:boolean }`
  * [x] Boucle `fetch → extract → normalize → ingest`
  * [x] Retour `{ ok:true, docs:[{id,url,title}] }`

* [x] **Créer** `src/tools/search_status.ts`

  * [x] Si persistance de jobs **non** mise en place : renvoyer proprement “non implémenté” (code/tool result standard)

* [x] **Modifier** `src/mcp/registry.ts`

  * [x] **Enregistrer** les 3 tools (`search.run`, `search.index`, `search.status`) dans le pack approprié (p.ex. `authoring` ou `ops`)
  * [x] Ajouter **tags** (`search`,`web`,`ingest`,`rag`) et **budgets**
  * [x] Ajouter un **exemple d’appel** dans la description (cohérent avec les autres tools)

---

## D) Intégration orchestrateur & observabilité

* [x] **Événements EventStore** : **ne pas inventer un nouveau `EventKind`** si tu ne touches pas le type union

  * [x] Utiliser `EventKind` existants (p.ex. `"INFO"` pour les étapes Search) et inclure un `payload` structuré :

    * [x] `search:job_started` → `{ query, categories, engines, maxResults }`
    * [x] `search:doc_ingested` → `{ docId, url, injectGraph, injectVector }`
    * [x] `search:error` → `{ url, error }`
    * [x] `search:job_completed` → `{ query, tookMs, docCount }`
  * [x] **Alternative (option “plus propre”)** : étendre l’union `EventKind` de `src/eventStore.ts` pour ajouter `"SEARCH"` et router ces events sous ce kind (exige update des types et dashboard). Si tu fais ça :

    * [x] Mettre à jour toutes les occurrences de l’union dans le repo (compilateur t’aidera)
    * [x] Adapter `monitor/dashboard.ts` (voir ci-dessous)

* [x] **Modifier** `src/monitor/dashboard.ts`

  * [x] Ajouter un **panneau Search** (HTML) et un **endpoint JSON** récapitulant :

    * [x] `jobs` récents, `docs/min`, `errors by type`, latence moyenne par `contentType`
  * [x] Brancher la **SSE** si nécessaire (en t’inspirant des autres panneaux)
  * [x] **Ne pas** casser les pages existantes (garde la navigation)

* [x] **Modifier** `src/runtime/*` si nécessaire pour injecter des dépendances (logger/tracing) vers `src/search/pipeline.ts` (garde la composition root **pure**)

* [x] **HTTP idempotence/rate-limit** (si tools exposés via HTTP)

  * [x] Dans `src/httpServer.ts` et `src/orchestrator/controller.ts`, vérifier que l’**idempotency cache key** couvre `search.run` (clé = hash des arguments pertinents)
  * [x] Ajouter un **rate-limit** spécifique pour `search.*` si la conf le permet

---

## E) Sécurité, conformité & robustesse

* [x] **User-Agent** dédié (`SEARCH_FETCH_UA`), **timeouts** et **limites de taille** stricts
* [x] **robots.txt** : si tu ajoutes le respect des robots, le rendre **activable par env**, et logguer une alerte si bloqué
* [x] **Redaction** des headers sensibles dans les logs (`logger` central)
* [x] **Provenance** : toujours renseigner `sourceUrl`, `fetchedAt`, + provenance Unstructured si utile
* [x] **Licences engines SearxNG** : commenter/désactiver ceux à risque dans `settings.yml`

---

## F) Tests (unit, intégration, E2E)

> Respecter la structure existante : **Mocha + tsx**, fichiers `*.test.ts`, répertoires sous `tests/`. Viser ≥90% de cov. `src/search/**`.

### F1. Unitaires (nouveaux)

* [x] **Créer** `tests/unit/search/searxClient.test.ts`

  * [x] Mocker réponses SearxNG (OK / schéma invalide / 500 / timeout)
  * [x] Vérifier parsing zod et mapping → `SearxResult[]`
  * [x] Vérifier params (`q`, `categories`, `engines`, `count`)

* [x] **Créer** `tests/unit/search/downloader.test.ts`

  * [x] Mocker HTTP : redirects, 404/500, `content-type` variés, clamp taille
  * [x] Tester `computeDocId` (variation ETag/Last-Modified)

* [x] **Créer** `tests/unit/search/extractor.test.ts`

  * [x] Mocker Unstructured (`/general/v0/general`) avec jeux d’éléments (title/paragraph/list/table/figure)
  * [x] Vérifier mapping → `StructuredSegment[]`, détection langue, erreurs 5xx

* [x] **Créer** `tests/unit/search/normalizer.test.ts`

  * [x] Vérifier `finalizeDocId` + déduplication (pas de doubles)
  * [x] S’assurer que les champs optionnels absents sont **omis** (pas `undefined`)

* [x] **Créer** `tests/unit/search/ingest.toKnowledgeGraph.test.ts`

  * [x] Mocker `KnowledgeGraph` : vérifier **appel de `insert`** avec provenance, titre/langue/source
  * [x] Vérifier génération `mentions` (stopwords FR/EN basiques)

* [x] **Créer** `tests/unit/search/ingest.toVectorStore.test.ts`

  * [x] Mocker `VectorMemoryIndex` : vérifier **appel à `upsert`** par chunk
  * [x] Vérifier metadata (`docId,url,title,language,fetchedAt`)

* [x] **Créer** `tests/unit/search/pipeline.test.ts`

  * [x] Cas **heureux** : 2–3 résultats Searx → 2 docs ingérés (KG + Vector)
  * [x] Cas **partiellement en échec** : 1 URL fail (erreur fetch/extract) → event `search:error` émis, job continue
  * [x] Vérifier **events** émis (voir section D)

### F2. Intégration (mocks réseaux, sans containers)

* [x] **Créer** `tests/integration/search.tools.test.ts`

  * [x] Mocker SearxNG/Unstructured (nock)
  * [x] Appeler tool `search.run` → vérifier **sortie tool**, appels KG/Vector, events

### F3. E2E (avec containers)

* [x] **Créer** `tests/e2e/search.e2e.test.ts`

  * [x] Démarrer `docker/docker-compose.search.yml` (ou script existant `scripts/run-http-e2e.mjs` adapté)
  * [x] Appeler `search.run` avec requête de démo (ex : `benchmarks LLM multimodal 2025 filetype:pdf`)
  * [x] Attendre complétion → vérifier :

    * [x] au moins 1 triple `Document` dans **KnowledgeGraph** (via tool/query existant)
    * [x] au moins 1 **VectorMemory** `upsert` (via tool de recherche mémoire existant)
    * [x] Dashboard/endpoint stats expose un **compteur de jobs** et **latences**

### F4. Couverture & CI

* [x] Configurer la **couverture** (collecte existante OK) : viser ≥90% sur `src/search/**`
* [x] **CI** : ajouter un job qui monte `docker-compose.search.yml`, attend les healthchecks, lance `npm run test:e2e` et publie logs/coverage

---

## G) Documentation & Changelog

* [x] **Créer** `docs/search-module.md`

  * [x] Architecture (schémas, étapes du pipeline)
  * [x] Variables d’environnement et valeurs par défaut
  * [x] Exemples d’utilisation des tools `search.run` / `search.index`
  * [x] Stratégie de recrawl (ETag/Last-Modified, TTL par domaine)
  * [x] Limites connues (PDF scannés, OCR lourd, multilingue)
  * [x] Runbook incident (SearxNG down, Unstructured slow/5xx)

* [x] **Modifier** `CHANGELOG.md`

  * [x] Entrée : `feature: search llm searxng (module + tools + infra + tests)`

---

## H) Nettoyage et vérifications finales

* [x] **Aucun** `console.log` brut : utiliser `StructuredLogger`
* [x] **Aucune** clé optionnelle exposant `undefined` dans JSON publics
* [x] **Budgets** tools `search.*` revus (temps, toolCalls, bytesOut) selon perfs mesurées
* [x] **Smoke test** local : `docker compose -f docker/docker-compose.search.yml up -d` → `search.run` → dashboard OK

---

## 📁 Récap **fichier par fichier** (créations/modifs)

**À créer :**

* [x] `src/search/types.ts` — types pivots structurés
* [x] `src/search/config.ts` — configuration centralisée du module
* [x] `src/search/searxClient.ts` — client SearxNG (zod, timeouts, retries)
* [x] `src/search/downloader.ts` — fetch robuste + `computeDocId`
* [x] `src/search/extractor.ts` — client Unstructured + mapping segments
* [x] `src/search/normalizer.ts` — finalisation d’ID + dédup
* [x] `src/search/ingest/toKnowledgeGraph.ts` — **`KnowledgeGraph.insert`** + provenance + mentions
* [x] `src/search/ingest/toVectorStore.ts` — **`VectorMemoryIndex.upsert`** + metadata
* [x] `src/search/pipeline.ts` — orchestration end-to-end + events
* [x] `src/search/metrics.ts` — timers/histogrammes
* [x] `src/search/index.ts` — exports module
* [x] `src/tools/search_run.ts` — tool principal (ingestion + retour docs)
* [x] `src/tools/search_index.ts` — ingestion directe d’URL(s)
* [x] `src/tools/search_status.ts` — statut job (ou “non implémenté” propre)
* [x] `docker/docker-compose.search.yml` — infra E2E
* [x] `docker/searxng/settings.yml` — config engines/catégories
* [x] `docs/search-module.md` — runbook
* [x] `tests/unit/search/*.test.ts` — 7 fichiers (client, downloader, extractor, normalizer, ingest KG, ingest Vector, pipeline)
* [x] `tests/integration/search.tools.test.ts` — intégration tools search
* [x] `tests/e2e/search.e2e.test.ts` — E2E containers

**À modifier :**

* [x] `src/mcp/registry.ts` — enregistrement des tools `search.*` (pack/tags/budgets/descriptions)
* [x] `src/monitor/dashboard.ts` — panneau Search + endpoints JSON correspondants
* [x] `src/orchestrator/runtime.ts` — wiring propre (si injection nécessaire du logger/tracing vers le pipeline)
* [x] `src/eventStore.ts` — **optionnel** : si tu décides d’ajouter `EventKind = "SEARCH"`, étendre l’union et adapter usages
* [x] `env/.env.example` — ajouter toutes les variables `SEARCH_*` et `UNSTRUCTURED_*`
* [x] `CHANGELOG.md` — nouvelle entrée

---

## 🧪 Ce qu’il faut savoir et respecter concernant **les tests** et le **build**

* **Build** :

  * [ ] `npm run build` doit compiler sans warnings ; ESM strict ; imports Node en `node:` ; `graph-forge` unaffected.
  * [ ] Respecter **`exactOptionalPropertyTypes`** : jamais `undefined` dans les objets publics ; préférer omettre la clé.

* **Tests** :

  * [ ] **Unitaires** : isoler chaque fichier logique du module ; utiliser **nock** pour mocks HTTP ; ne pas dépasser des timeouts élevés.
  * [ ] **Intégration** : valider le flow MCP tool → pipeline → KG/Vector ; vérifier les **events**.
  * [ ] **E2E** : monter les containers (`docker-compose.search.yml`), attendre **healthchecks**, lancer `npm run test:e2e`, vérifier ingestion réelle (au moins 1 doc).
  * [ ] **Couverture** : `src/search/**` ≥ 90%, global ≥ 85% ; éviter tests flaky (retries côté mocks plutôt que sleep).

* **Observabilité** :

  * [ ] Tracer les durées par étape, compter les erreurs par type (Network, Unstructured, Ingest).
  * [ ] S’assurer que le **Dashboard** expose des stats consultables (JSON + page), et que les **SSE** restent stables.

---

Si tu coches ces cases dans l’ordre, tu livreras un **moteur de recherche LLM** complet, **self-host** (SearxNG), **multimodal via unstructured**, solidement **intégré** au KnowledgeGraph et à la VectorMemory du repo, avec **outillage MCP**, **observabilité**, et **tests** robustes.
## Historique Agent


### 2025-10-28
- Vérification de l’implémentation complète du module search, mise à jour de la checklist et exécution de `npm run test:unit` (échoue ici sur `graph worker pool performance offloads heavy change-sets via worker threads when available`, `server module loader falls back to the compiled output when forced` et une sonde maintenance HTTP).

### 2025-11-18
- Réinitialisation du fichier AGENTS.md avec la nouvelle checklist fournie par l'utilisateur.
