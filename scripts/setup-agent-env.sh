#!/usr/bin/env bash
# But : prépare l'environnement MCP en garantissant un build reproductible avec npm ci et @types/node en dependencies.
# Explications : neutralise les variables npm qui omettent les devDependencies, vérifie @types/node, effectue le build TypeScript
# (avec repli via npx typescript) puis configure/relance le serveur HTTP si START_HTTP=1.
set -euo pipefail

echo "🔎 Vérification Node/npm"
node -v
npm -v

# Verrouillage du lockfile obligatoire pour npm ci reproductible
if [[ ! -f package-lock.json ]]; then
  echo "❌ package-lock.json manquant. Ce dépôt requiert 'npm ci' (Mode A)."
  exit 2
fi

# Neutralise toute config npm qui omet les devDependencies et force un environnement de développement
unset NPM_CONFIG_PRODUCTION || true
unset NPM_CONFIG_OMIT || true
export NODE_ENV=development

echo "🔧 npm ci (inclut devDeps et respecte lockfile)"
npm ci --include=dev

# Vérifie que @types/node est bien présent même en environnement capricieux
echo "🧪 Vérification @types/node"
if [[ ! -d node_modules/@types/node ]]; then
  echo "⚠️ @types/node absent — installation de secours"
  npm install @types/node@^20 --no-save --no-package-lock
fi

# Build TypeScript (src + graph-forge) avec fallback npx si tsc manque du PATH
echo "🏗️ Build TypeScript (src + graph-forge)"
if [[ -x node_modules/.bin/tsc ]]; then
  npm run build
else
  echo "ℹ️ tsc absent du PATH — utilisation de npx typescript"
  npx --yes typescript tsc
  npx --yes typescript tsc -p graph-forge/tsconfig.json
fi

if [[ ! -f dist/server.js ]]; then
  echo "❌ dist/server.js introuvable après build"
  exit 3
fi

# Optionnel : config Codex CLI pour STDIO (désactivable avec DISABLE_CLI_CONFIG=1)
if [[ "${DISABLE_CLI_CONFIG:-0}" != "1" ]]; then
  echo "📝 Écriture de ~/.codex/config.toml (STDIO)"
  mkdir -p "$HOME/.codex"
  REPO_DIR="$(pwd)"
  cat > "$HOME/.codex/config.toml" <<EOF2
[mcp_servers.self-fork-orchestrator]
command = "node"
args = ["${REPO_DIR}/dist/server.js"]
startup_timeout_sec = 20
tool_timeout_sec = 60
EOF2
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
