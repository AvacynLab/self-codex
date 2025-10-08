## 📋 Mission pour toi, Agent Codex — Campagne de validation & amélioration MCP

**Objectif global :**
Tu dois tester **tous les outils (tools)** exposés par le serveur MCP, les **appeler directement**, vérifier leur **fonctionnement complet**, produire des **logs détaillés** et répondre à des **questions d’analyse**.
Tu dois créer un **dossier d’audit séparé** du dépôt (`validation_runs/<timestamp>/`) et produire un **rapport complet** contenant :

* les appels (`inputs/`)
* les réponses (`outputs/`)
* les événements (`events/`)
* les ressources lues (`resources/`)
* les logs (`logs/`)
* un rapport final (`report/`)

Pour chaque étape, coche ✅ lorsque l’objectif est rempli.

---

### 📁 Préparation de l’environnement

* [x] Créer un dossier `validation_runs/<timestamp>/` à la racine du workspace
* [x] Créer les sous-dossiers : `inputs/`, `outputs/`, `events/`, `logs/`, `resources/`, `report/`
* [x] Configurer un identifiant unique (`traceId`) pour chaque appel MCP
* [x] Activer l’écriture de toutes les réponses JSON brutes dans `outputs/`
* [x] Activer la capture complète des événements dans `events/` en format JSONL
* [x] Activer la journalisation complète (horodatée) dans `logs/`

---

### 🧪 Étape 1 – Introspection et découverte

* [x] Appeler `mcp_info` pour récupérer la version, le protocole, les capacités
* [x] Appeler `mcp_capabilities` et sauvegarder la liste complète des tools disponibles
* [x] Lister les ressources disponibles (`resources_list`) pour tous les préfixes connus
* [x] Souscrire aux événements (`events_subscribe`) et vérifier qu’ils sont bien reçus en temps réel

---

### ⚙️ Étape 2 – Tests de base des outils

* [x] Appeler chaque tool **au moins une fois** avec des paramètres valides
* [x] Documenter pour chaque appel : durée, résultat, code d’erreur éventuel, logs associés
* [x] Tester les comportements attendus et inattendus (cas normaux + erreurs)
* [x] Vérifier que chaque tool renvoie les bons types et formats de données
* [x] Vérifier que tous les tools gèrent correctement les erreurs et les statuts HTTP
  * [x] Couvrir les outils `graph_*` de base (`graph_generate`, `graph_validate`, `graph_summarize`, `graph_paths_k_shortest`) et `logs_tail` avec rapports persistés (`report/step02-base-tools.json`).
* [x] Compléter la couverture des outils restants signalés par le rapport final (section « Couverture des outils ») afin de lever les alertes de Stage 8.
  * _(Progression : `mcp_info`, `mcp_capabilities`, `resources_list`, `resources_read`, `resources_watch`, `events_*`, `logs_tail`, `graph_export`, `graph_state_stats`, `graph_state_metrics`, `graph_state_inactivity`, `graph_config_retention`, `graph_config_runtime`, `graph_prune`, `graph_query`, `graph_mutate`, `graph_state_save`, `graph_state_load`, `graph_state_autosave`, `graph_subgraph_extract`, `graph_hyper_export`, `graph_rewrite_apply`, `graph_batch_mutate`, `graph_paths_constrained`, `graph_centrality_betweenness`, `graph_partition`, `graph_critical_path`, `graph_simulate`, `graph_optimize`, `graph_optimize_moo`, `graph_causal_analyze`, `graph_forge_analyze`, `status`, `job_view`, `conversation_view`, `start`, `aggregate`, `kill`, `agent_autoscale_set`, `plan_compile_bt`, `plan_fanout`, `plan_join`, `plan_reduce` (concat/merge_json/vote), `child_spawn_codex`, `child_status`, `child_attach`, `child_set_limits`, `child_set_role`, `child_send`, `child_cancel`, `child_prompt`, `child_push_partial`, `child_push_reply`, `child_chat`, `child_info`, `child_transcript`, `child_rename`, `child_reset`, `child_create`, `child_batch_create`, `child_collect`, `child_stream`, `child_kill`, `child_gc`, ainsi que `bb_set`/`bb_get`/`bb_batch_set`/`bb_query`/`bb_watch` exercés et journalisés.)_

---

### 🔁 Étape 3 – Transactions, versions et invariants

* [x] Créer un graphe de test (`G_TEST`) et effectuer une transaction complète (`tx_begin`, `tx_apply`, `tx_commit`)
* [x] Comparer les différences avant/après (`graph_diff`)
* [x] Tester le patching (`graph_patch`) avec succès et avec violation d’invariant (doit échouer proprement)
* [x] Tester les verrous (`graph_lock`, `graph_unlock`) en cas d’accès concurrent
* [x] Tester l’idempotence (`tx_begin` avec `idempotencyKey`) et vérifier l’identité bit-à-bit des réponses

---

### 👶 Étape 4 – Enfants & orchestration multi-instances

* [x] Tester la création d’instances enfant (`child_spawn_codex`) avec des prompts différents
* [x] Vérifier la communication avec les enfants (`child_attach`, `child_status`)
* [x] Tester les limites CPU/mémoire (`child_set_limits`) et vérifier leur application
* [x] Annuler une tâche enfant en cours (`op_cancel`) et observer le comportement
* [x] Confirmer que chaque enfant fonctionne comme une instance autonome complète de Codex

---

### 📊 Étape 5 – Graphes, valeurs et plans

* [x] Créer et modifier un graphe avec plusieurs nœuds et relations complexes
* [x] Tester les outils de planification (`plan_run_bt`, `plan_dry_run`, `plan_status`)
* [x] Vérifier la pause et la reprise de plans (`plan_pause`, `plan_resume`)
* [x] Utiliser `values_set`/`values_score`/`values_filter`/`values_explain` pour injecter des règles et vérifier leur impact
* [x] Utiliser `kg_insert`, `kg_query` et `kg_export` pour manipuler le graphe de connaissance

---

### 📉 Étape 6 – Résilience et annulation

* [x] Démarrer une opération longue puis l’annuler (`op_cancel`) → vérifier que l’arrêt est propre
* [x] Annuler un plan complet (`plan_cancel`) et s’assurer que toutes les opérations enfants sont arrêtées
* [x] Tester les réactions aux erreurs : paramètres invalides, dépendances manquantes, timeout

---

### 🧠 Étape 7 – Fonctions avancées

* [x] Tester les fonctions de raisonnement causal (`causal_explain`, `causal_export`)
* [x] Tester les mécanismes de stigmergie (`stig_mark`, `stig_decay`, `stig_batch`, `stig_snapshot`)
* [x] Tester les outils de consensus et coordination (`consensus_vote`, `cnp_announce`, `cnp_refresh_bounds`, `cnp_watcher_telemetry`)
* [x] Tester les fonctionnalités d’assistance (`kg_suggest_plan`)
* [x] Vérifier la cohérence des logs et la corrélation des événements avec `logs_tail`

---

### 📜 Étape 8 – Rapport final

* [x] Générer `report/summary.md` avec le résumé des résultats, succès/échecs
* [x] Générer `report/findings.json` avec les métriques et observations détaillées
* [x] Générer `report/recommendations.md` avec tes suggestions d’améliorations techniques
* [x] Inclure un tableau des outils testés avec pour chacun : statut ✅/❌, latence moyenne, erreurs, anomalies

---

### 🤔 Questions obligatoires auxquelles tu dois répondre dans `recommendations.md`

* [x] Quelles tools sont sous-documentées ou manquent de clarté dans leur réponse ?
* [x] Y a-t-il des invariants non vérifiés ou des règles trop permissives ?
* [x] Quelles erreurs sont silencieuses ou mal gérées ?
* [x] Quels événements manquent de contexte ou de granularité ?
* [x] Quels outils pourraient être fusionnés ou refactorisés ?
* [x] As-tu remarqué des problèmes de performance ou de latence ?
* [x] As-tu rencontré des points d’annulation incomplets ou défaillants ?
* [x] Quelles nouvelles capacités pourraient améliorer l’expérience multi-agent ?
* [x] Y a-t-il des informations absentes dans les logs nécessaires pour le débogage ?
* [x] Quelles métriques ajouterais-tu pour mieux observer l’état du système ?

---

## ✅ Critères de validation finaux

* Tous les outils ont été appelés au moins une fois.
* Chaque outil a une trace d’entrée/sortie enregistrée.
* Tous les événements et logs sont corrélés à leurs opérations.
* Les fonctions critiques (annulation, transactions, idempotence, lock, enfants, planification) sont vérifiées.
* Les erreurs sont identifiées, catégorisées et documentées.
* Un rapport final exploitable est produit.

---

📌 **Rappel** : tu ne dois **rien modifier dans le dépôt**. Tout doit être écrit dans `validation_runs/`.
📌 Tu dois agir **comme un testeur expert et un ingénieur QA multi-agent** : explorer, casser, observer, comprendre, recommander.

---

---

### Historique des passages
- 2025-10-07 – Agent `gpt-5-codex` (iteration 41)
  - ✅ Réinitialisation du fichier `AGENTS.md` avec la checklist fournie par l’utilisateur.
  - ✅ Création de l’exécution `validation_runs/20251007T184620Z` et de son squelette d’artefacts.
  - ✅ Ajout des utilitaires `runContext` (générateur de `traceId`, initialisation des dossiers) et tests associés.
- 2025-10-07 – Agent `gpt-5-codex` (iteration 42)
  - ✅ Implémentation de l’enregistreur d’artefacts (entrées, sorties, événements, logs) pour les appels MCP.
  - ✅ Couverture de tests dédiée aux enregistreurs pour garantir les écritures JSON/JSONL déterministes.
  - ✅ Validation via `npm run lint` et exécution des tests `validation_runs/20251007T184620Z/tests/**/*.test.ts`.
- 2025-10-07 – Agent `gpt-5-codex` (iteration 43)
  - ✅ Ajout du harnais `McpSession` pour piloter le serveur via transports mémoire avec restauration des flags.
  - ✅ Implémentation de l’étape d’introspection (outils MCP, ressources, events) avec génération des rapports JSON.
  - ✅ Couverture de tests e2e sur le harnais et l’étape d’introspection, vérification des artefacts et des logs.
- 2025-10-07 – Agent `gpt-5-codex` (iteration 44)
  - ✅ Implémentation de `lib/baseTools.ts` pour exécuter les fumigations Stage 2 (graph + logs) avec collecte des codes d’erreur.
  - ✅ Génération automatisée du rapport `report/step02-base-tools.json` et sauvegarde du graphe de référence (`resources/stage02-base-graph.json`).
  - ✅ Ajout d’un test mocha dédié garantissant les artefacts et la couverture des scénarios valides/invalides (`tests/baseTools.test.ts`).
- 2025-10-07 – Agent `gpt-5-codex` (iteration 45)
  - ✅ Implémentation de `lib/transactions.ts` couvrant la transaction complète, le diff et les scénarios de patch (succès + violation d’invariant) avec rapports persistés.
  - ✅ Validation des verrous coopératifs et de la rejouabilité idempotente (`tx_begin`) avec agrégation des métriques Stage 3.
  - ✅ Ajout du test `tests/transactions.test.ts` vérifiant la production des artefacts Stage 3 et mise à jour de la documentation de run.
- 2025-10-07 – Agent `gpt-5-codex` (iteration 46)
  - ✅ Implémentation de l’étape 4 (enfants & multi-instances) via `lib/children.ts` avec rapports d’orchestation et annulation `op_cancel`.
  - ✅ Couverture de tests dédiée (`tests/children.test.ts`) validant la création multi-enfants, la communication, les limites et la cancellation.
  - ✅ Génération du rapport `report/step04-child-orchestration.json` et nettoyage déterministe des runtimes enfants.

- 2025-10-08 – Agent `gpt-5-codex` (iteration 47)
  - ✅ Implémentation de `lib/plans.ts` pour l’étape 5 (graphes enrichis, valeur guard, planification BT + réactive, lifecycle pause/reprise).
  - ✅ Ajout du test `tests/plans.test.ts` couvrant pause/resume, value guard, knowledge graph et rapport Stage 5.
  - ✅ Génération du rapport `report/step05-plans-values.json` et restauration de la dépendance `tsx` pour permettre `npm test` complet.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 48)
  - ✅ Implémentation de l’étape 6 via `lib/resilience.ts` couvrant annulation longue (`op_cancel`), `plan_cancel` et probes d’erreurs (timeout, paramètres invalides, dépendances manquantes).
  - ✅ Ajout du test `tests/resilience.test.ts` validant les scénarios de résilience et la génération du rapport `report/step06-resilience.json`.
  - ✅ Exécution de `npm test` pour garantir la réussite de l’ensemble de la suite.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 49)
  - ✅ Implémentation de `lib/advanced.ts` couvrant causalité, stigmergie, consensus, Contract-Net et assistance avec génération du rapport `report/step07-advanced-functions.json`.
  - ✅ Ajout du test `tests/advanced.test.ts` vérifiant les métriques de l’étape 7 (causal, coordination, assistance, logs).
  - ✅ Mise à jour de `AGENTS.md` pour valider les cases de l’étape 7 et documenter l’itération.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 50)
  - ✅ Consolidation de l’étape 8 via `lib/finalReport.ts` générant `summary.md`, `findings.json` et `recommendations.md` avec agrégations de latence et d’erreurs.
  - ✅ Ajout du test `tests/finalReport.test.ts` couvrant la consolidation multi-étapes et la table de couverture des outils.
  - ✅ Enrichissement des rapports d’étapes 3 à 7 avec la persistance des appels pour l’audit final et mise à jour de la checklist Stage 8.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 51)
  - ✅ Ajout de la détection des outils non exercés dans `lib/finalReport.ts` (comparaison Stage 1 ↔ appels cumulés) avec métriques de couverture détaillées.
  - ✅ Mise à jour du rapport Markdown/JSON pour afficher les outils manquants et exposer les jeux de données inattendus.
  - ✅ Extension de `tests/finalReport.test.ts` pour valider les nouvelles métriques de couverture et l’exposition de `FinalReportStageResult.coverage`.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 52)
  - ✅ Extension de l’étape 2 avec les outils d’introspection/ressources/événements et `agent_autoscale_set`, plus journalisation dédiée.
  - ✅ Enrichissement de l’étape 5 : appels `values_score`, `values_filter`, `kg_export` et propagation des résumés dans le rapport et le résultat retourné.
  - ✅ Ajout des scénarios `stig_batch`, `stig_snapshot`, `cnp_refresh_bounds` et `cnp_watcher_telemetry` à l’étape 7, avec synthèse et assertions de test mises à jour.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 53)
  - ✅ Activation du module blackboard dans Stage 2 et appels `bb_set`/`bb_get`/`bb_batch_set`/`bb_query`/`bb_watch` persistés sous `stage02/baseTools`.
  - ✅ Mise à jour du test `tests/baseTools.test.ts` pour valider la structuration des réponses blackboard (bulk + watch) et la couverture des nouveaux outils.
  - ✅ Installation des dépendances manquantes (`npm install --silent`) puis exécution de `npm test --silent` (605 tests verts).
- 2025-10-08 – Agent `gpt-5-codex` (iteration 54)
  - ✅ Extension du harnais Stage 2 pour couvrir `graph_export`, `graph_state_*`, `graph_config_*`, `graph_prune` et `graph_query` avec scénarios documentés.
  - ✅ Renforcement du test `tests/baseTools.test.ts` pour affirmer les nouvelles réponses (statistiques, métriques, configuration runtime) et vérifier les scénarios de purge.
  - ✅ Mise à jour de la checklist (Section Étape 2) pour refléter la progression sur les outils de gestion d’état du graphe.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 55)
  - ✅ Ajout de la persistance `graph_state_save`/`graph_state_load` avec archivage des instantanés dans `resources/`.
  - ✅ Couverture des outils hiérarchiques (`graph_state_autosave`, `graph_subgraph_extract`, `graph_hyper_export`, `graph_rewrite_apply`) avec copies locales des artefacts générés.
  - ✅ Renforcement du test Stage 2 pour valider les nouveaux snapshots, métriques autosave et projections hyper-graphe.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 56)
  - ✅ Extension du harnais Stage 2 pour couvrir les outils d’analytique (`graph_paths_constrained`, `graph_centrality_betweenness`, `graph_partition`, `graph_critical_path`, `graph_simulate`, `graph_optimize`, `graph_optimize_moo`, `graph_causal_analyze`) avec scénarios normaux et erreurs contrôlées.
  - ✅ Mise à jour du test `tests/baseTools.test.ts` pour valider les réponses structurées (chemins contraints, centralité, partitions, simulation, optimisation) et vérifier les codes d’erreur attendus.
  - ✅ Actualisation de `AGENTS.md` pour refléter la progression Stage 2 et documenter l’itération pour le prochain agent.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 57)
  - ✅ Ajout d’un scénario `graph_mutate` dans Stage 2 pour enrichir le graphe de base (nœud QA, attributs de priorité) et préparer les opérations bulk.
  - ✅ Couverture des appels `graph_batch_mutate` (succès + conflit de version) avec consolidation du graphe retourné pour les étapes ultérieures.
  - ✅ Renforcement du test Stage 2 pour valider les nouvelles invocations (`graph_mutate`, `graph_batch_mutate`) et vérifier les attributs persistés.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 58)
  - ✅ Extension de l’étape 5 avec la compilation BT (`plan_compile_bt`) et synthèse des feuilles exécutables pour le rapport.
  - ✅ Orchestration d’un fan-out planifié (`plan_fanout`) suivi des jointures (`plan_join`) et réductions (`plan_reduce`) avec prompts enfants dédiés et nettoyage automatique.
  - ✅ Mise à jour du test Stage 5 et du rapport pour exposer les métriques fan-out/join/reduce et documenter les nouvelles couvertures de tools.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 59)
  - ✅ Renforcement de Stage 5 : relance automatique des `child_send`, suivi des échecs et jointures dégradées documentées dans le rapport.
  - ✅ Couverture des réducteurs supplémentaires (`plan_reduce` en `merge_json` et `vote`) avec persistance des agrégats et des traces associées.
  - ✅ Mise à jour des tests Stage 5 pour vérifier les nouveaux appels, les métriques de fan-out (échecs, dégradations) et les rapports enrichis.

- 2025-10-08 – Agent `gpt-5-codex` (iteration 60)
  - ✅ Extension du harnais enfants avec `child_set_role`, `child_prompt`/`child_push_partial`/`child_push_reply`, `child_chat`, `child_info`, `child_transcript`, `child_collect`, `child_stream`, `child_create`, `child_batch_create`, `child_rename`, `child_reset`, `child_kill` et `child_gc` pour lever les alertes de couverture.
  - ✅ Renforcement de `tests/children.test.ts` en vérifiant les pending_id, les artefacts batch, les nouveaux tracés et l’inclusion du troisième enfant synthétisé.
  - ✅ Mise à jour de `AGENTS.md` (progression Étape 2) afin de documenter l’exhaustivité accrue des outils enfants avant les prochaines itérations.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 61)
  - ✅ Ajout de la couverture `graph_forge_analyze` dans Stage 2 avec un script DSL compact et journalisation des analyses compilées.
  - ✅ Exercices des outils de gestion des jobs (`status`, `job_view`, `conversation_view`, `start`, `aggregate`, `kill`) côté Stage 2 avec validation des codes d’erreur déterministes `NOT_FOUND`.
  - ✅ Extension du test `tests/baseTools.test.ts` pour exiger les nouveaux appels, inspecter les charges JSON et vérifier la présence des erreurs attendues.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 62)
  - ✅ Ajout des appels `values_score`/`values_filter` et `kg_export` dans `runPlanningStage` avec résumés enrichis et assertions de test dédiées.
  - ✅ Extension de `runAdvancedFunctionsStage` pour couvrir `stig_batch`, `stig_snapshot`, `cnp_refresh_bounds` et `cnp_watcher_telemetry`, plus élargissement du rapport et du test Stage 7.
  - ✅ Mise à jour de la checklist Stage 2 afin de refléter la couverture exhaustive et la documentation des outils restants.
