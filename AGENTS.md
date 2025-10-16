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

# 0) Pré-travaux (inventaire & mapping)

[ ] Localiser/créer l’arborescence **TypeScript** :

* `src/httpServer.ts` ⇄ `dist/httpServer.js`
* `src/server.ts` ⇄ `dist/server.js`
* `src/events/eventStore.ts` ⇄ `dist/eventStore.js`
* `src/graphState.ts` ⇄ `dist/graphState.js`
* `src/agents/{selfReflect,metaCritic,supervisor}.ts` ⇄ `dist/agents/*.js`
* `src/coord/{blackboard,consensus,contractNet,stigmergy}.ts` ⇄ `dist/coord/*.js`
* `src/knowledge/{knowledgeGraph,causalMemory,assist}.ts` ⇄ `dist/knowledge/*.js`
* `src/resources/registry.ts` ⇄ `dist/resources/registry.js`
* `src/monitor/{dashboard,metrics}.ts` ⇄ `dist/monitor/*.js`
  [ ] Si les sources TS n’existent pas, **reconstruire** à partir de `dist/*` (minimale extraction de types) et **réorganiser** proprement sous `src/**`.
  [ ] Mettre à jour `tsconfig.json` si nécessaire (paths, outDir=`dist`, moduleResolution, strict).
  [ ] `package.json` : vérifier/ajouter `type: "module"`, scripts build/test/start, dépendances TS (ts-node/tsx, vitest/jest).

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
[ ] Dans les **réponses** finales, agréger et **citer** les sources (limite raisonnable, ex. top-k par confidence).
[ ] **Tests** :
- [x] insertion KG avec source → lecture conserve provenance ;
- [ ] pipeline RAG → provenance propagée jusqu’à la sortie.

---

# 3) Mémoire vectorielle & RAG — **neuro-symbolique**

**Fichiers** : `src/memory/vectorMemory.ts` (nouveau), `src/memory/retriever.ts` (nouveau), `src/tools/ragTools.ts` (nouveau), `src/knowledge/assist.ts` (adaptation), `src/tools/knowledgeTools.ts` (adaptation)

[ ] **Interface** `VectorMemory` (upsert/query/delete). Implémentation par défaut : **local** (FAISS-like/HNSW) ou wrapper simple en mémoire + disques, puis adaptateurs `qdrant`/`weaviate` optionnels.
[ ] **Retriever** hybride : chunking (titres/code/paragraphes), **cosine + BM25** (si BM25 dispo), re-rank léger par `metaCritic` + pondération `ValueGraph` (coût/risque).
[ ] **Outils MCP** :

* `rag_ingest`: ingérer fichiers/URLs → chunks → embeddings → `VectorMemory` (+ triples dérivés dans KG si pertinent).
* `rag_query`: requête sémantique → retours **passages + provenance**.
  [ ] **Assist** (`knowledge/assist.ts`) : quand manque de contexte, **fallback RAG** (filtrage par domaine).
  [ ] **Env** à ajouter : `MEM_BACKEND`, `MEM_URL`, `EMBED_PROVIDER`, `RETRIEVER_K`, `HYBRID_BM25=1`.
  [ ] **Tests** :
* Ingestion + recherche exacte/fuzzy + provenance ;
* Perf basique (K=5) et ordre des résultats ;
* Intégration `kg_suggest_plan` → RAG.

---

# 4) Sélection d’outils MCP — **Router contextuel**

**Fichiers** : `src/resources/registry.ts` (extension), `src/tools/toolRouter.ts` (nouveau), `src/server.ts` (wire), `src/agents/metaCritic.ts` (feedback)

[ ] Enrichir **ResourceRegistry** : metadata (domaines, latence médiane, taux succès, coût estimé).
[ ] **ToolRouter** : score = **similitude du contexte** (embedding du prompt) + **historique de succès** (EventStore) + **budget** (ValueGraph).
[ ] **Fallback** : si top-1 échoue, essaie top-k avec backoff.
[ ] Journaliser `tool_attempt`, `tool_success`, `tool_failure` (avec scores).
[ ] **Tests** : stub de deux outils, vérifier le choix du router selon contexte et stats.

---

# 5) Auto-amélioration — **Lessons Store**

**Fichiers** : `src/learning/lessons.ts` (nouveau), `src/agents/{selfReflect,metaCritic}.ts` (adaptation), `src/server.ts` (injection contexte)

[ ] Type `Lesson = { pattern:string; advice:string; evidence:{jobId:string; score:number}[]; weight:number; createdAt:number }`.
[ ] **Création/renforcement** : sur échecs répétitifs détectés par `metaCritic`, générer/renforcer une *Lesson*.
[ ] **Injection** : au prompt, récupérer `Lesson[]` pertinentes (pattern match + similarité) et **guider** le modèle.
[ ] **Anti-règles** : si une *Lesson* nuit aux perfs (mesuré par harness), diminuer `weight` ou supprimer.
[ ] **Tests** : apprentissage d’une leçon, récupération et impact mesurable sur un mini-scénario.

---

# 6) Raisonnement multi-voies — **ThoughtGraph** + agrégation

**Fichiers** : `src/reasoning/thoughtGraph.ts` (nouveau), `src/graphState.ts` (sérialisation attributs), `src/agents/supervisor.ts` (scheduler), `src/coord/consensus.ts` (agrégation), `src/values/valueGraph.ts` (pondération)

[x] **Modèle** `ThoughtNode` (id, parents, prompt, tool?, result?, score?, provenance[], status, timings).
[ ] **Scheduler** : générer N branches en parallèle (diversité contrôlée), **prune** guidé par `metaCritic`, **merge** via `Consensus` pondéré par `ValueGraph`.
[ ] **Sérialisation** : stocker l’état compact dans `GraphState` (JSON trié, stable).
[ ] **Tests** :

* Création de branches, prune de chemins faibles, merge cohérent ;
* Comparaison single-path vs multi-path sur un puzzle standardisé (mini harness).

---

# 7) Dashboard — **observabilité causale & replay**

**Fichiers** : `src/monitor/{dashboard,metrics}.ts`, `src/events/eventStore.ts`, `src/reasoning/thoughtGraph.ts`

[ ] **Vues** :

* Heatmap **par branche** (ThoughtGraph),
* Timeline **causale** (events ordonnés) avec filtres,
* Panneau **votes Consensus** (poids, quorum, tie-break),
* **Stigmergy** : intensités + half-life.
  [ ] **Replay** : endpoint pour rejouer un job (depuis EventStore), avec *diff* des prompts (avant/après Lessons).
  [ ] **Tests** : endpoints JSON du dashboard, SSE stables, pagination du replay.

---

# 8) Harness d’évaluation — **E2E agentique**

**Fichiers** : `scenarios/*.yaml|json` (nouveau), `src/eval/runner.ts` (nouveau), `src/eval/metrics.ts` (nouveau), `scripts/eval.ts` (nouveau)

[ ] **Format scénario** : objectif, contraintes (budget/temps/outils), oracle de succès (regex, tests), tags.
[ ] **Runner** : lance un job complet, collecte **succès/latence/coût tokens/#outils** et exporte un **rapport**.
[ ] **CI gate** : seuils minimaux (ex. succès ≥ X%, latence ≤ Y, coût ≤ Z) sur scénarios **critiques**.
[ ] **Tests** : golden tests (sorties stabilisées) + tolérances.

---

# 9) Nettoyage, docs & env

**Fichiers** : `README.md`, `AGENTS.md`, `config/env/expected-keys.json`, `Dockerfile`, `package.json`

[ ] **expected-keys.json** : ajouter les nouvelles clés (doc brève + défauts sûrs) :

* `MCP_HTTP_ALLOW_NOAUTH` (0/1), `RATE_LIMIT_RPS`,
* `MEM_BACKEND`, `MEM_URL`, `EMBED_PROVIDER`, `RETRIEVER_K`, `HYBRID_BM25`,
* `TOOLROUTER_TOPK`,
* `LESSONS_MAX`,
* `THOUGHTGRAPH_MAX_BRANCHES`, `THOUGHTGRAPH_MAX_DEPTH`.
  [ ] **README/AGENTS** : sections RAG, ThoughtGraph, ToolRouter, Lessons, Dashboard causal, Harness.
  [ ] **Dockerfile** : installer dépendances (embeddings backend si local), exposer port MCP & dashboard, ARG/ENV des nouvelles clés.
  [ ] **package.json** : scripts ajoutés, dépendances (ex. `fastest-levenshtein`/`wink-bm25-text-search` si BM25, client Qdrant/Weaviate si activés par ENV).

---

# 10) Tests — plan par fichier

* `src/httpServer.ts`
  [ ] Unitaires : token obligatoire, no-auth dev, rate-limit.
  [ ] Intégration : JSON-RPC POST valide/invalid, logs vers EventStore.

* `src/events/eventStore.ts`
  [ ] Unitaires :
  - [x] nouvelles formes d’events (provenance)
  - [ ] pagination/recherche par `jobId`, `kind`.
  [ ] Non-régression : taille FIFO respectée.

* `src/knowledge/knowledgeGraph.ts`
  [ ] Unitaires :
  - [x] CRUD triple + provenance ; déduplication ;
  - [ ] export pour RAG.

* `src/tools/knowledgeTools.ts`
  [ ] Unitaires :
  - [x] `kg_insert`, `kg_query`
  - [ ] `kg_suggest_plan` (avec/ sans RAG fallback).

* `src/memory/{vectorMemory,retriever}.ts`
  [ ] Unitaires : ingestion, recherche, ranking hybride, filtres.
  [ ] Perf smoke test (K, latence) en local.

* `src/tools/ragTools.ts`
  [ ] Unitaires : `rag_ingest`, `rag_query` (provenance, limites).
  [ ] Intégration : boucle complète avec `knowledgeTools`.

* `src/resources/registry.ts` + `src/tools/toolRouter.ts`
  [ ] Unitaires : scoring contextuel, fallback top-k, logging.

* `src/agents/{selfReflect,metaCritic}.ts`
  [ ] Unitaires : détection lacunes, création/renforcement de *Lessons*.

* `src/learning/lessons.ts`
  [ ] Unitaires : upsert/match/decay des leçons ; anti-règles.

* `src/reasoning/thoughtGraph.ts` + `src/agents/supervisor.ts` + `src/coord/consensus.ts`
  [ ] Unitaires : création/prune/merge ; consensus pondéré `ValueGraph`.
  [ ] Intégration : gain vs single-path sur micro-scénario.

* `src/monitor/{dashboard,metrics}.ts`
  [ ] Unitaires : endpoints JSON ; SSE ; sérialisation stable.
  [ ] Intégration : replay d’un job, affichage votes, stigmergie.

* `scenarios/**` + `src/eval/**`
  [ ] E2E : scénarios de référence ; rapports ; seuils CI.

---

# 11) Build & Scripts — checklist

[ ] `package.json` :

* `"build": "tsc -p tsconfig.json"`
* `"dev": "tsx src/server.ts"` (ou ts-node)
* `"start:http": "node dist/server.js --http --http-host 127.0.0.1 --http-port 8765 --http-path /mcp --http-json on --http-stateless yes"`
* `"start:dashboard": "node dist/monitor/dashboard.js"`
* `"test": "vitest run"` (ou jest) ; `"test:watch": "vitest"`
* `"eval:scenarios": "node dist/eval/runner.js --scenarios ./scenarios"`

[ ] **tsconfig** : `outDir: "dist"`, `rootDir: "src"`, `module: "ESNext"`, `target: "ES2022"`, `strict: true`.
[ ] **CI** : jobs séparés : **lint** → **build** → **test** → **eval:scenarios** (avec seuils).

---

# 12) Petites finitions & hygiène

[ ] **Logging structuré** partout (code/raison → pas de `console.log`) ; niveaux : info/warn/error.
[ ] **Feature flags** pour nouvelles capacités (RAG, ThoughtGraph, ToolRouter) afin d’activer progressivement.
[ ] **Mesures** de coût/latence (tokens, temps CPU) remontées au dashboard.
[ ] **Recherche de code mort** (exports non référencés) et suppression.
[ ] **Documentation** des modèles de données (Provenance, Lesson, ThoughtNode) en en-tête de fichier.

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
