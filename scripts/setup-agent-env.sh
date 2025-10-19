#!/usr/bin/env bash
# Prépare un environnement reproductible pour Self-Codex (MCP orchestrator).
# - Respecte le lockfile (npm ci)
# - Garantit la présence des types Node (@types/node) déjà en dependencies
# - Compile TypeScript (src + graph-forge) avec fallback via npx si tsc absent
# - Peut démarrer le serveur HTTP si START_HTTP=1

set -euo pipefail

# Emplacement standard du fichier PID utilisé par le serveur HTTP optionnel.
SERVER_PID_FILE="/tmp/mcp_http.pid"
SERVER_PID=""

# Nettoyage systématique : tue le serveur HTTP éventuel et supprime le fichier PID.
cleanup() {
  if [[ -n "${SERVER_PID}" ]]; then
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      kill "${SERVER_PID}" 2>/dev/null || true
      wait "${SERVER_PID}" 2>/dev/null || true
    fi
  elif [[ -f "${SERVER_PID_FILE}" ]]; then
    local recorded_pid
    recorded_pid="$(cat "${SERVER_PID_FILE}")"
    if [[ -n "${recorded_pid}" ]] && kill -0 "${recorded_pid}" 2>/dev/null; then
      kill "${recorded_pid}" 2>/dev/null || true
      wait "${recorded_pid}" 2>/dev/null || true
    fi
  fi

  rm -f "${SERVER_PID_FILE}"
}
trap cleanup EXIT INT TERM

echo "🔎 Vérification Node/npm"
node -v

# Neutraliser toute configuration NPM susceptible de filtrer les devDeps ou de forcer un proxy.
unset NPM_CONFIG_PRODUCTION || true
unset NPM_CONFIG_OMIT || true
unset NPM_CONFIG_HTTP_PROXY   || true
unset NPM_CONFIG_HTTPS_PROXY  || true
unset npm_config_http_proxy   || true   # variantes en minuscule parfois injectées
unset npm_config_https_proxy  || true

# Vérification npm après nettoyage des variables pour garantir que l'exécutable consulté
# respecte l'environnement neutralisé (premier appel à `npm`).
npm -v

# Lockfile requis pour npm ci reproductible
if [[ ! -f package-lock.json ]]; then
  echo "❌ package-lock.json manquant. Ce dépôt requiert 'npm ci'."
  exit 2
fi

# Helper : lance une commande en forçant NODE_ENV=development uniquement sur la portée demandée.
run_with_dev_env() {
  local cmd=("$@")
  NODE_ENV=development "${cmd[@]}"
}

# Guard HTTP : empêche le démarrage d'un endpoint non authentifié sauf autorisation explicite.
: "${START_HTTP:=0}"
if [[ "${START_HTTP}" == "1" ]]; then
  allow_noauth="${MCP_HTTP_ALLOW_NOAUTH:-0}"
  allow_noauth_lower="${allow_noauth,,}"
  if [[ -z "${MCP_HTTP_TOKEN:-}" && "${allow_noauth_lower}" != "1" && "${allow_noauth_lower}" != "true" && "${allow_noauth_lower}" != "yes" ]]; then
    echo "❌ START_HTTP=1 sans MCP_HTTP_TOKEN (et MCP_HTTP_ALLOW_NOAUTH != 1) — arrêt pour sécurité." >&2
    exit 3
  fi
fi

echo "🔧 Installation (npm ci, inclut devDeps)"
run_with_dev_env npm ci --include=dev

# @types/node doit exister (il est en dependencies, mais double-sécurisation)
echo "🧪 Vérification @types/node"
if [[ ! -d node_modules/@types/node ]]; then
  echo "⚠️  @types/node absent — installation de secours"
  run_with_dev_env npm install @types/node@^20 --no-save --no-package-lock
fi

echo "🏗️  Build TypeScript (src + graph-forge)"
if [[ -x node_modules/.bin/tsc ]]; then
  run_with_dev_env npm run build
else
  echo "ℹ️  tsc absent → fallback npx typescript"
  run_with_dev_env npx --yes typescript tsc
  run_with_dev_env npx --yes typescript tsc -p graph-forge/tsconfig.json
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
    > "$LOG_FILE" 2>&1 &

  SERVER_PID=$!
  echo "${SERVER_PID}" > "${SERVER_PID_FILE}"

  sleep 1
  echo "✅ MCP HTTP PID: $(cat "${SERVER_PID_FILE}" 2>/dev/null || echo 'n/a')"
  echo "🌐 Endpoint: http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT}${MCP_HTTP_PATH}"
else
  echo "ℹ️ START_HTTP=0 → serveur HTTP non démarré (STDIO seul)."
fi

echo "🎉 Setup terminé"
