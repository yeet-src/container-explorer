#!/usr/bin/env bash
# demo-up.sh — spin up a varied set of containers so container-explorer has
# something interesting to show. Every container name is prefixed with
# `cx-demo-` so `demo-down.sh` can find and remove exactly what this
# script created (no `docker rm -f $(docker ps -aq)` blast radius).
#
# The mix is chosen to exercise every section of the detail view:
#
#   cx-demo-web       — image tag + published port + a bind mount
#   cx-demo-db        — env vars + a named volume + custom network
#   cx-demo-cache     — same custom network (multi-attached net view)
#   cx-demo-busy      — a CPU load loop (so cpu% is non-zero)
#   cx-demo-chatty    — pings out constantly (network rx/tx counters move)
#   cx-demo-stopped   — created then stopped (state colouring)
#   cx-demo-restart   — crashes on a schedule (restart_count climbs)
#
# Safe to re-run: each `docker run` is guarded by a name-exists check.

set -euo pipefail

PREFIX="cx-demo-"
NET="cx-demo-net"
VOL="cx-demo-data"

have() { docker inspect "$1" >/dev/null 2>&1; }

ensure_net() {
  docker network inspect "$NET" >/dev/null 2>&1 || {
    echo ">> creating network $NET"
    docker network create "$NET" >/dev/null
  }
}

ensure_vol() {
  docker volume inspect "$VOL" >/dev/null 2>&1 || {
    echo ">> creating volume $VOL"
    docker volume create "$VOL" >/dev/null
  }
}

run() {
  local name="$1"; shift
  if have "$name"; then
    echo ">> $name already exists — skipping"
    return
  fi
  echo ">> starting $name"
  docker run -d --name "$name" "$@" >/dev/null
}

ensure_net
ensure_vol

# 1. Classic web server: image tag, published port, bind mount.
BIND_DIR="$(mktemp -d -t cx-demo-web-XXXX)"
echo "hello from container-explorer demo" > "$BIND_DIR/index.html"
run "${PREFIX}web" \
  --label demo=container-explorer \
  -p 18080:80 \
  -v "$BIND_DIR":/usr/share/nginx/html:ro \
  nginx:alpine

# 2. Redis-ish: named volume + custom network + env vars.
run "${PREFIX}db" \
  --label demo=container-explorer \
  --network "$NET" \
  -e POSTGRES_PASSWORD=demo -e POSTGRES_USER=demo \
  -v "$VOL":/var/lib/postgresql/data \
  postgres:16-alpine

# 3. Another node on the same custom network.
run "${PREFIX}cache" \
  --label demo=container-explorer \
  --network "$NET" \
  redis:7-alpine

# 4. Busy CPU loop so the cpu% column shows movement.
run "${PREFIX}busy" \
  --label demo=container-explorer \
  alpine sh -c 'while :; do :; done'

# 5. Network-chatty: constant pings so rx/tx counters climb.
run "${PREFIX}chatty" \
  --label demo=container-explorer \
  alpine sh -c 'apk add --no-cache iputils >/dev/null 2>&1 || true; while :; do ping -c1 1.1.1.1 >/dev/null 2>&1 || true; sleep 1; done'

# 6. A stopped one — created then explicitly stopped so `state` != running.
if ! have "${PREFIX}stopped"; then
  echo ">> starting ${PREFIX}stopped (will stop shortly)"
  docker run -d --name "${PREFIX}stopped" --label demo=container-explorer \
    alpine sh -c 'sleep 2' >/dev/null
  # give it a moment so its state is EXITED not RUNNING when the TUI opens
  sleep 3
fi

# 7. Auto-restarter — exits every few seconds, so restart_count climbs.
run "${PREFIX}restart" \
  --label demo=container-explorer \
  --restart on-failure \
  alpine sh -c 'sleep 5; exit 1'

echo
echo "demo containers up. names:"
docker ps -a --filter "label=demo=container-explorer" \
  --format "  {{.Names}}\t{{.Status}}\t{{.Image}}"
echo
echo "run:    yeet run ."
echo "clean:  scripts/demo-down.sh"
