# ragbot-openshift

**ragbot** (ERPNext + Frappe Drive + a knowledge base over your Drive files, with an AI sidebar)
runs here across two OpenShift clusters, as plain YAML deployed by one Argo CD ApplicationSet:

- **On-prem OpenShift:** MariaDB 12, Frappe (via frappe-operator), the AI agent and its tools, embeddings, and the MetalLB frontend. All data stays here.
- **ROSA:** the GPU model (Ollama and the model in one image), plus the Skupper side that exposes it.
- **Red Hat Service Interconnect (Skupper):** the model on ROSA appears on-prem as `http://ollama-llm:11434`. On-prem dials out, and the model API is never exposed.

```
ON-PREM  (deploy/onprem/)                                 ROSA  (deploy/rosa/)
──────────────────────────────────────────────            ──────────────────────────
Browser ─► MetalLB :8080 ─┐                                ollama-llm  1× A10/T4 GPU
Browser ─► Route https ───┴► Frappe (frappe-operator)          ▲  model baked in image
                             ├─► MariaDB 12.3                   │
                             ├─► ollama-embed (CPU)             │
                             └─► agent ─► mcp ─► Frappe (as the user)
                                   └─► ollama-llm:11434 ══ Skupper (mTLS) ══╛
```

Every tool call runs as the asking user, so an answer only draws on files Drive lets that user
read.

## Layout

```
deploy/onprem/    plain YAML for the on-prem cluster
  10-mariadb.yaml         MariaDB 12.3.3
  20-frappe.yaml          FrappeBench + FrappeSite + SiteConfig
  30-mcp.yaml             MCP server (the agent's tools)
  31-agent.yaml           AI agent
  32-embed.yaml           Ollama + nomic-embed-text, CPU
  40-frontend-lb.yaml     MetalLB Service, port 8080 (or 6443)
  50-skupper.yaml         Skupper Site + Listener
  60-post-setup-job.yaml  one-off setup after each sync
deploy/rosa/      plain YAML for ROSA
  10-llm.yaml             Ollama + gemma4:26b on 1 GPU
  20-skupper.yaml         Skupper Site + Connector + one-time AccessGrant
argocd/           ACM Placements + the ApplicationSet
images/           Dockerfiles: bench, agent, mcp, ollama-model
app/ragbot/       ragbot source (the rag Frappe app and its /ask UI)
docs/             architecture, deployment, images
```

## Deploy in four steps

**1. Build and push the images.** See [docs/IMAGES.md](docs/IMAGES.md) for what each one contains.

```bash
make images REGISTRY=quay.io/<you>
```

```bash
make push REGISTRY=quay.io/<you>
```

**2. Fix every `CHANGE-ME`, then commit and push.** These are the registry, site name, MetalLB IP
and hostname, storage class, GPU taint and ACM cluster set:

```bash
grep -rn CHANGE-ME deploy/ argocd/
```

**3. On the ACM hub,** label the clusters and create the ApplicationSet:

```bash
oc label managedcluster <onprem-cluster> ragbot.io/role=onprem
```

```bash
oc label managedcluster <rosa-cluster> ragbot.io/role=rosa
```

```bash
oc apply -f argocd/placements.yaml -f argocd/applicationset.yaml
```

**4. Link the two Skupper sites, once.** See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#5-link-the-sites-once).

## Documentation

| Doc | Covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, request flow, what crosses the link, latency, security, failure behaviour |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Prerequisites, pods and resources per cluster, what to edit, step by step, known gaps |
| [docs/IMAGES.md](docs/IMAGES.md) | The five images, why the model is in the image, multi-arch builds |

## Status

- **Manifests:** all files in `deploy/` and `argocd/` are valid YAML.
- **Bench image:** builds for amd64 and arm64. Tested on MariaDB 12.3.3, where all four apps install, a document indexes, search respects Drive permissions, and backup and restore keep the vectors.
- **Other images:** the agent, MCP and embedding images build and run as a random OpenShift UID.
- **Not yet deployed end to end** on the two clusters. Read the known gaps in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#notes-and-known-gaps) first.

## Credits and licences

| Part | Licence |
| --- | --- |
| `app/ragbot/`: ragbot, © Sarathi Thirumalai Soundararajan | AGPL-3.0-or-later ([app/ragbot/LICENSE](app/ragbot/LICENSE)) |
| ERPNext | GPL-3.0 |
| Frappe Drive | AGPL-3.0 |
| frappe-operator, frappe_ai, frappe-ai-agent, frappe-mcp-server (vyogotech) | Their own licences |
| `gemma4:26b`, `nomic-embed-text` | Apache-2.0 licence layers |

Running ragbot as a network service carries AGPL obligations.
