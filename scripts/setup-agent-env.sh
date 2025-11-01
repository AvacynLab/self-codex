#!/usr/bin/env bash
# Prépare un environnement reproductible pour Self-Codex (MCP orchestrator).
# - Respecte le lockfile (npm ci)
# - Garantit la présence des types Node (@types/node) déjà en dependencies
# - Compile TypeScript (src + graph-forge) avec fallback via npx si tsc absent
# - Peut démarrer le serveur HTTP si START_HTTP=1
# - Vérifie la version de Node, crée l'arborescence `validation_run/` et avertit
#   si les endpoints SearxNG/Unstructured sont absents.

set -euo pipefail

# La validation requiert Node.js >= 20 (fetch natif + AbortController).
MIN_NODE_MAJOR=20

# START_MCP_BG pilote l'orchestration MCP en arrière-plan. On neutralise
# volontairement la variable lors du bootstrap global afin d'éviter qu'un run
# précédent laisse le serveur HTTP actif par inadvertance. Les scripts de
# validation ré-exportent ensuite la valeur documentée dans
# `docs/validation-run-runtime.md` lorsqu'un démarrage automatique est requis.
unset START_MCP_BG || true

# Neutralisation immédiate des variables npm pour éviter les surprises (proxies, devDeps omis).
unset NPM_CONFIG_PRODUCTION || true
unset NPM_CONFIG_OMIT || true
unset NPM_CONFIG_HTTP_PROXY   || true
unset NPM_CONFIG_HTTPS_PROXY  || true
unset npm_config_http_proxy   || true   # variantes en minuscule parfois injectées
unset npm_config_https_proxy  || true

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
node_version_raw="$(node -v 2>/dev/null || true)"
if [[ -z "${node_version_raw}" ]]; then
  echo "❌ Node.js introuvable. Installez Node ${MIN_NODE_MAJOR}+ avant de poursuivre." >&2
  exit 5
fi
echo "${node_version_raw}"
if [[ ! "${node_version_raw}" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "❌ Version Node inattendue (${node_version_raw})." >&2
  exit 6
fi
node_major="${BASH_REMATCH[1]}"
if (( node_major < MIN_NODE_MAJOR )); then
  echo "❌ Node ${node_version_raw} détecté (< ${MIN_NODE_MAJOR}). Mettez à jour Node.js." >&2
  exit 7
fi

# Validation supplémentaire : vérifie qu'aucune variable npm_config proxy n'est restée active.
ensure_no_npm_proxy_env() {
  local snapshot
  snapshot="$(mktemp)"
  # Sauvegarde ciblée pour diagnostic en cas d'échec.
  if env | grep -i '^npm_config' >"${snapshot}" 2>/dev/null; then
    if grep -Eqi 'https?_proxy=' "${snapshot}"; then
      echo "❌ Variables npm_config proxy détectées après neutralisation. Nettoyez votre environnement." >&2
      cat "${snapshot}" >&2
      rm -f "${snapshot}"
      exit 4
    fi
  fi

  rm -f "${snapshot}"
}

ensure_no_npm_proxy_env

# Vérification npm après nettoyage des variables pour garantir que l'exécutable consulté
# respecte l'environnement neutralisé (premier appel à `npm`).
npm -v

# Lockfile requis pour npm ci reproductible
if [[ ! -f package-lock.json ]]; then
  echo "❌ package-lock.json manquant. Ce dépôt requiert 'npm ci'."
  exit 2
fi

# Préparation des répertoires runtime (`validation_run`, `children`, logs...).
RUNTIME_ROOT_DEFAULT="./validation_run"
RUNTIME_ROOT="${MCP_RUNS_ROOT:-${RUNTIME_ROOT_DEFAULT}}"
LOG_ROOT="${RUNTIME_ROOT}/logs"
mkdir -p "${RUNTIME_ROOT}" "${LOG_ROOT}" "${RUNTIME_ROOT}/runs" "${RUNTIME_ROOT}/snapshots" "${RUNTIME_ROOT}/metrics" "${RUNTIME_ROOT}/artifacts" "${RUNTIME_ROOT}/reports"
mkdir -p ./children

# Valeurs par défaut pour l'orchestrateur (respect des conventions validation_run).
if [[ -z "${MCP_RUNS_ROOT:-}" ]]; then
  export MCP_RUNS_ROOT="${RUNTIME_ROOT}"
fi
if [[ -z "${MCP_LOG_FILE:-}" ]]; then
  export MCP_LOG_FILE="${LOG_ROOT}/self-codex.log"
fi

# Avertissement précoce si les endpoints requis ne sont pas configurés.
if [[ -z "${SEARCH_SEARX_BASE_URL:-}" ]]; then
  echo "⚠️  SEARCH_SEARX_BASE_URL non défini : les outils search échoueront." >&2
fi
if [[ -z "${UNSTRUCTURED_BASE_URL:-}" ]]; then
  echo "⚠️  UNSTRUCTURED_BASE_URL non défini : l'extracteur ne pourra pas fonctionner." >&2
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
  LOG_FILE="${MCP_LOG_FILE:-${LOG_ROOT}/self-codex.log}"
  mkdir -p "$(dirname "$LOG_FILE")"
  touch "${LOG_FILE}"

  # Token optionnel pour sécuriser l’endpoint
  AUTH_ENV=()
  if [[ -n "${MCP_HTTP_TOKEN:-}" ]]; then
    AUTH_ENV=(MCP_HTTP_TOKEN="${MCP_HTTP_TOKEN}")
  fi

  env MCP_RUNS_ROOT="${MCP_RUNS_ROOT}" MCP_LOG_FILE="${LOG_FILE}" "${AUTH_ENV[@]}" node dist/server.js \
    --http \
    --http-host "$MCP_HTTP_HOST" \
    --http-port "$MCP_HTTP_PORT" \
    --http-path "$MCP_HTTP_PATH" \
    --http-json "$MCP_HTTP_JSON" \
    --http-stateless "$MCP_HTTP_STATELESS" \
    >> "$LOG_FILE" 2>&1 &

  SERVER_PID=$!
  echo "${SERVER_PID}" > "${SERVER_PID_FILE}"

  sleep 1
  echo "✅ MCP HTTP PID: $(cat "${SERVER_PID_FILE}" 2>/dev/null || echo 'n/a')"
  echo "🌐 Endpoint: http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT}${MCP_HTTP_PATH}"
  echo "🗂️  Log file: ${LOG_FILE}"
else
  echo "ℹ️ START_HTTP=0 → serveur HTTP non démarré (STDIO seul)."
fi

echo "🎉 Setup terminé"
