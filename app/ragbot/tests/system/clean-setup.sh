#!/bin/sh
# `make clean-setup`: prove a fresh clone of this repository still becomes a working product. Clones HEAD into a
# scratch directory, runs `make setup` there as its own compose project with its own site, port and image tags, runs
# the smoke journeys against it, and takes that project down. The demo's project, images and data are never touched:
# the clone's volumes are tmpfs (compose.clean.yaml), so nothing is left behind and no volume is ever removed.
set -eu
PROJECT=${CLEAN_PROJECT:-frappe-clean}
PORT=${CLEAN_HTTP_PORT:-8091}
SITE=${CLEAN_SITE:-clean.localhost}
repo=$(git rev-parse --show-toplevel)
work=${CLEAN_WORK:-${TMPDIR:-/tmp}/ragbot-clean-setup}

rm -rf "$work"
git clone -q --no-hardlinks "$repo" "$work"
cd "$work"
echo "clean-setup: $(git rev-parse --short HEAD), project $PROJECT, site $SITE, port $PORT"

cat > .env <<EOF
CUSTOM_IMAGE=frappe-clean
CUSTOM_TAG=16
DB_PASSWORD=$(openssl rand -hex 16)
HTTP_PUBLISH_PORT=$PORT
SITE_NAME=$SITE
AI_MODEL=${AI_MODEL:-gemma4:26b}
AI_NUM_CTX=65536
OLLAMA=native
EMBED_MODEL=${EMBED_MODEL:-nomic-embed-text}
ADMIN_PASSWORD=$(openssl rand -hex 16)
EOF

clean="COMPOSE_PROJECT=$PROJECT COMPOSE_EXTRA=tests/system/compose.clean.yaml AGENT_IMAGE=frappe-ai-agent:clean MCP_IMAGE=frappe-mcp-server:clean"
# refuse to go on unless this clone really honours the settings above: a clone that predates them would compose the
# demo's own project, whose containers it would then recreate against this scratch directory
make $clean -n up 2>/dev/null | grep -q -- "--project-name $PROJECT" || {
  echo "clean-setup: this commit does not honour COMPOSE_PROJECT; refusing to touch another project" >&2
  exit 2
}
teardown() {
  # never `down -v`: the volumes are tmpfs, so their data is gone once nothing mounts them
  make $clean down >/dev/null 2>&1 || true
  docker image rm -f frappe-clean:16 frappe-ai-agent:clean frappe-mcp-server:clean >/dev/null 2>&1 || true
}
trap teardown EXIT

status=0
make $clean setup || status=$?
# the smoke journeys against this project's own site; the not-the-demo guards let it through because the project is
# not the demo's, and they still refuse the demo's site in the demo's project
[ "$status" = 0 ] && { make $clean test-seed smoke TEST_SITE="$SITE" TEST_HTTP_PORT="$PORT" || status=$?; }
echo "clean-setup finished with status $status"
exit $status
