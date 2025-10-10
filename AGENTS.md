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
* [ ] Lire `process.env` utiles (HOST, PORT, PATH, TOKEN) et afficher la cible finale.
* [ ] Vérifier accessibilité HTTP du MCP :

  * [ ] **Sans** Authorization → obtenir **401**.
  * [ ] **Avec** `Authorization: Bearer <TOKEN>` → **200** (health/info).
* [ ] Sauvegarder l’en-tête de session (URL, headers, date) dans `report/context.json`.

## 1) Introspection du serveur MCP

* [ ] `mcp_info` → sauvegarder request/response dans `inputs/01_introspection.jsonl` & `outputs/01_introspection.jsonl`.
* [ ] `mcp_capabilities` → lister transports, streaming, limites.
* [ ] `tools_list` → inventaire des outils (noms, schémas d’input/output).
* [ ] `resources_list` → ressources disponibles (si applicable).
* [ ] `events_subscribe` → ouvrir un flux sur `events/01_bus.jsonl`, vérifier numérotation/horodatage.

## 2) Journalisation & santé

* [ ] Forcer l’écriture de logs via un outil simple (ex : ping/echo) ; vérifier que `/tmp/mcp_http.log` bouge.
* [ ] Copier `/tmp/mcp_http.log` → `runs/validation_…/logs/mcp_http.log`.
* [ ] Ajouter un résumé JSON (`logs/summary.json`) : lignes totales, erreurs, WARN, p95 latence (si évaluable).

## 3) Transactions & graphes

* [ ] Cas nominal :

  * [ ] `tx_begin` → récupérer l’ID de transaction.
  * [ ] `graph_diff` (baseline) → attendre “no changes”.
  * [ ] `graph_patch` (ajout de nœuds/edges) → succès.
  * [ ] `tx_commit` → succès.
* [ ] Cas erreur :

  * [ ] `tx_begin` → `graph_patch` invalide (contrainte cassée) → **erreur attendue**.
  * [ ] `tx_rollback` → vérif que l’état n’a pas changé.
* [ ] Concurrence :

  * [ ] `graph_lock` (session A) puis tentative de modification par session B → blocage explicite.
* [ ] Export :

  * [ ] `values_graph_export` / `causal_export` → déposer fichiers dans `artifacts/graphs/`.
* [ ] Sauvegarder toutes les requêtes/réponses dans `inputs/02_tx.jsonl` & `outputs/02_tx.jsonl`; événements dans `events/02_tx.jsonl`.

## 4) Outils “graph forge / analyse”

* [ ] `graph_forge_analyze` (sur un graphe jouet) → vérifier qualité des diagnostics, formats de sortie.
* [ ] `graph_state_autosave start` → attendre 2 cycles, vérifier événements `autosave.tick`.
* [ ] `graph_state_autosave stop` → plus de tick.
* [ ] Sauvegarder artefacts d’analyse dans `artifacts/forge/`.

## 5) Enfants (instances Codex “self-fork”)

* [ ] `child_spawn_codex` → créer un enfant avec métadonnées (objectif, limites CPU/Mem/Wall).
* [ ] `child_attach` → confirmer attachement & canaux de communication.
* [ ] `child_set_limits` → réduire les quotas, tenter une tâche dépassant le budget → attendre l’événement `child.limit.exceeded`.
* [ ] `child_send` (prompt de test) → attendre retour textuel + événements de progression.
* [ ] `child_kill` / arrêt propre ; vérifier libération des descripteurs/handles.
* [ ] Journaliser dans `inputs/05_children.jsonl`, `outputs/05_children.jsonl`, `events/05_children.jsonl`.

## 6) Planification & exécution (BT / réactif)

* [ ] `plan_compile_bt` sur un arbre simple (3 nœuds : collecte → transformation → écriture).
* [ ] `plan_run_bt` → vérifier succession des états RUNNING/SUCCESS/FAILURE.
* [ ] `plan_run_reactive` → injecter un événement externe et vérifier adaptation.
* [ ] `plan_pause` → état PAUSED, pas d’avancement → `plan_resume`.
* [ ] `plan_cancel` ou `op_cancel` sur tâche longue → vérifier annulation propre.
* [ ] Exporter le journal du plan (si dispo) dans `artifacts/plans/`.

## 7) Coordination multi-agent

* [ ] Blackboard : `bb_set`, `bb_get`, `bb_query`, `bb_watch` (watch → flux fini de 3-5 événements).
* [ ] Stigmergie : `stig_mark` (avec intensité/décroissance), `stig_decay`, `stig_snapshot`.
* [ ] Contract-Net : `cnp_announce` → collecter 2 propositions simulées, choisir la meilleure, notifier la décision.
* [ ] Consensus : `consensus_vote` (pairage) → vérifier tie-break stable, résultat déterministe.
* [ ] Enregistrer tout dans `inputs/07_coord.jsonl`, `outputs/07_coord.jsonl`, `events/07_coord.jsonl`.

## 8) Connaissance & valeurs

* [ ] `kg_assist` / `kg_suggest_plan` → vérifier qualité des suggestions (critères : cohérence, citations internes si prévues).
* [ ] `kg_get_subgraph` → cohérence structurale (noeuds/relations attendus).
* [ ] `values_explain` → justification compréhensible, stable avec mêmes inputs (tester 2 runs identiques).
* [ ] `values_graph_export` / `causal_export` → formats bien formés ; déposer dans `artifacts/knowledge/`.

## 9) Robustesse & erreurs contrôlées

* [ ] Appels avec schéma d’input invalide → **400**/erreur outillée avec message utile.
* [ ] Outil inconnu → **404** clair.
* [ ] Idempotency : même `Idempotency-Key` sur `tx_begin` → même réponse (sans duplicata).
* [ ] Crash simulé de l’enfant → événement d’erreur + nettoyage (pas de fuite de process).
* [ ] Timeout volontaire (op longue + limite serrée) → statut `cancelled`/`timeout` attendu.

## 10) Performance (sanity)

* [ ] Mesurer latence p50/p95/p99 d’un outil léger (ex: echo) sur 50 appels ; exporter `report/perf_summary.json`.
* [ ] Concurrence : lancer 5 tâches enfants simultanées (charges faibles) → vérifier stabilité/ordre des événements.
* [ ] Taille des logs : rotation si configurée ; sinon, fichier unique mais non explosif.

## 11) Sécurité & redaction

* [ ] Tester masquage (`MCP_LOG_REDACT`) avec un faux secret dans l’input → s’assurer qu’il n’apparaît pas en clair.
* [ ] Vérifier refus d’accès sans `Authorization` si le token est requis.
* [ ] Vérifier absence de chemin d’écriture hors `runs/` pour les artefacts (pas d’escape).

## 12) Rapport final & recommandations

* [ ] Générer `report/findings.json` :

  * [ ] versions (node/npm, app, SDK)
  * [ ] outils testés (succès/échecs, latence p95)
  * [ ] incidents (erreurs, timeouts, violations de schéma)
  * [ ] KPIs : #events, ordonnancement (seq monotone), taille des artefacts
* [ ] Générer `report/summary.md` (lisible) :

  * [ ] ce qui marche, ce qui ne marche pas
  * [ ] points ambigus à clarifier côté outils/contrats d’I/O
  * [ ] check des objectifs par phase (réussi/partiel/échec)
* [ ] Générer `report/recommendations.md` (priorisé P0/P1/P2) :

  * [ ] P0 = corrections indispensables pour stabilité (ex : messages d’erreur, validations d’input, quotas enfants)
  * [ ] P1 = améliorations UX/dev (ex : schémas/outils plus stricts, docs, exemples)
  * [ ] P2 = optimisations (perf, logs, observabilité)

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
