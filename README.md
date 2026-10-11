# ragbot-openshift

**ragbot** (ERPNext + Frappe Drive + a knowledge base over your Drive files, with an AI sidebar)
runs here across two OpenShift clusters, deployed by one Helm chart and one Argo CD
ApplicationSet:

- **On-prem OpenShift:** MariaDB 12, the Frappe tier, the AI agent and its tools, and embeddings. All data stays here.
- **ROSA:** GPU inference only. Ollama and the model are baked into one image.
- **Red Hat Service Interconnect (Skupper)** makes the ROSA model appear on-prem as a local Service. On-prem dials out, and the model API is never exposed.

```
ON-PREM OpenShift                                         ROSA
───────────────────────────────────────────────           ─────────────────────────────
Browser ─► MetalLB :8080/:6443 ─┐                          ollama-llm  (1× A10/T4 GPU)
Browser ─► Route https ─────────┴► Frappe (frappe-operator)    ▲  model baked in image
                                   │  erpnext·drive·frappe_ai·rag
                                   ├─► MariaDB 12.3 (vectors)  │
                                   ├─► ollama-embed (CPU)      │
                                   └─► ragbot-agent ─► ragbot-mcp ─► Frappe (as the user)
                                          └─► ollama-llm:11434 ══ Skupper (mTLS) ══╛
```

An answer only draws on files Drive already lets the asking user read: every tool call runs as
that user.

## Documentation

| Doc | Covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, request flow, what crosses the link, latency, security, failure behaviour |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Prerequisites, **pods per cluster with CPU and memory**, GPU sizing, values reference, step-by-step deploy, known gaps |
| [docs/IMAGES.md](docs/IMAGES.md) | The five images, why the model is in the image, how to build |

## Quick start

Build and push the images, then print the values to paste into `charts/ragbot/values.yaml`:

```bash
make images REGISTRY=quay.io/<you>
```

```bash
make push REGISTRY=quay.io/<you>
```

```bash
make values REGISTRY=quay.io/<you>
```

Set `siteHost`, the MetalLB `ip` and `hostnames`, the storage classes and the GPU tolerations, then
check that both roles render:

```bash
make lint
```

On the ACM hub, label the two clusters and create the ApplicationSet:

```bash
oc label managedcluster <onprem-cluster> ragbot.io/role=onprem
```

```bash
oc label managedcluster <rosa-cluster> ragbot.io/role=rosa
```

```bash
oc apply -f argocd/placements.yaml -f argocd/applicationset.yaml
```

Then link the two Skupper sites once, as described in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#5-link-the-sites-once).

## Repository layout

```
app/ragbot/            ragbot source: the rag Frappe app, its /ask UI, tests and design docs
charts/ragbot/         Helm chart. role=onprem|rosa decides what renders
  values.yaml            shared: model, images
  values-onprem.yaml     MariaDB, Frappe, agent, MCP, embeddings, MetalLB, Skupper Listener
  values-rosa.yaml       GPU Ollama, Skupper Connector + grant
argocd/                ACM Placements, AppProject, ApplicationSet (central Argo CD)
images/                Dockerfiles: bench, agent, mcp, ollama-model (LLM and embeddings)
docs/                  architecture, deployment, images
Makefile               build, push, lint, render
```

## What's deployed

| | On-prem | ROSA |
| --- | --- | --- |
| Running pods | about 14 (9 frappe-operator, 1 MariaDB, agent, MCP, embed, Skupper router) | 2 (ollama-llm, Skupper router) |
| CPU / memory requested | ≈ 3 CPU / 6 GiB | 2 CPU / 8 GiB + 1 GPU |
| Storage | 50Gi RWO (MariaDB) + 20Gi RWX (sites) | none (model in image) |
| Exposure | Route (HTTPS) and MetalLB (HTTP, 8080 or 6443) | none: Skupper only |

The full breakdown is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#what-runs-where).

## Status

The chart renders and lints for both roles. The agent, MCP and embedding images build from these
Dockerfiles and run as a random OpenShift UID (the embedding image serves 768-dim vectors). **It has not yet been deployed end to end.** Before relying on it, read the known
gaps in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#known-gaps-check-these-first), above all MariaDB
12 under frappe-operator and realtime through the Route.

## Credits and licences

| Part | Licence |
| --- | --- |
| `app/ragbot/`: ragbot, © Sarathi Thirumalai Soundararajan | AGPL-3.0-or-later ([app/ragbot/LICENSE](app/ragbot/LICENSE)) |
| ERPNext | GPL-3.0 |
| Frappe Drive | AGPL-3.0 |
| frappe-operator, frappe_ai, frappe-ai-agent, frappe-mcp-server (vyogotech) | Their own licences |
| `gemma4:26b`, `nomic-embed-text` | Apache-2.0 licence layers (`ollama show --license <model>`) |

Running ragbot as a network service carries AGPL obligations: users must be able to get the
source.
