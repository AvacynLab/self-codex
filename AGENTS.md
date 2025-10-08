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

* [ ] Appeler chaque tool **au moins une fois** avec des paramètres valides
* [ ] Documenter pour chaque appel : durée, résultat, code d’erreur éventuel, logs associés
* [ ] Tester les comportements attendus et inattendus (cas normaux + erreurs)
* [ ] Vérifier que chaque tool renvoie les bons types et formats de données
* [ ] Vérifier que tous les tools gèrent correctement les erreurs et les statuts HTTP
  * [x] Couvrir les outils `graph_*` de base (`graph_generate`, `graph_validate`, `graph_summarize`, `graph_paths_k_shortest`) et `logs_tail` avec rapports persistés (`report/step02-base-tools.json`).

---

### 🔁 Étape 3 – Transactions, versions et invariants

* [x] Créer un graphe de test (`G_TEST`) et effectuer une transaction complète (`tx_begin`, `tx_apply`, `tx_commit`)
* [x] Comparer les différences avant/après (`graph_diff`)
* [x] Tester le patching (`graph_patch`) avec succès et avec violation d’invariant (doit échouer proprement)
* [x] Tester les verrous (`graph_lock`, `graph_unlock`) en cas d’accès concurrent
* [x] Tester l’idempotence (`tx_begin` avec `idempotencyKey`) et vérifier l’identité bit-à-bit des réponses

---

### 👶 Étape 4 – Enfants & orchestration multi-instances

* [ ] Tester la création d’instances enfant (`child_spawn_codex`) avec des prompts différents
* [ ] Vérifier la communication avec les enfants (`child_attach`, `child_status`)
* [ ] Tester les limites CPU/mémoire (`child_set_limits`) et vérifier leur application
* [ ] Annuler une tâche enfant en cours (`op_cancel`) et observer le comportement
* [ ] Confirmer que chaque enfant fonctionne comme une instance autonome complète de Codex

---

### 📊 Étape 5 – Graphes, valeurs et plans

* [ ] Créer et modifier un graphe avec plusieurs nœuds et relations complexes
* [ ] Tester les outils de planification (`plan_run_bt`, `plan_dry_run`, `plan_status`)
* [ ] Vérifier la pause et la reprise de plans (`plan_pause`, `plan_resume`)
* [ ] Utiliser `values_set` et `values_explain` pour injecter des règles et vérifier leur impact
* [ ] Utiliser `kg_insert` et `kg_query` pour manipuler le graphe de connaissance

---

### 📉 Étape 6 – Résilience et annulation

* [ ] Démarrer une opération longue puis l’annuler (`op_cancel`) → vérifier que l’arrêt est propre
* [ ] Annuler un plan complet (`plan_cancel`) et s’assurer que toutes les opérations enfants sont arrêtées
* [ ] Tester les réactions aux erreurs : paramètres invalides, dépendances manquantes, timeout

---

### 🧠 Étape 7 – Fonctions avancées

* [ ] Tester les fonctions de raisonnement causal (`causal_explain`, `causal_export`)
* [ ] Tester les mécanismes de stigmergie (`stig_mark`, `stig_decay`)
* [ ] Tester les outils de consensus et coordination (`consensus_vote`, `cnp_announce`)
* [ ] Tester les fonctionnalités d’assistance (`kg_suggest_plan`)
* [ ] Vérifier la cohérence des logs et la corrélation des événements avec `logs_tail`

---

### 📜 Étape 8 – Rapport final

* [ ] Générer `report/summary.md` avec le résumé des résultats, succès/échecs
* [ ] Générer `report/findings.json` avec les métriques et observations détaillées
* [ ] Générer `report/recommendations.md` avec tes suggestions d’améliorations techniques
* [ ] Inclure un tableau des outils testés avec pour chacun : statut ✅/❌, latence moyenne, erreurs, anomalies

---

### 🤔 Questions obligatoires auxquelles tu dois répondre dans `recommendations.md`

* [ ] Quelles tools sont sous-documentées ou manquent de clarté dans leur réponse ?
* [ ] Y a-t-il des invariants non vérifiés ou des règles trop permissives ?
* [ ] Quelles erreurs sont silencieuses ou mal gérées ?
* [ ] Quels événements manquent de contexte ou de granularité ?
* [ ] Quels outils pourraient être fusionnés ou refactorisés ?
* [ ] As-tu remarqué des problèmes de performance ou de latence ?
* [ ] As-tu rencontré des points d’annulation incomplets ou défaillants ?
* [ ] Quelles nouvelles capacités pourraient améliorer l’expérience multi-agent ?
* [ ] Y a-t-il des informations absentes dans les logs nécessaires pour le débogage ?
* [ ] Quelles métriques ajouterais-tu pour mieux observer l’état du système ?

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
