# syntax=docker/dockerfile:1
#
# frappe-mcp-server at the commit ragbot pins (ragbot ADR-021 supplies this
# Dockerfile because that commit predates the server's own). Self-contained.
#
#   podman build --platform linux/amd64 -t quay.io/me/frappe-mcp-server:a01ce12c images/mcp
ARG MCP_GIT=https://github.com/vyogotech/frappe-mcp-server.git
ARG MCP_REF=a01ce12c1b4ad7513eb95f162292fd5d79fc44bc

FROM docker.io/library/alpine:3.24 AS src
ARG MCP_GIT
ARG MCP_REF
RUN apk add --no-cache git \
 && git init -q /src && cd /src \
 && git fetch -q --depth 1 "$MCP_GIT" "$MCP_REF" \
 && git checkout -q FETCH_HEAD

FROM docker.io/library/golang:1.27-alpine AS build
WORKDIR /src
COPY --from=src /src/go.mod /src/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY --from=src /src/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/frappe-mcp-server .

FROM docker.io/library/alpine:3.24
WORKDIR /app
COPY --from=build /out/frappe-mcp-server ./
USER 1001
EXPOSE 8080
CMD ["./frappe-mcp-server"]
