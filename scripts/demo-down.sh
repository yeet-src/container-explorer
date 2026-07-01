#!/usr/bin/env bash
# demo-down.sh — remove everything demo-up.sh created. Only touches
# containers labelled `demo=container-explorer` plus the demo network and
# volume, so nothing else on the host is at risk.

set -euo pipefail

LABEL="demo=container-explorer"
NET="cx-demo-net"
VOL="cx-demo-data"

ids="$(docker ps -aq --filter "label=$LABEL" || true)"
if [ -n "$ids" ]; then
  echo ">> removing containers:"
  # shellcheck disable=SC2086
  docker ps -a --filter "label=$LABEL" --format "   {{.Names}}"
  # shellcheck disable=SC2086
  docker rm -f $ids >/dev/null
else
  echo ">> no demo containers found"
fi

if docker network inspect "$NET" >/dev/null 2>&1; then
  echo ">> removing network $NET"
  docker network rm "$NET" >/dev/null
fi

if docker volume inspect "$VOL" >/dev/null 2>&1; then
  echo ">> removing volume $VOL"
  docker volume rm "$VOL" >/dev/null
fi

# The bind-mount tmp dirs demo-up created (cx-demo-web-XXXX) live under
# $TMPDIR; sweep any that are still around.
find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'cx-demo-web-*' \
  -exec rm -rf {} + 2>/dev/null || true

echo "done."
