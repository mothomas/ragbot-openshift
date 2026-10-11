# Deployment

One Helm chart (`charts/ragbot`) and one Argo CD ApplicationSet (`argocd/`) deploy both halves.
ACM decides which cluster is which, the chart's `role` value decides what renders there, and Argo
CD keeps both in sync from Git.

```
ACM hub + central Argo CD
  ├─ Placement ragbot-onprem  (label ragbot.io/role=onprem) ─► Application ragbot-onprem
  │     helm: values.yaml + values-onprem.yaml
  └─ Placement ragbot-rosa    (label ragbot.io/role=rosa)   ─► Application ragbot-rosa
        helm: values.yaml + values-rosa.yaml
```

## Prerequisites

| Where | Needs | Notes |
| --- | --- | --- |
| Hub | ACM, OpenShift GitOps (central Argo CD) | Both clusters registered with Argo CD (`argocd/gitopscluster.yaml` if not) |
| On-prem | MariaDB Operator (`k8s.mariadb.com`) | Cluster-wide install |
| On-prem | frappe-operator (`vyogo.tech`) | OperatorHub/OLM or Helm |
| On-prem | RHSI 2.x (Skupper) | The chart uses `skupper.io/v2alpha1` |
| On-prem | MetalLB with an `IPAddressPool` | Only if `frontend.loadBalancer.enabled` |
| On-prem | RWX StorageClass | The bench's sites volume (ODF CephFS) |
| On-prem | RWO StorageClass | MariaDB |
| ROSA | NFD and the NVIDIA GPU Operator | GPU nodes labelled `nvidia.com/gpu.present=true` |
| ROSA | RHSI 2.x | |
| ROSA | GPU MachinePool | A10G (`g5.xlarge`/`g5.2xlarge`) or T4 (`g4dn.xlarge`). Root volume ≥ 100 GiB (it holds the model image) |
| Both | Pull access to your registry | Five images, see [IMAGES.md](IMAGES.md) |

Neither cluster needs internet egress at runtime: the models are inside the images.

## What runs where

### On-prem: about 14 pods

| Pod | Count | Created by | CPU req / limit | Memory req / limit | Storage |
| --- | --- | --- | --- | --- | --- |
| `ragbot-nginx` | 1 | frappe-operator | 100m / 1 | 128Mi / 128Mi | sites (RWX) |
| `ragbot-gunicorn` | 1 | frappe-operator | 200m / 2 | 256Mi / 4Gi | sites |
| `ragbot-socketio` | 1 | frappe-operator | 100m / 1 | 128Mi / 2Gi | sites |
| `ragbot-scheduler` | 1 | frappe-operator | 100m / 1 | 128Mi / 2Gi | sites |
| `ragbot-worker-default` | 1 | frappe-operator | 200m / 2 | 256Mi / 4Gi | sites |
| `ragbot-worker-short` | 1 | frappe-operator | 200m / 2 | 256Mi / 4Gi | sites |
| `ragbot-worker-long` | 1 | frappe-operator | 200m / 2 | 256Mi / 4Gi | sites |
| `ragbot-redis-cache` | 1 | frappe-operator (StatefulSet) | 100m / 1 | 128Mi / 2Gi | |
| `ragbot-redis-queue` | 1 | frappe-operator (StatefulSet) | 100m / 1 | 128Mi / 2Gi | |
| `ragbot-mariadb` | 1 | MariaDB Operator | 500m / 2 | 2Gi / 4Gi | 50Gi RWO |
| `ragbot-agent` | 1 | this chart | 100m / 1 | 256Mi / 1Gi | |
| `ragbot-mcp` | 1 | this chart | 50m / 500m | 64Mi / 256Mi | |
| `ollama-embed` | 1 | this chart | 1 / 4 | 2Gi / 4Gi | (model in image) |
| `skupper-router` | 1 | RHSI, from the `Site` | RHSI defaults | RHSI defaults | |
| `ragbot-worker-index` | 0 (opt-in) | this chart | 200m / 2 | 512Mi / 2Gi | sites |
| **Total (running)** | **14** | | **≈ 3 CPU requested** | **≈ 6 GiB requested** | 50Gi RWO + 20Gi RWX |

The frappe-operator values are its built-in defaults (`controllers/frappebench_helpers.go`).
Override them with `FrappeBench.spec.componentResources` if needed.

Short-lived Jobs also run and then complete: the bench init (`ragbot-init`), the site init, the
SiteConfig apply, and this chart's `ragbot-post-setup` (an Argo CD PostSync hook).

Leave about **6 CPU and 12 GiB** of headroom on-prem for limits and Jobs. Indexing a large batch of
PDFs is the busiest time: `worker-long` (or `worker-index`) parses PDFs while `ollama-embed`
computes vectors.

### ROSA: 2 pods

| Pod | Count | Created by | CPU req / limit | Memory req / limit | GPU |
| --- | --- | --- | --- | --- | --- |
| `ollama-llm` | 1 | this chart | 2 / 4 | 8Gi / 14Gi | 1 × `nvidia.com/gpu` |
| `skupper-router` | 1 | RHSI, from the `Site` | RHSI defaults | RHSI defaults | |

`ollama-llm` uses `strategy: Recreate`. With one GPU, the old pod must release it before the new
one can start, so a model change means a brief outage, not a rolling update.

### Scaling notes

| Component | Scale how | Limit |
| --- | --- | --- |
| gunicorn, workers | `onprem.bench.replicas.*` (or the operator's KEDA/HPA support) | RWX sites volume |
| agent | `onprem.agent.replicas` | Rate limit is per process unless `AI_AGENT_RATE_LIMIT_STORAGE_URI` points at Redis (`agent.extraEnv`) |
| mcp | `onprem.mcp.replicas` | Stateless |
| ollama-embed | `onprem.embed.replicas` | Stateless, CPU-bound |
| ollama-llm | One GPU per pod. More concurrency: `rosa.llm.numParallel` (VRAM-bound) or more GPU nodes and replicas | Each parallel slot adds a KV cache of `numCtx` |

## GPU and model sizing

| GPU | VRAM | `llm.model` | `llm.numCtx` | `rosa.llm.numParallel` |
| --- | --- | --- | --- | --- |
| A10 / A10G | 24 GB | `gemma4:26b` | 16384 | 1–2 |
| T4 | 16 GB | `qwen3.5:9b` (frappe-ai-agent's own default) | 16384 | 1 |

`gemma4:26b` does **not** fit a T4. If you change the model, rebuild the LLM image
(`make image-llm LLM_MODEL=...`), then update `images.llm.tag` and `llm.model` together. A startup
probe (`ollama show <llm.model>`) fails the pod if the two drift apart.

## Values reference

| Key | Default | Meaning |
| --- | --- | --- |
| `llm.model`, `llm.numCtx` | `gemma4:26b`, `16384` | The chat model, shared by ROSA (serves it) and the on-prem agent (requests it) |
| `embed.model` | `nomic-embed-text` | Must produce 768-dim vectors |
| `images.{bench,agent,mcp,llm,embed}` | `quay.io/CHANGE-ME/...` | `make values` prints these |
| `onprem.siteHost` | `ragbot.apps.onprem.example.com` | The site's FQDN; the operator creates the site under this name |
| `onprem.frontend.route.enabled` | `true` | HTTPS through the OpenShift router |
| `onprem.frontend.loadBalancer.*` | enabled, port `8080` | MetalLB Service: `port` (8080 or 6443), `ip`, `addressPool`, `hostnames`, `realtimeAuthPort` |
| `onprem.bench.storageClassName` | `ocs-storagecluster-cephfs` | Must be RWX |
| `onprem.bench.replicas.*` | 1 each | Static replicas per bench component |
| `onprem.bench.indexWorker.enabled` | `false` | Separate `index` queue and worker |
| `onprem.mariadb.*` | 12.3.3, 50Gi | Image, storage, resources |
| `onprem.agent.requestTimeoutS` | `75` | One model call's bound. Kept under the agent's 90 s turn |
| `onprem.skupper.accessToken.*` | empty | Optional declarative link redemption. Inject; never commit |
| `rosa.llm.*` | 1 GPU | `gpus`, `numParallel`, `nodeSelector`, `tolerations`, `resources` |
| `rosa.skupper.accessGrant.*` | 1 redemption, 1h | The one-time link grant |

Per-cluster overrides go in `charts/ragbot/values-cluster-<argo cluster name>.yaml`. The
ApplicationSet picks them up when present.

## Step by step

### 1. Images

```bash
make images REGISTRY=quay.io/<you>
```

```bash
make push REGISTRY=quay.io/<you>
```

```bash
make values REGISTRY=quay.io/<you>
```

Paste the output of `make values` into `charts/ragbot/values.yaml`. Details: [IMAGES.md](IMAGES.md).

### 2. Values

Set `onprem.siteHost`, `onprem.frontend.loadBalancer.{ip,hostnames}`, the storage classes, and the
GPU tolerations. Run `make lint`, then commit and push.

### 3. Hub

```bash
oc label managedcluster <onprem-cluster> ragbot.io/role=onprem
```

```bash
oc label managedcluster <rosa-cluster> ragbot.io/role=rosa
```

```bash
oc apply -f argocd/placements.yaml -f argocd/applicationset.yaml
```

Set the cluster set name in `argocd/placements.yaml` first.

### 4. First sync, and what to expect

| Time | On-prem | ROSA |
| --- | --- | --- |
| 0–5 min | Skupper Site, MariaDB, agent, MCP and embed come up | The GPU node pulls the LLM image (about 25 GB for gemma4:26b; a few minutes, once per node) |
| 5–40 min | frappe-operator runs the bench init, then the site init (installs erpnext, drive, frappe_ai, rag) | `ollama-llm` loads the model into VRAM (postStart), then reports Ready |
| after the site | `ragbot-post-setup` adds the host aliases and Drive flat storage | |

### 5. Link the sites (once)

Read the grant on ROSA:

```bash
oc -n ragbot get accessgrant ragbot-onprem-link -o jsonpath='{.status.url}{"\n"}{.status.code}{"\n"}{.status.ca}{"\n"}'
```

Create the token on-prem from those three values. Apply it directly; don't commit it:

```bash
oc -n ragbot apply -f - <<EOF
apiVersion: skupper.io/v2alpha1
kind: AccessToken
metadata:
  name: ragbot-rosa-link
spec:
  url: <status.url>
  code: <status.code>
  ca: |
    <status.ca>
EOF
```

Alternatively, use the Skupper v2 CLI: run `skupper token issue` on ROSA, then
`skupper token redeem` on-prem.

### 6. Verify

The link and listener are up on-prem:

```bash
oc -n ragbot get site,link,listener
```

The model answers across the link:

```bash
oc -n ragbot exec deploy/ragbot-agent -- python -c "import httpx;print(httpx.get('http://ollama-llm:11434/api/tags').json())"
```

The site is ready:

```bash
oc -n ragbot get frappesite ragbot -o jsonpath='{.status.phase} {.status.siteURL}{"\n"}'
```

The post-setup Job finished:

```bash
oc -n ragbot logs job/ragbot-post-setup
```

The Administrator password:

```bash
oc -n ragbot get secret ragbot-admin -o jsonpath='{.data.password}' | base64 -d
```

Then sign in, complete the ERPNext setup wizard, upload a PDF to Drive, and ask about it in the
sidebar or at `/ask`.

## Exposing the frontend

```yaml
onprem:
  frontend:
    route:
      enabled: true                 # https://<siteHost> via the OpenShift router
    loadBalancer:
      enabled: true
      port: 8080                    # or 6443
      ip: 10.0.0.241                # pin from your MetalLB pool
      addressPool: onprem-pool
      hostnames: [ragbot.onprem.example.com]
      realtimeAuthPort: 80
```

- **Frappe picks the site from the `Host` header.** Every hostname, plus `ip`, gets an alias to the site and a CORS origin on the agent. Point DNS for each name at `ip`.
- **Plain HTTP, including on 6443.** Don't use the cluster's API VIP as `ip`. Use the Route for HTTPS.
- **Port 80 is also exposed (`realtimeAuthPort`).** Frappe's realtime service authorises a socket by fetching its Origin back without the port. The socketio pod makes that fetch, so the hostnames must resolve in-cluster too. Set it to `0` to drop the port.

## Known gaps: check these first

1. **MariaDB 12.3.3 under frappe-operator has not been tested** (its examples use 10.11/11.4). rag needs 11.7+. Watch the first site init.
2. **Realtime through the Route.** If the sidebar's live updates fail with `Unauthorized`, see `realtimeAuthPort` above and ragbot's `nginx-realtime-auth.conf`.
3. **The index queue** is off by default (rag falls back to `long`). Turn on `indexWorker` and the queue declaration together, or neither.
4. **Backups.** The bench image installs `hex-blob` system-wide, so `bench backup` keeps vectors. After any restore, run `rag.ingest.health`, then `rag.ingest.reindex_all` if needed.
5. **`FrappeSite.spec.apps` is immutable.** Add apps later with `SiteApp`.
6. **Argo CD health for operator CRs.** Argo has no health checks for `MariaDB`/`FrappeBench`/`FrappeSite`; the post-setup Job does the real wait.
7. **The ERPNext setup wizard is manual.** Complete it on first sign-in.
