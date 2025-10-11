Parfait — voici une **liste de tâches à cocher**, prête à transmettre à l’agent, pour tester **les outils MCP**, le **fonctionnement global** (enfants, graphes, planification, événements), **relever ce qui marche/ne marche pas**, et **proposer des améliorations**.
Adresse-toi au serveur via HTTP (port et chemin configurés), consigne tout dans un dossier de run isolé.

---

# ✅ To-do de validation & amélioration — Self-Codex (à l’attention de l’agent)

> Dossier de travail (à créer au début et à réutiliser partout) : `runs/validation_<DATE-ISO>/`
> Arborescence attendue :
>
> ```
> runs/validation_<DATE-ISO>/
>   inputs/          # requêtes envoyées (1 fichier .jsonl par phase)
>   outputs/         # réponses complètes (1 fichier .jsonl par phase)
>   events/          # flux d’événements .jsonl (par phase)
>   logs/            # copies /tmp/mcp_http.log + résumés
>   artifacts/       # artefacts produits par les outils (fichiers, graphes exportés…)
>   report/          # findings.json, summary.md, recommendations.md
> ```

## 0) Préflight & environnement

* [x] Créer `runs/validation_<DATE-ISO>/{inputs,outputs,events,logs,artifacts,report}`.
* [x] Lire `process.env` utiles (HOST, PORT, PATH, TOKEN) et afficher la cible finale.
* [x] Vérifier accessibilité HTTP du MCP :

  * [x] **Sans** Authorization → obtenir **401**.
  * [x] **Avec** `Authorization: Bearer <TOKEN>` → **200** (health/info).
* [x] Sauvegarder l’en-tête de session (URL, headers, date) dans `report/context.json`.

## 1) Introspection du serveur MCP

* [x] `mcp_info` → sauvegarder request/response dans `inputs/01_introspection.jsonl` & `outputs/01_introspection.jsonl`.
* [x] `mcp_capabilities` → lister transports, streaming, limites.
* [x] `tools_list` → inventaire des outils (noms, schémas d’input/output).
* [x] `resources_list` → ressources disponibles (si applicable).
* [x] `events_subscribe` → ouvrir un flux sur `events/01_bus.jsonl`, vérifier numérotation/horodatage (résumé auto dans `report/introspection_summary.json`).
* [x] (Tooling) Automatiser la phase 01 via `runIntrospectionPhase` + tests `introspection` (cf. `npm run validation:introspect`).
* [x] Générer `report/introspection_summary.json` (agrège info/capacités/outils/ressources + diagnostics événements).

## 2) Journalisation & santé

* [x] Forcer l’écriture de logs via un outil simple (ex : ping/echo) ; vérifier que `/tmp/mcp_http.log` bouge.
* [x] Copier `/tmp/mcp_http.log` → `runs/validation_…/logs/mcp_http.log` (outil `captureHttpLog`).
* [x] Ajouter un résumé JSON (`logs/summary.json`) : lignes totales, erreurs, WARN, p95 latence (via `captureHttpLog`).

## 3) Transactions & graphes

* ℹ️ Automatisation : `npm run validation:transactions` exécute la séquence nominale (begin/apply/commit/diff/patch) et une tentative de patch invalide, en écrivant les artefacts dans `inputs|outputs|events/02_tx*` et `logs/transactions_http.json`. ⚠️ Vérifier les retours serveur avant de cocher les étapes ci-dessous.
* [ ] Cas nominal :

  * [ ] `tx_begin` → récupérer l’ID de transaction.
  * [ ] `graph_diff` (baseline) → attendre “no changes”.
  * [ ] `graph_patch` (ajout de nœuds/edges) → succès.
  * [ ] `tx_commit` → succès.
* [ ] Cas erreur :

  * [ ] `tx_begin` → `graph_patch` invalide (contrainte cassée) → **erreur attendue**.
  * [ ] `tx_rollback` → vérif que l’état n’a pas changé.
* [ ] Concurrence :

  * [ ] `graph_lock` (session A) puis tentative de modification par session B → blocage explicite (automatisé via `runTransactionsPhase`, à valider sur le serveur réel).
* [ ] Export :

  * [ ] `values_graph_export` → outil à confirmer / implémenter (non disponible côté serveur aujourd'hui).
  * [ ] `causal_export` → déposer fichiers dans `artifacts/graphs/` (généré automatiquement en `artifacts/graphs/causal_export.json`).
* [ ] Sauvegarder toutes les requêtes/réponses dans `inputs/02_tx.jsonl` & `outputs/02_tx.jsonl`; événements dans `events/02_tx.jsonl`.

## 4) Outils “graph forge / analyse”

* ℹ️ Automatisation : `npm run validation:graph-forge` exécute `graph_forge_analyze` et pilote `graph_state_autosave` (start/wait/stop) en déposant DSL, rapports et résumés dans `artifacts/forge/` ainsi que les événements `autosave.tick`.
* [ ] `graph_forge_analyze` (sur un graphe jouet) → vérifier qualité des diagnostics, formats de sortie.
* [ ] `graph_state_autosave start` → attendre 2 cycles, vérifier événements `autosave.tick`.
* [ ] `graph_state_autosave stop` → plus de tick.
* [ ] Sauvegarder artefacts d’analyse dans `artifacts/forge/`.

## 5) Enfants (instances Codex “self-fork”)

* ℹ️ Automatisation : `npm run validation:children` orchestre spawn/attach/limits/send/kill, enregistre la conversation et publie `report/children_summary.json`.
* [ ] `child_spawn_codex` → créer un enfant avec métadonnées (objectif, limites CPU/Mem/Wall).
* [ ] `child_attach` → confirmer attachement & canaux de communication.
* [ ] `child_set_limits` → réduire les quotas, tenter une tâche dépassant le budget → attendre l’événement `child.limit.exceeded`.
* [ ] `child_send` (prompt de test) → attendre retour textuel + événements de progression.
* [ ] `child_kill` / arrêt propre ; vérifier libération des descripteurs/handles.
* [ ] Journaliser dans `inputs/05_children.jsonl`, `outputs/05_children.jsonl`, `events/05_children.jsonl`.

## 6) Planification & exécution (BT / réactif)

* ℹ️ Automatisation : `npm run validation:plans` orchestre la compilation BT, l'exécution plan_run_bt/plan_run_reactive, les commandes lifecycle (status/pause/resume/cancel) et agrège `report/plans_summary.json`.
* [ ] `plan_compile_bt` sur un arbre simple (3 nœuds : collecte → transformation → écriture).
* [ ] `plan_run_bt` → vérifier succession des états RUNNING/SUCCESS/FAILURE.
* [ ] `plan_run_reactive` → injecter un événement externe et vérifier adaptation.
* [ ] `plan_pause` → état PAUSED, pas d’avancement → `plan_resume`.
* [ ] `plan_cancel` ou `op_cancel` sur tâche longue → vérifier annulation propre.
* [ ] Exporter le journal du plan (si dispo) dans `artifacts/plans/`.

## 7) Coordination multi-agent

* ℹ️ Automatisation : `npm run validation:coordination` pilote blackboard/stigmergie/contract-net/consensus, journalise les JSONL `07_coord` et génère `report/coordination_summary.json` pour revue.
* [ ] Blackboard : `bb_set`, `bb_get`, `bb_query`, `bb_watch` (watch → flux fini de 3-5 événements).
* [ ] Stigmergie : `stig_mark` (avec intensité/décroissance), `stig_decay`, `stig_snapshot`.
* [ ] Contract-Net : `cnp_announce` → collecter 2 propositions simulées, choisir la meilleure, notifier la décision.
* [ ] Consensus : `consensus_vote` (pairage) → vérifier tie-break stable, résultat déterministe.
* [ ] Enregistrer tout dans `inputs/07_coord.jsonl`, `outputs/07_coord.jsonl`, `events/07_coord.jsonl`.

## 8) Connaissance & valeurs

* ℹ️ Automatisation : `npm run validation:knowledge` orchestre `kg_assist`/`kg_suggest_plan`/`kg_get_subgraph`/`values_explain`/`values_graph_export`/`causal_export`, journalise les JSONL `08_knowledge` et génère `report/knowledge_summary.json` + artefacts `artifacts/knowledge/`.
* [ ] `kg_assist` / `kg_suggest_plan` → vérifier qualité des suggestions (critères : cohérence, citations internes si prévues).
* [ ] `kg_get_subgraph` → cohérence structurale (noeuds/relations attendus).
* [ ] `values_explain` → justification compréhensible, stable avec mêmes inputs (tester 2 runs identiques).
* [ ] `values_graph_export` / `causal_export` → formats bien formés ; déposer dans `artifacts/knowledge/`.

## 9) Robustesse & erreurs contrôlées

* ℹ️ Automatisation : `npm run validation:robustness` pilote les scénarios d'erreurs (schéma invalide, outil inconnu, idempotence, crash enfant, timeout) et génère `report/robustness_summary.json`.
* [ ] Appels avec schéma d’input invalide → **400**/erreur outillée avec message utile.
* [ ] Outil inconnu → **404** clair.
* [ ] Idempotency : même `Idempotency-Key` sur `tx_begin` → même réponse (sans duplicata).
* [ ] Crash simulé de l’enfant → événement d’erreur + nettoyage (pas de fuite de process).
* [ ] Timeout volontaire (op longue + limite serrée) → statut `cancelled`/`timeout` attendu.

## 10) Performance (sanity)

* ℹ️ Automatisation : `npm run validation:performance` exécute une rafale `tools/call` (latence p50/p95/p99), déclenche un burst concurrent et produit `report/perf_summary.json` + artefacts JSONL `10_performance`.
* [ ] Mesurer latence p50/p95/p99 d’un outil léger (ex: echo) sur 50 appels ; exporter `report/perf_summary.json`.
* [ ] Concurrence : lancer 5 tâches enfants simultanées (charges faibles) → vérifier stabilité/ordre des événements.
* [ ] Taille des logs : rotation si configurée ; sinon, fichier unique mais non explosif.

## 11) Sécurité & redaction

* ℹ️ Automatisation : `npm run validation:security` orchestre les requêtes sans token, les probes de redaction et les tests d'écriture hors-run, et publie `report/security_summary.json`.
* [ ] Tester masquage (`MCP_LOG_REDACT`) avec un faux secret dans l’input → s’assurer qu’il n’apparaît pas en clair.
* [ ] Vérifier refus d’accès sans `Authorization` si le token est requis.
* [ ] Vérifier absence de chemin d’écriture hors `runs/` pour les artefacts (pas d’escape).

## 12) Rapport final & recommandations

* ℹ️ Automatisation : `npm run validation:report` agrège automatiquement les JSONL et résumés existants en `report/{findings.json,summary.md,recommendations.md}` et affiche les chemins générés.
* [x] Générer `report/findings.json` :

  * [x] versions (node/npm, app, SDK)
  * [x] outils testés (succès/échecs, latence p95)
  * [x] incidents (erreurs, timeouts, violations de schéma)
  * [x] KPIs : #events, ordonnancement (seq monotone), taille des artefacts
* [x] Générer `report/summary.md` (lisible) :

  * [x] ce qui marche, ce qui ne marche pas
  * [x] points ambigus à clarifier côté outils/contrats d’I/O
  * [x] check des objectifs par phase (réussi/partiel/échec)
* [x] Générer `report/recommendations.md` (priorisé P0/P1/P2) :

  * [x] P0 = corrections indispensables pour stabilité (ex : messages d’erreur, validations d’input, quotas enfants)
  * [x] P1 = améliorations UX/dev (ex : schémas/outils plus stricts, docs, exemples)
  * [x] P2 = optimisations (perf, logs, observabilité)

---

## Notes d’exécution (conseils pratiques)

* Sauvegarde **chaque requête** envoyée (JSON) et la **réponse complète** (JSON) dans les fichiers `.jsonl` des phases.
* Pour les événements, utilise un **flux append** `.jsonl` par phase ; assure l’ordre strictement croissant d’un champ `seq` s’il existe.
* Tout artefact (export de graphe, fichiers générés par les outils, journaux de plan) doit aller dans `artifacts/` avec un nom **horodaté**.
* En cas d’échec à une étape, **note la cause exacte** (message d’erreur, code, contexte) et propose une **action corrective** dans `recommendations.md`.

---

## Grille de sortie minimale (doit figurer dans le rapport)

* ✅ Liste des outils testés + statut (OK/KO/partiel)
* ⏱️ Latences p50/p95/p99 (au moins sur 1 outil trivial + 1 outil lourd)
* 🔁 Tests d’idempotence et de concurrence documentés
* 🧒 Gestion des enfants (spawn, limites, kill) validée / non validée
* 📊 Exports de graphes présents & lisibles
* 🧰 Incidents & root causes (si incidents) + quick-fix proposés

---

Si tu veux, je peux aussi te fournir un **jeu de requêtes JSON d’exemple** (un par phase) prêt à être injecté, et un petit script Node pour router les appels et journaliser automatiquement dans l’arborescence `runs/validation_<DATE-ISO>/`.

---

### Historique des actions (dernier passage)

* 2025-10-10T16:09Z — gpt-5-codex : ajouté le module `src/validation/runSetup.ts` + script `scripts/initValidationRun.ts` avec tests (`tests/validation/runSetup.test.ts`), exécuté le préflight HTTP (401/200) et enregistré les artefacts dans `runs/validation_2025-10-10T16-09-28Z`.
* 2025-10-10T16:22Z — gpt-5-codex : ajouté `src/validation/introspection.ts` + tests associés, extension de l’allow-list fs et vérification via `npm test`.
* 2025-10-10T16:45Z — gpt-5-codex : créé `src/validation/logs.ts` + `scripts/captureHttpLog.ts`, ajouté les tests `tests/validation/logs.test.ts`, script npm `validation:capture-log`, et validé via `npm test`.
* 2025-10-10T16:44Z — gpt-5-codex : ajouté `scripts/runIntrospectionPhase.ts`, le module `src/validation/introspectionCli.ts`, les tests `tests/validation/introspectionCli.test.ts`, et publié le script npm `validation:introspect` (tests `npm test`).
* 2025-10-10T17:05Z — gpt-5-codex : généré `report/introspection_summary.json` via `src/validation/introspectionSummary.ts`, enrichi le CLI `validation:introspect` pour persister le résumé et consigner les diagnostics d’événements, ajouté les tests `tests/validation/introspectionSummary.test.ts` + mise à jour du playbook (tests `npm test`).
* 2025-10-10T17:01Z — gpt-5-codex : ajouté le module `src/validation/logStimulus.ts`, le CLI `scripts/stimulateHttpLogging.ts`/commande `npm run validation:stimulate-log`, et les tests `tests/validation/logStimulus*.test.ts` pour confirmer la mise à jour de `/tmp/mcp_http.log`.
* 2025-10-10T17:13Z — gpt-5-codex : ajouté l’automatisation des transactions (`src/validation/transactions*.ts`, script `npm run validation:transactions`, tests `tests/validation/transactions*.test.ts`) qui prépare les artefacts `02_tx` (nominal + patch invalide) pour validation manuelle.
* 2025-10-10T17:27Z — gpt-5-codex : étendu le workflow de transactions avec la simulation de verrou concurrent (`graph_lock`/`graph_unlock`) et l’export `causal_export` vers `artifacts/graphs/`, avec couverture de tests et hooks d’artefacts.
* 2025-10-10T17:45Z — gpt-5-codex : ajouté le runner `src/validation/graphForge.ts`, son CLI `validation:graph-forge`, les scripts/tests associés (`tests/validation/graphForge*.test.ts`) et la génération automatique des artefacts Graph Forge & autosave (`artifacts/forge/`).
* 2025-10-10T18:05Z — gpt-5-codex : automatisé la phase enfants (`src/validation/children*.ts`, script `validation:children`, tests CLI/unitaires, artefacts `artifacts/children/` + `report/children_summary.json`).
* 2025-10-10T20:06Z — gpt-5-codex : ajouté le runner Stage 6 (`src/validation/plans*.ts` + script `validation:plans`) couvrant compile/run/pause/resume/cancel avec résumé `report/plans_summary.json`, tests unitaires/CLI et mise à jour du playbook.
* 2025-10-10T20:30Z — gpt-5-codex : ajouté le runner Stage 7 (`src/validation/coordination*.ts`, script `validation:coordination`) orchestrant blackboard/stigmergie/contract-net/consensus avec résumé `report/coordination_summary.json`, tests unitaires/CLI et mises à jour AGENTS/hygiène.
* 2025-10-10T21:10Z — gpt-5-codex : ajouté le runner Stage 8 (`src/validation/knowledge*.ts`, script `validation:knowledge`) couvrant kg_assist/suggest_plan/subgraph/values_explain/exports avec résumé `report/knowledge_summary.json`, artefacts `artifacts/knowledge/` et tests unitaires/CLI + mise à jour de la checklist.
* 2025-10-10T21:35Z — gpt-5-codex : ajouté le runner Stage 9 (`src/validation/robustness*.ts`, script `validation:robustness`) orchestrant les scénarios d'erreurs/idempotence/timeout, summary `report/robustness_summary.json`, tests unitaires/CLI et mise à jour du playbook.
* 2025-10-10T22:12Z — gpt-5-codex : ajouté le runner Stage 10 (`src/validation/performance*.ts`, script `validation:performance`) pour mesurer latence/concurrence/log growth avec summary `report/perf_summary.json`, CLI & tests (`tests/validation/performance*.test.ts`) + mise à jour checklist/hygiène fs.
* 2025-10-10T22:45Z — gpt-5-codex : ajouté le runner Stage 11 (`src/validation/security*.ts`, script `validation:security`) pour auditer refus sans token, redaction et confinement fs avec résumé `report/security_summary.json`, CLI/tests associés et mise à jour de la checklist/hygiène.
* 2025-10-10T23:20Z — gpt-5-codex : ajouté le runner Stage 12 (`src/validation/finalReport*.ts`, script `validation:report`) qui agrège findings/summary/recommandations, expose les chemins via la CLI et couvre le workflow avec des tests dédiés.
* 2025-10-11T00:35Z — gpt-5-codex : corrigé les tests du rapport final en remplaçant `readFileUtf8` par `readFile`, ajouté `src/validation/finalReport.ts` à l'allow-list fs et validé `npm test`.
* 2025-10-11T03:10Z — gpt-5-codex : enrichi le rapport final avec l'analyse des séquences d'événements, les percentiles p50/p95/p99 et des KPI artefacts, ajouté la détection des séquences non monotones et mis à jour les tests/CLI associés (`npm test`).
* 2025-10-11T03:31Z — gpt-5-codex : comptabilisé les logs, résumés et dossiers d'artefacts dans les octets de stage du rapport final et ajusté les tests pour vérifier la ventilation par étape (`npm test`).
* 2025-10-11T03:40Z — gpt-5-codex : ajouté la vérification de couverture du Stage 03 (scénarios/méthodes) dans l'agrégateur du rapport final, enrichi les notes de stage, et ajusté les tests d'intégration pour refléter les nouveaux artefacts (`npm test`).
* 2025-10-11T03:45Z — gpt-5-codex : étendu les règles de couverture du rapport final au Stage 05 (enfants), ajusté le test d'intégration pour refléter les scénarios/méthodes attendus et validé `npm test`.
* 2025-10-11T04:05Z — gpt-5-codex : ajouté les attentes de couverture Stage 06 (planification) dans le rapport final, généré des artefacts de test réalistes et mis à jour la régression pour vérifier les scénarios/méthodes manquants (`npm test`).
* 2025-10-11T04:25Z — gpt-5-codex : ajouté la couverture attendue du Stage 07 (coordination) au rapport final et renforcé le test d'intégration pour vérifier les scénarios/méthodes manquants signalés (`npm test`).

* 2025-10-11T04:45Z — gpt-5-codex : ajouté les règles de couverture du Stage 08 (knowledge & values) dans l'agrégateur du rapport final, enrichi le test d'intégration pour vérifier les scénarios/méthodes manquants et validé `npm test`.

* 2025-10-11T05:05Z — gpt-5-codex : étendu les règles de couverture au Stage 09 (robustesse), créé des artefacts d'intégration représentatifs et mis à jour les assertions du rapport final pour vérifier les nouveaux scénarios/méthodes signalés (`npm test`).
* 2025-10-11T05:25Z — gpt-5-codex : ajouté le diagnostic de réussite/échec du spawn enfant dans l'agrégateur du rapport final et renforcé la régression pour refléter la note Stage 05 (`npm test`).
* 2025-10-11T05:45Z — gpt-5-codex : ajouté les attentes de couverture du Stage 10 (latence/concurrence) dans l'agrégateur du rapport final, mis à jour la détection de scénario via les artefacts JSONL et étendu la régression d'intégration (`npm test`).
* 2025-10-11T05:55Z — gpt-5-codex : étendu la couverture Stage 11 (sécurité) dans l'agrégateur du rapport final et actualisé la régression d'intégration avec artefacts/diagnostics dédiés (`npm test`).
* 2025-10-11T06:10Z — gpt-5-codex : ajouté la couverture Stage 04 (Graph Forge) dans l'agrégateur du rapport final, enrichi la régression d'intégration avec des artefacts partiels et validé `npm test`.
