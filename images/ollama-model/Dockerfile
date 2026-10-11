# syntax=docker/dockerfile:1
#
# Ollama server + one model, in one image. Used twice:
#   LLM on the ROSA GPU node:   --build-arg MODEL=gemma4:26b       (or qwen3.5:9b on a T4)
#   Embeddings on-prem (CPU):   --build-arg MODEL=nomic-embed-text
#
#   podman build --platform linux/amd64 --build-arg MODEL=gemma4:26b \
#     -t quay.io/me/ragbot-llm:gemma4-26b images/ollama-model
#
# No download at start-up, no egress, no PVC: the node pulls the image once and
# caches it, and the weights load straight from the image into the GPU.
ARG OLLAMA_VERSION=0.34.1

# Pull on the builder's own arch: weights are architecture-independent, so this
# is fast on Apple Silicon too and copies into an amd64 runtime unchanged.
# chmod happens here, not in the runtime stage, so the weights are not stored
# twice: OpenShift runs as a random UID in group 0, so all must be world-readable.
FROM --platform=$BUILDPLATFORM docker.io/ollama/ollama:${OLLAMA_VERSION} AS pull
ARG MODEL
ENV OLLAMA_MODELS=/models
RUN test -n "$MODEL" || { echo "build with --build-arg MODEL=<name:tag>" >&2; exit 1; } \
 && (ollama serve >/tmp/serve.log 2>&1 &) \
 && i=0 && until ollama list >/dev/null 2>&1; do \
      i=$((i+1)); [ "$i" -le 60 ] || { cat /tmp/serve.log; exit 1; }; sleep 1; done \
 && ollama pull "$MODEL" \
 && ollama list \
 && chmod -R a+rX /models

FROM docker.io/ollama/ollama:${OLLAMA_VERSION}
ARG MODEL
COPY --from=pull /models /models
# OLLAMA_NOPRUNE: the store is read-only to the random UID; never prune it.
# OLLAMA_KEEP_ALIVE=-1: keep the model loaded; a reload is the slowest wait.
# HOME=/tmp: Ollama writes an identity key under HOME; the random UID has none.
ENV OLLAMA_MODELS=/models \
    OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_NOPRUNE=1 \
    OLLAMA_KEEP_ALIVE=-1 \
    HOME=/tmp \
    RAGBOT_MODEL=${MODEL}
LABEL io.ragbot.model="${MODEL}"
EXPOSE 11434
CMD ["serve"]
