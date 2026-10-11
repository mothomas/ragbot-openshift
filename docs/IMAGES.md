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
| `ragbot-bench:16` | `images/bench/Dockerfile` | Frappe v16 + erpnext + drive + frappe_ai + rag, on frappe-operator's v16 image | ~2 GB compressed per arch (measured) | on-prem (every bench pod) |
| `frappe-ai-agent:7f1ef10c` | `images/agent/Dockerfile` | The agent, at ragbot's pinned commit | 359 MB (measured) | on-prem |
| `frappe-mcp-server:a01ce12c` | `images/mcp/Dockerfile` | The MCP server, at ragbot's pinned commit | 36 MB (measured) | on-prem |
| `ragbot-embed:nomic-embed-text` | `images/ollama-model/Dockerfile` | Ollama 0.34.1 + nomic-embed-text | 7.5 GB (measured; the Ollama runtime with its GPU libraries is most of it, the model is 270 MB) | on-prem, CPU |
| `ragbot-llm:gemma4-26b` | `images/ollama-model/Dockerfile` | Ollama 0.34.1 + gemma4:26b | ~25 GB (runtime + ~17 GB weights) | ROSA, GPU |

Build one at a time with `make image-bench`, `image-agent`, `image-mcp`, `image-llm` or
`image-embed`. Without make, each Dockerfile's header has the plain `podman build` line.

## Multi-arch (amd64 + arm64)

Every base image used here is published for both architectures:
- the frappe-operator v16 image
- `python:3.12-slim`
- `golang` and `alpine`
- `ollama/ollama`

So each Dockerfile builds for both architectures with Docker buildx.

Keep the result in local Docker. This needs Docker's containerd image store, which recent Docker
Desktop uses by default:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f images/bench/Dockerfile -t ragbot-bench:16 --load .
```

Or push the multi-arch manifest straight to a registry:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f images/bench/Dockerfile -t quay.io/<you>/ragbot-bench:16 --push .
```

Through make:

```bash
make images ENGINE=docker PLATFORM=linux/amd64,linux/arm64 REGISTRY=quay.io/<you>
```

The architecture that doesn't match the build machine runs under QEMU emulation, which is slow.
For the bench image, most of that time goes on compiling drive's `pycrdt` (Rust). OpenShift
nodes are amd64, so a single `linux/amd64` build is enough to deploy. arm64 is for local
testing on Apple Silicon.

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

`images/bench/Dockerfile` is one self-contained build. Run it from the **repository root**, because
it copies from `app/ragbot`:

```bash
docker build -f images/bench/Dockerfile -t quay.io/<you>/ragbot-bench:16 .
```

It starts from frappe-operator's own v16 image (`ghcr.io/vyogotech/erpnext-for-operator:version-16`,
Frappe 16.31 + erpnext, Python 3.14), so the layout is what the operator expects:

- **Two stages.** drive depends on `pycrdt`, which has no Python 3.14 wheel and compiles from source. Rust is fetched by maturin, and the C toolchain is installed in the build stage only. The final image copies over just the new apps, the env and the assets, so no compiler ships.
- **drive** (`develop`) and **frappe_ai** (`audit/production-readiness`) come from their repos via `bench get-app`. The branches are build args.
- **rag** is copied from `app/ragbot/rag`. It's a subdirectory of the ragbot repo, not a repo of its own, so `get-app` can't fetch it. It's installed into the bench env, and its `/ask` frontend is built with yarn.
- **`/home/frappe/assets_cache`** is refreshed with the new apps' bundles. The operator's bench and site init scripts copy that folder onto the shared sites volume; without it, the new apps would serve no CSS or JS.
- **`mariadb-client.cnf`** is installed system-wide as `/etc/mysql/conf.d/ragbot-client.cnf`. Without it, `mariadb-dump` writes VECTOR columns as text, and a restore silently zeroes every embedding (MDEV-35221).
- **Group 0 owns everything**, for OpenShift's random UID.

To build on a different base, pass `--build-arg BASE_IMAGE=...`. Any base must keep the
operator's layout: the bench at `/home/frappe/frappe-bench` and assets in
`/home/frappe/assets_cache`.

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
| `ragbot-bench` | Builds **multi-arch (amd64 + arm64)** with `docker buildx --load`. On both: frappe, erpnext, drive, frappe_ai and rag import as a random UID; `assets_cache` links resolve for all five apps; `assets.json` keeps the frappe and erpnext bundles (`desk.bundle.js`) plus drive and frappe_ai; rag's `/ask` export is in place; no compiler in the final image |

**Not built here:** `ragbot-llm`. It uses the same Dockerfile as `ragbot-embed`, just with a larger model.
