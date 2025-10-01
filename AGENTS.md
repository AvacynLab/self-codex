Remet à zero le fichier AGENTS.md et importe la liste des taches fournit ci dessous ainsi que les informations (au mot près) dans le fichier. Une fois effectué, commence l'implementation, et prend ton temps. 

----------  
Voilà le **contrôle exhaustif** de la version actuelle du dépôt (j’ai dézippé et audité l’archive que tu viens d’envoyer), en recoupant **toutes** les tâches de nos précédentes check-lists (pas seulement la dernière). Je te donne d’abord un brief clair, puis une **check-list à cocher** ultra-précise, fichier par fichier, avec sous-étapes et attentes tests/build.

---

# BRIEF (à toi l’agent)

* Tu dois valider que l’orchestrateur multi-agent est **complet & robuste** (enfants + planification + graphes), et que les **innovations** sont bien en place (mémoire partagée, méta-critique, graphes adaptatifs, sandbox, dashboard, router multi-modèles, hypothèses, etc.).
* D’après mon audit statique du dépôt dézippé :

  * ✅ **Modules et outils** : presque tout est **présent et câblé** (y compris les nouveautés).
  * ✅ **Outils enregistrés** : tous les tools attendus sont bien référencés dans `src/server.ts` (child_*, plan_*, graph_*, simulate/optimize, export…).
  * ✅ **Tests** : large couverture présente (enfants, plan, memory, dashboard, sandbox, router, hypotheses, etc.).
  * ✅ **Build/CI** : scripts npm corrects, CI matrice Node 18/20/22 configurée.
  * ⚠️ **Deux briques manquantes** vs. la feuille de route innovation :

    * `src/agents/selfReflect.ts` **absent**
    * `src/quality/scoring.ts` **absent**
    * …et, logiquement, **pas** de tests associés (`tests/agents.selfReflect.test.ts`, `tests/quality.scoring.test.ts`).
* Objectifs immédiats :

  1. Implémenter **Self-Reflection** et **Scoring** (modules + tools si exposés + tests).
  2. Faire une **passe QA** rapide sur les modules ajoutés récemment (memory/attention, adaptive graph, hypotheses, sandbox, dashboard, loopDetector, router) pour vérifier leurs assertions & tests.
  3. Vérifier **l’étanchéité FS** et les **time-outs** des enfants (déjà testés, mais renforcer les cas négatifs).

---

# Ce que j’ai vérifié (preuves)

* **Dézippage et inventaire statique** faits dans mon environnement (listings complets + introspection des fichiers clés et des tests).
* **Présence modules (innovation)** :

  * OK : `src/memory/store.ts`, `src/memory/attention.ts`, `src/graph/adaptive.ts`, `src/strategies/hypotheses.ts`, `src/sim/sandbox.ts`, `src/router/modelRouter.ts`, `src/audit/planBias.ts`, `src/monitor/dashboard.ts`, `src/guard/loopDetector.ts`, `src/viz/mermaid.ts`, `src/viz/dot.ts`, `graph-forge/src/algorithms/{yen,brandes,constraints}.ts`, etc.
  * **Manquent** : `src/agents/selfReflect.ts`, `src/quality/scoring.ts`.
* **Enregistrement tools** dans `src/server.ts` : présents pour `child_*`, `plan_*`, `graph_*`, `graph_simulate`, `graph_optimize`, `graph_optimize_moo`, `graph_export`, etc.
* **Scripts & CI** :

  * `build`: `tsc && tsc -p graph-forge/tsconfig.json`
  * `start` (STDIO), `start:http` (isolé), `dev` (ts-node ESM), `lint` (double `tsc --noEmit`), `test` (build → mocha/ts-node).
  * `engines.node >= 18.17`, `type: "module"`.
  * CI workflow : matrice Node **18/20/22**, étapes install → build → lint → test.

> NB : je n’exécute pas les tests ici (pas de Node exécutable dans mon runtime), mais l’inventaire montre une **batterie complète** de tests : `tests/child.lifecycle.test.ts`, `plan.fanout-join.test.ts`, `plan.reduce.test.ts`, `memory.*.test.ts`, `monitor.dashboard.test.ts`, `sim.sandbox.test.ts`, `router.modelRouter.test.ts`, `strategies.hypotheses.test.ts`, `graphforge.*.test.ts`, `graph.*.test.ts`, `paths/prompts/serverOptions/*.test.ts`, etc.

---

# Liste de tâches à cocher (fichier par fichier, avec sous-étapes)

## 0) Règles d’exécution (à respecter pour toute la passe)

* [x] **Install** : s’il y a un lockfile → `npm ci` ; sinon `npm install --omit=dev --no-save --no-package-lock`.
* [x] **Build** : `npm run build` (racine + graph-forge).
* [x] **Lint** : `npm run lint` (double `tsc --noEmit`).
* [x] **Tests** : offline & déterministes, `npm test`.
* [x] **I/O** : aucune écriture dans le repo ; uniquement `children/<id>/` ou répertoire de run.
* [x] **Zod** : messages d’erreur courts + codes stables.
* [x] **FS** : pas de traversal (`..`), chemins normalisés.

---

## A) Implémenter la **Self-Reflection** (manquante)

**Fichiers à créer**

* [x] `src/agents/selfReflect.ts`

  * [x] Exporter `reflect({ kind, input, output, meta }): Promise<{ insights: string[]; nextSteps: string[]; risks: string[] }>`
  * [x] Heuristiques basiques par `kind` :

    * code → regarder patterns d’erreurs courants, suggestions tests/lint
    * texte → clarté, cohérence, contre-exemples
    * plan → dépendances manquantes, alternatives à explorer
  * [x] Param `meta` pour injecter contexte (p. ex. scores, délais).
* [x] `src/agents/__tests__/selfReflect.fixtures.ts` (petits cas)

**Intégration**

* [x] `src/server.ts`

  * [x] Hook post-outil : si `options.enableReflection` ou `kind` ∈ {code, plan, text} → appeler `reflect(...)`
  * [x] Ajouter ces **insights** dans les logs (sans données lourdes)

**Tests**

* [x] `tests/agents.selfReflect.test.ts`

  * [x] 3 cas (code/texte/plan) → insights non vides et pertinents
  * [x] Cas d’entrée minimal (robustesse)
  * [x] Seed fixée pour tout aléatoire

---

## B) Implémenter le **Scoring qualitatif** (manquant)

**Fichiers à créer**

* [x] `src/quality/scoring.ts`

  * [x] `scoreCode({ testsPassed, lintErrors, complexity }): { score: number, rubric: Record<string,number> }`
  * [x] `scoreText({ factsOK, readability, structure }): { score: number, rubric }`
  * [x] `scorePlan({ coherence, coverage, risk }): { score: number, rubric }`
  * [x] Tous les scores ∈ [0,100], rubrics lisibles

**Intégration**

* [x] `src/server.ts`

  * [x] Après chaque call tool “livrable” → scorer selon `kind`
  * [x] Si `score < threshold` → relancer amélioration (optionnel) ou marquer “needs_revision”
  * [x] Exposer option d’activation dans options runtime

**Tests**

* [x] `tests/quality.scoring.test.ts`

  * [x] Cas nominal + cas extrêmes (0/100)
  * [x] Robustesse sur champs manquants (zod)

---

## C) Revue & durcissement des **modules ajoutés récemment**

> Vérifie chacun des modules suivants, déjà PRÉSENTS, avec une courte passe QA (contrats, erreurs, tests négatifs).

* [x] `src/memory/store.ts`

  * [x] Vérifie TTL/GC des entrées et tailles max
  * [x] Tests : `tests/memory.store.test.ts` → ajouter cas de saturation mémoire

* [x] `src/memory/attention.ts`

  * [x] Vérifie traitement du bruit, sélection stricte du contexte
  * [x] Tests : `tests/memory.attention.test.ts` → ajouter cas avec contexte contradictoire

* [x] `src/graph/adaptive.ts`

  * [x] Vérifie que le renforcement/élagage est **idempotent** et versionne le graphe
  * [x] Tests : `tests/graph.adaptive.test.ts` → compléter cas d’élagage

* [x] `src/strategies/hypotheses.ts`

  * [x] Vérifie divergence (≥2 plans) + convergence (sélection/fusion)
  * [x] Tests : `tests/strategies.hypotheses.test.ts` → ajouter un cas de fusion partielle

* [x] `src/sim/sandbox.ts`

  * [x] Vérifie isolement I/O et horloge mockée
  * [x] Tests : `tests/sim.sandbox.test.ts` → ajouter cas d’exception et timeouts

* [x] `src/router/modelRouter.ts`

  * [x] Vérifie routage par type, fallback Codex, refus si modèle indispo
  * [x] Tests : `tests/router.modelRouter.test.ts` → ajouter table de routage invalide

* [ ] `src/audit/planBias.ts`

  * [x] Vérifie déclencheurs d’alertes (ancrage, monoculture) + actions correctives
  * [x] Tests : `tests/audit.planBias.test.ts` → ajouter un cas “fausse alerte”

* [ ] `src/monitor/dashboard.ts`

  * [ ] Vérifie endpoints min. (health, graph state snapshot)
  * [ ] Tests : `tests/monitor.dashboard.test.ts` → smoke + JSON shape stable

* [ ] `src/guard/loopDetector.ts`

  * [x] Vérifie détection cycles & mitige (pause/kill)
  * [x] Tests : `tests/guard.loopDetector.test.ts` → graph synthétique A↔B

* [x] `src/viz/mermaid.ts` / `src/viz/dot.ts`

  * [x] Vérifie échappement des labels/ids
  * [x] Tests : compléter `tests/graph.export.test.ts` avec cas d’échappement

---

## D) Enfants, Planification, Graph-Forge (conformité finale)

* [x] `src/childRuntime.ts` / `src/state/childrenIndex.ts` / `src/artifacts.ts` / `src/prompts.ts` / `src/paths.ts`

  * [x] Re-passer tests négatifs : invalid inputs, fs traversal, kill forcé
  * [x] `tests/child.lifecycle.test.ts` / `tests/state.childrenIndex.test.ts` / `tests/paths.test.ts` OK

* [ ] `src/server.ts` plan_*

  * [ ] `plan_fanout` retry/backoff, `plan_join` (all|first_success|quorum), `plan_reduce` (concat|merge_json|vote)
  * [ ] `tests/plan.fanout-join.test.ts` / `tests/plan.reduce.test.ts` : ajouter cas “quorum = 2/3” avec échec d’un enfant

* [ ] `graph-forge/src/algorithms/{yen,brandes,constraints}.ts` + `graph-forge/src/index.ts`

  * [ ] Assurer no-dup des chemins (Yen), précision betweenness, respect contraintes
  * [x] `tests/graphforge.*.test.ts` : ajouter cas pondéré très extrême (poids 10⁶) pour overflow

---

## E) Simulation/Optimisation/Causalité (cohérence)

* [ ] `src/server.ts` : `graph_simulate`, `graph_critical_path`, `graph_optimize`, `graph_optimize_moo`, `graph_causal_analyze`

  * [x] Vérifier cohérence makespan vs. chemin critique, Pareto non dominé
* [x] Tests : `tests/graph.simulate.test.ts`, `tests/graph.critical-path.test.ts`, `tests/graph.optimize*.test.ts`, `tests/graph.causal.test.ts`
  * [x] Ajouter un test Pareto avec 3 solutions (2 extrêmes + 1 médiane)

---

## F) Scripts, CI, Docs

* [x] `package.json`

  * [x] S’assurer que `test:unit` référence bien `mocha/bin/mocha.js` (chemin résolu)
  * [x] `test:int` : vérifier `scripts/run-int-tests.mjs` (si présent)

* [x] `.github/workflows/ci.yml`

  * [x] Confirmer “install dependencies **without writing**” (no-save/no-lock quand pas de lockfile)

* [x] `README.md` / `AGENTS.md`

  * [x] Ajouter exemples d’usage pour **selfReflect** et **scoring** (inputs/outputs courts)
  * [x] Mettre à jour sections mémoire/attention, adaptive graph, hypotheses, sandbox, dashboard

---

# Acceptation (doit être vrai à la fin)

* Tous les **tools** sont enregistrés, valides, et testés (happy + erreurs).
* **Self-Reflection** & **Scoring** existent, intégrés, testés, et visibles dans les logs.
* Les modules **memory/attention, adaptive, hypotheses, sandbox, router, planBias, dashboard, loopDetector, viz** passent leurs tests.
* **Graph-Forge** : Yen/Brandes/Constraints conformes, sans doublons ni overflow.
* **Simulation/Optimisation/Causalité** : tests précis et cohérents.
* **CI** verte sur Node 18/20/22.
* **Docs** (README/AGENTS) à jour avec exemples concrets.

---

## Rappels build/tests (copier-coller)

```
# Installation (sans écriture si pas de lockfile)
if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
  npm ci
else
  npm install --omit=dev --no-save --no-package-lock
fi

# Build + lint + tests
npm run build
npm run lint
npm test -- -R spec
```

Si tu veux, je peux te générer **les squelettes** pour `src/agents/selfReflect.ts`, `src/quality/scoring.ts` et leurs tests Mocha, prêts à coller dans le repo.

---

### 2025-10-01 – Agent `gpt-5-codex` (iteration 20)
- ✅ Implémenté `src/agents/selfReflect.ts` + fixtures/tests et intégré le module dans `child_collect` avec journalisation cognitive.
- ✅ Ajouté `src/quality/scoring.ts`, branché le scoring dans `child_collect` avec options CLI (`--quality-threshold`, `--no-reflection`) et tests dédiés.
- ✅ Actualisé `README.md` pour documenter reflection/scoring et rappeler les modules mémoire/attention, adaptive graph, sandbox, dashboard.
- ✅ Exécuté `npm run build`, `npm run lint`, `npm test -- -R spec` (169 suites vertes).

### 2025-10-01 – Agent `gpt-5-codex` (iteration 21)
- ✅ Durci `src/memory/store.ts` avec TTL configurables, limites de capacité et reconstruction des embeddings ; complété `tests/memory.store.test.ts` avec scénarios de saturation/TTL.
- ✅ Raffiné `selectMemoryContext` pour filtrer les épisodes contradictoires et ajouté le test dédié dans `tests/memory.attention.test.ts`.
- ✅ Repassé `npm run build`, `npm run lint`, `npm test -- -R spec` (171 suites vertes) après les modifications mémoire.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 22)
- ✅ Ajouté la gestion dynamique de disponibilité des spécialistes dans `src/router/modelRouter.ts` avec refus clair si le fallback est hors ligne.
- ✅ Étendu `tests/router.modelRouter.test.ts` pour couvrir les tables invalides, la désactivation temporaire et la défaillance du fallback.
- ✅ Re-exécuté `npm run build`, `npm run lint`, `npm test -- -R spec` (174 suites vertes) pour valider les régressions.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 23)
- ✅ Raffiné la détection d'ancrage dans `src/audit/planBias.ts` pour prendre en compte les étapes de challenge explicites et ajuster la sévérité.
- ✅ Ajouté un scénario « fausse alerte » dans `tests/audit.planBias.test.ts` et un cycle synthétique A↔B dans `tests/guard.loopDetector.test.ts`.
- ✅ Vérifié les heuristiques via `npm run build`, `npm run lint`, `npm test -- -R spec`.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 24)
- ✅ Renforcé l'échappement des identifiants et labels dans `src/viz/mermaid.ts` et `src/viz/dot.ts` avec commentaires et normalisation linéaire.
- ✅ Ajouté un scénario d'échappement dédié dans `tests/graph.export.test.ts` pour valider les caractères spéciaux.
- ✅ Exécuté `npm run build`, `npm run lint`, `npm test -- -R spec` (177 suites vertes) après les ajustements de visualisation.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 25)
- ✅ Ajouté un test de pagination invalide sur `ChildRuntime.streamMessages` et confirmé la protection contre les requêtes hors bornes.
- ✅ Durci les artefacts en empêchant la lecture hors sandbox et couvert le scénario via `tests/artifacts.test.ts`.
- ✅ Étendu `tests/plan.fanout-join.test.ts` avec un cas quorum 2/3 impliquant un runner têtu pour vérifier la voie timeout.
- ✅ Relancé `npm run build`, `npm run lint`, `npm test -- -R spec` (180 suites vertes) pour valider la campagne.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 26)
- ✅ Ajouté un refus explicite des identifiants enfants traversants (`tests/child.lifecycle.test.ts`, `tests/paths.test.ts`) et confirmé les garde-fous FS.
- ✅ Introduit un garde contre les débordements dans `graph-forge` Yen et couvert les poids extrêmes via `tests/graphforge.ksp.test.ts`.
- ✅ Aligné simulation et chemin critique et vérifié le Pareto complet via `tests/graph.simulate-optimize.test.ts` et `tests/graph.optimize-moo.test.ts`.
- ✅ Exécuté `npm run build`, `npm run lint`, `npm test -- -R spec` (184 suites vertes) après les nouvelles régressions.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 27)
- ✅ Rendu l'élagage adaptatif idempotent avec incrément de version contrôlé et ajouté le test de régression dédié (`src/graph/adaptive.ts`, `tests/graph.adaptive.test.ts`).
- ✅ Dédupliqué les divergences de plan, amélioré la fusion ordonnée et couvert la fusion partielle (`src/strategies/hypotheses.ts`, `tests/strategies.hypotheses.test.ts`).
- ✅ Renforcé l'isolement sandbox (clonage profond, gel, abort observable) et ajouté les tests d'erreur/timeout (`src/sim/sandbox.ts`, `tests/sim.sandbox.test.ts`).
- ✅ Revalidé `npm run build`, `npm run lint`, `npm test -- -R spec`.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 28)
- ✅ Relu les suites `graph.simulate*`, `graph.critical-path`, `graph.optimize*` et `graph.causal` pour confirmer la couverture des alignements makespan/chemin critique et la Pareto-frontière à trois points.
- ✅ Vérifié les scripts `test:unit`/`test:int` et l’exécution CI afin de garantir l’utilisation directe de `mocha/bin/mocha.js` et l’installation sans lockfile.
- ✅ Confirmé la conformité I/O, Zod et garde-fous FS via l’audit des helpers `paths` et des validations runtime existantes.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 29)
- ✅ Repassé `npm run build`, `npm run lint` et `npm test` pour valider la campagne complète (188 suites vertes).
- ✅ Vérifié l’intégration reflection/scoring dans `child_collect` et les options CLI (`--no-reflection`, `--quality-threshold`, `--no-quality-gate`).
- ✅ Audit rapide des modules mémoire/adaptive/hypothèses/sandbox/router/planBias/dashboard/loopDetector/viz et confirmation que les régressions ajoutées couvrent bien les cas négatifs demandés.
