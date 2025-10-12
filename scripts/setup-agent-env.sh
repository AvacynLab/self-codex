#!/usr/bin/env bash
# Prépare un environnement reproductible pour Self-Codex (MCP orchestrator).
# - Respecte le lockfile (npm ci)
# - Garantit la présence des types Node (@types/node) déjà en dependencies
# - Compile TypeScript (src + graph-forge) avec fallback via npx si tsc absent
# - Peut démarrer le serveur HTTP si START_HTTP=1

set -euo pipefail

echo "🔎 Vérification Node/npm"
node -v
npm -v

# Lockfile requis pour npm ci reproductible
if [[ ! -f package-lock.json ]]; then
  echo "❌ package-lock.json manquant. Ce dépôt requiert 'npm ci'."
  exit 2
fi

# Neutraliser toute conf NPM qui omettrait les devDeps
unset NPM_CONFIG_PRODUCTION || true
unset NPM_CONFIG_OMIT || true
export NODE_ENV=development

echo "🔧 Installation (npm ci, inclut devDeps)"
npm ci --include=dev

# @types/node doit exister (il est en dependencies, mais double-sécurisation)
echo "🧪 Vérification @types/node"
if [[ ! -d node_modules/@types/node ]]; then
  echo "⚠️  @types/node absent — installation de secours"
  npm install @types/node@^20 --no-save --no-package-lock
fi

echo "🏗️  Build TypeScript (src + graph-forge)"
if [[ -x node_modules/.bin/tsc ]]; then
  npm run build
else
  echo "ℹ️  tsc absent → fallback npx typescript"
  npx --yes typescript tsc
  npx --yes typescript tsc -p graph-forge/tsconfig.json
fi

# Config Codex CLI (STDIO par défaut)
echo "⚙️  Écriture ~/.codex/config.toml"
mkdir -p "$HOME/.codex"
REPO_DIR="$(pwd)"
cat > "$HOME/.codex/config.toml" <<EOF
[mcp_servers.self-fork-orchestrator]
command = "node"
args = ["${REPO_DIR}/dist/server.js"]
startup_timeout_sec = 20
tool_timeout_sec = 60
EOF

# Démarrage HTTP optionnel
: "${START_HTTP:=0}"
: "${MCP_HTTP_HOST:=127.0.0.1}"
: "${MCP_HTTP_PORT:=8765}"
: "${MCP_HTTP_PATH:=/mcp}"
: "${MCP_HTTP_JSON:=on}"
: "${MCP_HTTP_STATELESS:=yes}"

if [[ "${START_HTTP}" == "1" ]]; then
  echo "🚀 Démarrage serveur MCP HTTP"
  LOG_FILE="${REPO_DIR}/runs/http-$(date +%Y%m%d-%H%M%S).log"
  mkdir -p "$(dirname "$LOG_FILE")"

  # Token optionnel pour sécuriser l’endpoint
  AUTH_ENV=()
  if [[ -n "${MCP_HTTP_TOKEN:-}" ]]; then
    AUTH_ENV=(MCP_HTTP_TOKEN="${MCP_HTTP_TOKEN}")
  fi

  env "${AUTH_ENV[@]}" node dist/server.js \
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
