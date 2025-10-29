#!/usr/bin/env bash
# Sondage rapide de la stack de recherche (SearxNG + Unstructured).
# - Écrit des snapshots dans `validation_run/snapshots/`
# - Facilite les diagnostics CI en conservant les réponses ou erreurs.

set -euo pipefail

RUNTIME_ROOT="${MCP_RUNS_ROOT:-./validation_run}"
SNAPSHOT_DIR="${RUNTIME_ROOT}/snapshots"
mkdir -p "${SNAPSHOT_DIR}"

# Helper pour consigner un message d'erreur lisible dans un fichier de snapshot.
write_failure() {
  local dest="$1"
  local message="$2"
  printf 'status=error\n%s\n' "${message}" > "${dest}"
}

# ---- SearxNG --------------------------------------------------------------
SEARX_SNAPSHOT="${SNAPSHOT_DIR}/searxng_probe.txt"
if [[ -z "${SEARCH_SEARX_BASE_URL:-}" ]]; then
  write_failure "${SEARX_SNAPSHOT}" "SEARCH_SEARX_BASE_URL manquant"
else
  SEARX_PATH="${SEARCH_SEARX_API_PATH:-/search}"
  SEARX_URL="${SEARCH_SEARX_BASE_URL%/}${SEARX_PATH}?q=test&format=json"
  TMP_BODY="$(mktemp)"
  TMP_ERR="$(mktemp)"
  # Utilise un timeout court pour éviter de bloquer les pipelines CI.
  set +e
  curl --fail --show-error --silent --max-time 10 \
    --output "${TMP_BODY}" \
    "${SEARX_URL}" 2>"${TMP_ERR}"
  CURL_STATUS=$?
  set -e
  if (( CURL_STATUS == 0 )); then
    head -c 500 "${TMP_BODY}" >"${SEARX_SNAPSHOT}"
  else
    CURL_STDERR="$(cat "${TMP_ERR}" 2>/dev/null)"
    write_failure "${SEARX_SNAPSHOT}" "curl_exit=${CURL_STATUS}; ${CURL_STDERR:-aucune sortie}"
  fi
  rm -f "${TMP_BODY}" "${TMP_ERR}"
fi

# ---- Unstructured ---------------------------------------------------------
UNSTRUCTURED_SNAPSHOT="${SNAPSHOT_DIR}/unstructured_probe.txt"
if [[ -z "${UNSTRUCTURED_BASE_URL:-}" ]]; then
  write_failure "${UNSTRUCTURED_SNAPSHOT}" "UNSTRUCTURED_BASE_URL manquant"
else
  HEALTH_URL="${UNSTRUCTURED_BASE_URL%/}/healthcheck"
  TMP_BODY="$(mktemp)"
  TMP_ERR="$(mktemp)"
  set +e
  curl --fail --show-error --silent --max-time 15 \
    --request POST \
    --header 'Content-Type: application/json' \
    --data '{"ping":"search-stack"}' \
    --output "${TMP_BODY}" \
    "${HEALTH_URL}" 2>"${TMP_ERR}"
  CURL_STATUS=$?
  set -e
  if (( CURL_STATUS == 0 )); then
    head -c 500 "${TMP_BODY}" >"${UNSTRUCTURED_SNAPSHOT}"
  else
    CURL_STDERR="$(cat "${TMP_ERR}" 2>/dev/null)"
    write_failure "${UNSTRUCTURED_SNAPSHOT}" "curl_exit=${CURL_STATUS}; ${CURL_STDERR:-aucune sortie}"
  fi
  rm -f "${TMP_BODY}" "${TMP_ERR}"
fi
