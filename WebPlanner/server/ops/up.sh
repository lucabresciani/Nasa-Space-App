#!/bin/sh
# Build and start the local Docker stack with the code identity baked in (WS12 O1, D57, D69).
#   flock /tmp/hl-heavy.lock sg docker -c "server/ops/up.sh"      # from the repo root
# Extra arguments go to `docker compose up` (default: -d --build).
#
# The image reports HL_COMMIT / HL_ENGINE_TREE at /engine/version and in every result hash, so
# they must describe the files copied into it: uncommitted or untracked changes in the image paths
# stop the build. HL_ALLOW_DIRTY=1 builds anyway WITHOUT an identity (/engine/version then answers
# 503 engine_identity_unavailable; nothing invented).
# It also exports HL_PROXY_MAX_BODY from config/backend.yaml (needs the repo venv: uv sync --group
# server). HL_TEAM_TOKEN (admin) is passed through from the caller's environment only.
set -eu
cd "$(git rev-parse --show-toplevel)"
dirty=$(git status --porcelain --untracked-files=all -- \
  .dockerignore pyproject.toml uv.lock config contracts pipeline server tools web/public/data)
if [ -n "$dirty" ]; then
  if [ "${HL_ALLOW_DIRTY:-}" != 1 ]; then
    echo "up.sh: uncommitted changes in the image paths; commit them or set HL_ALLOW_DIRTY=1:" >&2
    echo "$dirty" >&2
    exit 1
  fi
  echo "up.sh: dirty tree, building WITHOUT code identity (HL_ALLOW_DIRTY=1)" >&2
  HL_COMMIT="" HL_ENGINE_TREE=""
else
  HL_COMMIT=$(git rev-parse HEAD) HL_ENGINE_TREE=$(git rev-parse HEAD:pipeline)
fi
# Caddy's request body cap comes from config/backend.yaml limits.proxy_max_body_bytes (Caddy cannot
# read YAML). Read through the server's own validated loader; no value, no start.
HL_PROXY_MAX_BODY=$(uv run --no-sync python -c \
  'from server.settings import load; print(load().limits.proxy_max_body_bytes)') || {
  echo "up.sh: cannot read limits.proxy_max_body_bytes from config/backend.yaml" \
       "(uv sync --group server first)" >&2
  exit 1
}
case "$HL_PROXY_MAX_BODY" in
  ''|*[!0-9]*) echo "up.sh: limits.proxy_max_body_bytes is not a byte count: '$HL_PROXY_MAX_BODY'" >&2
               exit 1 ;;
esac
export HL_COMMIT HL_ENGINE_TREE HL_PROXY_MAX_BODY
echo "up.sh: HL_COMMIT=${HL_COMMIT:-<none>} HL_PROXY_MAX_BODY=$HL_PROXY_MAX_BODY" \
     "HL_TEAM_TOKEN=$([ -n "${HL_TEAM_TOKEN:-}" ] && echo set || echo unset)" >&2
if [ $# -eq 0 ]; then set -- -d --build; fi
exec docker compose -f server/ops/compose.yaml up "$@"
