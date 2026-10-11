# syntax=docker/dockerfile:1
#
# frappe-ai-agent at the commit ragbot pins. Self-contained: the source is
# fetched inside the build, so the context can be this directory alone.
#
#   podman build --platform linux/amd64 -t quay.io/me/frappe-ai-agent:7f1ef10c images/agent
ARG AGENT_GIT=https://github.com/vyogotech/frappe-ai-agent.git
ARG AGENT_REF=7f1ef10c755502b1d4104b9bace9c5a09cd4b5a7

FROM docker.io/library/alpine:3.24 AS src
ARG AGENT_GIT
ARG AGENT_REF
RUN apk add --no-cache git \
 && git init -q /src && cd /src \
 && git fetch -q --depth 1 "$AGENT_GIT" "$AGENT_REF" \
 && git checkout -q FETCH_HEAD

FROM docker.io/library/python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.18 /uv /bin/
ENV UV_LINK_MODE=copy
WORKDIR /app
# dependencies first, from the committed lock, so a source change reuses this layer
COPY --from=src /src/pyproject.toml /src/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project
COPY --from=src /src/ ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-editable

FROM docker.io/library/python:3.12-slim
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH
# any UID works (OpenShift assigns one); 1001 for plain Docker
USER 1001
EXPOSE 8484
CMD ["/bin/sh", "-c", "exec uvicorn ai_agent.app:create_app --factory --host 0.0.0.0 --port 8484 --workers ${AI_AGENT_WORKERS:-1} --timeout-graceful-shutdown 8"]
