Remet à zero le fichier AGENTS.md et importe la liste des taches fournit ci dessous ainsi que les informations (au mot près) dans le fichier. Une fois effectué, commence l'implementation, et prend ton temps. 

----------
Voici ta **check-list exhaustive**, à ton attention (toi, l’agent), basée sur l’état courant du dépôt et sur nos deux derniers échanges. Elle couvre **ce qu’il reste à corriger/ajouter/supprimer/modifier**, avec sous-étapes (et sous-sous-étapes), **fichier par fichier**, plus un **brief** clair des objectifs, des correctifs attendus, et des **règles tests/build** à respecter.
Important : reste local, transport **STDIO**, pas d’auth. Ne touche pas au dossier d’exemple `projet_mcp_test/`.

---

## BRIEF (lis-moi d’abord)

* Ton objectif : rendre l’orchestrateur **beaucoup plus capable côté tools & graphes**, et **hautement agentique** pour piloter des **copies de lui-même** (une instance Codex par enfant), tout en restant **testable hors réseau**.
* Non-objectifs : pas d’authentification HTTP, pas de dépendances SaaS.
* Contraintes : build TypeScript propre, tests déterministes et offline, scripts d’env **sans écriture** dans le dépôt (pas de lockfile généré si absent).
* Défauts à corriger : robustesse « enfants » (timeouts, retry, GC), enrichissement des tools graphes (partitionnement, contraintes de chemins, causalité), simulation/optimisation plus poussées, et batteries de tests manquants sur ces nouvelles briques.
* Deliverables : code + tests associés + docs d’usage (README/AGENTS) alignées.

---

## A) Fondations & dette technique (env, build, ergonomie)

### A1. Scripts d’environnement (ne jamais écrire dans le dépôt)

* [x] Confirmer l’usage des scripts **Bash** « sans écriture » en prod.

  * [x] Si lockfile présent → `npm ci`.
  * [x] Sinon → `npm install --omit=dev --no-save --no-package-lock`.
  * [x] `npm install @types/node@latest --no-save --no-package-lock`.
  * [x] `npm run build`.
  * [x] Écrire **seulement** `~/.codex/config.toml`.
* [x] Si tu utilises les scripts **Node** dans `scripts/` (optionnel) :

  * [x] Ajouter `--no-save --no-package-lock` quand pas de lockfile.
  * [x] Ne jamais `git add` quoi que ce soit : pas d’effets sur le dépôt.

### A2. `package.json`

* [x] Vérifier/renforcer :

  * [x] `build` compile racine **et** `graph-forge`.
  * [x] `start` = STDIO ; `start:http` = isolé (pas utilisé par Codex CLI).
  * [x] `test` exécute build → mocha/ts-node ESM.
  * [x] `lint` = double `tsc --noEmit` (racine + graph-forge).
  * [x] `engines.node >= 18`.
* [ ] Ajouter scripts utilitaires (optionnel) :

  * [ ] `test:unit` (unitaires rapides), `test:int` (intégration offline).
  * [ ] `clean` (suppression `dist/`, caches éventuels).

### A3. `tsconfig.json`

* [x] Confirmer : `types:["node"]`, `moduleResolution:"node"`, `strict:true`, `outDir:"dist"`, `rootDir:"src"`.
* [x] `lib` au moins ES2020+ (OK si ES2022).
* [x] S’assurer que les tests ne fuient pas dans `dist/`.

### A4. `.github/workflows/ci.yml`

* [x] Matrice Node 18/20/22.
* [x] Jobs : install → build → lint → test ; fail si `tsc`/tests échouent.
* [ ] Optionnel : job `test:int` séparé.

---

## B) Orchestration « clones Codex » (enfants) – robustesse & outillage

### B1. `src/childRuntime.ts` (création/complétion)

* [x] Création enfant :

  * [x] Générer `childId` stable (`child-<timestamp>-<shortid>`).
  * [x] Créer workdir `children/<childId>/` (sous dossier du run).
  * [x] Écrire `children/<childId>/manifest.json` (prompt, tools_allow, timeouts, budget).
* [x] Lancement process Codex enfant (mêmes MCP servers) :

  * [x] Rediriger STDIO → `children/<childId>/logs/child.log` (JSONL).
  * [x] Socket interne (ou pipe) pour `child_send`/stream.
* [x] Heartbeat :

  * [x] Mettre à jour `lastHeartbeatAt` à chaque IO.
  * [x] Watchdog périodique (timer) → marquer `idle` après `idleSec`.
* [x] Arrêt propre/forcé :

  * [x] `SIGINT` gracieux, puis `SIGKILL` après timeout.
  * [x] Nettoyage file descriptors, suppression locks temporaires.

### B2. `src/state/childrenIndex.ts` (création/complétion)

* [x] Index mémoire : `childId`, `pid`, `workdir`, `state`, `lastHeartbeatAt`, `retries`, `startedAt`, `endedAt`.
* [x] API : `add(child)`, `get(childId)`, `update(childId, patch)`, `list()`, `remove(childId)`.
* [x] Snapshot minimal dans GraphState (clé/valeurs non sensibles).

### B3. `src/artifacts.ts` (création/complétion)

* [x] Manifestes :

  * [x] `children/<childId>/outbox/` : (path, size, mime, sha256).
  * [x] Helpers : `writeArtifact`, `scanArtifacts`, `hashFile`.

### B4. `src/prompts.ts` (création/complétion)

* [x] Templating prompts :

  * [x] Merge `system`/`user`/`assistant` + variables by child.
  * [x] Validation des champs, normalisation de whitespace.

### B5. `src/paths.ts` (création/complétion)

* [x] Résolution sûre :

  * [x] Interdire path traversal (`..`), normaliser `cwd`.
  * [x] Création récursive de répertoires.

### B6. `src/server.ts` – Tools enfants (à valider/compléter)

* [x] `child_create` :

  * [x] Entrées zod : prompt parts, tools_allow, timeouts, budgets.
  * [x] Sorties : `{ childId, workdir, startedAt }`.
  * [x] Écrit manifest + démarre runtime.
* [x] `child_send` :

  * [x] Enqueue message → process enfant ; `expect:"stream"|"final"`.
* [x] `child_status` :

  * [x] Retour `state`, `lastHeartbeatAt`, `uptime`, `retries`.
* [x] `child_collect` :

  * [x] Renvoyer derniers messages + artefacts manifest.
* [x] `child_cancel` / `child_kill` / `child_gc` :

  * [x] Annulation douce, kill forcé, garbage-collect du workdir.

### B7. Tests enfants

* [x] `tests/child.lifecycle.test.ts` :

  * [x] Create → Send → Status (ready/idle) → Collect → Cancel → Kill → GC.
  * [x] Vérifier log JSONL non vide, manifest conforme.
* [x] Mock runner enfant :

  * [x] Petit script Node simulant Codex (stdin→stdout JSON).
  * [x] Injecter retours contrôlés (succès/erreur/stream).

---

## C) Planification – fan-out/join/reduce évolués

### C1. `src/server.ts` – Tools plan

* [x] `plan_fanout` (étendre si pas fait) :

  * [x] Paramètres : `childrenSpec` (N ou liste), `promptTemplate`, `parallelism`, `retry:{max,backoff}`, `constraints?`.
  * [x] Sorties : mapping enfants, `fanout.json` écrit dans run.
* [x] `plan_join` :

  * [x] Politiques : `all` | `first_success` | `quorum`.
  * [x] Gestion timeout global, statut détaillé par enfant.
* [x] `plan_reduce` :

  * [x] Réducteurs : `concat` | `merge_json` | `vote` | `custom(spec)`.
  * [x] Traces (origine des fragments retenus).

### C2. Tests plan

* [x] `tests/plan.fanout-join.test.ts` :

  * [x] 3 enfants mock, `parallelism=2`, `retry=1`.
  * [x] `joinPolicy` = `all` / `first_success` / `quorum`.
* [x] `tests/plan.reduce.test.ts` :

  * [x] `concat` → ordre stable, `merge_json` → résolution de conflit, `vote` → majorité.

---

## D) Graphes – outillage d’ingénierie

### D1. `src/server.ts` – Tools graphes (créer/compléter)

* [x] `graph_generate` :

  * [x] Entrée : texte/JSON/DSL ; sortie : graphe normalisé (nodes, edges, weights, labels).
  * [x] Presets : pipelines courants.
* [x] `graph_mutate` :

  * [x] Opérations idempotentes : add/remove/rename node/edge, set weight/labels.
  * [x] Retour : diff des changements appliqués.
* [x] `graph_validate` :

  * [x] Détecte cycles, nœuds inaccessibles, edges orphelins, poids invalides ; codes `errors`/`warnings`.
* [x] `graph_summarize` :

  * [x] Couches (topo), degré moyen, nœuds critiques, components.

### D2. Tests graph tools

* [x] `tests/graph.tools.mutate-validate.test.ts` :

  * [x] Ajouts/suppressions/renames et validate → erreurs attendues.
* [x] `tests/graph.tools.generate-summarize.test.ts` :

  * [x] Générations → structure correcte ; résumé cohérent.

---

## E) GraphForge – algorithmes avancés

### E1. `graph-forge/src/algorithms/yen.ts` (créer si absent)

* [x] Implémenter **Yen** pour k plus courts chemins (loopless).
* [x] Exposer via `graph-forge/src/index.ts` → tool `graph_paths_k_shortest`.

### E2. `graph-forge/src/algorithms/brandes.ts` (créer si absent)

* [x] **Betweenness centrality** (Brandes) pondéré/non-pondéré.
* [x] Exposer → tool `graph_centrality_betweenness`.

### E3. `graph-forge/src/algorithms/constraints.ts` (nouveau)

* [x] `graph_paths_constrained` :

  * [x] Dijkstra/A* + contraintes (éviter nœuds/étiquettes, bornes coût/durée).
  * [x] Fallback si heuristique indispo.

### E4. `graph-forge/src/index.ts`

* [x] Ré-exporter toutes les nouvelles APIs.

### E5. Tests GraphForge

* [x] `tests/graphforge.ksp.test.ts` :

  * [x] Cas DAG/avec cycles (filtrés), poids ; k=1..N, pas de duplicat.
* [x] `tests/graphforge.betweenness.test.ts` :

  * [x] Petits graphes connus, pondéré vs non-pondéré.
* [x] `tests/graphforge.constrained.test.ts` :

  * [x] Contraintes d’évitement et bornes coût → chemins attendus.

---

## F) Simulation & optimisation (mono + multi-objectifs)

### F1. `src/server.ts` – Tools de simulation/optimisation

* [x] `graph_simulate` :

  * [x] Durées sur nœuds/arêtes ; parallélisme max ; calcule makespan ; journal d’événements.
* [x] `graph_critical_path` (si pas déjà outillé) :

  * [x] PERT/CPM, nœuds critiques, marge.
* [x] `graph_optimize` (mono-objectif) :

  * [x] Min makespan / min coût / min risque (param `objective`).
* [x] `graph_optimize_moo` (nouveau, multi-objectifs) :

  * [x] Approche Pareto : renvoie ensemble de solutions non-dominées ; option de scalarisation pondérée.

### F2. Tests simulation/optimisation

* [x] `tests/graph.simulate.test.ts` :

  * [x] Scénarios simples → makespan attendu ; parallélisme effectif.
* [x] `tests/graph.critical-path.test.ts` :

  * [x] DAG connu → chemin critique et marges corrects.
* [x] `tests/graph.optimize.test.ts` :

  * [x] Mono-objectif → amélioration mesurable.
* [x] `tests/graph.optimize-moo.test.ts` :

  * [x] Deux objectifs (durée, coût) → au moins 2 solutions Pareto extrêmes + 1 intermédiaire ; aucune dominée.

---

## G) Causalité & dépendances

### G1. `src/server.ts` – Tool causal

* [x] `graph_causal_analyze` (nouveau) :

  * [x] Sur DAG : ordre topologique, ancêtres/descendants, coupe minimale.
  * [x] Sur graphe avec cycles : détecter circuits, proposer suppression minimale (feedback arc set heuristique).

### G2. Tests causalité

* [x] `tests/graph.causal.test.ts` :

  * [x] DAG : ordres valides, fermeture transitive.
  * [x] Cycle introduit → cycle détecté, suggestion cohérente.

---

## H) Visualisations & exports (texte/mermaid/DOT)

### H1. `src/viz/mermaid.ts` (nouveau)

* [x] Générer code Mermaid `graph LR/TB` :

  * [x] Labels nœuds/poids arêtes ; échappement des IDs.

### H2. `src/viz/dot.ts` (nouveau)

* [x] Export DOT (GraphViz) :

  * [x] Attributs (shape, weight) basiques.

### H3. `src/server.ts` – Tools viz/export

* [x] `graph_export` :

  * [x] Formats : `json`, `mermaid`, `dot`, `graphml` (si simple).
  * [x] Option : écrire fichier via tool FS/local, sinon renvoyer inline (tronqué si trop gros).

### H4. Tests viz/export

* [x] `tests/graph.export.test.ts` :

  * [x] Fichiers valides ; re-import JSON → même graphe.

---

## I) Performance & scalabilité

### I1. `src/graph/cache.ts` (nouveau)

* [x] Cache LRU pour résultats coûteux (plus courts chemins, centralités).
* [x] Invalidation à mutation (graph versioning).

### I2. `src/graph/index.ts` (nouveau)

* [x] Index par attributs nœuds/arêtes ; find rapide.
* [x] Index par degré (min/max/hub) pour heuristiques.

### I3. `src/graph/partition.ts` (nouveau outil + algo)

* [x] Partition heuristique (si pas de binding METIS) :

  * [x] Cut minimal approximé, bissection répétée ou Louvain light.
* [x] Tool `graph_partition` :

  * [x] Entrées : `k`, objectif (`min-cut`/`community`), seed.
  * [x] Sortie : étiquette de partition par nœud.

### I4. Tests perf/partition

* [x] `tests/graph.partition.test.ts` :

  * [x] Graphes jouets → partitions attendues ; peu d’arêtes coupées.
* [ ] Bench local (non CI) :

  * [ ] Mesurer temps sans/avec cache/index (doc interne).

---

## J) Documentation & UX agent

### J1. `README.md`

* [x] Ajouter exemples concrets pour tous les **nouveaux tools** :

  * [x] Enfants : create/send/status/collect/cancel.
  * [x] Plan : fanout/join/reduce.
  * [x] Graphes : generate/mutate/validate/summarize/export.
  * [x] Algorithmes : k-shortest, betweenness, constrained paths.
  * [x] Simulation/optimisation (mono + multi-obj).
  * [x] Causalité.
* [x] Mentionner explicitement : usage interne, STDIO, pas d’auth.

### J2. `AGENTS.md`

* [x] Recette « en 5 minutes » fan-out de 3 clones + join + reduce.
* [x] Bonnes pratiques prompts templates (variables, formats).
* [x] Limites : pas d’écriture hors `children/<id>/`, tailles de payload, timeouts conseillés.

#### Recette express : fan-out (×3) → join → reduce

1. `plan_fanout` avec `children_spec.count = 3`, `parallelism = 2` et un
   `prompt_template` minimal. Conserver `run_id` et la liste `child_ids` depuis
   la réponse (le fichier `<run_id>/fanout.json` détaille chaque clone).
2. `plan_join` enchaîné avec `join_policy = "all"` (ou `"quorum"` si le vote
   majoritaire suffit) et un `timeout_sec` raisonnable (2–5 s pour les mocks).
3. `plan_reduce` pour agréger :
   - `concat` pour un verbatim fusionné,
   - `merge_json` si les clones répondent en JSON,
   - `vote` pour dégager la majorité ; vérifier `trace.details.tally`.
4. Finaliser par `child_collect`/`child_gc` pour rapatrier les artefacts et
   libérer les workdirs (automatique après `plan_reduce` si besoin de nettoyage).

#### Prompts : bonnes pratiques

- Toujours définir `system` + `user`; garder `assistant` pour contextualiser les
  réponses attendues ou exemples. Les segments peuvent être chaînes ou tableaux.
- `prompt_variables` doit couvrir **toutes** les occurrences `{{variable}}`. Un
  oubli déclenche la validation de `renderPromptTemplate`.
- Préférer des clés explicites (`task_summary`, `ticket_id`) et typer les
  valeurs (`number` pour index, `boolean` pour drapeaux). Les conversions sont
  réalisées côté template.
- Garder les instructions idempotentes : chaque clone doit comprendre son rôle
  sans dépendre de l’historique parent.

#### Limites opérationnelles

- Écritures strictement confinées à `children/<childId>/` (logs, outbox,
  manifestes) et `run-*/` pour les fan-outs/exports. Toute tentative hors de ces
  racines est bloquée par `resolveWithin`.
- Taille conseillée des payloads : <= 32 KiB par message MCP pour rester fluide
  en STDIO ; privilégier les artefacts pour les contenus volumineux.
- Timeouts recommandés :
  - `child_create.timeouts.ready_ms` entre 1 000 et 5 000 ms selon la machine,
  - `child_send.timeout_ms` adapté au workload (garder une marge ×2 sur la
    durée estimée),
  - Watchdog d’inactivité (`idle_ms`) ≥ 30 s pour éviter les faux positifs.

---

## Règles de TEST & BUILD (à respecter strictement)

* Build : `npm run build` doit **réussir** sans erreurs, `npm run lint` **propre** (tsc noEmit).
* Tests : offline, déterministes (pas de réseau, pas d’horloge non contrôlée).
* Couverture : chaque **nouveau tool** a ses tests unitaires ; les parties critiques ont aussi un test d’intégration (mock runner enfant).
* Contrats : toutes les entrées/sorties tool sont validées **zod** ; en cas d’erreur, message clair + code stable.
* FS : toute écriture se fait dans `children/<childId>/` ou `run-*/` ; interdiction de traversée de chemin (`paths.ts`).
* Logs : JSONL toujours actif (niveau configurable) ; ne pas logguer des données lourdes en CI.
* CI : échec si tests/tsc échouent ; garder la matrice Node.

---

## Acceptation (critères)

* Enfants : créer/envoyer/collecter/annuler/GC validés par tests ; log JSONL visible ; heartbeats stables ; no leak process.
* Plan : fan-out contrôlé (`parallelism`, `retry`) ; `join` (all/first_success/quorum) ; `reduce` (concat/merge_json/vote).
* Graphes : generate/mutate/validate/summarize opérationnels ; exports (JSON/Mermaid/DOT) valides ; re-import JSON inchangé.
* Algorithmes : k-paths (Yen) corrects ; betweenness (Brandes) correcte ; constrained paths respectent contraintes.
* Simulation/optimisation : makespan simulé correct ; critical path correct ; multi-obj produit au moins deux solutions Pareto non dominées.
* Causal : ordres topo corrects ; cycles détectés ; suggestions de coupure cohérentes.
* Performance : cache/index fonctionnels (tests simples) ; partitionneur donne partitions plausibles sur graphes jouets.
* Docs : README/AGENTS contiennent des exemples exécutables réalistes.

---

## Remarques finales (pour t’organiser)

* Priorise : B (enfants robustes) → C (plan) → D/E (outils & algos) → F (simulation/opt) → G (causal) → H/I (viz/perf) → J (docs).
* À chaque ajout de tool : code + schémas zod + tests + un **mini-exemple** dans README.
* Garde les mutations de graphe **atomiques** avec un numéro de version pour invalider proprement le cache (I1).

Quand tu auras avancé, je peux te générer les **squelettes** des fichiers nouveaux (TypeScript + tests) pour accélérer l’implémentation.

---

## Historique des actions

- 2025-10-31 : README complété (exemples graph_generate/mutate/validate/summarize, algos & optimisations) et AGENTS enrichi (recette plan_fanout→join→reduce, bonnes pratiques prompts, limites FS/timeouts).
- 2025-10-24 : `child_send` accepte `expect` (`stream`/`final`), temps d'attente optionnel, clonage du message attendu ; tests `child.tools` étendus et README mis à jour.
- 2025-10-23 : Raffinement du partitionneur `min-cut` (rotation/variants + raffinement greedy) et restauration de l’idempotence de `graph_mutate` ; suite `npm test` de nouveau entièrement verte.
- 2025-10-21 : Renforcement des tests `graph_causal_analyze` (multi-sources, fermeture BFS sur graphe cyclique) pour valider min-cut et transitivité.
- 2025-09-30 : Implémentation de `graph_paths_constrained` côté GraphForge, intégration du tool orchestrateur associé et ajout des tests unitaires (`graphforge.constrained`, cas supplémentaires dans `graph.tools.paths`).
- 2025-10-15 : Ajout des tools `graph_optimize_moo` et `graph_causal_analyze`, création des exports Mermaid/DOT/GraphML avec conversion des snapshots, extension du tool `graph_export`, nouveaux tests (`graph.optimize-moo`, `graph.causal`, `graph.export`) et mise à jour du README.
- 2025-09-30 : Ajout d’un test d’intégration `graph_export` validant l’écriture sur disque avec `inline=false`, la troncature du pré-visualisation et la restauration du `GraphState` après l’appel.
- 2025-10-20 : Paramètre `objective` généralisé pour `graph_optimize`, projections enrichies (valeurs d’objectif) et nouveaux tests unitaires dédiés (`graph.simulate`, `graph.critical-path`, `graph.optimize`).

**Memento pour le prochain agent**

### Bloc 2025-10-31 — Docs & recettes alignées
- ✅ README complété avec des appels MCP prêts à l’emploi pour `graph_generate`,
  `graph_mutate`, `graph_validate`, `graph_summarize`, `graph_paths_k_shortest`,
  `graph_paths_constrained`, `graph_centrality_betweenness` et `graph_optimize`
  afin de couvrir l’ensemble des outils graphes/algos. 【F:README.md†L168-L346】
- ✅ AGENTS mis à jour : cases A1/A4 cochées, recette fan-out→join→reduce,
  bonnes pratiques de templating et limites FS/timeouts pour guider les agents
  suivants. 【F:AGENTS.md†L20-L115】【F:AGENTS.md†L348-L392】
- 🔜 (optionnel) Ajouter un job `test:int` dédié si la séparation unit/inté
  devient utile ; maintenir le bench cache/index lorsqu’il sera priorisé.

### Bloc 2025-09-30 — Contrainte des chemins
- ✅ Ajout de `graph-forge/src/algorithms/constraints.ts` avec Dijkstra contraint (évite nœuds/arêtes, budget max) et export depuis `graph-forge/src/index.ts`.
- ✅ Intégration du calcul dans `handleGraphPathsConstrained` (diagnostics détaillés, notes de budget) et extension des tests `graph.tools.paths`.
- ✅ Nouveau fichier `tests/graphforge.constrained.test.ts` couvrant exclusions, dépassement de budget et start interdit.
- 🔜 Vérifier à terme l’intégration avec des graphes pondérés complexes (ex : coûts dérivés d’attributs custom) et envisager un heuristique A* si les performances deviennent un enjeu.
- 🧪 Vérifié via `npm run lint`, `npm run build`, `npm test` (tous verts avant commit).

### Bloc 2025-10-20 — Optimisation mono-objectif
- ✅ `graph_optimize` accepte désormais `objective` (`makespan`/`cost`/`risk`) avec projection des valeurs d’objectif et impact détaillé. 【F:src/tools/graphTools.ts†L1697-L1910】
- ✅ Nouveaux tests ciblés : `graph.simulate`, `graph.critical-path`, `graph.optimize` pour verrouiller la simulation, le calcul du chemin critique et les stratégies mono-objectif. 【F:tests/graph.simulate.test.ts†L1-L63】【F:tests/graph.critical-path.test.ts†L1-L40】【F:tests/graph.optimize.test.ts†L1-L43】
- 🔜 Ajouter des scénarios `objective: "risk"` avec fortes concurrences pour éprouver les pénalités de risque/concurrence.
- 🧪 Vérifié via `npm test` (couverture unitaires complète).

### Bloc 2025-10-22 — Cache & partition
- ✅ Mise en place du cache LRU et de l’invalidation par version pour les calculs de chemins, centralité et résumé de graphe. 【F:src/graph/cache.ts†L1-L136】【F:src/tools/graphTools.ts†L624-L713】【F:src/tools/graphTools.ts†L785-L905】
- ✅ Création de l’index d’attributs/dégré pour alimenter `graph_summarize` et préparer les heuristiques de partition. 【F:src/graph/index.ts†L1-L200】【F:src/tools/graphTools.ts†L624-L713】
- ✅ Ajout de l’outil `graph_partition`, de son exposition serveur/tests et de la documentation dédiée. 【F:src/graph/partition.ts†L1-L220】【F:src/tools/graphTools.ts†L1070-L1119】【F:src/server.ts†L1644-L1672】【F:README.md†L150-L229】【F:tests/graph.partition.test.ts†L1-L58】

### Bloc 2025-10-23 — Partition & mutation stabilisées
- ✅ Ajout de variantes de seeds + raffinement greedy pour le mode `min-cut` du partitionneur. 【F:src/graph/partition.ts†L1-L360】【F:tests/graph.partition.test.ts†L1-L58】
- ✅ `graph_mutate` conserve la version si l’état final est identique (snapshot net-change). 【F:src/tools/graphTools.ts†L360-L472】【F:tests/graph.tools.mutate-validate.test.ts†L28-L76】
- 🧪 `npm test` complet (91 tests, tous verts). 【37d9ef†L1-L118】

### Bloc 2025-10-30 — Manifestes enrichis `child_create`
- ✅ Extension du schéma `child_create` pour capturer `prompt`, `tools_allow`, `timeouts` et `budget`, avec retour direct du `workdir` et du timestamp de démarrage. 【F:src/tools/childTools.ts†L24-L169】
- ✅ Mise à jour des tests `child.tools` afin de valider la persistance des nouveaux champs dans `manifest.json`. 【F:tests/child.tools.test.ts†L28-L94】
- ✅ Documentation enrichie (`README`) détaillant les nouveaux paramètres et leur stockage. 【F:README.md†L40-L87】
- 🧪 `npm test` 【9e20f2†L1-L33】

### Bloc 2025-10-24 — Diff structuré `graph_mutate`
- ✅ Remplacement du double `JSON.stringify` par une comparaison structurée insensible à l’ordre pour détecter les mutations nettes, tout en conservant l’invalidation du cache. 【F:src/tools/graphTools.ts†L360-L476】
- ✅ Ajout d’un test régressif garantissant que des opérations annulées n’incrémentent plus la version du graphe. 【F:tests/graph.tools.mutate-validate.test.ts†L52-L69】
- 🧪 `npm test` (92 tests) pour valider le diff structuré et l’absence de régressions. 【15c387†L1-L120】

### Bloc 2025-10-25 — Identifiants enfants & watchdog
- ✅ Génération `child-<timestamp>-<suffix>` centralisée dans le superviseur pour garantir des workdirs stables et concises. 【F:src/childSupervisor.ts†L133-L164】【F:src/childSupervisor.ts†L236-L284】
- ✅ Mise en place d’un watchdog d’inactivité configurable qui bascule les clones en état `idle` après `idleTimeoutMs`, avec purge automatique lors de l’arrêt/GC. 【F:src/childSupervisor.ts†L191-L409】【F:src/childSupervisor.ts†L434-L490】
- 🧪 Nouveaux tests couvrant l’identifiant, la configuration des timeouts et la transition automatique vers `idle`. 【F:tests/child.tools.test.ts†L35-L200】【F:tests/child.supervisor.test.ts†L15-L130】

### Bloc 2025-10-26 — Plan_reduce validé
- ✅ Création de `tests/plan.reduce.test.ts` pour verrouiller les stratégies `concat`, `merge_json` et `vote` avec synchronisation explicite des réponses enfants avant agrégation. 【F:tests/plan.reduce.test.ts†L1-L228】
- ✅ Vérification que `handlePlanReduce` trace correctement les erreurs de parsing et les comptages de vote lors des agrégations. 【F:src/tools/planTools.ts†L765-L893】
- 🧪 `npm test` 【270d38†L1-L89】

### Bloc 2025-10-29 — Risque & pénalités de parallélisme
- ✅ Ajout d'un scénario `graph_optimize` orienté risque pour valider les pénalités de parallélisme et de concurrence sur un graphe très parallélisable. 【F:tests/graph.optimize.test.ts†L52-L98】
- 🧪 `npm test` 【1a18bd†L1-L104】

### Bloc 2025-10-28 — Scalarisation validations
- ✅ Couverture des validations `graph_optimize_moo` : rejet des libellés dupliqués via le schéma et note runtime lorsque la somme des pondérations est nulle. 【F:tests/graph.optimize-moo.test.ts†L61-L98】
- 🧪 `npm test` 【e057b7†L1-L34】

### Bloc 2025-10-27 — Partition stress tests
- ✅ Ajout de cas `k` surdimensionné pour vérifier le clamp automatique et la couverture des notes de diagnostic. 【F:tests/graph.partition.test.ts†L64-L76】
- ✅ Scénario de graphes denses avec ponts multiples afin de valider la stabilité des communautés et la borne supérieure des arêtes coupées. 【F:tests/graph.partition.test.ts†L78-L109】
- 🧪 `npm test` 【e8d417†L1-L28】

### Bloc 2025-09-30 — Graph generate & summarize regressions
- ✅ Création de `tests/graph.tools.generate-summarize.test.ts` pour couvrir la fusion preset+tâches, la génération de dépendances synthétiques et les métriques de résumé (couches, entrypoints, nœuds critiques). 【F:tests/graph.tools.generate-summarize.test.ts†L1-L72】
- 🧪 `npm test` 【c4c554†L1-L105】

### Ce qui a été fait
* J’ai enrichi `child_send` avec le paramètre `expect` (stream/final) + attente optionnelle, clonage du message et documentation associée (tests `child.tools`, README). 【F:src/tools/childTools.ts†L121-L247】【F:tests/child.tools.test.ts†L1-L169】【F:README.md†L30-L92】
* J’ai ajouté un cache LRU pour les calculs coûteux et branché l’invalidation par version dans les outils de chemins, de centralité et de résumé. 【F:src/graph/cache.ts†L1-L136】【F:src/tools/graphTools.ts†L624-L713】【F:src/tools/graphTools.ts†L785-L905】【F:src/tools/graphTools.ts†L1002-L1119】
* J’ai créé l’index d’attributs/degrés et l’ai intégré au résumé de graphe ainsi qu’aux heuristiques de partition. 【F:src/graph/index.ts†L1-L200】【F:src/tools/graphTools.ts†L624-L713】
* J’ai introduit l’outil `graph_partition`, son enregistrement serveur et la documentation utilisateur correspondante. 【F:src/graph/partition.ts†L1-L220】【F:src/tools/graphTools.ts†L1070-L1119】【F:src/server.ts†L1644-L1672】【F:README.md†L150-L229】
* J’ai ajouté des tests unitaires ciblant le cache/index et les partitions pour verrouiller les comportements de base. 【F:tests/graph.cache-index.test.ts†L1-L63】【F:tests/graph.partition.test.ts†L1-L58】
* J’ai raffiné l’heuristique `min-cut` (rotation des seeds, variantes multiples, raffinement greedy) pour réduire les coupures et stabiliser les tests. 【F:src/graph/partition.ts†L1-L360】【F:tests/graph.partition.test.ts†L1-L58】
* J’ai fiabilisé `graph_mutate` en remplaçant la comparaison JSON par un diff structuré insensible à l’ordre et couvert par des tests d’annulation de mutations. 【F:src/tools/graphTools.ts†L360-L476】【F:tests/graph.tools.mutate-validate.test.ts†L28-L69】

### Ce qui reste à faire / TODO
1. **Benchmarks cache/index** : mesurer l’impact avec et sans LRU/index sur des graphes volumineux, puis documenter les résultats. 【F:src/graph/cache.ts†L1-L136】【F:src/graph/index.ts†L1-L200】

### Tests supplémentaires recommandés
* ~~**`graph_optimize_moo`** : scénarios avec pondérations nulles/négatives ou objectifs redondants afin de couvrir les validations.~~ ✅ Couvert par `tests/graph.optimize-moo.test.ts`. 【F:tests/graph.optimize-moo.test.ts†L61-L98】
* ~~**`graph_export`** : test d’intégration écrivant réellement un fichier pour vérifier les droits et le flush.~~ ✅ Couvert par `tests/graph.export.test.ts`. 【F:tests/graph.export.test.ts†L1-L147】
* ~~**`graph_optimize` (objective: risk)** : valider l’impact des pénalités de concurrence sur des graphes fortement parallélisables.~~ ✅ Couvert par `tests/graph.optimize.test.ts`. 【F:tests/graph.optimize.test.ts†L52-L98】

### Notes / Quirks
* L’environnement reconstruit `dist/` à chaque build ; vérifier que `dist/viz/` reste synchronisé avec `src/viz/`.
* Les tests `npm test` lancent un `npm run build` préalable — prévoir un peu de temps.
* Aucun bug ouvert repéré, mais l’algorithme de min-cut est un Edmonds-Karp simplifié avec capacités unitaires ; pour des besoins plus avancés, une refactorisation pourrait être envisagée.

### Résumé rapide
- ✅ Implémentation complète du cache LRU pour les calculs de graphes avec invalidation par version dans `src/graph/cache.ts`, intégration dans les outils de chemins/k plus courts et centralité (`src/tools/graphTools.ts`), plus ajout d’un clone utilitaire.
- ✅ Création de l’index d’attributs/dégré dans `src/graph/index.ts` et raccords (outil partition et tests).
- ✅ Ajout de l’algorithme de partition heuristique dans `src/graph/partition.ts` et exposition via le nouveau tool `graph_partition` (enregistrement serveur + doc + tests).
- ✅ Versionning des graphes : `normaliseDescriptor` capture `graph_id`/`graph_version`, `handleGraphMutate` n’incrémente plus la version si le résultat net est inchangé, métadonnées mises à jour.
- ✅ Nouveaux tests : `tests/graph.cache-index.test.ts` (cache + index) et `tests/graph.partition.test.ts`. Mise à jour du README avec la section `graph_partition`.
- ✅ Heuristique `min-cut` améliorée (rotation des seeds, raffinement local) + `npm test` repassé au vert. 【F:src/graph/partition.ts†L1-L360】【F:tests/graph.partition.test.ts†L1-L58】【37d9ef†L1-L118】
- ✅ `graph_mutate` détecte désormais les mutations via un diff structuré (plus de double `JSON.stringify`) et reste idempotent. 【F:src/tools/graphTools.ts†L360-L476】【F:tests/graph.tools.mutate-validate.test.ts†L28-L69】

### Modifications détaillées
- `src/graph/cache.ts`: nouvelle classe `GraphComputationCache`, LRU interne, fonction `serialiseVariant` et logiques d’invalidation.
- `src/graph/index.ts`: index attributs, calculs de degrés/hubs/isolation, résumé de degrés avec tie-breaks.
- `src/graph/partition.ts`: label propagation + min-cut heuristique, distribution équilibrée, options seed/iterations.
- `src/tools/graphTools.ts`: imports cache/index/partition, ajout `graph_id`/`graph_version`, cache sur `graph_paths_k_shortest`/`graph_centrality_betweenness`/betweenness summary, nouveau handler/schema `graph_partition`, génération manifeste baseline et versioning net, diff structuré pour `graph_mutate`.
- `src/server.ts`: enregistrement du tool `graph_partition` avec logs, import des schémas/handlers.
- `README.md`: bullet `graph_partition` + exemple complet.
- Tests : `tests/graph.cache-index.test.ts`, `tests/graph.partition.test.ts`.
- Metadata dans autres fichiers générés (ex. doc, tests) alignés.

### TODO / Suivi
1. **Éventuels cas limites cache** – vérifier comportement quand les variantes sont très volumineuses ou contiennent des objets profonds. Voir `src/graph/cache.ts` (logiciel pourrait bénéficier d’optimisation ou de deep-clone plus robuste).
2. **Partition heuristics** – envisager des tests supplémentaires pour graphes très connectés ou avec pondérations asymétriques (`src/graph/partition.ts`). Actuellement test principal couvre cluster séparés mais pas graphes complexes.
3. **README** – si d’autres tools utilisent le cache/index, ajouter exemples avancés (non bloquant).

### Tests complémentaires à prévoir
- Partition : cas pondérés très asymétriques (poids dirigés, k>2) pour affiner l’analyse de la stabilité restante.
- Cache : scénarios multi-thread (si orchestrateur devient concurrent) et variantes non JSON-sérialisables. À couvrir dans de futurs tests d’intégration.

### Notes / Quirks
- `npm install --no-save --no-package-lock` a été nécessaire pour récupérer `mocha`/`chai`.
- Les métadonnées `graph_id`/`graph_version` sont désormais présentes dans tous les graphes renvoyés : vérifier compatibilité avec consommateurs externes.
- Le cache utilise SHA-1 pour composer les clés ; suffisamment pour maintenant, mais à surveiller si budgets sécurité stricts.
- `graph_partition` produit des partitions déterministes via seed (fallback sur hash du graphe) : adapter si vous avez besoin de randomisation différente.
- Aucun bug ouvert identifié après les tests (`npm run lint`, `npm test`).
