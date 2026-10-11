# Deployment

Plain YAML, one folder per cluster, and one Argo CD ApplicationSet:

```
deploy/onprem/   ─► ACM Placement ragbot-onprem ─► Application ragbot-onprem ─► on-prem cluster
deploy/rosa/     ─► ACM Placement ragbot-rosa   ─► Application ragbot-rosa   ─► ROSA cluster
```

There's no Helm and no Kustomize. Argo CD applies every file in the folder as it is. To change
something, edit the YAML and push.

The two operators those files depend on are installed by `argocd/operators.yaml`, on the on-prem
cluster only. It installs frappe-operator (which provides `FrappeBench`, `FrappeSite` and
`SiteConfig`) and the MariaDB Operator (which provides `MariaDB`). It uses frappe-operator's own
Helm chart (v5.4.0), because the operator isn't in OpenShift's built-in OperatorHub catalogs and
the chart is its supported install. The chart includes the MariaDB Operator (0.34.0), and KEDA is
switched off. Until those resource types exist, `ragbot-onprem` keeps retrying.

## Prerequisites

| Where | Needs | Notes |
| --- | --- | --- |
| Hub | ACM and OpenShift GitOps (central Argo CD) | Both clusters registered with Argo CD (`argocd/gitopscluster.yaml` if not) |
| On-prem | frappe-operator and the MariaDB Operator | **Installed by this repo** (`argocd/operators.yaml`). Skip that file if they're already installed |
| On-prem | Red Hat Service Interconnect 2.x (Skupper) | The manifests use `skupper.io/v2alpha1` |
| On-prem | MetalLB with an `IPAddressPool` | For `40-frontend-lb.yaml` |
| On-prem | An RWX StorageClass (ODF CephFS) and an RWO one | The bench's sites volume; MariaDB |
| ROSA | NFD and the NVIDIA GPU Operator | GPU nodes labelled `nvidia.com/gpu.present=true` |
| ROSA | Red Hat Service Interconnect 2.x | |
| ROSA | GPU MachinePool | A10G (`g5.xlarge`/`2xlarge`) or T4 (`g4dn.xlarge`). Root volume ≥ 100 GiB, because the model image lands there. Keep the minimum at 1 node |
| Both | Pull access to your registry | See [IMAGES.md](IMAGES.md) |

Neither cluster needs internet egress at runtime: the models are inside the images.

## What goes where

### On-prem: `deploy/onprem/`, about 14 pods

| File | Creates | Pods |
| --- | --- | --- |
| `10-mariadb.yaml` | `MariaDB` 12.3.3 | 1 (MariaDB Operator) |
| `20-frappe.yaml` | `FrappeBench`, `FrappeSite`, `SiteConfig` | 9 (frappe-operator): nginx, gunicorn, socketio, scheduler, 3 workers, 2 Redis |
| `30-mcp.yaml` | MCP server | 1 |
| `31-agent.yaml` | AI agent | 1 |
| `32-embed.yaml` | Ollama + nomic-embed-text (CPU) | 1 |
| `40-frontend-lb.yaml` | MetalLB Service, port 8080 (or 6443) | none |
| `50-skupper.yaml` | Skupper `Site` + `Listener` (`ollama-llm:11434`) | 1 (skupper-router) |
| `60-post-setup-job.yaml` | Argo CD PostSync Job: host aliases, Drive setting | Job, completes |

### ROSA: `deploy/rosa/`, 2 pods

| File | Creates | Pods |
| --- | --- | --- |
| `10-llm.yaml` | Ollama + gemma4:26b on 1 GPU | 1 |
| `20-skupper.yaml` | Skupper `Site`, `Connector`, one-time `AccessGrant` | 1 (skupper-router) |

### Resources

| Pod | CPU req / limit | Memory req / limit | Storage |
| --- | --- | --- | --- |
| nginx | 100m / 1 | 128Mi / 128Mi | sites (RWX) |
| gunicorn | 200m / 2 | 256Mi / 4Gi | sites |
| socketio | 100m / 1 | 128Mi / 2Gi | sites |
| scheduler | 100m / 1 | 128Mi / 2Gi | sites |
| worker-default, -short, -long (each) | 200m / 2 | 256Mi / 4Gi | sites |
| redis-cache, redis-queue (each) | 100m / 1 | 128Mi / 2Gi | |
| MariaDB | 500m / 2 | 2Gi / 4Gi | 50Gi RWO |
| agent | 100m / 1 | 256Mi / 1Gi | |
| mcp | 50m / 500m | 64Mi / 256Mi | |
| ollama-embed | 1 / 4 | 2Gi / 4Gi | |
| **On-prem total requested** | **≈ 3 CPU** | **≈ 6 GiB** | 50Gi RWO + 20Gi RWX |
| ollama-llm (ROSA) | 2 / 4 | 8Gi / 14Gi | + 1 × `nvidia.com/gpu` |

The bench pods use frappe-operator's built-in defaults. Leave about 6 CPU and 12 GiB of headroom
on-prem for limits and the setup Jobs.

## What to edit

Every value to change is marked `CHANGE-ME`:

```bash
grep -rn CHANGE-ME deploy/ argocd/
```

| What | Where |
| --- | --- |
| Registry for the five images | the `image:` lines in `deploy/` |
| Site name (FQDN under your `*.apps` wildcard) | `20-frappe.yaml` (`siteName`, `routeConfig.host`), `31-agent.yaml` (CORS), `60-post-setup-job.yaml` (`SITE`) |
| MetalLB IP and hostname | `40-frontend-lb.yaml`, `31-agent.yaml` (CORS), `60-post-setup-job.yaml` (`ALIASES`) |
| RWX StorageClass | `20-frappe.yaml` |
| GPU taint | `deploy/rosa/10-llm.yaml` (`tolerations`) |
| ACM cluster set | `argocd/placements.yaml` |

### Changing the model

| GPU | VRAM | Model | Context |
| --- | --- | --- | --- |
| A10 / A10G | 24 GB | `gemma4:26b` | 16384 |
| T4 | 16 GB | `qwen3.5:9b` | 16384 |

To switch:
1. Build the image with the new model: `make image-llm LLM_MODEL=qwen3.5:9b`.
2. Update `deploy/rosa/10-llm.yaml`: the `image:` tag, plus the model name in the `ollama show` and `ollama run` lines.
3. Update `AI_AGENT_LLM_MODEL` in `deploy/onprem/31-agent.yaml`.

A startup probe fails the ROSA pod if the image and the model name disagree. Keep
`OLLAMA_CONTEXT_LENGTH` (ROSA) equal to `AI_AGENT_LLM_NUM_CTX` (on-prem); otherwise the first
question reloads the model.

### Changing the frontend port

In `40-frontend-lb.yaml`, set `port: 6443` instead of `8080`, and update the port in the CORS list in
`31-agent.yaml`.

## Deploy

### 1. Images

Build and push all five images, then put your registry into the `image:` lines:

```bash
make images REGISTRY=quay.io/<you>
```

```bash
make push REGISTRY=quay.io/<you>
```

### 2. Edit and push

Fix every `CHANGE-ME`, then commit and push to this repo.

### 3. On the ACM hub

Label the two clusters, then create the placements, the operators and the application:

```bash
oc label managedcluster <onprem-cluster> ragbot.io/role=onprem
```

```bash
oc label managedcluster <rosa-cluster> ragbot.io/role=rosa
```

```bash
oc apply -f argocd/placements.yaml -f argocd/operators.yaml -f argocd/applicationset.yaml
```

Argo CD creates three Applications: `ragbot-operators` (on-prem, namespace
`frappe-operator-system`), `ragbot-onprem` and `ragbot-rosa`.

### 4. What to expect on the first sync

| Time | On-prem | ROSA |
| --- | --- | --- |
| 0–5 min | The operators install; then Skupper, MariaDB, agent, MCP and embed start | The GPU node pulls the LLM image (~25 GB, once per node) |
| 5–40 min | frappe-operator initialises the bench, then creates the site with all four apps | The model loads into VRAM, then the pod is Ready |
| after the site | `ragbot-post-setup` adds the host aliases and the Drive setting | |

### 5. Link the sites (once)

The link token is a credential, so it isn't stored in Git.

On ROSA, read the grant:

```bash
oc -n ragbot get accessgrant ragbot-onprem-link -o jsonpath='{.status.url}{"\n"}{.status.code}{"\n"}{.status.ca}{"\n"}'
```

On-prem, create the token from those three values:

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

Alternatively, use the Skupper CLI: `skupper token issue` on ROSA, then `skupper token redeem`
on-prem. The grant allows one redemption and expires after an hour. To link again, delete the grant
on ROSA and Argo CD recreates it.

### 6. Check

On-prem, the link should be up:

```bash
oc -n ragbot get site,link,listener
```

The model should answer across the link:

```bash
oc -n ragbot exec deploy/ragbot-agent -- python -c "import httpx;print(httpx.get('http://ollama-llm:11434/api/tags').json())"
```

The site should be ready:

```bash
oc -n ragbot get frappesite ragbot -o jsonpath='{.status.phase} {.status.siteURL}{"\n"}'
```

The setup Job should have finished:

```bash
oc -n ragbot logs job/ragbot-post-setup
```

The Administrator password:

```bash
oc -n ragbot get secret ragbot-admin -o jsonpath='{.data.password}' | base64 -d
```

Then:
1. Sign in at `https://<site>` or `http://<metallb-name>:8080`, and complete the ERPNext setup wizard.
2. Upload a PDF to Drive.
3. Ask about it in the AI sidebar or at `/ask`.

## Notes and known gaps

- **Host header.** Frappe picks the site from the `Host` header. Any name or IP users type must be in `ALIASES` (in `60-post-setup-job.yaml`), and DNS for the MetalLB hostname must point at its IP.
- **Port 80 on the LB** is for Frappe's realtime authorisation, which fetches the page's origin back without its port. The socketio pod makes that fetch, so the MetalLB hostname must resolve inside the cluster too.
- **The LB is plain HTTP**, including on 6443. Don't use the cluster's API VIP. Use the Route for HTTPS.
- **MariaDB 12.3.3 under mariadb-operator 0.34.0** hasn't been tried. If the MariaDB resource doesn't come up, check the mariadb-operator logs in `frappe-operator-system`.
- **frappe-operator itself hasn't been exercised end to end.** The bench image was tested on MariaDB 12.3.3 with plain `bench`: site install, indexing, permission-aware search, and backup/restore. It hasn't run through the operator's own init Jobs on OpenShift.
- **`FrappeSite.apps` can't be changed** after creation. Add apps later with a `SiteApp`.
- **Argo CD has no health checks** for `MariaDB`, `FrappeBench` and `FrappeSite`, so it marks them Healthy as soon as they're applied. The post-setup Job does the real wait.
- **The ERPNext setup wizard** is manual, on first sign-in.
- **The `default` AppProject** is used. If your central Argo CD restricts it, set `project:` in `argocd/applicationset.yaml` to one that allows the `ragbot` namespace on both clusters.
