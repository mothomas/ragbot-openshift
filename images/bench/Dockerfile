# syntax=docker/dockerfile:1
#
# The bench image frappe-operator runs. Two layers:
#   1. BASE_IMAGE: Frappe v16 + erpnext + drive + frappe_ai, built from
#      apps.json with frappe_docker's layered Containerfile (`make image-bench-base`).
#   2. This file: + rag (from app/ragbot) + the vector-safe MariaDB client config.
#
# rag is a subdirectory of the ragbot repo, not a repo root, so `bench get-app`
# cannot fetch it; it is copied in and installed here. Build context: app/ragbot.
#
#   podman build --platform linux/amd64 --build-arg BASE_IMAGE=quay.io/me/ragbot-bench-base:16 \
#     -f images/bench/Dockerfile -t quay.io/me/ragbot-bench:16 app/ragbot
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root
# MDEV-35221: the 10.11 client in the bench image dumps VECTOR columns as text,
# and a restore turns every vector into zeroes, silently. hex-blob fixes dumps.
# System-wide rather than ~/.my.cnf: OpenShift's random UID has no HOME.
COPY --chmod=0644 mariadb-client.cnf /etc/mysql/conf.d/ragbot-client.cnf

USER frappe
WORKDIR /home/frappe/frappe-bench
COPY --chown=frappe:frappe rag apps/rag
RUN bench pip install --no-cache-dir -e apps/rag \
 && ls -1 apps > sites/apps.txt \
 && cd apps/rag && yarn install --frozen-lockfile && cd ../.. \
 && bench build --app rag

# group 0 owns what the random UID reads, as on any OpenShift image
USER root
RUN chgrp -R 0 apps/rag && chmod -R g=u apps/rag
USER frappe
