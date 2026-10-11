# Images

Five images, one Dockerfile each under `images/`, and one `make` target for all of them.

```bash
make images REGISTRY=quay.io/<you>
```

```bash
make push REGISTRY=quay.io/<you>
```

```bash
make values REGISTRY=quay.io/<you>
```

`make values` prints the `images:` block for `charts/ragbot/values.yaml`. Use `ENGINE=docker` for
Docker instead of Podman. `PLATFORM` defaults to `linux/amd64` (OpenShift nodes), which is what
you want even when building on Apple Silicon.

| Image | Dockerfile | Contents | Approx. size | Runs on |
| --- | --- | --- | --- | --- |
| `ragbot-bench:16` | `images/bench/Dockerfile` | Frappe v16.34.0 + erpnext + drive + frappe_ai + rag | ~3 GB | on-prem (every bench pod) |
| `frappe-ai-agent:7f1ef10c` | `images/agent/Dockerfile` | The agent, at ragbot's pinned commit | 359 MB (measured) | on-prem |
| `frappe-mcp-server:a01ce12c` | `images/mcp/Dockerfile` | The MCP server, at ragbot's pinned commit | 36 MB (measured) | on-prem |
| `ragbot-embed:nomic-embed-text` | `images/ollama-model/Dockerfile` | Ollama 0.34.1 + nomic-embed-text | 7.5 GB (measured; the Ollama runtime with its GPU libraries is most of it, the model is 270 MB) | on-prem, CPU |
| `ragbot-llm:gemma4-26b` | `images/ollama-model/Dockerfile` | Ollama 0.34.1 + gemma4:26b | ~25 GB (runtime + ~17 GB weights) | ROSA, GPU |

Build one at a time with `make image-bench`, `image-agent`, `image-mcp`, `image-llm` or
`image-embed`. Without make, each Dockerfile's header has the plain `podman build` line.

## The model is packaged in the image

The Ollama server and the weights ship as **one image**. Use the same Dockerfile with a different
`MODEL`:

```bash
make image-llm LLM_MODEL=gemma4:26b
```

```bash
make image-llm LLM_MODEL=qwen3.5:9b
```

```bash
make image-embed EMBED_MODEL=nomic-embed-text
```

### Why an image, not a download at startup

| | Baked into the image (chosen) | Downloaded at start (S3 or the Ollama registry) to a PVC |
| --- | --- | --- |
| Pod start on a node that has the image | **Seconds**, plus loading into VRAM | Seconds, if the PVC is already populated |
| First start on a new node | One image pull (~25 GB, a few minutes from an in-region registry) | One download of the same size, plus PVC provisioning |
| Runtime dependencies | **The registry only** | S3 or internet egress, credentials, a PVC per replica |
| Versioning | The tag is the model. Immutable, and easy to roll back | The model lives outside the deployment's version history |
| Moving to another GPU node | Pull on that node; no volume to re-attach | An RWO volume pins the pod to one AZ |

Once the model is in VRAM, inference latency is identical either way. What the user feels is
**time to first answer after a restart**, and that is covered by:
- **No download at start.** The weights are already on the node.
- **`OLLAMA_KEEP_ALIVE=-1`.** The model is never unloaded.
- **A `postStart` hook** that loads the model before the pod reports Ready.
- **`OLLAMA_CONTEXT_LENGTH` equal to the agent's `num_ctx`.** The first request doesn't force a reload.

To keep the first pull fast:
- **Push to a registry in the same AWS region as ROSA.** ECR, or Quay with a regional mirror.
- **Use `imagePullPolicy: IfNotPresent` with immutable tags.** These are the chart defaults.
- **Keep the GPU MachinePool's minimum at 1.** Scaling to zero discards the cached image, and the next node pulls it again.
- **Give the GPU MachinePool a root volume of at least 100 GiB.**

### OpenShift details baked into `images/ollama-model`

- **The model store is world-readable.** OpenShift runs pods as a random UID in group 0. The `chmod` happens in the pull stage, so the weights aren't stored twice.
- **`OLLAMA_NOPRUNE=1`.** That UID can't write the store, and Ollama must not try to prune it.
- **`HOME=/tmp`.** Ollama writes an identity key there, and the random UID has no home directory.
- **The pull stage runs on the builder's own architecture.** Weights are architecture-independent, so building on a Mac copies them into an amd64 runtime unchanged.

## The bench image

Two layers:

1. **`make image-bench-base`** runs frappe_docker's `images/layered/Containerfile` (pinned at
   `a0c5213`) with `images/bench/apps.json`: erpnext `version-16`, drive `develop` and frappe_ai
   `audit/production-readiness`. This is exactly how ragbot builds its own image.
2. **`images/bench/Dockerfile`** adds `rag` from `app/ragbot/rag`:
   - It's installed with `bench pip install -e`, its `/ask` frontend is built with yarn, and `bench build --app rag` runs.
   - `mariadb-client.cnf` is installed system-wide as `/etc/mysql/conf.d/ragbot-client.cnf`.
   - Without that file, `mariadb-dump` writes VECTOR columns as text, and a restore silently zeroes every embedding (MDEV-35221).

rag is a subdirectory of the ragbot repo, not a repo of its own, so `bench get-app` can't fetch it.
That's why it's copied in.

## The agent and MCP images

Both Dockerfiles fetch their source inside the build, at the exact commits ragbot tests against,
so the build context is just the directory. To move to a newer commit, change `AGENT_REF` or
`MCP_REF` in the Makefile and rebuild.

The agent image includes only the Ollama provider. If you ever point it at an OpenAI-compatible
server (vLLM, for example), it also needs the `openai` extra (`uv sync --extra openai`).

## Verified

Built from these Dockerfiles (on arm64; the Dockerfiles have no arch-specific steps) and run as a
random non-root UID in group 0, the way OpenShift runs them:

| Image | Result |
| --- | --- |
| `frappe-mcp-server` | Builds. The binary is executable by any UID |
| `frappe-ai-agent` | Builds. `ai_agent.app` imports |
| `ragbot-embed` (nomic-embed-text) | Builds. Serves as a random UID; `ollama show` finds the model; `/api/embed` returns 768-dim vectors |

**Not built here:**
- `ragbot-llm` uses the same Dockerfile as `ragbot-embed`, just with a larger model.
- `ragbot-bench` takes about 20 minutes, mostly frappe_docker's base build. Its `bench pip install` step for rag is the line most likely to need adjusting on the first build.
