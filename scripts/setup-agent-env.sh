#!/usr/bin/env bash
# But : prépare l'environnement MCP en Mode A avec npm ci, build TypeScript et configuration optionnelle du serveur HTTP.
# Explications : utilise npm ci pour garantir les devDependencies (`@types/node`), puis construit dist/ et lance le serveur HTTP si START_HTTP=1.
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
