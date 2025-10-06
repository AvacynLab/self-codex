#!/usr/bin/env bash
# retry-flaky.sh — rerun a command multiple times to flush out non-deterministic failures.
#
# Usage:
#   ./scripts/retry-flaky.sh [command [args...]]
#
# When no command is provided the script defaults to the deterministic unit test
# runner (`npm run test:unit -- --exit`). The RETRY_FLAKY_ATTEMPTS environment
# variable controls how many times the command is executed (defaults to 10).

set -euo pipefail

attempts="${RETRY_FLAKY_ATTEMPTS:-10}"
if ! [[ "$attempts" =~ ^[0-9]+$ ]] || [[ "$attempts" -lt 1 ]]; then
  echo "RETRY_FLAKY_ATTEMPTS must be a positive integer (received '$attempts')." >&2
  exit 1
fi

if [[ "$#" -eq 0 ]]; then
  set -- npm run test:unit -- --exit
fi

for attempt in $(seq 1 "$attempts"); do
  echo "🔁 Attempt ${attempt}/${attempts}: $*"
  if "$@"; then
    continue
  fi
  echo "❌ Command failed on attempt ${attempt}. Aborting." >&2
  exit 1
done

echo "✅ Completed ${attempts} successful attempt(s)."
