# syntax=docker/dockerfile:1
#
# The bench image frappe-operator runs: Frappe v16 + erpnext + drive + frappe_ai + rag.
# One self-contained build, from the repository root:
#
#   docker build -f images/bench/Dockerfile -t quay.io/me/ragbot-bench:16 .
#
# Multi-arch (amd64 + arm64; the base publishes both):
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f images/bench/Dockerfile -t quay.io/me/ragbot-bench:16 --push .
#
# Based on frappe-operator's own v16 ERPNext image, so the layout is the one the
# operator expects: the bench at /home/frappe/frappe-bench, pre-built assets in
# /home/frappe/assets_cache (bench_init.sh / site_init.sh copy them onto the
# sites volume), group 0 ownership for OpenShift's random UID.
ARG BASE_IMAGE=ghcr.io/vyogotech/erpnext-for-operator:version-16

# ---------------------------------------------------------------- build
# drive depends on pycrdt, which has no Python 3.14 wheel and compiles from
# source (Rust, fetched by maturin, plus a C linker). The compiler stays here.
FROM ${BASE_IMAGE} AS build

ARG DRIVE_REPO=https://github.com/frappe/drive
ARG DRIVE_BRANCH=develop
ARG FRAPPE_AI_REPO=https://github.com/vyogotech/frappe_ai
ARG FRAPPE_AI_BRANCH=audit/production-readiness

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

USER frappe
WORKDIR /home/frappe/frappe-bench
ENV PATH=/home/frappe/.nvm/current/bin:$PATH

# drive's frontend imports socketio_port from common_site_config.json at build
# time. The operator writes the real file (same port) onto the sites volume at
# runtime; this copy only exists for the build and is not carried over.
RUN python3 -c 'import json; p="sites/common_site_config.json"; \
c=json.load(open(p)) if __import__("os").path.exists(p) else {}; \
c.setdefault("socketio_port", 9000); json.dump(c, open(p, "w"), indent=1)'

# drive and frappe_ai from their repos (what ragbot's apps.json lists)
RUN bench get-app --branch "${DRIVE_BRANCH}" "${DRIVE_REPO}" \
 && bench get-app --branch "${FRAPPE_AI_BRANCH}" "${FRAPPE_AI_REPO}"

# rag is a subdirectory of the ragbot repo, not a repo root, so `bench get-app`
# cannot fetch it: copy it in, install it into the bench env, build its assets
# (including the /ask Next.js app).
COPY --chown=frappe:root app/ragbot/rag apps/rag
RUN bench pip install --no-cache-dir -e apps/rag \
 && (cd apps/rag && yarn install --frozen-lockfile) \
 && ls -1 apps > sites/apps.txt \
 && bench build --app rag

# Refresh the operator's asset cache. Each app's entry is a symlink into
# apps/<app>/<app>/public (where `bench build` writes dist/), so links are copied
# as links. assets.json / assets-rtl.json map bundle names to hashed files: the
# builds here only know the new apps, so they are MERGED into the base image's
# maps (frappe, erpnext), never copied over them. Then drop git metadata and
# node_modules, and give group 0 what the owner has.
RUN cd /home/frappe/assets_cache \
 && for f in assets.json assets-rtl.json; do [ -f "$f" ] && mv "$f" "/tmp/base-$f"; done; \
    cd /home/frappe/frappe-bench \
 && cp -a --remove-destination sites/assets/. /home/frappe/assets_cache/ \
 && python3 -c 'import json, os; \
d="/home/frappe/assets_cache"; \
[ (lambda m: json.dump(m, open(f"{d}/{f}", "w"), indent=1))( \
   {**(json.load(open(f"/tmp/base-{f}")) if os.path.exists(f"/tmp/base-{f}") else {}), \
    **(json.load(open(f"{d}/{f}")) if os.path.exists(f"{d}/{f}") else {})}) \
  for f in ("assets.json", "assets-rtl.json") ]' \
 && find apps -mindepth 2 -maxdepth 2 \( -name .git -o -name node_modules \) -type d -exec rm -rf {} + \
 && chmod -R g=u apps env sites /home/frappe/assets_cache

# ---------------------------------------------------------------- runtime
# Only what the build changed is copied over the base: the new apps, the env
# with their Python packages, and the assets. No compiler in the final image.
FROM ${BASE_IMAGE}

USER root
# MDEV-35221: the 10.11 client dumps VECTOR columns as text and a restore turns
# every vector into zeroes, silently. hex-blob fixes dumps. System-wide rather
# than ~/.my.cnf: OpenShift's random UID has no HOME.
COPY --chmod=0644 app/ragbot/mariadb-client.cnf /etc/mysql/conf.d/ragbot-client.cnf

USER frappe
WORKDIR /home/frappe/frappe-bench
COPY --from=build --chown=frappe:root /home/frappe/frappe-bench/apps/drive apps/drive
COPY --from=build --chown=frappe:root /home/frappe/frappe-bench/apps/frappe_ai apps/frappe_ai
COPY --from=build --chown=frappe:root /home/frappe/frappe-bench/apps/rag apps/rag
COPY --from=build --chown=frappe:root /home/frappe/frappe-bench/env env
COPY --from=build --chown=frappe:root /home/frappe/frappe-bench/sites/apps.txt sites/apps.txt
COPY --from=build --chown=frappe:root /home/frappe/frappe-bench/sites/assets sites/assets
COPY --from=build --chown=frappe:root /home/frappe/assets_cache /home/frappe/assets_cache
