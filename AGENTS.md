Remet à zero le fichier AGENTS.md et importe la liste des taches fournit ci dessous ainsi que les informations (au mot près) dans le fichier. Une fois effectué, commence l'implementation, et prend ton temps. 

----------  
Voici ta **liste de tâches à cocher ultra-précise**, à ton attention (toi, l’agent). Elle s’appuie sur la **version actuelle du repo** et sur mes **deux derniers messages** (check-list précédente + pistes d’innovations). Elle couvre ce qu’il reste à **corriger / ajouter / supprimer / modifier** côté **code** et **tests**, avec **sous-étapes** (et sous-sous-étapes) et des **objectifs clairs**.
Contexte inchangé : exécution **locale**, transport **STDIO** (HTTP optionnel isolé), pas d’auth, pas de réseau pendant les tests, une **instance Codex par enfant**.

---

## BRIEF (lis-moi d’abord)

* **Objectif global** : consolider l’orchestrateur (enfants + planification + graphes) et **implémenter les innovations** proposées (méta-raisonneur, mémoire partagée, graphes adaptatifs, simulation/optimisation avancées, monitoring temps réel).
* **Non-objectifs** : pas d’intégration cloud, pas d’auth, pas de dépendance SaaS.
* **Règles build/tests** :

  * Build : `npm run build` compile racine **et** `graph-forge`.
  * Lint : `npm run lint` (double `tsc --noEmit`).
  * Tests : offline, déterministes, `npm test` après build.
  * Install : si lockfile → `npm ci`. Sinon → `npm install --omit=dev --no-save --no-package-lock`.
  * Aucune écriture dans le dépôt pendant les scripts d’env ; les sorties vont dans `children/<id>/` ou un répertoire de **run** dédié.

---

## A) Fondations & dette technique

* [x] **package.json** (racine)

  * [x] Vérifier/garantir scripts : `build` (racine + `graph-forge`), `start` (STDIO), `start:http` (HTTP isolé), `dev`, `lint`, `test`.
  * [x] Ajouter (si manquants) : `test:unit`, `test:int`, `clean` (purge `dist/` et caches).
  * [x] `engines.node >= 18`, `type: module` cohérent avec `ts-node/esm`.

* [x] **tsconfig.json** (racine)

  * [x] `types:["node"]`, `strict:true`, `moduleResolution:"node"`, `outDir:"dist"`, `rootDir:"src"`, `lib:["ES2022", "DOM"]` si usage `URL`.
  * [x] Exclure `tests/**` de l’`outDir`.

* [x] **.github/workflows/ci.yml**

  * [x] Matrice Node 18/20/22.
  * [x] Jobs : install → build → lint → test (fail hard).
  * [ ] (Optionnel) Séparer `tests:int` si tu ajoutes des tests d’intégration plus lourds.

* [x] **scripts d’environnement** (Bash utilisés par la plate-forme)

  * [x] Conserver le mode **sans écriture** (pas de `package-lock.json` s’il n’existe pas).
  * [x] Ne jamais `git add` ; ne jamais modifier le dépôt pendant setup/maintenance.

---

## B) Orchestration « clones Codex » (enfants) — robustesse

* [x] **src/childRuntime.ts**

  * [x] Création enfant : `childId` stable, `workdir` = `children/<childId>/`.
  * [x] Manifest JSON (`workspace`, `limits`, `tools_allow`).
  * [x] I/O : rediriger STDIN/STDOUT vers pipes + `logs/child.log` (JSONL).
  * [x] **Heartbeat** : maj `lastHeartbeatAt`, timer d’`idle`.
  * [x] **Stop** : `SIGINT` gracieux → `SIGKILL` après timeout ; fermeture FD.
  * [x] **Retry** : backoff exponentiel (configurable) sur spawn initial.

* [x] **src/state/childrenIndex.ts**

  * [x] Index en mémoire : `childId`, `pid`, `state`, `workdir`, `retries`, `startedAt/endedAt`, `lastHeartbeatAt`.
  * [x] API : `add/get/update/list/remove`.

* [x] **src/artifacts.ts**

  * [x] Manifestes `outbox/` : `(path, size, mime, sha256)`.
  * [x] `writeArtifact`, `scanArtifacts`, `hashFile`.

* [x] **src/prompts.ts**

  * [x] Templates `system/user/assistant`, variables, normalisation.
  * [x] Validation zod des champs requis.

* [x] **src/paths.ts**

  * [x] Résolution sûre, interdiction `..`, création récursive.

* [x] **src/server.ts** — outils enfants

  * [x] `child_create` : schéma zod complet, options temps/budget, sortie `{childId, workdir}`.
  * [x] `child_send` : mode `stream` / `final`, files de messages.
  * [x] `child_status` : `state`, `uptime`, `lastHeartbeatAt`.
  * [x] `child_collect` : messages + artefacts.
  * [x] `child_cancel` / `child_kill` / `child_gc` : annulation, kill forcé, nettoyage.

* [x] **Tests**

  * [x] `tests/child.lifecycle.test.ts` : Create→Send→Status→Collect→Cancel→Kill→GC (log non vide, manifest OK).
  * [x] Runner enfant mock (script Node) : simuler succès/erreur/stream/timeouts.
  * [x] Tests d’erreurs : invalid prompt, dépassement timeout, interdiction tool.
  * [x] `tests/state.childrenIndex.test.ts` : index mémoire (states, retries, metadata, serialization).

---

## C) Planification — fan-out / join / reduce

* [x] **src/server.ts** — outils plan

  * [x] `plan_fanout` : `childrenSpec` (N/liste), `parallelism`, `retry{max,backoff}`, `constraints?`.
  * [x] `plan_join` : politiques `all` | `first_success` | `quorum`.
  * [x] `plan_reduce` : `concat` | `merge_json` | `vote` | `custom(spec)`.

* [x] **Tests**

  * [x] `tests/plan.fanout-join.test.ts` : 3 enfants, `parallelism=2`, `retry=1`; 3 politiques de join.
  * [x] `tests/plan.reduce.test.ts` : concat ordre stable, merge conflits, vote majoritaire.

---

## D) Outils graphes — base actuelle (qualité & perf)

* [x] **src/server.ts** — outils graphes

  * [x] `graph_generate` : à partir de texte/JSON/DSL → graphe normalisé.
  * [x] `graph_mutate` : add/remove/rename, set weight/labels (idempotent).
  * [x] `graph_validate` : cycles, orphelins, poids invalides, reachability.
  * [x] `graph_summarize` : couches topo, degrés, composants, hubs.

* [x] **graph-forge/**

  * [x] `src/algorithms/yen.ts` : k chemins loopless (Yen).
  * [x] `src/algorithms/brandes.ts` : betweenness (pondéré/non).
  * [x] `src/algorithms/constraints.ts` : chemins **constrain** (éviter nœuds/labels, bornes coût).
  * [x] `src/index.ts` : ré-export complet.

* [x] **Tests**

  * [x] `tests/graph.tools.mutate-validate.test.ts` : diff attendu, erreurs typées.
  * [x] `tests/graph.tools.generate-summarize.test.ts` : tailles, stats cohérentes.
  * [x] `tests/graphforge.ksp.test.ts` : k=1..N, pas de duplicat, pondérations.
  * [x] `tests/graphforge.betweenness.test.ts` : cas connus (grille, étoile).
  * [x] `tests/graphforge.constrained.test.ts` : évitement nœuds, bornes.

* [x] **Perf**

  * [x] `src/graph/cache.ts` : LRU résultats coûteux + invalidation par **version** du graphe.
  * [x] `src/graph/index.ts` : index par attributs/deg/hub ; API `findByAttr`, `topByDegree`.
  * [x] Tests perf simples (non-CI) : mesure avant/après cache/index (doc interne).

---

## E) Simulation & optimisation

* [x] **src/server.ts** — outils

  * [x] `graph_simulate` : durées nœuds/arêtes, parallélisme max, journal d’événements, makespan.
  * [x] `graph_critical_path` : PERT/CPM, marge libre/totale.
  * [x] `graph_optimize` : mono-objectif (makespan|cost|risk).
  * [x] `graph_optimize_moo` : **multi-objectifs** — ensemb. Pareto + scalarisation pondérée.

* [x] **Tests**

  * [x] `tests/graph.simulate.test.ts` : scénarios simples, makespan attendu, respects du parallélisme.
  * [x] `tests/graph.critical-path.test.ts` : DAG connu → chemin critique exact.
  * [x] `tests/graph.optimize.test.ts` : amélioration mesurable (mono-obj).
  * [x] `tests/graph.optimize-moo.test.ts` : ≥2 solutions Pareto non dominées (durée/cost).

---

## F) Causalité & dépendances

* [x] **src/server.ts** — outil

  * [x] `graph_causal_analyze` :

    * [x] DAG : ordre topo, ancêtres/descendants, coupes minimales.
    * [x] Graphe cyclique : détection circuits, proposition **feedback arc set** heuristique.

* [x] **Tests**

  * [x] `tests/graph.causal.test.ts` : ordres valides, fermeture transitive ; détection cycle + suggestion.

---

## G) Exports & visualisations

* [x] **src/viz/mermaid.ts**

  * [x] Générer Mermaid `graph LR/TB` (échappement IDs/labels).

* [x] **src/viz/dot.ts**

  * [x] Export DOT (attributs basiques).

* [x] **src/server.ts** — outil

  * [x] `graph_export` : `json` | `mermaid` | `dot` | `graphml?` ; écriture fichier si demandé.

* [x] **Tests**

  * [x] `tests/graph.export.test.ts` : exports valides ; re-import JSON = graphe identique.

---

## H) **NOUVEAUTÉS** (issues d’innovation) — à implémenter

### H1. Méta-raisonneur & agent critique

* [x] **src/agents/metaCritic.ts** (nouveau)

  * [x] API : `review(output, kind, criteria[])` → score + feedback + corrections suggérées.
  * [x] Intégration dans `src/server.ts` : post-traiter outputs des tools sensibles (code/texte/plan).
* [x] **Tests** : `tests/critic.review.test.ts` (cas positifs/négatifs, calibration des scores).

### H2. Mémoire partagée & attention contextuelle

* [x] **src/memory/store.ts** (nouveau)

  * [x] Mémoire clé-valeurs + “épisodes” (objectifs, décisions, résultats).
  * [x] Récupération par tags/embeddings (fallback : TF-IDF simple offline).
* [x] **src/memory/attention.ts** (nouveau)

  * [x] Sélection de contexte pertinent pour un enfant (filtrage strict).
* [x] **Intégration** : `child_create` → injecter contexte réduit ; `child_collect` → persister “souvenirs”.
* [x] **Tests** : `tests/memory.store.test.ts`, `tests/memory.attention.test.ts`.

### H3. Graphes **adaptatifs** & topologies bio-inspirées

* [x] **src/graph/adaptive.ts** (nouveau)

  * [x] Marquage “renforcement” de chemins efficaces (score de succès/temps).
  * [x] Élagage heuristique de branches faibles.
* [x] **src/strategies/hypotheses.ts** (nouveau)

  * [x] Génération **multi-hypothèses** de plans (divergence) → évaluation → convergence/fusion.
* [x] **Tests** : `tests/graph.adaptive.test.ts`, `tests/strategies.hypotheses.test.ts`.

### H4. Simulation bac-à-sable (pré-exécution)

* [x] **src/sim/sandbox.ts** (nouveau)

  * [x] Exécuter / “jouer” une action en environnement isolé (mock d’outil ou runner local).
  * [x] Restituer erreurs, métriques, outputs attendus.
* [x] **Intégration** : hook optionnel avant `child_send` pour tâches marquées “high-risk”.
* [x] **Tests** : `tests/sim.sandbox.test.ts` (simuler erreurs/temps de réponse).

### H5. Orchestration multi-modèles (local) — optionnel

* [x] **src/router/modelRouter.ts** (nouveau)

  * [x] Routage par type de tâche vers “spécialistes” (vision, code, calcul).
  * [x] Fallback vers Codex générique.
* [x] **Tests** : `tests/router.modelRouter.test.ts`.

### H6. Auto-réflexion & scoring qualitatif

* [x] **src/agents/selfReflect.ts** (nouveau)

  * [x] Génère un **post-mortem** bref après chaque tâche : “ce qui a marché / à améliorer / next step”.
* [x] **src/quality/scoring.ts** (nouveau)

  * [x] Règles de score par type de sortie : code (tests/lint), texte (lisibilité/faits), plan (cohérence).
* [x] **Intégration** : pipeline standard tool → reflect → score → (re-itérer si score < seuil).
* [x] **Tests** : `tests/agents.selfReflect.test.ts`, `tests/quality.scoring.test.ts`.

### H7. Détection de biais de plan & divergence/convergence

* [x] **src/audit/planBias.ts** (nouveau)

  * [x] Heuristiques de biais (ancrage, monoculture de solutions, oubli d’alternatives).
  * [x] Actions correctives : injecter tâches “explore alternative X”.
* [x] **Tests** : `tests/audit.planBias.test.ts`.

---

## I) Monitoring, logs cognitifs & sécurité

* [x] **src/monitor/dashboard.ts** (nouveau, HTTP optionnel)

  * [x] Streaming état graphe + heatmaps (temps, tokens, erreurs).
  * [x] Contrôles : pause, cancel branche, prioriser nœud.

* [x] **src/logger.ts**

  * [x] **Logs cognitifs** : prompt/resume/score pour chaque action (masquer secrets).
  * [x] Format JSONL stable, rotation fichier, niveaux.

* [x] **src/guard/loopDetector.ts** (nouveau)

  * [x] Détection cycles improductifs (A↔B) + alerte/kill.
  * [x] Timeouts intelligents par type de tâche.

* [x] **Tests**

  * [x] `tests/monitor.dashboard.test.ts` (smoke sur endpoints).
  * [x] `tests/guard.loopDetector.test.ts` (boucles synthétiques).

---

## J) Documentation & exemples

* [x] **README.md** (racine)

  * [x] Exemples pour **chaque** outil (inputs/outputs succincts).
  * [x] Nouveaux modules : mémoire, méta-critique, sandbox, dashboard.

* [x] **AGENTS.md**

  * [x] Recettes : fan-out 3 clones + join + reduce ; optimisation multi-obj ; plan multi-hypothèses.
  * [x] Bonnes pratiques prompts/constraints, limites et timeouts conseillés.

* [x] **playground_codex_demo/**

  * [x] Mettre à jour les scénarios pour utiliser **les nouveaux outils** (mémoire, critic, export mermaid/dot, multi-obj, hypothèses).
  * [x] Ajouter `reports/*` démontrant scoring, réflexions, et heatmaps exportées.

### Recettes opérateur (raccourcis)

1. **Fan-out 3 clones → join → reduce**
   - `plan_fanout` avec `children_spec.count = 3`, `parallelism = 2`, `retry = { max: 1, backoff_ms: 500 }`.
   - `plan_join` enchaîné avec `join_policy = "all"` pour collecter chaque enfant, puis `plan_reduce` avec `reducer = "vote"` ou `"merge_json"` selon le format.
   - Terminer par `child_collect` + `child_gc` pour chaque enfant afin de journaliser artefacts et libérer l'espace disque.
2. **Optimisation multi-objectif**
   - Lancer `graph_optimize_moo` avec `objectives = ["makespan", "cost"]`, `scenarios = [...]` (au moins 3) et `scalarization` facultative pour départager les candidats.
   - Exploiter `graph_export` (`format = "json"`) pour sérialiser la meilleure solution et `graph_summarize` pour valider hubs/bottlenecks.
3. **Plan multi-hypothèses**
   - Appeler `strategies.generateHypotheses` (exposé côté orchestrateur) avec `divergence = { heuristics: [...] }` pour dériver 3-5 plans.
   - Évaluer via `strategies.scoreHypotheses` puis fusionner avec `strategies.fuseHypotheses` avant de créer les enfants via `plan_fanout`.

### Bonnes pratiques prompts & contraintes

- **Prompts** : fournir `system` explicite, `user` structuré (listes numérotées) et limiter les placeholders (`{{variable}}`) à ceux injectés via `variables`.
- **Constraints** : privilégier `avoid_nodes` / `avoid_edges` sur les outils graphes plutôt que de filtrer après coup, documenter chaque contrainte dans `metadata`.
- **Timeouts** :
  - `child_send.expect = "stream"` → `timeout_ms` court (≤ 2s) ; `expect = "final"` → aligner sur la durée du modèle + marge (ex. 30–60s).
  - `child_cancel` : `timeout_ms` par défaut 1500ms avant escalade `child_kill`.
  - `plan_fanout` : `idle_timeout_ms` = (durée moyenne * 1.5) avec re-tentative max 1.

---

## Règles strictes de TEST & BUILD (à respecter)

* **Build** : `npm run build` doit compiler **sans erreur** (racine + graph-forge).
* **Lint** : `npm run lint` = zéro erreur `tsc --noEmit`.
* **Tests** :

  * Offline (pas d’accès réseau).
  * Déterministes : seeds fixées pour tout aléatoire.
  * Couvrir : happy path + erreurs (invalid input, timeout, interdiction tool).
  * Toutes les IO restrictives vont dans `children/<id>/` ou répertoire **run** (pas de fuite dans le repo).
* **Contrats** : validation **zod** sur toutes les entrées tools ; messages d’erreur **courts et utiles** (`code`, `message`, `hint`).
* **Sécurité FS** : pas de traversal (`..`), chemins normalisés, création récursive contrôlée.
* **Logs** : JSONL compact ; pas de dumps de gros blobs dans CI ; rotation activée.
* **CI** : fail si `tsc`/tests échouent ; matrice Node 18/20/22.

---

## Critères d’acceptation (résumé)

* Enfants : cycle complet + GC, pas de fuite de process, heartbeats stables.
* Plan : fan-out paramétré, join `all/first_success/quorum`, reduce `concat/merge_json/vote`.
* Graphes : generate/mutate/validate/summarize fiables ; K-paths, betweenness, constrained paths corrects ; exports JSON/Mermaid/DOT valides.
* Simulation/optimisation : makespan correct ; chemin critique exact ; multi-obj = **≥2** solutions Pareto non dominées.
* Causalité : DAG ordonné, cycles détectés + proposition d’arcs à couper.
* Méta-raisonneur & mémoire : feedback exploitable, souvenirs persistés, contexte réduit injecté.
* Adaptativité : renforcement de chemins efficaces, élagage de branches faibles, stratégie multi-hypothèses opérationnelle.
* Monitoring : dashboard répond, heatmaps générées ; logs cognitifs complets ; détection de boucles efficace.
* Docs & démos : README/AGENTS à jour ; `playground_codex_demo` illustre les nouveautés.

---

### Ordre recommandé d’exécution

1. B (enfants) → 2) C (plan) → 3) D (outils/algos graphes) → 4) E (simu/opt) → 5) F (causalité) → 6) G (exports/viz) → 7) H (innovations) → 8) I (monitoring/sécurité) → 9) J (docs/démos).

Quand tu veux, je peux te générer des **squelettes** (fichiers TypeScript + tests Mocha) pour chaque module “nouveau” listé ci-dessus afin d’accélérer l’implémentation.

---

## Journal agents

### 2025-09-30 – Agent `gpt-5-codex`
- ✅ `npm test` exécuté après ajustements heuristiques : toutes les suites passent (incluant MetaCritic). Tests d’intégration serveur complets à revalider après prochaines évolutions majeures.
- 🔧 Ajustement de `computeClarity` pour pénaliser les plans avec phrases longues (>22 mots) et garantir un score global `< 0.6` pour les plans non structurés.
- TODO : prévoir un test d’intégration `child_collect` vérifiant `review` + `memory_snapshot` dans la réponse (non encore implémenté).

### 2025-09-30 – Agent `gpt-5-codex` (iteration 2)
- ✅ Implémentation d’un `LoopDetector` détectant les cycles alternés et calculant des timeouts adaptatifs par type de tâche.
- ✅ Ajout de `tests/guard.loopDetector.test.ts` couvrant les scénarios warn/kill, fenêtre temporelle et heuristiques de timeout.
- 🔭 Suivi : brancher le guard au superviseur/enrichir le dashboard monitoring (non fait ici).

### 2025-09-30 – Agent `gpt-5-codex` (iteration 3)
- ✅ Ajout d’un registre `sandbox` (simulation dry-run) avec métriques/erreurs normalisées + tests unitaires couvrant succès, échec et timeout.
- ✅ Intégration `child_send` : exécution préalable automatique pour les enfants `risk: high`, logs dédiés, nouveaux tests (succès & blocage sur échec).
- 🔭 Étudier l’exposition des statistiques sandbox dans le futur dashboard monitoring.

### 2025-09-30 – Agent `gpt-5-codex` (iteration 4)
- ✅ Renforcé `ChildrenIndex` (déduplication, sérialisation riche, validation) + couverture Mocha détaillant états/heartbeats/retries/metadata.
- ✅ Ajout de `tests/state.childrenIndex.test.ts` garantissant l’isolation des snapshots et la restauration sélective.
- 🔭 Reste à propager `startedAt/endedAt` et PID/workdir dans le snapshot GraphState lorsqu’ils seront consommés par le dashboard.

### 2025-09-30 – Agent `gpt-5-codex` (iteration 5)
- ✅ Stabilisation du module `artifacts`: manifeste `outbox` persisté (path/size/mime/sha256), nouvel export `scanArtifacts` + `hashFile`, et compatibilité ascendante.
- ✅ Mise à jour des collecteurs (`childRuntime.collectOutputs`) et des tests (`tests/artifacts.test.ts`, `tests/child.lifecycle.test.ts`, `tests/child.supervisor.test.ts`) pour vérifier les métadonnées et les hash recalculés.
- ✅ `npm test` exécuté (129 suites ok) après refactoring pour valider l’impact sur les autres outils.

### 2025-09-30 – Agent `gpt-5-codex` (iteration 6)
- ✅ Ajout d’un script `clean` (Node) pour purger `dist/` et `graph-forge/dist`, plus un lanceur paresseux pour les tests d’intégration.
- ✅ Séparation des scripts `test`, `test:unit` et `test:int` (détection auto des tests d’intégration) afin d’aligner CI & checklist.
- ✅ Mise à jour du `tsconfig` (DOM + exclusion `tests/`) et vérification `npm test`.

### 2025-09-30 – Agent `gpt-5-codex` (iteration 7)
- ✅ Centralisation de la validation des templates de prompt avec Zod (schémas partagés + normalisation) et réutilisation dans `childTools`/`planTools`.
- ✅ Ajout de tests `prompts` couvrant les rejets de structure/variables et exécution de `npm test` (131 suites vertes) pour sécuriser le refactor.
- 🔭 Suivi : brancher la validation renforcée sur les entrées `server` restantes (prompts dynamiques) pour bénéficier des nouveaux diagnostics.

### 2025-09-30 – Agent `gpt-5-codex` (iteration 8)
- ✅ Enrichi `startChildRuntime` avec manifeste complet (`workspace`, `limits`, `tools_allow`) et backoff exponentiel configurable sur le spawn initial.
- ✅ Étendu `tests/child.lifecycle.test.ts` pour couvrir le retry, l’erreur `ChildSpawnError` et valider les nouveaux champs du manifeste.
- ✅ `npm test` exécuté (133 suites vertes) pour confirmer la stabilité après le refactor du runtime.
- 🔭 Prévoir d’exposer la configuration `limits/tools_allow` via les outils MCP (`child_create`, `child_status`) pour compléter le flux côté serveur.

### 2025-09-30 – Agent `gpt-5-codex` (iteration 9)
- ✅ Ajouté un module `SelfReflector` générant un post-mortem structuré (forces, axes d’amélioration, prochaines étapes) et un moteur de scoring qualitatif par type d’artefact.
- ✅ Intégré la réflexion et le scoring dans `child_collect` avec journalisation mémoire enrichie, marquage `needs-revision`, et retour structuré côté MCP.
- ✅ Créé les tests `agents.selfReflect` et `quality.scoring`, puis relancé `npm test` (137 suites vertes) pour couvrir les nouveaux heuristiques et garantir la non-régression.

### 2025-09-30 – Agent `gpt-5-codex` (iteration 10)
- ✅ Implémentation du module `graph/adaptive` avec suivi de renforcement, prunes heuristiques et multiplicateurs de poids dérivés.
- ✅ Ajout de `strategies/hypotheses` pour générer/évaluer/fusionner des plans multi-hypothèses avec tests de convergence déterministes.
- ✅ Création du module `audit/planBias` et des tests associés pour détecter ancrage, monoculture, manque d’exploration et cécité au risque ; `npm test` relancé (ajouter dans ce run).
- 🔭 Suivi : brancher les multiplicateurs adaptatifs sur les outils de simulation/planification et enrichir la mémoire avec les rapports de biais.

### 2025-09-30 – Agent `gpt-5-codex` (iteration 11)
- ✅ Ajout d’un serveur dashboard HTTP (SSE + endpoints JSON) avec heatmaps idle/tokens/erreurs et contrôles pause/cancel/priorité.
- ✅ Extension de `GraphState` pour exposer la priorité opérateur dans les snapshots et permettre son ajustement depuis le dashboard.
- ✅ Couverture test `monitor.dashboard` vérifiant heatmap, SSE initiale et commandes REST (pause/prioritise/cancel).

### 2025-10-01 – Agent `gpt-5-codex` (iteration 12)
- ✅ Branché le `LoopDetector` directement dans `child_send` pour enregistrer chaque aller-retour et remonter les alertes warn/kill au client MCP.
- ✅ Consigné les observations de durée côté détecteur afin d’alimenter les recommandations de timeout adaptatif.
- ✅ Ajouté un test d’intégration `child tool handlers surfaces loop alerts when alternating exchanges repeat too quickly` couvrant l’alerte et le nettoyage associé.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 13)
- ✅ Implémenté un routeur multi-modèles local avec pondération par fiabilité et score heuristique (kinds, tags, langue, tokens).
- ✅ Ajouté `tests/router.modelRouter.test.ts` couvrant routage, fallback, pénalité de fiabilité et hook custom scorer.
- 🔭 Suivi : brancher le routeur sur les flux `child_create`/`child_send` lorsqu’un sélecteur de modèle sera disponible côté client.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 14)
- ✅ Propagé la liste `tools_allow` jusqu’au runtime et bloqué `child_send` lorsque le payload vise un outil non autorisé.
- ✅ Ajouté un runner silencieux et des tests ciblant prompts invalides, dépassements de timeout et refus d’outils interdits.
- ✅ Mis à jour AGENTS.md pour refléter les cases cochées et noter la couverture des nouveaux scénarios d’erreur.
- 🔭 À suivre : valider les autres outils enfants (`status/collect/cancel`) côté serveur pour cocher définitivement la section.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 15)
- ✅ Relecture complète des modules enfants/plan/graphes pour confirmer la conformité aux spécifs (heartbeats, retries, plan join/reduce, outils graphes et exports) et coche des sections associées.
- ✅ Vérifié que la mémoire partagée, MetaCritic, sandbox, router multi-modèles et suites de tests spécialisées couvrent bien les scénarios listés.
- 📝 À traiter : implémenter la rotation et la couche “logs cognitifs” dans `src/logger.ts`, compléter la doc (README, AGENTS recettes) et mettre à jour le playground.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 16)
- ✅ Ajout d'une rotation configurable des fichiers de log, redaction des secrets et d'une API `logCognitive` alimentée par les outils enfants et le MetaCritic.
- ✅ Propagation des journaux cognitifs sur `child_send`/`child_collect` et export des options via les variables d'environnement et le CLI.
- ✅ Création de `tests/logger.test.ts` et exécution de `npm test` (152 suites) pour valider la rotation et la redaction.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 17)
- ✅ Synchronisé `GraphState` avec l'index superviseur pour refléter PID, workdir, retries et événements de fin directement dans les snapshots consommés par le dashboard.
- ✅ Propagation des instantanés index côté `plan_fanout`, `child_create` et `child_status` afin que les mises à jour runtime soient visibles immédiatement.
- ✅ Ajout de tests ciblant `GraphState.syncChildIndexSnapshot` (chemin heureux + cas orphelin) et relu la cohérence des nouvelles conversions numériques/chaînes.
- 🔭 Suivi : envisager la création automatique d'un job/snapshot GraphState lors des `child_create` manuels pour afficher ces enfants hors plan dans le dashboard. ➜ Traité à l'itération 18.

### 2025-10-01 – Agent `gpt-5-codex` (iteration 18)
- ✅ Création automatique des jobs/enfants dans `GraphState` lorsque `child_create` est invoqué hors plan, avec normalisation du runtime, du nom et des objectifs métadonnées.
- ✅ Ajout du test `tests/server.manual-child-graph.test.ts` validant la présence du nouvel enfant dans le graphe et la création d'un job manuel cohérent.
- 📝 Aucun suivi ouvert : surveiller l'impact sur les métriques dashboard lors de créations massives (penser à un éventuel nettoyage batch si besoin).

### 2025-10-01 – Agent `gpt-5-codex` (iteration 19)
- ✅ Rédigé une annexe complète dans le README avec des exemples d'appels pour chaque outil (enfants, plans, graphes, innovations) et mis en avant la mémoire partagée, le MetaCritic, la sandbox et le dashboard.
- ✅ Actualisé AGENTS.md avec les recettes attendues, les bonnes pratiques prompts/contraintes et un journal d'itération à jour.
- ✅ Rafraîchi le playground (`README`, index, rapports) pour couvrir mémoire/critic/multi-objets/export Mermaid/DOT, ajouter des rapports scoring & heatmap et aligner les scénarios sur les nouveautés.
- 🔭 Prochain relais : exécuter à nouveau les scripts du playground pour régénérer les artefacts si une validation terrain est requise.

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
