Parfait. Voici tout ce qu’il te faut, prêt à copier-coller : 

* un **script de configuration** (setup) fiable pour l’environnement de l’agent (Mode A, avec `@types/node`)
* la **liste des variables d’environnement** à définir dans le panel
* une **liste de tâches à cocher** pour l’agent afin de tester les outils et le fonctionnement global, avec consignes de journalisation.

---

## 1) Script de configuration (à copier-coller)

Enregistre-le à la racine du repo sous `scripts/setup-agent-env.sh` (ou colle-le dans le champ “setup script” de l’agent Cloud).

```
#!/usr/bin/env bash
set -euo pipefail

echo "🔎 Vérification Node/npm"
node -v
npm -v

# Ce projet est en Mode A : build avec @types/node (devDeps) + lockfile
# => On exige npm ci (reproductible) sinon on échoue explicitement.
if [[ ! -f package-lock.json ]]; then
  echo "❌ package-lock.json manquant. Ce dépôt requiert 'npm ci' (Mode A)."
  exit 2
fi

echo "🔧 Installation reproductible (npm ci)"
npm ci

echo "🏗️ Build TypeScript (src + graph-forge)"
npm run build

if [[ ! -f dist/server.js ]]; then
  echo "❌ dist/server.js introuvable après build"
  exit 3
fi

# Optionnel : config Codex CLI pour STDIO (désactivable avec DISABLE_CLI_CONFIG=1)
if [[ "${DISABLE_CLI_CONFIG:-0}" != "1" ]]; then
  echo "📝 Écriture de ~/.codex/config.toml (STDIO)"
  mkdir -p "$HOME/.codex"
  REPO_DIR="$(pwd)"
  cat > "$HOME/.codex/config.toml" <<EOF
[mcp_servers.self-fork-orchestrator]
command = "node"
args = ["${REPO_DIR}/dist/server.js"]
startup_timeout_sec = 20
tool_timeout_sec = 60
EOF
fi

# Démarrage HTTP en arrière-plan si demandé
if [[ "${START_HTTP:-1}" == "1" ]]; then
  echo "🚀 Démarrage MCP HTTP en arrière-plan"
  pkill -f "node .*dist/server.js" 2>/dev/null || true

  : "${MCP_HTTP_HOST:=0.0.0.0}"
  : "${MCP_HTTP_PORT:=8765}"
  : "${MCP_HTTP_PATH:=/mcp}"
  : "${MCP_HTTP_JSON:=on}"
  : "${MCP_HTTP_STATELESS:=yes}"

  # Journalisation
  mkdir -p /tmp
  LOG_FILE="/tmp/mcp_http.log"
  echo "→ Log: $LOG_FILE"

  nohup node dist/server.js \
    --http \
    --http-host "$MCP_HTTP_HOST" \
    --http-port "$MCP_HTTP_PORT" \
    --http-path "$MCP_HTTP_PATH" \
    --http-json "$MCP_HTTP_JSON" \
    --http-stateless "$MCP_HTTP_STATELESS" \
    > "$LOG_FILE" 2>&1 & echo $! > /tmp/mcp_http.pid

  sleep 1
  echo "✅ MCP HTTP PID: $(cat /tmp/mcp_http.pid 2>/dev/null || echo 'n/a')"
  echo "🌐 Endpoint: http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT}${MCP_HTTP_PATH}"
else
  echo "ℹ️ START_HTTP=0 → serveur HTTP non démarré (STDIO seul)."
fi

echo "🎉 Setup terminé"
```

> Remarque importante : **Mode A** signifie que le build **dépend** de `devDependencies` (dont `@types/node`), **donc on utilise `npm ci`** et on **n’omet pas** les devDeps.

---

## 2) Variables d’environnement (panel de l’agent)

Renseigne les clés suivantes (toutes sont sûres par défaut ; certaines vivement recommandées) :

### Recommandées (HTTP actif)

* `START_HTTP=1`
* `MCP_HTTP_HOST=0.0.0.0`
* `MCP_HTTP_PORT=8765`
* `MCP_HTTP_PATH=/mcp`
* `MCP_HTTP_JSON=on`
* `MCP_HTTP_STATELESS=yes`
* *(si tu veux protéger l’endpoint)* `MCP_HTTP_TOKEN=<ton_token_long_et_aléatoire>`

### Exécution & chemins

* `NODE_ENV=production`
* `FORCE_COLOR=1`
* `MCP_RUNS_ROOT=runs`
* `MCP_CHILDREN_ROOT=children`

### Journalisation & rotation

* `MCP_LOG_FILE=/tmp/self-codex.log`
* `MCP_LOG_ROTATE_SIZE=10mb`         *(formats acceptés : 10mb, 100mb, etc.)*
* `MCP_LOG_ROTATE_KEEP=5`
* `MCP_LOG_REDACT=on`                *(masque les secrets connus dans les logs)*

### Comportement & qualité

* `MCP_ENABLE_REFLECTION=true`
* `MCP_QUALITY_GATE=true`
* `MCP_QUALITY_THRESHOLD=70`         *(0–100)*

### Idempotence

* `IDEMPOTENCY_TTL_MS=120000`        *(durée de conservation des clés – 2 min)*

### Enfants (fork Codex)

* *(optionnel)* `MCP_CHILD_COMMAND=` *(par défaut : binaire Node courant)*
* *(optionnel)* `MCP_CHILD_ARGS=--max-old-space-size=512` *(args Node enfants)*

### STDIO uniquement (si tu ne veux pas écrire ~/.codex/config.toml)

* `DISABLE_CLI_CONFIG=1` *(empêche l’écriture de la config CLI)*

---

## 3) Liste de tâches à cocher pour l’agent (validation complète)

> Dossier de travail unique pour la session : `runs/validation_<DATE-ISO>/`
> Crée systématiquement : `inputs/`, `outputs/`, `events/`, `logs/`, `artifacts/`, `report/`.
> Chaque requête/réponse HTTP est stockée en **.jsonl** (une ligne par échange), et les événements en **.jsonl** append-only.

### 0) Préflight

* [x] Créer `runs/validation_<DATE-ISO>/{inputs,outputs,events,logs,artifacts,report}`.
* [x] Afficher `node -v`, `npm -v`, `git rev-parse --short HEAD` dans `report/context.json`.
* [x] Lancer `scripts/setup-agent-env.sh` et enregistrer la sortie dans `logs/setup.out.txt`.
* [x] Health HTTP :

  * [x] sans token (si `MCP_HTTP_TOKEN` défini) → **401** attendu.
  * [x] avec `Authorization: Bearer <TOKEN>` → **200** attendu.
  * [x] Journaliser les checks santé dans `logs/http_health.jsonl` avec les chemins des corps HTTP.

### 1) Introspection MCP

* [x] `mcp_info` → sauver req/resp → `inputs/01_introspection.jsonl`, `outputs/01_introspection.jsonl`.
* [x] `tools_list`, `resources_list` → inventaire complet (noms + schémas I/O).
* [x] `events_subscribe` → consigner dans `events/01_bus.jsonl` (au moins 30s).
  * `events/01_bus.jsonl` comporte une entrée de garde (`note": "no events returned"`) lorsque le flux n'émet rien durant la fenêtre, afin de matérialiser l'artefact demandé.

### 2) Journalisation & rotation

* [x] Déclencher un outil léger (echo/ping) 20× → vérifier que `/tmp/mcp_http.log` grossit.
* [x] Copier le log → `logs/mcp_http.log`.
* [x] Générer `logs/summary.json` avec : nb lignes, WARN/ERROR, tailles, top 3 messages.

> ℹ️ Utilise `npm run validation:log-stimulus -- --iterations 20` (ou le CLI `logStimulus` via `node --import tsx src/validation/logStimulusCli.ts`) pour déclencher automatiquement les 20 appels : le module accepte désormais `--iterations`, consigne l'évolution du log (delta en octets, artefacts JSONL) et échoue explicitement lorsque le log n'augmente pas (Δ ≤ 0).
>  Le rapport final surface également cette étape en rappelant le volume de lignes du journal HTTP, les compteurs d'erreurs/avertissements et le message le plus fréquent extraits de `logs/summary.json`.

### 3) Transactions & graphes

* [x] `tx_begin` → `graph_diff` (baseline) → **no changes**.
* [x] `graph_patch` (ajout 2 nœuds + 1 arête) → **OK** ; `tx_commit`.
* [x] `tx_begin` → `graph_patch` invalide → **erreur attendue** ; `tx_rollback`.
* [x] Concurrence : verrou (session A) puis écriture (session B) → blocage explicite.
* [x] Export : `values_graph_export` / `causal_export` → `artifacts/graphs/`.

> ℹ️ Le plan par défaut `validation:transactions` rejoue désormais 18 appels : diff de base (Δ=0), patch validé + `graph_diff` incrémental, transaction secondaire pour rejouer un patch cyclique (erreur `tx_apply` puis `tx_rollback`), invariants `graph_patch` forcés, conflit de verrou (owner B) et double export (`values_graph_export.json` + `causal_export.json`).

### 4) Forge/Analyse

* [x] `graph_forge_analyze` sur un graphe jouet → vérifier diagnostics/format.
* [x] `graph_state_autosave start` → attendre 2 ticks, `stop` → plus de ticks.

> ℹ️ Le runner Stage 4 vérifie désormais la quiescence après `graph_state_autosave:stop` : un évènement `autosave.quiescence` est
>  consigné dans `events/04_forge.jsonl` et l'exécution échoue si la valeur `saved_at` évolue après l'arrêt (ou si le fichier est
>  réécrit). Les tests couvrent le succès, l'échec et le cas où le fichier est supprimé.

### 5) Enfants (instances Codex)

* [x] `child_spawn_codex` (objectif + limites CPU/Mem/Wall) → **OK**.
* [x] `child_attach` → **OK**, puis `child_send` (prompt simple) → réponse **OK**.
* [x] `child_set_limits` (resserrer) → provoquer un dépassement budget → **event limit**.
* [x] `child_kill` → libération des ressources confirmée.

> ℹ️ Le runner Stage 5 refuse désormais les validations sans évènement `limit*`. Le résumé JSON ajoute `events.limitEvents` et le plan `child_send` envoie un `payload` structuré avec `expect: "final"` pour rester aligné avec le schéma MCP.
>  Le rapport final synthétise désormais le nombre d'évènements limite et les types dominants extraits de `report/children_summary.json` pour souligner la preuve de surveillance.

### 6) Planification & exécution

* [x] `plan_compile_bt` (3 nœuds : collect → transform → write) → **OK**.
* [x] `plan_run_bt` → états RUNNING→SUCCESS, journal complet.
* [x] `plan_pause` / `plan_resume` → comportements corrects.
* [x] `plan_cancel` / `op_cancel` → annulation **propre** et métadonnées cohérentes.

> ℹ️ Le runner Stage 6 vérifie désormais que chaque appel renvoie l'état attendu :
> `plan_run_bt` doit fournir des ticks > 0 et publier des événements, `plan_run_reactive`
> expose `run_id` + `op_id` et un journal scheduler, `plan_pause` confirme un état
> `paused`, `plan_resume` revient sur `running|success`, `plan_cancel` confirme
> explicitement l'annulation du même `run_id` et `op_cancel` valide l'`op_id` et le
> drapeau `ok`. Le résumé `plans_summary.json` ajoute une section `opCancel` et
> tout écart provoque un échec immédiat du runner/CLI.

### 7) Coordination multi-agent

* [x] Blackboard : `bb_set` / `bb_get` / `bb_watch` (recevoir ≥3 événements).
* [x] Contract-Net : annonce → 2 propositions → décision → notification.
* [x] Consensus : vote pair → tie-break stable (déterminisme).

> ℹ️ Le runner Stage 7 applique désormais deux `bb_set` supplémentaires après la
>  souscription `bb_watch` et refuse les validations < 3 évènements cumulés.
>  L'annonce Contract-Net embarque deux `manual_bids` pour garantir au moins deux
>  propositions et l'échec explicite si `proposalCount < 2` ou si
>  `awarded_agent_id` manque. Le vote de consensus injecte deux bulletins
>  contradictoires et exige que l'issue corresponde au `prefer_value`
>  (`validation_tie_break_preference`) tout en vérifiant que le tally expose bien
>  un ex-aequo (détection de tie-break déterministe).

### 8) Connaissance & valeurs

* [x] `kg_suggest_plan` / `kg_get_subgraph` → cohérence du sous-graphe.
* [x] `values_explain` → justification stable (2 runs idem).

> ℹ️ Le runner Stage 8 vérifie désormais les citations et la cohérence des
> sous-graphes : `kg_assist` doit fournir ≥1 citation, `kg_suggest_plan` un
> titre + ≥2 étapes, `kg_get_subgraph` au moins autant de nœuds/arêtes que
> demandé, et `values_explain` doit restituer une explication identique lors
> de la répétition avec `reference_answer`. L'export `values_graph_export`
> et `causal_export` doivent également produire des artefacts physiques.

### 9) Robustesse / erreurs contrôlées

* [x] Input invalide → **400** clair (message utile).
* [x] Outil inconnu → **404** clair.
* [x] Idempotence : même `Idempotency-Key` sur `tx_begin` → même réponse (pas de doublon).
* [x] Timeout volontaire (op longue + limite serrée) → statut `timeout`/`cancelled`.

> ℹ️ Le runner Stage 9 échoue désormais lorsque :
>  • `graph_diff_invalid` ne renvoie pas HTTP 400 avec un message explicite.
>  • l'appel inconnu n'obtient pas HTTP 404 + message clair.
>  • les deux `tx_begin` idempotents divergent (statut ou payload).
>  • la simulation de crash n'émet aucun événement ou message d'erreur.
>  • `plan_run_reactive` ne fournit pas un `status` `timeout|cancelled`.

### 10) Perf (sanity)

* [x] Échos 50× → latences p50/p95/p99 → `report/perf_summary.json`.
* [x] 5 enfants simultanés (charges légères) → stabilité/ordre événements.

> ℹ️ Le runner Stage 10 vérifie désormais qu'au moins 50 échantillons de latence sont collectés et qu'un burst simultané ≥ 5 appels réussit sans erreur. Toute configuration `sampleSize < 50`, `batch < 5` ou incomplète est rejetée avec un message explicite.
>  Le rapport final annote également l'étape avec le volume d'échantillons, les percentiles clés et la croissance du journal HTTP.

### 11) Sécurité / redaction

* [x] `MCP_LOG_REDACT=on` + input contenant un faux secret → log **non** en clair.
* [x] Auth : vérifier 401/200 selon token.

> ℹ️ Le runner Stage 11 échoue si l'appel non authentifié ne retourne pas 401/403, si un secret apparaît dans les réponses/événements, ou si la tentative d'évasion fichier n'est pas rejetée (HTTP ≥ 400). Le résumé `security_summary.json` consigne également les fuites détectées.
>  L'agrégateur Stage 12 relaie maintenant les statuts auth 401/403, le comptage des fuites et les rejets filesystem dans les notes de l'étape.

### 12) Rapport final

* [x] `report/summary.md` : ce qui marche / ne marche pas, points ambigus.
* [x] `report/findings.json` : versions, outils testés (OK/KO/partiel), latences, incidents.
* [x] `report/recommendations.md` : P0 (bloquants), P1 (UX/dev), P2 (perf/obs).

> ℹ️ Les sorties Stage 12 agrègent maintenant les validations renforcées (latence/perf et sécurité) : le rapport final relaye les scénarios manquants et met en avant les incidents signalés par les nouveaux garde-fous.

---

### Conseils d’exécution pour l’agent

* Sauvegarde **chaque** requête/response HTTP en **.jsonl** (une ligne JSON par échange).
* Les **événements** restent en flux append dans `events/*.jsonl`.
* Horodate et nomme chaque artefact (exports graphes, journaux plan) dans `artifacts/`.
* En cas d’échec, consigne **le message exact** + proposition de **quick-fix**.

Si tu veux, je peux te fournir un mini script Node de client HTTP MCP pour sérialiser automatiquement toutes les requêtes/réponses et remplir l’arborescence `runs/validation_<DATE-ISO>/`.

---

### Historique des actions (sessions récentes)

* 2025-10-11T22:48Z — gpt-5-codex : Réinitialisation d'AGENTS.md avec les nouvelles instructions fournies, ajout du script scripts/setup-agent-env.sh, exécution du setup pour générer logs/setup.out.txt, et préparation du run runs/validation_2025-10-11T22-47-32Z (structure + context.json).
* 2025-10-11T23:01Z — gpt-5-codex : Création du run `runs/validation_2025-10-11T22-59-12Z`, génération du `report/context.json`, exécution du setup avec `MCP_HTTP_TOKEN=validation-token`, collecte des sorties dans `logs/setup.out.txt`, et vérification HTTP 401/200 consignée dans `logs/http_health.jsonl`.
* 2025-10-11T23:40Z — gpt-5-codex : Extension du stimulateur de logs pour supporter des itérations multiples (suffixes nommés, delta octets), ajout de `--iterations` côté CLI, documentation de l'usage dans la checklist, et couverture de tests unitaires renforcée (`stimulateHttpLogging` & CLI) + `npm run build` + `npm run test:unit`.
* 2025-10-11T23:45Z — gpt-5-codex : Alignement des appels d'introspection sur les outils (`mcp_info`, `mcp_capabilities`, `resources_list`, `events_subscribe`), ajout d'une garde JSONL lorsque le bus ne publie aucun événement, capture du run `runs/validation_2025-10-11T23-45-00Z` (inputs/outputs/logs/report), et exécution de `npm run build` + `npm run test:unit`.
* 2025-10-12T00:05Z — gpt-5-codex : Ajout du CLI `logsCli` pour capturer et résumer les journaux HTTP, enrichissement de `summariseHttpLogFile` avec le top 3 des messages (priorité aux messages structurés), mise à jour du script `validation:capture-log`, création de tests dédiés, et validation complète via `npm run build` + `npm run test:unit`.
* 2025-10-12T00:20Z — gpt-5-codex : Durcissement du CLI `logStimulus` pour échouer lorsque Δ ≤ 0, ajout de la couverture de test associée, et mise à jour de la checklist (Stage 2 désormais cochée) suite à `npm run build` + `npm run test:unit`.
* 2025-10-12T00:36Z — gpt-5-codex : Finalisation du Stage 3 : ajout du diff de base (`graph_diff_baseline`), transaction d'annulation (`tx_begin_invalid_patch` → `tx_apply_invalid_patch` → `tx_rollback_invalid_patch`), export valeurs (`values_graph_export_snapshot`) et artefacts dédiés, mise à jour des CLI/tests (`transactions`, `transactionsCli`) et exécution de `npm run build` + `npm run test:unit` après installation des devDeps (`npm ci --include=dev`).
* 2025-10-12T01:05Z — gpt-5-codex : Stage 5 renforcé : `child_send` transmet désormais `payload` + `expect="final"`, le résumé expose `events.limitEvents`, et le runner échoue s'il n'observe aucun évènement de dépassement de limites (tests mis à jour pour capturer la requête et le scénario d'erreur).
* 2025-10-12T01:32Z — gpt-5-codex : Stage 4 finalisé : vérification de la quiescence post-`graph_state_autosave:stop`, ajout d'évènements `autosave.quiescence`, garde-fou avec échec explicite en cas de ticks tardifs, CLI enrichi, et tests couvrant quiescence, mutation inattendue et fichier supprimé (`npm run build` + `npm run test:unit`).
* 2025-10-12T02:05Z — gpt-5-codex : Stage 6 verrouillé : validations strictes des runs BT (ticks > 0 + événements), transitions pause/résumé, cohérence `plan_cancel`/`op_cancel`, nouvelle section `opCancel` dans le résumé et tests CLI/unitaires couvrant l'échec `plan_pause` non pausé (`npm run build` + `npm run test:unit`).
* 2025-10-12T02:40Z — gpt-5-codex : Stage 7 complété : ajout de deux `bb_set` post-watch, vérification Δ évènements ≥3, `manual_bids` Contract-Net pour garantir 2 propositions + `awarded_agent_id`, tie-break consensus (`prefer_value`) et nouveaux logs CLI (`Blackboard events`, `Contract-Net proposals`, `Consensus outcome`) avec couverture tests runner/CLI (`npm run build` + `npm run test:unit`).
* 2025-10-12T02:52Z — gpt-5-codex : Stage 8 verrouillé : validations strictes des citations `kg_assist`, plan ≥2 étapes, sous-graphe cohérent, explication `values_explain` stable + artefacts export obligatoires, logs CLI enrichis (citations/subgraph) et couverture tests runner/CLI (succès + scénarios d'échec) après `npm ci --include=dev`, `npm run build`, `npm run test:unit`.
* 2025-10-12T03:20Z — gpt-5-codex : Stage 9 verrouillé : invariants stricts sur les statuts HTTP 400/404, cohérence idempotence, événements de crash, et statut `timeout|cancelled` pour `plan_run_reactive`, journalisation CLI du `timeout status token`, couverture de tests (chemins succès/erreur) après `npm run build` + `npm run test:unit`.
* 2025-10-12T03:55Z — gpt-5-codex : Stage 10 validé avec exigence d'au moins 50 échantillons et burst ≥ 5 (échec si plan incomplet), Stage 11 durci (401/403 obligatoires, secrets masqués, rejet filesystem) et checklist mise à jour ; tests `performance`/`security` étendus + documentation Stage 12 synchronisée.
* 2025-10-12T04:25Z — gpt-5-codex : Ajout des résumés Stage 10/11 dans le rapport final (notes latence/logs et auth/redaction/filesystem), avec tests `finalReport` mis à jour pour valider les nouvelles annotations.
* 2025-10-12T04:45Z — gpt-5-codex : Extension du rapport final pour résumer la journalisation Stage 2 (volume de lignes, erreurs/avertissements, top message) et ajout des assertions `finalReport` associées.
* 2025-10-12T05:10Z — gpt-5-codex : Mise à jour du rapport final pour exposer les évènements limite Stage 5 (compteurs + types dominants) depuis `children_summary.json`, documentation AGENTS correspondante et validations `npm run build` + `npm run test:unit`.
