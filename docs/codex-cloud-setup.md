# Déploiement du serveur MCP "Self Fork" dans Codex Cloud

Ce guide décrit la procédure complète pour exposer l'orchestrateur MCP via HTTP dans un environnement Codex Cloud afin que les agents Codex puissent consommer l'ensemble des outils (`graph_state_*`, `graph_forge_*`, etc.). Les étapes couvrent la préparation du build, la publication dans le cloud, la configuration réseau et l'enregistrement du serveur côté Codex.

## 1. Pré-requis

- **Node.js 18 LTS ou supérieur** installé dans l'environnement Codex Cloud (le build local peut être effectué avec `pnpm`, `npm` ou `yarn`).
- **Accès shell** à l'environnement cible pour déployer les artefacts et lancer le processus Node.
- **Port TCP ouvert** entre Codex Cloud et l'orchestrateur (par défaut `4000`). En production, prévoir un reverse-proxy/TLS (Nginx, Caddy, Cloudflare Tunnel…).
- **Capacité d'écriture** sur `~/.codex/config.toml` dans l'espace Codex afin de déclarer le serveur MCP distant.

### Vérifier la version livrée

Avant de pousser une archive dans Codex Cloud, confirmer que vous déployez bien la révision `1.3.0` ou ultérieure. Le `package.json` du dépôt référence cette version et exige Node ≥ 18.17 pour supporter le transport HTTP Streamable fourni par le SDK MCP.【F:package.json†L1-L24】

La build `dist/server.js` générée à partir de `src/server.ts` embarque l'initialisation du transport `StreamableHTTPServerTransport` (chemin `/mcp` par défaut) et le générateur de session HTTP (`createHttpSessionId`).【F:src/server.ts†L1896-L2051】 Cette révision permet donc à Codex d'invoquer directement tous les outils MCP exposés par le serveur via HTTP.

## 2. Préparer un build reproductible

Exécuter les commandes suivantes en local (ou dans un job CI) pour produire des artefacts prêts à être copiés dans le cloud :

```bash
# Installation dépendances sans polluer les devDependencies
npm ci --omit=dev

# Compilation TypeScript -> dist/
npm run build
```

Le dossier `dist/` contient désormais les bundles JavaScript nécessaires (`server.js`, `serverOptions.js`, etc.). Les outils MCP se basent sur ces artefacts et n'ont pas besoin des sources TypeScript une fois compilés.

## 3. Emballer et transférer les artefacts

1. Nettoyer d'éventuels modules natifs superflus (optionnel mais recommandé) :
   ```bash
   npm prune --omit=dev
   ```
2. Créer une archive à copier vers Codex Cloud :
   ```bash
   tar czf self-fork-orchestrator.tar.gz dist package.json package-lock.json node_modules README.md
   ```
3. Transférer l'archive via `scp`, `rsync`, ou tout mécanisme fourni par Codex Cloud.

> Astuce : pour des déploiements automatisés, stocker l'archive dans un bucket (S3/GCS/Azure Blob) et utiliser un job CI pour la pousser sur chaque commit validé.

## 4. Déployer sur l'instance Codex Cloud

Sur la VM/conteneur cible :

```bash
mkdir -p ~/apps/self-fork-orchestrator
cd ~/apps/self-fork-orchestrator

# Copier l'archive transférée puis l'extraire
tar xzf ~/self-fork-orchestrator.tar.gz

# Vérifier la présence de dist/server.js
ls dist/server.js
```

### Service systemd (optionnel)

Pour conserver le serveur actif même après un redémarrage, créer `/etc/systemd/system/self-fork-orchestrator.service` :

```ini
[Unit]
Description=Self Fork MCP Orchestrator
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/codex/apps/self-fork-orchestrator
ExecStart=/usr/bin/node dist/server.js --http --http-host 0.0.0.0 --http-port 4000 --no-stdio
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Puis activer :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now self-fork-orchestrator.service
```

## 5. Démarrer le transport HTTP

L'orchestrateur accepte les options suivantes (issues de `parseOrchestratorRuntimeOptions`) :

| Option | Effet |
| --- | --- |
| `--http` | Active le serveur HTTP sur les valeurs par défaut (hôte `0.0.0.0`, port `4000`, chemin `/mcp`). |
| `--http-port <port>` | Modifie le port d'écoute. |
| `--http-host <hôte>` | Modifie l'interface de binding (ex. `127.0.0.1` derrière un proxy). |
| `--http-path <chemin>` | Change le chemin racine (défaut : `/mcp`). |
| `--http-json` | Autorise les réponses JSON directes pour les clients compatibles. |
| `--http-stateless` | Désactive les sessions (`Mcp-Session-Id`) si le client ne supporte pas la reprise. |
| `--no-stdio` | Désactive explicitement le transport STDIO (automatique dès que `--http` est fourni). |

Commande de base à lancer manuellement :

```bash
node dist/server.js --http --http-host 0.0.0.0 --http-port 4000 --no-stdio
```

La sortie standard doit afficher :

```
[orchestrator] MCP server listening on http://0.0.0.0:4000/mcp (json=off, stateless=no)
```

Adapter `--http-json` ou `--http-stateless` selon la compatibilité du client Codex. Pour restreindre l'accès, placer un reverse-proxy TLS en amont et utiliser les options de protection DNS du transport si nécessaire (`allowedHosts` / `allowedOrigins` via modification du code si besoin).

## 6. Configurer Codex Cloud (`~/.codex/config.toml`)

Ajouter (ou adapter) un bloc serveur MCP dans la configuration Codex. La structure suivante respecte la nomenclature MCP actuelle :

```toml
[[servers]]
id = "self-fork-orchestrator"
name = "Self Fork Orchestrator"
type = "mcp"

[servers.transport]
type = "streamable-http"
url = "https://votre-domaine.example/mcp"

[servers.capabilities]
tools = true
resources = true
prompts = false
```

Points clés :
- `type = "streamable-http"` indique à Codex d'utiliser le transport MCP Streamable HTTP avec reprise SSE.
- `url` doit pointer vers l'URL publique (derrière TLS si possible). Adapter le schéma (`http://` vs `https://`) selon votre exposition.
- Les capacités (`tools`, `resources`, `prompts`) peuvent être ajustées selon les features exposées par le serveur. Ici, seules les tools/resources sont nécessaires.

Après modification, redémarrer l'agent Codex ou déclencher un rechargement de la configuration pour que le serveur apparaisse dans la liste des outils.

## 7. Vérifier la connectivité MCP

Avant d'utiliser Codex, effectuer une validation manuelle depuis une machine ayant accès au serveur.

### 7.1 Ping HTTP et initialisation JSON-RPC

```bash
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  https://votre-domaine.example/mcp \
  -d '{
    "jsonrpc": "2.0",
    "id": "init",
    "method": "initialize",
    "params": {
      "clientInfo": { "name": "connectivity-check", "version": "0.1" },
      "capabilities": {}
    }
  }'
```

- Un statut `200 OK` confirme que le point d'entrée répond.
- La réponse doit contenir `"result"` avec les métadonnées du serveur et éventuellement `"meta": { "sessionId": ... }` si le mode stateful est actif.

### 7.2 Flux SSE

```bash
curl -i \
  -H 'Accept: text/event-stream' \
  -H 'Mcp-Session-Id: <sessionId_si_reçu>' \
  https://votre-domaine.example/mcp
```

La réponse doit démarrer par `HTTP/1.1 200 OK` puis des événements `event:` / `data:`. Si vous avez activé `--http-stateless`, l'entête `Mcp-Session-Id` est inutile.

### 7.3 Appel d'outil

Une fois l'initialisation réussie, utiliser l'ID de session retourné pour invoquer un outil :

```bash
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Mcp-Session-Id: <sessionId>' \
  https://votre-domaine.example/mcp \
  -d '{
    "jsonrpc": "2.0",
    "id": "tool-check",
    "method": "call_tool",
    "params": {
      "name": "graph_state_inactivity",
      "arguments": { "max_idle_ms": 300000 }
    }
  }'
```

Vous devez recevoir un `result` JSON contenant la réponse textuelle générée par l'outil.

## 8. Dépannage rapide

| Symptôme | Vérifications |
| --- | --- |
| `404 NOT_FOUND` | Le reverse-proxy ne redirige pas vers `/mcp`, ou `--http-path` différent. Ajuster l'URL côté Codex. |
| `400 Bad Request` sans session | Manque de `Mcp-Session-Id` alors que le serveur est en mode stateful. Relancer `initialize` et réutiliser l'ID. |
| Timeout côté Codex | Firewall/VPC bloque le port, ou TLS invalide. Vérifier l'ouverture réseau et les certificats. |
| JSON `error` code `-32000` | Option `--http-json` désactivée alors que le client attend une réponse JSON. Relancer avec `--http-json`. |

En cas de doute, activer les logs détaillés (`DEBUG=orchestrator* node dist/server.js ...`) pour inspecter les requêtes entrantes.

## 9. Scripts Codex Cloud (onglet configuration/maintenance)

L'interface Codex Cloud affiche deux blocs de scripts (capture fournie par l'utilisateur) :

- **Script de configuration** — exécuté une fois lors de la création ou du reclonage du conteneur.
- **Script de maintenance** — exécuté à chaque redémarrage/activation du conteneur.

Les extraits suivants supposent que l'application vit dans `~/apps/self-fork-orchestrator` (adapter au besoin). Ils créent également des utilitaires `bin/` pour gérer le processus et centraliser les journaux.

### Script de configuration (mode manuel)

À coller dans le champ « Script de configuration » après avoir sélectionné le mode **Manuel** :

```bash
#!/bin/bash
set -euo pipefail

APP_HOME="${APP_HOME:-$HOME/apps/self-fork-orchestrator}"
LOG_DIR="${APP_HOME}/logs"
BIN_DIR="${APP_HOME}/bin"

mkdir -p "$APP_HOME" "$LOG_DIR" "$BIN_DIR"
cd "$APP_HOME"

if command -v npm >/dev/null 2>&1; then
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
  npm run build
  npm prune --omit=dev || true
else
  echo "npm introuvable (Node.js >= 18 requis)." >&2
  exit 1
fi

cat >"$BIN_DIR/orchestrator-stop.sh" <<'STOP'
#!/bin/bash
set -euo pipefail
APP_HOME="${APP_HOME:-$HOME/apps/self-fork-orchestrator}"
PID_FILE="${APP_HOME}/logs/orchestrator.pid"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    for _ in {1..10}; do
      if kill -0 "$PID" 2>/dev/null; then
        sleep 0.5
      else
        break
      fi
    done
  fi
  rm -f "$PID_FILE"
fi
STOP

cat >"$BIN_DIR/orchestrator-start.sh" <<'START'
#!/bin/bash
set -euo pipefail

APP_HOME="${APP_HOME:-$HOME/apps/self-fork-orchestrator}"
LOG_DIR="${APP_HOME}/logs"
PID_FILE="${LOG_DIR}/orchestrator.pid"
PORT="${MCP_HTTP_PORT:-4000}"
HOST="${MCP_HTTP_HOST:-0.0.0.0}"
PATH_PART="${MCP_HTTP_PATH:-/mcp}"
JSON_FLAG="${MCP_HTTP_JSON:-0}"
STATELESS_FLAG="${MCP_HTTP_STATELESS:-0}"

"${APP_HOME}/bin/orchestrator-stop.sh" || true

mkdir -p "$LOG_DIR"
cd "$APP_HOME"

CMD=(node dist/server.js --http --http-port "$PORT" --http-host "$HOST" --http-path "$PATH_PART" --no-stdio)
if [ "$JSON_FLAG" = "1" ]; then
  CMD+=(--http-json)
fi
if [ "$STATELESS_FLAG" = "1" ]; then
  CMD+=(--http-stateless)
fi

nohup env NODE_ENV=production "${CMD[@]}" >>"$LOG_DIR/orchestrator.log" 2>&1 &
echo $! >"$PID_FILE"
START

chmod +x "$BIN_DIR/orchestrator-start.sh" "$BIN_DIR/orchestrator-stop.sh"

"$BIN_DIR/orchestrator-start.sh"
```

Ce script :

1. Installe les dépendances Node, compile `dist/` et nettoie les devDependencies inutiles.
2. Crée deux helpers (`orchestrator-start.sh` / `orchestrator-stop.sh`) pour gérer proprement le processus Node.
3. Démarre immédiatement le transport HTTP en arrière-plan (`nohup`) et consigne les logs dans `logs/orchestrator.log`.

### Script de maintenance

À coller dans le champ « Script de maintenance » :

```bash
#!/bin/bash
set -euo pipefail

APP_HOME="${APP_HOME:-$HOME/apps/self-fork-orchestrator}"

if [ ! -x "${APP_HOME}/bin/orchestrator-start.sh" ]; then
  echo "Scripts non initialisés : exécuter d'abord le script de configuration." >&2
  exit 1
fi

"${APP_HOME}/bin/orchestrator-start.sh"
```

Lorsqu'un conteneur Codex Cloud est remis en route, ce script relance le serveur MCP (après arrêt éventuel du précédent PID). Les variables `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `MCP_HTTP_PATH`, `MCP_HTTP_JSON` et `MCP_HTTP_STATELESS` peuvent être définies dans l'environnement Codex pour ajuster le transport sans modifier les scripts.

