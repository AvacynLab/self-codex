----------
## 4) Liste de tâches à transmettre à l’agent (checklist)

**Objectif général** : valider bout-en-bout que l’agent Codex Cloud **voit et utilise** le MCP (STDIO + HTTP), que les **outils** fonctionnent (graphes/tx/enfants), et que les **journaux/artefacts** sont archivés proprement pour les futures optimisations.

### A. Démarrage & visibilité

* [x] **Relancer** `scripts/setup-agent-env.sh` avec `START_HTTP=1` et `MCP_HTTP_TOKEN` défini.
* [x] **Vérifier** que l’endpoint répond (cf. commandes curl ci-dessus).
* [x] **Côté STDIO**, vérifier que `~/.codex/config.toml` est bien pris en compte (si tu utilises aussi le transport STDIO via la CLI Codex).

### B. Outils de base

* [x] Appeler `mcp_info` et **archiver** la réponse dans `runs/validation_<date>/outputs/info.json`.
* [x] Appeler `tools_list` et **archiver** la liste dans `runs/validation_<date>/outputs/tools.json`.
* [x] Appeler `resources_list` (si dispo) et **archiver** la réponse.

### C. Transactions & graphes

* [x] `tx_begin` → `graph_diff` (doit être vide) → `tx_commit`; archiver les trois réponses.
* [x] `tx_begin` → `graph_patch` (ajoute 2 nœuds + 1 arête) → `graph_diff` (doit refléter l’ajout) → `tx_commit`; archiver.
* [x] `tx_begin` → `graph_patch` **invalide** (structure erronée) → s’attendre à **400** → `tx_rollback`; archiver la **400** (message explicite attendu) et le rollback.

### D. Enfants Codex (spawn/attach/send/kill)

* [x] `child_spawn_codex` avec limites CPU/Mem/Wall faibles → archiver l’ID de l’enfant.
* [x] `child_attach` → `child_send` avec un prompt simple (“dis bonjour et renvoie ta PID”) → archiver la réponse.
* [x] `child_set_limits` pour provoquer un dépassement **timeout** (ou budget) → archiver l’événement de limite.
* [x] `child_kill` → vérifier qu’il n’apparaît plus dans l’index des enfants.

### E. Autosave, forge & diff

* [x] `graph_state_autosave start` (interval court) → attendre 2 ticks → `stop`; archiver les timestamps d’autosave.
* [x] `graph_forge_analyze` sur un petit graphe jouet → archiver le diagnostic/rapport.
* [x] `graph_diff` entre 2 snapshots successifs → vérifier que les diff sont exacts (ajouts/suppressions ciblés).
* [x] Consolider un résumé des événements (autosave, limites enfants) dans `report/events-summary.json`.

### F. Idempotence & erreurs contrôlées

* [x] Réémettre **deux fois** un `tx_begin` avec le **même** `Idempotency-Key` → archiver que l’ID/effet est identique (pas de duplication).
* [x] Émettre une requête sans `Authorization` alors que `MCP_HTTP_TOKEN` est actif → **401** attendu (archiver).
* [x] Émettre une requête vers une **méthode inconnue** → **404 NOT_FOUND** (ou 400 “method not found”), avec un message utile (archiver).

### G. Logs / rotation / redaction

* [x] Activer `MCP_LOG_FILE`, `MCP_LOG_ROTATE_SIZE`, `MCP_LOG_ROTATE_KEEP`, `MCP_LOG_REDACT=on`.
* [x] Forcer l’écriture de quelques centaines de lignes → vérifier **rotation** et **masquage** (ex. “API_KEY=***”).

### H. Rapport & artefacts

* [x] Créer `runs/validation_<date>/report/summary.md` avec : latences p50/p95, statut des tests, points à améliorer.
* [x] Sauvegarder **toutes** les requêtes/réponses au format `.jsonl` (inputs/outputs), les événements SSE éventuels, et les logs.
* [x] Lister **très précisément** toute anomalie rencontrée (nom de méthode, payload exact, code HTTP, message d’erreur).

---

## 5) Conseils “pièges à éviter”

* Ne remets **pas** `@types/node` en devDep : il DOIT rester en `dependencies` (pour éviter TS2688 en Cloud).
* Ne change **pas** `module`/`moduleResolution` (reste en **NodeNext**).
* N’introduis **aucun import** non-préfixé (`from "fs"`) : **toujours** `from "node:fs"`.
* En HTTP, **toujours** envoyer `Authorization: Bearer $MCP_HTTP_TOKEN` si un token est défini.
* Si l’agent ne voit rien : vérifie que **HTTP est démarré** (`START_HTTP=1`) et que l’hôte est **approprié** (`127.0.0.1` si même machine ; `0.0.0.0` si exposition réseau requise).

---

### Historique des actions

* 2025-10-12T00:00Z — (aucun historique, nouveau départ)
* 2025-10-13T00:55Z — gpt-5-codex : Script `record-run.mjs` enrichi (archives info/tools/resources, transactions/idempotence, enfants & autosave), tests `npm run test:unit` (ok).
* 2025-10-13T01:45Z — gpt-5-codex : Ajout rotation/redaction synthétiques, diagnostics de logs, rapport markdown avec latences/anomalies et archivage complet; tests `npm run test:unit` (ok).
* 2025-10-13T02:30Z — gpt-5-codex : Script `validate-setup.mjs` pour automatiser la relance du setup HTTP + vérifications endpoint/STDIO, fixtures et tests associés; tests `npm run test:unit` (à relancer après les modifs).
* 2025-10-13T03:25Z — gpt-5-codex : Vérification explicite de la suppression des enfants via `child_status` après `child_gc`, artefacts et tests mis à jour pour refléter la nouvelle anomalie 404; tests `npm run test:unit`.
* 2025-10-13T04:20Z — gpt-5-codex : Agrégation du journal d’événements (autosave/limites), génération `events-summary.json`, enrichissement du rapport Markdown et des fixtures/tests record-run; tests `npm run test:unit`.
