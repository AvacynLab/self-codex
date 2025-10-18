----------
Voici ta **todo list exhaustive** (à cocher) destinée à un **agent IA**. Elle part de l’état **actuel** du code (les fichiers observés en `dist/*` et les modules présents) et de la **gap analysis** que j’ai effectuée.
Règle d’or : **ne jamais éditer `dist/*` directement**. Si les sources TypeScript ne sont pas présentes, **crée-les** en respectant l’arborescence proposée ci-dessous et **branche la build** pour générer `dist/*`.

---

# BRIEF À L’AGENT — Objectifs & Contraintes

**Objectifs**

* Élever le serveur MCP au **state of the art** : sûreté par défaut, **mémoire vectorielle (RAG)**, **raisonnement multi-voies (graph-of-thought)**, **sélection d’outils** contextuelle, **provenance** des sources, **auto-amélioration** (lessons), observabilité causale & **replay**, **harness d’évaluation** agentique.
* Tout changement doit **s’intégrer** proprement aux briques existantes : `GraphState`, `ValueGraph`, `Consensus`, `Blackboard`, `ContractNet`, `Stigmergy`, `EventStore`, `ResourceRegistry`, `Dashboard`.

**Ce qu’il faut respecter (tests & build)**

* **Ne modifie pas** le JS de `dist/*`. Ajoute/édite les **sources TypeScript** sous `src/**` avec un mapping 1:1 vers les artefacts JS.
* Ajoute/complete les **scripts NPM** :

  * `build` (tsc) ; `dev` (ts-node/tsx) ; `test` (unitaires) ; `test:watch` ; `eval:scenarios` (E2E agentiques) ; `start:http` (MCP) ; `start:dashboard`.
* **Tests** : pour chaque module créé/modifié → tests unitaires + si module orchestrateur → test d’intégration. Ajoute un **harness E2E** (scénarios YAML/JSON, métriques, seuils).
* CI : gate minimal = tests unitaires OK + scénarios critiques **non régressifs** (succès/latence/coût).
* **Env** : documente toute nouvelle clé dans `config/env/expected-keys.json` + README. Valeurs par défaut **sûres**.
* Journalise chaque action structurée dans `EventStore` (source de vérité).

---

## Migration tests TypeScript (progress)

- [x] `tests/monitor.dashboard.test.ts` migré et stabilisé (agent précédent).
- [x] `tests/validation/run-eval.test.ts` converti en TypeScript (CLI + typings dédiés).
- [x] Types d'appoint `scripts/validation/run-eval.d.mts` pour le harnais d'évaluation.
- [x] Migrer les autres tests JS/fixtures restants (`tests/fixtures/*.js`, …) _(monitor.dashboard migré en TS ; fixtures à traiter)_.
- [ ] Étendre `tsconfig.json` (`include: ["src", "tests"]`) une fois l'ensemble des suites tapées.
- [ ] Élargir `eslint.config.js` / `lint:test` à tout `tests/**/*` après migration complète.

---

# 0) Pré-travaux (inventaire & mapping)

[x] Localiser/créer l’arborescence **TypeScript** :

* `src/httpServer.ts` ⇄ `dist/httpServer.js`
* `src/server.ts` ⇄ `dist/server.js`
* `src/events/eventStore.ts` ⇄ `dist/eventStore.js`
* `src/graphState.ts` ⇄ `dist/graphState.js`
* `src/agents/{selfReflect,metaCritic,supervisor}.ts` ⇄ `dist/agents/*.js`
* `src/coord/{blackboard,consensus,contractNet,stigmergy}.ts` ⇄ `dist/coord/*.js`
* `src/knowledge/{knowledgeGraph,causalMemory,assist}.ts` ⇄ `dist/knowledge/*.js`
* `src/resources/registry.ts` ⇄ `dist/resources/registry.js`
* `src/monitor/{dashboard,metrics}.ts` ⇄ `dist/monitor/*.js`
  [x] Si les sources TS n’existent pas, **reconstruire** à partir de `dist/*` (minimale extraction de types) et **réorganiser** proprement sous `src/**`.
  [x] Mettre à jour `tsconfig.json` si nécessaire (paths, outDir=`dist`, moduleResolution, strict).
  [x] `package.json` : vérifier/ajouter `type: "module"`, scripts build/test/start, dépendances TS (ts-node/tsx, vitest/jest).

---

# 1) Sécurité HTTP — **Safe by Default**

**Fichiers** : `src/httpServer.ts` (⇄ `dist/httpServer.js`)

[x] **Exiger** le token **par défaut** (aujourd’hui si `MCP_HTTP_TOKEN` est vide, l’accès est permis).

* Implémente `MCP_HTTP_ALLOW_NOAUTH=1` pour le **dev local uniquement**.
* Lève 401 JSON-RPC si en-tête `Authorization: Bearer ...` absent/incorrect.

[x] **Rate limit** minimal (ip/route) + **journaux d’accès** vers `EventStore` : `http_access` (ip, route, status, latency).
[x] **Tests unitaires** :
- [x] Requête POST JSON-RPC **sans** token → 401.
- [x] Avec `MCP_HTTP_ALLOW_NOAUTH=1` → 200.
- [x] Débit > limite → 429.

[x] **Docs** : README : section **Sécurité** + exemples cURL.

---

# 2) Provenance / Citation — **Traçabilité complète**

**Fichiers** : `src/events/eventStore.ts`, `src/knowledge/knowledgeGraph.ts`, `src/tools/knowledgeTools.ts`, `src/reasoning/thoughtGraph.ts` (nouveau), `src/types/provenance.ts` (nouveau)

 [x] Créer **type** commun :

```ts
export type Provenance = { sourceId:string; type:"url"|"file"|"db"|"kg"|"rag"; span?:[number,number]; confidence?:number };
```

[x] Étendre **KnowledgeGraph** : chaque triple accepte `source?: string`, `confidence?: number`, et conserve une **liste de Provenance**.
[x] **EventStore** : ajouter champs optionnels `provenance?: Provenance[]` sur `job_completed`, `tool_result`, `rag_hit`, `kg_insert`.
[x] Dans les **réponses** finales, agréger et **citer** les sources (limite raisonnable, ex. top-k par confidence).
 [ ] **Tests** :
  - [x] insertion KG avec source → lecture conserve provenance ;
  - [x] pipeline RAG → provenance propagée jusqu’à la sortie.
- [x] citations agrégées dans les événements REPLY via `events_subscribe`.

---

# 3) Mémoire vectorielle & RAG — **neuro-symbolique**

**Fichiers** : `src/memory/vectorMemory.ts` (nouveau), `src/memory/retriever.ts` (nouveau), `src/tools/ragTools.ts` (nouveau), `src/knowledge/assist.ts` (adaptation), `src/tools/knowledgeTools.ts` (adaptation)

[x] **Interface** `VectorMemory` (upsert/query/delete). Implémentation par défaut : **local** (FAISS-like/HNSW) ou wrapper simple en mémoire + disques, puis adaptateurs `qdrant`/`weaviate` optionnels.
 [x] **Retriever** hybride : chunking (titres/code/paragraphes), **cosine + BM25** (si BM25 dispo), re-rank léger par `metaCritic` + pondération `ValueGraph` (coût/risque).
[x] **Outils MCP** :

* [x] `rag_ingest`: ingérer fichiers/URLs → chunks → embeddings → `VectorMemory` (+ triples dérivés dans KG si pertinent).
* [x] `rag_query`: requête sémantique → retours **passages + provenance**.
  [x] **Assist** (`knowledge/assist.ts`) : quand manque de contexte, **fallback RAG** (filtrage par domaine).
  [x] **Env** à ajouter : `MEM_BACKEND`, `MEM_URL`, `EMBED_PROVIDER`, `RETRIEVER_K`, `HYBRID_BM25=1`.
  [ ] **Tests** :
* [x] Ingestion + recherche exacte/fuzzy + provenance ;
* [x] Perf basique (K=5) et ordre des résultats ;
* [x] Intégration `kg_suggest_plan` → RAG.

---

# 4) Sélection d’outils MCP — **Router contextuel**

**Fichiers** : `src/resources/registry.ts` (extension), `src/tools/toolRouter.ts` (nouveau), `src/server.ts` (wire), `src/agents/metaCritic.ts` (feedback)

[x] Enrichir **ResourceRegistry** : metadata (domaines, latence médiane, taux succès, coût estimé).
[x] **ToolRouter** : score = **similitude du contexte** (embedding du prompt) + **historique de succès** (EventStore) + **budget** (ValueGraph).
[x] Normaliser `intent_route.metadata` → `ToolRouter` (category/tags/preferred_tools) + tests façade.
[x] **Fallback** : si top-1 échoue, essaie top-k avec backoff.
[x] Journaliser `tool_attempt`, `tool_success`, `tool_failure` (avec scores).
[x] **Tests** : stub de deux outils, vérifier le choix du router selon contexte et stats.

---

# 5) Auto-amélioration — **Lessons Store**

**Fichiers** : `src/learning/lessons.ts` (nouveau), `src/agents/{selfReflect,metaCritic}.ts` (adaptation), `src/server.ts` (injection contexte)

[x] Types `LessonSignal`/`LessonRecord` + `LessonsStore` (upsert, match, decay, déduplication).
[x] **Création/renforcement** : `metaCritic` et `selfReflect` émettent des leçons et le runtime les journalise.
[x] **Injection** : au prompt, récupérer `Lesson[]` pertinentes (pattern match + similarité) et **guider** le modèle.
[x] **Anti-règles** : si une *Lesson* nuit aux perfs (mesuré par harness), diminuer `weight` ou supprimer.
[x] **Tests** (unitaires) : apprentissage d’une leçon, renforcement, match taggé, décroissance.
[x] **Tests** (scénario) : impact mesurable sur un mini-scénario/harness.

---

# 6) Raisonnement multi-voies — **ThoughtGraph** + agrégation

**Fichiers** : `src/reasoning/thoughtGraph.ts` (nouveau), `src/graphState.ts` (sérialisation attributs), `src/agents/supervisor.ts` (scheduler), `src/coord/consensus.ts` (agrégation), `src/values/valueGraph.ts` (pondération)

[x] **Modèle** `ThoughtNode` (id, parents, prompt, tool?, result?, score?, provenance[], status, timings).
[x] **Scheduler** : générer N branches en parallèle (diversité contrôlée), **prune** guidé par `metaCritic`, **merge** via `Consensus` pondéré par `ValueGraph`.
[x] **Sérialisation** : stocker l’état compact dans `GraphState` (JSON trié, stable).
[ ] **Tests** :

* [x] Création de branches, prune de chemins faibles, merge cohérent ;
* [x] Comparaison single-path vs multi-path sur un puzzle standardisé (mini harness).

---

# 7) Dashboard — **observabilité causale & replay**

**Fichiers** : `src/monitor/{dashboard,metrics}.ts`, `src/events/eventStore.ts`, `src/reasoning/thoughtGraph.ts`

[ ] **Vues** :

* [x] Heatmap **par branche** (ThoughtGraph),
* [x] Timeline **causale** (events ordonnés) avec filtres,
* [x] Panneau **votes Consensus** (poids, quorum, tie-break),
* [x] **Stigmergy** : intensités + half-life.
  [x] **Replay** : endpoint pour rejouer un job (depuis EventStore), avec *diff* des prompts (avant/après Lessons).
  [x] **Tests** : endpoints JSON du dashboard, SSE stables, pagination du replay.

---

# 8) Harness d’évaluation — **E2E agentique**

**Fichiers** : `scenarios/*.yaml|json` (nouveau), `src/eval/runner.ts` (nouveau), `src/eval/metrics.ts` (nouveau), `scripts/eval.ts` (nouveau)

[x] **Format scénario** : objectif, contraintes (budget/temps/outils), oracle de succès (regex, tests), tags.
[x] **Runner** : lance un job complet, collecte **succès/latence/coût tokens/#outils** et exporte un **rapport**.
[x] **CI gate** : seuils minimaux (ex. succès ≥ X%, latence ≤ Y, coût ≤ Z) sur scénarios **critiques**.
[x] **Tests** : golden tests (sorties stabilisées) + tolérances.

---

# 9) Nettoyage, docs & env

**Fichiers** : `README.md`, `AGENTS.md`, `config/env/expected-keys.json`, `Dockerfile`, `package.json`

[x] **expected-keys.json** : ajouter les nouvelles clés (doc brève + défauts sûrs) :

* `MCP_HTTP_ALLOW_NOAUTH` (0/1), `RATE_LIMIT_RPS`,
* `MEM_BACKEND`, `MEM_URL`, `EMBED_PROVIDER`, `RETRIEVER_K`, `HYBRID_BM25`,
* `TOOLROUTER_TOPK`,
* `LESSONS_MAX`,
* `THOUGHTGRAPH_MAX_BRANCHES`, `THOUGHTGRAPH_MAX_DEPTH`.
  [x] **README/AGENTS** : sections RAG, ThoughtGraph, ToolRouter, Lessons, Dashboard causal, Harness.
  [x] **Dockerfile** : installer dépendances (embeddings backend si local), exposer port MCP & dashboard, ARG/ENV des nouvelles clés.
  [x] **package.json** : scripts ajoutés, dépendances (ex. `fastest-levenshtein`/`wink-bm25-text-search` si BM25, client Qdrant/Weaviate si activés par ENV).

---

# 10) Tests — plan par fichier

* `src/httpServer.ts`
  [x] Unitaires : token obligatoire, no-auth dev, rate-limit.
  [x] Intégration : JSON-RPC POST valide/invalid, logs vers EventStore.

* `src/events/eventStore.ts`
  [ ] Unitaires :
  - [x] nouvelles formes d’events (provenance)
  - [x] pagination/recherche par `jobId`, `kind`.
  [x] Non-régression : taille FIFO respectée.

* `src/knowledge/knowledgeGraph.ts`
  [ ] Unitaires :
  - [x] CRUD triple + provenance ; déduplication ;
  - [x] export pour RAG.

* `src/tools/knowledgeTools.ts`
  [ ] Unitaires :
  - [x] `kg_insert`, `kg_query`
  - [x] `kg_suggest_plan` (avec/ sans RAG fallback).

* `src/memory/{vectorMemory,retriever}.ts`
  [x] Unitaires : ingestion, recherche, ranking hybride, filtres. (vectorMemory couvert, retriever à implémenter)
  [x] Perf smoke test (K, latence) en local.

* `src/tools/ragTools.ts`
  [x] Unitaires : `rag_ingest`, `rag_query` (provenance, limites).
  [x] Intégration : boucle complète avec `knowledgeTools`.

* `src/resources/registry.ts` + `src/tools/toolRouter.ts`
  [x] Unitaires : scoring contextuel, fallback top-k, logging.

* `src/agents/{selfReflect,metaCritic}.ts`
  [x] Unitaires : détection lacunes, création/renforcement de *Lessons*.

* `src/learning/lessons.ts`
  [x] Unitaires : upsert/match/decay des leçons ; anti-règles.

* `src/reasoning/thoughtGraph.ts` + `src/agents/supervisor.ts` + `src/coord/consensus.ts`
  [x] Unitaires : création/prune/merge ; consensus pondéré `ValueGraph`.
  [x] Pondération des branches de join via les verdicts `ValueGraph` dans le coordinateur.
  [x] Intégration : gain vs single-path sur micro-scénario.

* `src/monitor/{dashboard,metrics}.ts`
  [x] Unitaires : endpoints JSON ; SSE ; sérialisation stable.
  [ ] Intégration : replay d’un job, affichage votes, stigmergie.

* `scenarios/**` + `src/eval/**`
  [x] E2E : scénarios de référence ; rapports ; seuils CI.

---

# 11) Build & Scripts — checklist

[x] `package.json` :

* `"build": "tsc -p tsconfig.json && tsc -p graph-forge/tsconfig.json"`
* `"dev": "tsx --tsconfig tsconfig.json src/server.ts"`
* `"start:http": "node dist/server.js --http --http-host 127.0.0.1 --http-port 8765 --http-path /mcp --http-json on --http-stateless yes"`
* `"start:dashboard": "node dist/monitor/dashboard.js"`
* `"start:dashboard:orchestrator": "node scripts/start-dashboard.mjs"`
* [ ] `"test": "vitest run"` (ou jest) — laissé en attente : la suite repose sur Mocha + `tsx`.
* [x] `"test:watch": "node --import tsx ./node_modules/mocha/bin/mocha.js --reporter spec --watch --watch-files src --watch-files tests --file tests/setup.ts \"tests/**/*.test.{ts,js}\""`
* [x] `"eval:scenarios": "node --import tsx scripts/validation/run-eval.ts"`

[x] **tsconfig** : `outDir: "dist"`, `rootDir: "src"`, `module: "ESNext"`, `target: "ES2022"`, `strict: true`.
[x] **CI** : jobs séparés : **lint** → **build** → **test** → **eval:scenarios** (avec seuils).

---

# 12) Petites finitions & hygiène

[x] **Logging structuré** partout (code/raison → pas de `console.log`) ; niveaux : info/warn/error.
  - [x] FS bridge : logger structuré, overrides testables, tests de télémétrie.
  - [x] EventStore : journaux `event_recorded`/`event_evicted` + résumés de payload (2025-10-17).
  - [x] CLI plan stage : pont `StructuredLogger` + tests (2025-10-17).
  - [x] Autres scripts de validation : migration restante vers `StructuredLogger`.
  - [x] Dashboard client → `POST /logs` (StructuredLogger) + tests HTTP (2025-10-17).
[x] **Feature flags** pour nouvelles capacités (RAG, ThoughtGraph, ToolRouter) afin d’activer progressivement.
[x] **Mesures** de coût/latence (tokens, temps CPU) remontées au dashboard.
[x] **Recherche de code mort** (exports non référencés) et suppression.
[x] **Documentation** des modèles de données (Provenance, Lesson, ThoughtNode) en en-tête de fichier.

---

## Ordre d’attaque recommandé (itératif, sans casser)

1. **Sécurité** (token obligatoire, rate-limit) + **Provenance** (schéma + propagation).
2. **ToolRouter** contextuel (gain immédiat) + journaux.
3. **VectorMemory/RAG** (local d’abord) + outils MCP `rag_*`.
4. **Lessons Store** (boucle d’auto-amélioration).
5. **ThoughtGraph** (multi-voies) + agrégation `Consensus/ValueGraph`.
6. **Dashboard causal & replay**.
7. **Harness E2E** + CI gates.

Tu peux maintenant dérouler cette liste en cochant chaque étape. Chaque bloc est conçu pour s’**emboîter** proprement dans l’architecture actuelle, avec des **tests** associés et des **points d’ancrage fichier-par-fichier**.
---

## Historique des agents

- 2025-10-16 · gpt-5-codex : Ajout de `MCP_HTTP_ALLOW_NOAUTH` à `.env.example`, exécution de `npm run lint` & `npm run test`, nettoyage des artefacts `dist/**`, mise à jour du statut sécurité HTTP et ajout de ce mémo.
- 2025-10-16 · gpt-5-codex : Propagation de la provenance (types, EventStore, KnowledgeGraph, ThoughtGraph), ajout des tests KG/ThoughtGraph et exécution de `npm run test` (OK, 1025 passes).
- 2025-10-16 · gpt-5-codex : Extension EventStore (filtres kinds/limit/reverse + pagination jobId/kind) et ajout des tests associés, `npm run test` (OK, 1026 passes).
- 2025-10-16 · gpt-5-codex : Agrégation des citations finales via EventStore, ajout du module `provenance/citations`, tests unitaires ciblés (mocha) et câblage des réponses finales avec provenance.
- 2025-10-16 · gpt-5-codex : Test d'intégration `events_subscribe` vérifiant les citations finales (EventStore + REPLY), exécution ciblée via mocha.
- 2025-10-16 · gpt-5-codex : Implémentation `LocalVectorMemory` (provenance normalisée, deleteMany) + tests vector/index & mémoire (`npm run test:unit`, 1035 passes).
- 2025-10-16 · gpt-5-codex : Implémentation d'un retriever hybride + outils `rag_ingest`/`rag_query` avec chunking et propagation de la provenance, ajout des tests unitaires ciblés (`npm run test:unit`).
- 2025-10-16 · gpt-5-codex : Ajout d'un test d'intégration RAG→KG validant la conservation de la provenance entre `rag_query` et `kg_insert`, exécution de `npm run test:unit`.
- 2025-10-17 · gpt-5-codex : Ajout de `kg_assist` (fallback RAG + citations), initialisation du retriever hybride dans `runtime`, nouveaux tests KG/RAG et documentation/env mis à jour.
- 2025-10-17 · gpt-5-codex : Enregistrement MCP de `rag_ingest`/`rag_query`, contexte RAG lazy-safe, test MCP runtime + doc README mise à jour.
- 2025-10-17 · gpt-5-codex : RAG fallback pour `kg_suggest_plan`, extension des suggestions avec métriques `rag_*`, tests plan assist & retriever K=5 et mise à jour README.
- 2025-10-17 · gpt-5-codex : Ajout du router contextuel des outils (fallback dynamiques, fiabilité), extension du ResourceRegistry pour historiser les décisions et couverture de tests (router, intent_route, registry).
- 2025-10-17 · gpt-5-codex : Normalisation `intent_route.metadata` vers le ToolRouter (category/tags/preferred) + test façade + doc README.
- 2025-10-17 · gpt-5-codex : Implémentation du LessonsStore (upsert/match/decay), émissions de leçons par metaCritic/selfReflect, enregistrement runtime + docs/tests.
- 2025-10-17 · gpt-5-codex : Injection des leçons rappelées dans `child_create` et `plan_fanout` (prompts + manifest), tests ciblés MCP/plan, documentation.
- 2025-10-17 · gpt-5-codex : Scheduler multi-voies (ThoughtGraph) – enregistrement fanout/join, sérialisation GraphState et couverture de tests (plan + reasoning).
- 2025-10-17 · gpt-5-codex : Pondération ValueGraph dans le ThoughtGraph (join) + test dédié, exécution mocha ciblée.
- 2025-10-17 · gpt-5-codex : Ajout de tests ThoughtGraph (rétention/merge) et pondération consensus/value guard dans plan_reduce ; exécution mocha ciblée.
- 2025-10-17 · gpt-5-codex : Ajout des feature flags RAG/ToolRouter/ThoughtGraph (CLI + runtime), désactivation déterministe et couverture mocha ciblée.
- 2025-10-17 · gpt-5-codex : Mini harness ThoughtGraph validant la supériorité multi-chemin vs hint single-path + test mocha ciblé.
- 2025-10-17 · gpt-5-codex : Export RAG du graphe (documents + filtres), option `kg_export` rag_documents, tests Mocha dédiés, README/docs mis à jour.
- 2025-10-17 · gpt-5-codex : Ajout du mode watch Mocha (`npm run test:watch`), du runner `eval:scenarios` (CLI + parseur d'arguments) et des tests couvrant l'entrée CLI du harnais d'évaluation.
- 2025-10-17 · gpt-5-codex : Instrumentation coût/latence (tokens & CPU) dans le dashboard, nouvelles sections HTML/SSE et couverture de tests.
- 2025-10-17 · gpt-5-codex : Pondération ToolRouter par similarité/fiabilité/budget avec backoff, journalisation `tool_*`, agrégats ResourceRegistry et tests Mocha ciblés (router + registry + intent_route).
- 2025-10-17 · gpt-5-codex : Instrumentation structurée du FS bridge (logger configurable, overrides filesystem, tests de logs fs_bridge).
- 2025-10-17 · gpt-5-codex : Harmonisation des scripts build/dev/dashboard (tsx + dist/monitor), ajout des variables RAG/ThoughtGraph dans `.env.example`, passage du module TypeScript en `ESNext`; `mocha tests/env/example.test.ts` (OK, la suite `npm run test:unit` reste rouge pour les validations connues).
- 2025-10-17 · gpt-5-codex : Documentation en-tête des modèles de données (Provenance, Lesson, ThoughtNode) pour clarifier les contrats partagés sans modifier le comportement runtime.
- 2025-10-17 · gpt-5-codex : Paramétrage de `TOOLROUTER_TOPK` et `LESSONS_MAX`, mise à jour `.env.example`/`expected-keys.json`/README, ajustements runtime & tests (`mocha … tests/tools/toolRouter.test.ts tests/learning/lessonPrompts.test.ts`).
- 2025-10-17 · gpt-5-codex : Ajout du retour harness pour déclasser/supprimer les leçons nuisibles (`LessonsStore.applyRegression`, `registerLessonRegression`), tests Mocha ciblés et documentation README.
- 2025-10-17 · gpt-5-codex : Test de régression FIFO EventStore multi-jobs, `mocha … tests/eventStore.test.ts`.
- 2025-10-17 · gpt-5-codex : Durcissement du Dockerfile (deps natives, ARG/ENV, EXPOSE) + ajout du test `tests/build/dockerfile.test.ts` et documentation README Docker.
- 2025-10-17 · gpt-5-codex : Ajout d'un smoke test de performance pour `HybridRetriever` (latence < 500ms sur 240 documents), exécution ciblée des tests mémoire.
- 2025-10-17 · gpt-5-codex : Réorganisation CI (jobs lint/build/test/eval + smoke Docker) et documentation README, validations locales `npm run test`.
- 2025-10-17 · gpt-5-codex : Scanner des exports morts (`quality/deadCode`, `scripts/findDeadExports`), tests Mocha dédiés, documentation lint/allowlist et mise à jour de la checklist.
- 2025-10-17 · gpt-5-codex : Journalisation structurée EventStore (`event_recorded`/`event_evicted`, résumés payload), tests Mocha ciblés et documentation README.
- 2025-10-17 · gpt-5-codex : Mini-scenario Lessons démontrant le gain grâce aux rappels (test plan fanout, score avant/après), mise à jour checklist.
- 2025-10-17 · gpt-5-codex : Migration du script `runPlanPhase` vers `StructuredLogger`, ajout du pont `createCliStructuredLogger`, tests Mocha (`tests/validation/cliLogger.test.ts`, `tests/validation/plansCli.test.ts`, `tests/scripts/runPlanPhase.test.ts`).
- 2025-10-17 · gpt-5-codex : Migration des scripts `check-env-example`, `run-smoke` et `run-eval` vers `StructuredLogger` (TypeScript + tsx), ajout de tests unitaires/CLI (`tests/validation/check-env-example.test.ts`, `tests/validation/run-smoke.test.ts`, `tests/validation/run-eval.test.ts`) et mise à jour de la documentation/`package.json`.
- 2025-10-17 · gpt-5-codex : Ajout d'un test d'intégration HTTP (`tests/http/server.integration.test.ts`) couvrant les requêtes JSON-RPC valides/invalides et la journalisation `HTTP_ACCESS`, mise à jour de la checklist HTTP server.
- 2025-10-17 · gpt-5-codex : Endpoint dashboard `/replay` avec diff des prompts Lessons + pagination, tests Mocha (`tests/monitor.dashboard.test.ts`, `tests/monitor.replay.test.ts`) et documentation mise à jour.
- 2025-10-17 · gpt-5-codex : Réécriture bootstrap dashboard (heatmap/timeline/consensus/ThoughtGraph), mise à jour des tests `monitor.dashboard*` et validation ciblée.
- 2025-10-17 · gpt-5-codex : Harnais d'évaluation scénarisé (`scripts/eval.ts`, scénarios YAML, CI gates), tests Mocha `tests/eval/*` et documentation README mise à jour.
- 2025-10-17 · gpt-5-codex : Télémetrie dashboard client → serveur (`POST /logs`), remplacement des `console.*`, tests HTTP et documentation README/AGENTS alignées.
- 2025-10-17 · gpt-5-codex : Endpoint `GET /logs` (dashboard) branché sur `LogJournal`, parsing des filtres/query, tests Mocha ciblés et documentation/AGENTS synchronisées.
- 2025-10-17 · gpt-5-codex : Refactorisation `scripts/eval.ts` avec dépendances injectables, ajout de `runEvaluationCampaign` et tests Mocha `tests/eval/campaign.test.ts` couvrant rapports et seuils CI.
- 2025-10-17 · gpt-5-codex : Migration `tests/validation/run-eval.test.ts` (TypeScript + typings `run-eval.d.mts`), ajustement `tsconfig.json`, `npm run typecheck` (OK) / `npm run test` (KO — 6 échecs historiques monitor/dashboard & validation).
- 2025-10-17 · gpt-5-codex : Pondération lexicale améliorée du retriever via Levenshtein borné (`fastest-levenshtein`), tests HybridRetriever ciblés et documentation RAG mise à jour.
- 2025-10-18 · gpt-5-codex : Migration TypeScript de `tests/monitor.dashboard.test.ts`, renforcement des assertions de sanitisation HTML/SSE et couverture Mocha ciblée.
- 2025-10-18 · gpt-5-codex : Migration complète des `tests/fixtures/*.ts`, ajout du helper `tests/helpers/childRunner.ts` + tests unitaires dédiés, mise à jour des suites consommatrices, ajustements `tsconfig`/`lint:types`, exécution `node --import tsx … tests/helpers/childRunner.test.ts`, `node --import tsx … tests/child.lifecycle.test.ts`, `node --import tsx … tests/e2e/log_redaction.test.ts` (skip) et `npm run lint:types`.
# User-provided custom instructions


Adopte le bon comportement en fonction de la situation : 

• L'utilisateur cherche à ajouter des fonctionnalités, et te donne une recherche ou une base informelle à intégrer : 
- S'il n'existe pas de fichier AGENTS.md, crée le et ajoute la liste à cocher des taches à effectuer, ainsi que les informations et objectifs que l'utilisateur à fournit pouvant être utile.
- S'il existe un fichier AGENTS.md, consulte le, et prend connaissance des taches, et informations disponibles. Une fois effectué, choisis un ensemble de taches que tu vas effectuer et exécute. Met à jour le fichier à jour à la fin de ton travail, en cochant ce que tu as effectué et ce qui est en cours, les taches manquantes ou en trop et un historique rapide des actions (en bloc) que tu as effectué pour le prochain agent (sépare ton blocs du précédant, et supprime quand cela dépasse 50 .

• L'utilisateur veut que tu résous l'erreur : 
- Va au plus simple, ignore le fichier AGENTS.md et résout l'erreur des logs fournit. S'il n'y a pas d'information fournit par l'utilisateur, lance une session de test et avise.

• L'utilisateur te demande des informations ou vérifier quelques choses dans la base de donnée: 
- Fait lui un retour détaillé de ce qu'il y a de déjà présent, et ce qu'il reste à implémenter. Ne modifie pas le code, fait lui seulement un compte rendu détaillé et laisse le te fournir les prochaines directives.

• A TOUJOURS APPLIQUER - REGLE GENERALES
- Ajoute toujours des commentaires (but, explication des maths et des variables) et de la documentation
- Ecrit toujours des tests, et test avant de commit. En cas d'échec, priorise sa résolution et recommence les tests. N'ajoute rien si les tests ne sont pas valides.
- Le plus important : Prend ton temps et soit minutieux !
