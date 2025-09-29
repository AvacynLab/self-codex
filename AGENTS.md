# Agent Guidelines

## Brief et objectifs

Remet à zero le fichier AGENTS.md et importe la liste des taches fournit ci dessous ainsi que les informations (au mot près) dans le fichier. Une fois effectué, commence l'implementation, et prend ton temps. 

----------
Voici la **liste de tâches à cocher** (avec sous-étapes) destinée à **toi, l’agent**. Elle consolide l’état actuel du dépôt (fourni précédemment) et nos deux derniers échanges axés sur les **tools**, le **système de graphes**, et l’**orchestration multi-enfants (instances Codex)**.
Objectif : livrer un orchestrateur MCP interne, sans couche d’auth, mais **très puissant côté outils**, **planification**, **fan-out** d’enfants, **analyse/simulation de graphes**, et **tests solides**.
**Important** : ne modifie pas le dossier `projet_mcp_test/` (il reste un exemple figé). Les scripts Bash “sans écriture” sont la voie officielle pour l’environnement.

---

# BRIEF (à lire d’abord)

Toi, l’agent :

* Tu dois **renforcer** les outils existants, **ajouter** des outils de planification multi-enfants (une instance **Codex par enfant**), **étendre** les algorithmes de graphes (chemins multiples, centralités avancées, simulation/optimisation) et **poser une base de tests** complète, **sans dépendance réseau**.
* Le transport principal reste **STDIO** (Codex CLI). Le mode HTTP reste optionnel/isolé.
* Les **scripts d’install/maintenance** ne doivent **jamais écrire** dans des fichiers suivis par git (pas de `package-lock.json` forcé).
* Les **tests** doivent être **déterministes**, **offline**, **couvrants**, et **échouer** en cas d’erreur TypeScript ou de divergence de contrat.
* Toute **nouvelle feature** = **nouveaux tests**. Toute **API tool** = **schémas d’entrées/sorties** (zod) et **exemples**.

---

# A. BUILD / ENV / CONFIG (sécurité des workflows de build)

## A1. Scripts d’environnement (ne rien écrire dans le dépôt)

* [x] **Confirmer** que les scripts Bash (config/maintenance) utilisés en prod sont exactement ceux “sans écriture” :

  * [x] `npm ci` si lockfile présent, sinon `npm install --omit=dev --no-save --no-package-lock`.
  * [x] `npm install @types/node@latest --no-save --no-package-lock`.
  * [x] `npm run build`.
  * [x] Écriture **uniquement** dans `~/.codex/config.toml`.
* [x] **Interdire** leur usage sur des branches où l’agent applique des patches (pour éviter les collisions).

## A2. `package.json` / `tsconfig.json`

* [x] `package.json`

  * [x] Scripts : `build` compile racine **puis** `graph-forge` (déjà OK, vérifier).
  * [x] Scripts : `start` (STDIO) **et** `start:http` (optionnel, isolé).
  * [x] Scripts : `test` (build puis mocha/ts-node en ESM), `lint` (tsc noEmit racine+graph-forge).
  * [x] Engines node >= 18 maintenu.
* [x] `tsconfig.json`

  * [x] `types: ["node"]`, `outDir: "dist"`, `rootDir: "src"`, `moduleResolution: "node"`, `strict: true`.
  * [x] `lib` ES récente (≥ ES2020/2022).
  * [x] Pas de chemins qui feraient fuiter des fichiers de test vers `dist/`.

## A3. CI

* [x] Matrice Node (18/20/22).
* [x] Jobs : `npm install` → `npm run build` → `npm run lint` → `npm test`.
* [x] Faille sur `tsc`/tests/logique = **fail** du pipeline.

---

# B. ORCHESTRATION « COPIES DE SOI-MÊME » (1 instance Codex par enfant)

> But : le parent planifie et **spawne N enfants** (chacun = **une instance Codex**), **pousse un prompt** dédié, **reçoit** leur output, **surveille** (heartbeat/inactivité), et **agrège**.

## B1. Nouvelles APIs tools « enfant » (création/échanges/collecte)

* [x] **Créer** `src/childRuntime.ts`

  * [x] Fonction pour **démarrer** une instance Codex enfant (process séparé ou session isolée) :

    * [x] Même config MCP servers, STDIO.
    * [x] Redirection IO vers `children/<childId>/logs/child.log` (JSONL) + pipe interne.
    * [x] `manifest.json` écrit dans `children/<childId>/`.
  * [x] **Heartbeat** (timestamp mis à jour sur activité IO).
  * [x] Fin propre (SIGINT/SIGTERM) + kill forcé si timeout.
  * [x] Statut runtime + agrégation des sorties (`getStatus`, `collectOutputs`).
* [x] **Créer** `src/state/childrenIndex.ts`

  * [x] Table en mémoire des `children`: `childId`, `pid`, `workdir`, `state`, `lastHeartbeatAt`, `retries`.
  * [x] Sur persistence/snapshot : sérialiser minimalement dans l’état global (GraphState).
* [x] **Créer** `src/artifacts.ts`

  * [x] Manifest artefacts (path, size, mime, sha256).
  * [x] Helpers pour lecture/écriture sous `children/<childId>/outbox/`.
* [x] **Créer** `src/prompts.ts`

  * [x] Templating simple de prompts (system/user/assistant), injection de variables par enfant.
* [x] **Créer** `src/paths.ts`

    * [x] Résolution sûre (pas de sortie du workdir enfant), normalisation, création dossiers.
* [x] **Créer** `src/childSupervisor.ts`

  * [x] Superviseur encapsulant le runtime enfant (`startChildRuntime`), l'index mémoire et les transitions heartbeat/arrêt.
* [x] **Ajouter** tools (dans `src/server.ts` ou modules dédiés) :

  * [x] `child_create` (in : prompt, constraints, timeouts, etc. ; out : childId, startedAt).
  * [x] `child_send` (in : message ; out : msgId).
  * [x] `child_status` (in : childId ; out : état, lastHeartbeatAt, cpu/mem?).
  * [x] `child_collect` (in : childId ; out : outputs textuels + artefacts manifest).
  * [x] `child_cancel` / `child_kill` / `child_gc` (in : childId ; out : ok).
  * [x] (option) `child_stream` (pagination d’events/token/logs).

## B2. Planification (fan-out/join/reduce)

* [x] **Étendre** `plan_fanout` (existe déjà)

  * [x] Paramètres : `childrenSpec` (N cible ou liste cible), `promptTemplate`, `parallelism`, `retry`.
  * [x] Démarrage via `child_create` + premier `child_send`.
  * [x] Enregistrer mapping dans `run-<ts>/fanout.json`.
* [x] **Créer** `plan_join`

  * [x] Paramètres : `children`, `joinPolicy` (`all` | `first_success` | `quorum`), `timeoutSec`.
  * [x] Retour : tableau de résultats (status, résumé, artefacts).
* [x] **Créer** `plan_reduce`

  * [x] Paramètres : `children`, `reducer` (`concat` | `vote` | `merge_json` | `custom`), `spec`.
  * [x] Retour : `aggregate`, `trace`.

## B3. Intégrations état/monitoring

* [x] **Intégrer** les heartbeats enfants dans `graph_state_autosave` (déjà présent côté parent) :

  * [x] Conserver un snapshot minimal `childId → lastHeartbeatAt/state`.
* [x] **Réutiliser** `graph_state_inactivity` :

  * [x] Ajouter un mode `scope:"children"` pour détecter enfants inactifs au-delà d’un seuil configurable.
  * [x] Proposer action (ping/cancel/retry) comme simple champ de résultat (pas d’action automatique dans ce tool).

---

# C. OUTILS « INGÉNIERIE DE GRAPHES » (générer, muter, valider, expliquer)

## C1. Outils de manipulation de graphes

* [x] **Créer** `graph_generate`

  * [x] Entrée : texte/JSON de tâches ; sortie : graphe (nœuds/edges/poids étiquetés).
  * [x] Option : patrons pré-définis (pipelines “lint→test→build→package”).
* [x] **Créer** `graph_mutate`

  * [x] Opérations idempotentes : add/remove/rename node/edge, set weight/labels.
  * [x] Validation structure a posteriori.
* [x] **Créer** `graph_validate`

  * [x] Détecte cycles, nœuds inaccessibles, edges orphelins, poids invalides.
  * [x] Retour JSON structuré (erreurs, warnings, auto-fix possibles).
* [x] **Créer** `graph_summarize`

  * [x] Résumé lisible : couches, degré moyen, nœuds critiques, éventuels goulets.

## C2. Algorithmes avancés (GraphForge)

* [x] **Ajouter** `graph-forge/src/algorithms/yen.ts`

  * [x] Implémenter **Yen** pour k plus courts chemins, loopless.
  * [x] Exposer `kShortestPaths(u,v,k,{weightKey,costFunction})`.
* [x] **Ajouter** `graph-forge/src/algorithms/brandes.ts`

  * [x] **Betweenness centrality** (Brandes), pondérée/non pondérée.
  * [x] Exposer `betweenness({weighted?:boolean})`.
* [x] **Exposer** via `graph-forge/src/index.ts` les nouvelles APIs.
* [x] **Créer** tools correspondants :

  * [x] `graph_paths_k_shortest`, `graph_centrality_betweenness`, `graph_critical_path` (si pas déjà outillé).
  * [x] `graph_paths_constrained` (évitements, bornes de coût) basé sur wrapper de Dijkstra/A* avec contraintes.

## C3. Simulation & optimisation

* [x] **Créer** `graph_simulate`

  * [x] Simulation “temps” avec poids = durée estimée, parallélisme max, calcul du makespan, files d’attente.
  * [x] Retour : Gantt minimal (JSON), métriques (makespan, utilisation max).
* [x] **Créer** `graph_optimize`

  * [x] Politique : minimiser makespan/sauts critiques ; proposer mutations (re-ordonnancement, parallélisation) avec justification.

---

# D. TESTS (unitaires/intégration/contrats)

## D1. Unitaires « enfant »

* [x] `tests/child.lifecycle.test.ts`

  * [x] `child_create` crée workdir + manifest + log + PID.
  * [x] `child_send` push message (mock runner).
  * [x] `child_status` varie correctement (starting→ready→idle).
  * [x] `child_collect` ramène outputs + artefacts factices.
  * [x] `child_cancel/kill/gc` : transitions et nettoyage OK.
* [x] `tests/child.supervisor.test.ts`

  * [x] Couverture du superviseur (création, envoi, collecte, arrêt/destroy).
* [x] `tests/child.tools.test.ts`

  * [x] Couverture JSON-RPC hors bande des tools `child_*` (création, envoi, status, collecte, shutdown forcé, streaming).
* [x] **Mock runner Codex** (sans réseau)

  * [x] Petit script Node qui lit stdin et écrit une réponse JSON simulée → plug à `childRuntime`.

## D2. Unitaires « planification »

* [x] `tests/plan.fanout-join.test.ts`

  * [x] `plan_fanout` sur 3 enfants (mock), `plan_join` avec `joinPolicy` (`all`, `first_success`, `quorum`).
  * [x] `plan_reduce` : `concat`, `merge_json`, `vote` (majorité).

## D3. Unitaires « graphes »

* [x] `tests/graphforge.ksp.test.ts` (Yen)

  * [x] Graphes sans cycles/avec cycles (filtrés), pondérés ; comparer k chemins attendus.
* [x] `tests/graphforge.betweenness.test.ts` (Brandes)

  * [x] Cas standard, pondéré/non-pondéré, bornes sur petits graphes connus.
* [x] `tests/graph.tools.mutate-validate.test.ts`

  * [x] Mutations idempotentes, validate renvoie erreurs/warnings attendus.
* [x] `tests/graph.tools.paths.test.ts`

  * [x] Chemins k-plus-courts, contraintes d'évitement/coût, centralité et chemin critique exposés via les nouveaux tools.
* [x] `tests/graph.simulate-optimize.test.ts`

* [x] Simulation cohérente (makespan attendu), optimisations qui améliorent un critère.

## D4. Contrats & build

* [x] `tests/serverOptions.parse.test.ts`

  * [x] Flags CLI : `--max-event-history`, `--log-file`, `--http-*` (si activé), options enfant (timeouts, parallelism).
* [x] `npm run lint` **sans erreur** (tsc noEmit) ; `npm run build` must pass.
* [x] Test “contrat STDIO” : round-trip JSON-RPC simple (appel tool → succès/erreur contrôlée).
* [x] Tests **offline** : aucun accès réseau ; toute E/S sur FS local mocké/isolé.

---

# E. DOCS (à jour et utiles à l’agent)

* [x] `README.md`

  * [x] Exemples d’usage **des nouveaux tools** : `child_*`, `plan_*`, `graph_*`.
  * [x] Exemples de prompts templates pour fan-out.
  * [x] Avertissement : orchestrateur interne, transport STDIO ; HTTP optionnel et isolé.
* [x] `AGENTS.md`

  * [x] Procédure en **5 minutes** : “comment fan-out 3 clones Codex, leur pousser des prompts, joindre et réduire”.
  * [x] Check-list des résultats attendus (artefacts, logs, manifestes).

### Procédure express (≤ 5 minutes)

1. **Préparer l’orchestrateur**
   * `npm run build` si les sources viennent d’être modifiées.
   * Démarrer le serveur STDIO : `node dist/server.js --log-file ./tmp/orchestrator.log`.
2. **Planifier un fan-out de 3 enfants Codex**
   * Appeler le tool `plan_fanout` avec :
     ```json
     {
       "tool": "plan_fanout",
       "arguments": {
         "childrenSpec": { "count": 3 },
         "promptTemplate": {
           "system": "Analyse en parallèle",
           "user": "{{topic}}",
           "variables": { "topic": "Choix d’architecture" }
         },
         "parallelism": 3,
         "retry": { "maxAttempts": 1 }
       }
     }
     ```
   * Chaque enfant reçoit automatiquement le prompt initial via `child_send`.
3. **Attendre les réponses et joindre les résultats**
   * Utiliser `plan_join` avec `joinPolicy: "all"` et `timeoutSec` adapté.
   * Contrôler l’avancement via `child_status` en cas de latence.
4. **Réduire/agréger la sortie**
   * Appeler `plan_reduce` avec `reducer: "vote"` (ou `concat`/`merge_json`) pour combiner les synthèses.
5. **Collecter les artefacts**
   * Terminer avec `child_collect` pour récupérer logs, manifestes et fichiers produits.

### Résultats attendus à cocher

- [x] Trois dossiers `children/<childId>/` créés avec `manifest.json`, `logs/child.log`, `outbox/`.
- [x] Un fichier `run-<timestamp>/fanout.json` listant les associations enfant ↔ prompt.
- [x] Des entrées `plan_join` montrant l’état (`success`, `timeout`, etc.) de chaque enfant.
- [x] Un résultat `plan_reduce` contenant le champ `aggregate` et la trace des votes.
- [x] Les artefacts collectés (taille, SHA-256, MIME) présents dans la réponse `child_collect`.
- [x] Le log JSONL `tmp/orchestrator.log` référençant les appels `child_*`/`plan_*`.
- [x] Aucun test ne déclenche d’accès réseau (garde hors-ligne active).

  ---

# F. Détails **fichier par fichier** (création/modification)

* [x] **`src/server.ts`**

  * [x] **Ajouter** l’enregistrement des tools : `child_*`, `plan_*`, `graph_*` nouveaux (import + routeurs).
  * [x] **Valider** les schémas d’entrée/sortie via **zod**.
  * [x] **Tracer** chaque appel (JSONL logger existant).
* [x] **`src/childRuntime.ts`** *(nouveau)*

  * [x] Démarrage enfant (process), IO, logs, heartbeat, arrêt propre/forcé.
* [x] **`src/state/childrenIndex.ts`** *(nouveau)*

  * [x] Store mémoire + API de consultation/màj.
* [x] **`src/artifacts.ts`** *(nouveau)*

  * [x] Manifeste (sha256, mime, size), helpers lecture/écriture.
* [x] **`src/prompts.ts`** *(nouveau)*

  * [x] Templating prompts (variables), validation.
* [x] **`src/paths.ts`** *(nouveau)*

  * [x] Sécurité des chemins : pas de “path traversal”, création récursive.
* [x] **`src/graphState.ts`**

  * [x] **Inclure** état minimal des enfants (heartbeat) dans snapshots.
* [x] **`src/serverOptions.ts`**

  * [x] **Ajouter** options pour planification enfants : `--parallelism`, `--child-idle-sec`, `--child-timeout-sec`.
* [x] **`graph-forge/src/algorithms/yen.ts`** *(nouveau)*

  * [x] Implémentation + tests.
* [x] **`graph-forge/src/algorithms/brandes.ts`** *(nouveau)*

  * [x] Implémentation + tests.
* [x] **`graph-forge/src/index.ts`**

  * [x] Ré-export des APIs nouvelles.
* [x] **`tests/*.test.ts`** *(nouveaux cités ci-dessus)*

  * [x] Couvrir chaque nouveau tool et chaque scénario critique.
* [x] **`README.md` / `AGENTS.md`**

  * [x] Sections et exemples mis à jour.

---

# G. Règles **tests & build** (à respecter en permanence)

* **Toujours** : `npm run build` doit réussir **sans warning bloquant** ; `npm run lint` doit être **propre**.
* **Tests offline** uniquement ; pas de dépendance à un réseau/service externe.
* **Couverture** : chaque nouveau tool → tests unitaires +, si possible, un test d’intégration minimal.
* **Contrats** : entrée/sortie tool validées par **zod** ; en cas d’erreur, messages clairs et code d’erreur stable.
* **Isolation FS** : les outils enfants/artefacts ne peuvent écrire **qu’au-dessus de** `children/<childId>/` de leur run.
* **Non-régression** : ne touche pas `projet_mcp_test/`.
* **Logs** : laisser activé le logger JSONL (utile au débogage IA), mais prévoir un niveau `silent` pour tests.

---

## Historique des actions

- 2025-02-21 : Création des modules `src/paths.ts`, `src/prompts.ts`, `src/artifacts.ts` (résolution de chemins sécurisée, templates de prompts, gestion des artefacts) et ajout des tests unitaires associés (`tests/paths.test.ts`, `tests/prompts.test.ts`, `tests/artifacts.test.ts`).
- 2025-02-22 : Mise en place du runtime enfant (`src/childRuntime.ts`) avec journalisation JSONL, manifestes et arrêt forcé, ajout de l’index mémoire (`src/state/childrenIndex.ts`), des scripts de mock (`tests/fixtures/`) et des tests `tests/child.lifecycle.test.ts` validant création, échanges et terminaison.
- 2025-02-23 : Ajout de `getStatus`/`collectOutputs` dans `ChildRuntime`, collecte des artefacts via `listArtifacts`, extension des tests `child.lifecycle` et installation ponctuelle des dépendances (`npm install --no-save --no-package-lock`) pour restaurer Mocha.
- 2025-02-24 : Intégration des heartbeats enfants dans les snapshots (`GraphState.recordChildHeartbeat`), mise à jour de `graph_state_autosave` via la sérialisation enrichie et ajout des tests `tests/graphState.heartbeat.test.ts`.
- 2025-02-25 : Ajout des options CLI `--parallelism`, `--child-idle-sec`, `--child-timeout-sec` dans `src/serverOptions.ts` et création du test `tests/serverOptions.parse.test.ts` vérifiant les validations associées.
- 2025-09-29 : Implémentation des algorithmes de graphes avancés (Yen k-chemins, Brandes centralité) avec export dans graph-forge, ajout des tests unitaires `tests/graphforge.ksp.test.ts` et `tests/graphforge.betweenness.test.ts` vérifiant pondération et filtrage.
- 2025-09-30 : Introduction du superviseur `src/childSupervisor.ts` pour piloter les runtimes enfants, création des tests `tests/child.supervisor.test.ts` validant échanges, collecte d'artefacts et arrêts forcés.
- 2025-10-01 : Enregistrement des tools `child_*` via le superviseur (création, send, status, collect, cancel/kill/gc), ajout du module `src/tools/childTools.ts`, intégration serveur (`src/server.ts`) et tests `tests/child.tools.test.ts` couvrant le flux complet (payload initial, artefacts, shutdown forcé).
- 2025-10-02 : Implémentation des plans `plan_fanout`/`plan_join`/`plan_reduce` avec contexte partagé (`src/tools/planTools.ts`), enregistrements serveur, fichiers `run-<ts>/fanout.json` et tests `tests/plan.fanout-join.test.ts` validant fan-out, politiques de join et stratégies de réduction.
- 2025-10-03 : Ajout des tools `graph_generate`/`graph_mutate`/`graph_validate`/`graph_summarize`, enregistrement dans `src/server.ts`, implémentations commentées (`src/tools/graphTools.ts`), tests `tests/graph.tools.mutate-validate.test.ts` couvrant génération/mutations/validation/synthèse et exécution `npm run lint`, `npm test`, `npm run build` (mocha installé via `npm install --no-save --no-package-lock`).
- 2025-10-04 : Implémentation de `graph_simulate`/`graph_optimize` (planification, files d'attente, suggestions), enregistrement serveur, et ajout du test dédié `tests/graph.simulate-optimize.test.ts` confirmant makespan et recommandations.

- 2025-10-05 : Ajout du test `tests/stdio.contract.test.ts` validant le round-trip JSON-RPC via InMemoryTransport et mise à jour de `README.md` avec les scénarios child*/plan*/graph*.
- 2025-10-06 : Implémentation du tool `child_stream` (pagination stdout/stderr) avec support du curseur dans `ChildRuntime`, ajout du handler serveur, tests `child.tools` étendus et documentation `README`/`AGENTS` actualisée.
- 2025-10-07 : Consolidation des scripts `setup`/`maintenance` avec garde anti-branches patch, commandes install read-only, mode dry-run et tests `environment script helpers` vérifiant la politique "sans écriture".
- 2025-10-08 : Ajout de la garde hors-ligne (`tests/000.offline.guard.test.ts`), extension de la matrice CI Node 18/20/22 avec installation sans lockfile et rédaction de la procédure fan-out + checklist résultats dans `AGENTS.md`.
- 2025-10-09 : Extension de `graph_state_inactivity` (scope children + actions ping/cancel/retry), mise à jour des tests heartbeat pour valider les recommandations et pointage des tâches GraphForge/planification désormais couvertes.
- 2025-10-10 : Ajout des tools `graph_paths_k_shortest`/`graph_paths_constrained`/`graph_centrality_betweenness`/`graph_critical_path`, enregistrement serveur, création du test `tests/graph.tools.paths.test.ts`, régénération de `dist/` après nettoyage de l'environnement et exécution `npm run build`, `npm run lint`, `npm test`.

- 2025-10-11 : Renforcé `tests/plan.fanout-join.test.ts` pour vérifier la création des manifestes/logs/outbox enfants, l'inclusion d'artefacts dans `plan_join` et marqué les tâches associées dans `AGENTS.md` (checklist fan-out et modules `childRuntime`/`childrenIndex`/`artifacts`/`prompts`/`graphState`).
- 2025-10-12 : Assuré la création automatique du dossier de logs via `StructuredLogger`, ajouté `logger.flush()`, vérifié la journalisation `child_*`/`plan_*` dans les tests et coché la checklist correspondante.
---
- 2025-10-13 : Vérification complète de la checklist (lint, build, tests STDIO) sans modifications de fonctionnalités ; aucun écart détecté et environnement laissé propre pour le prochain agent.
