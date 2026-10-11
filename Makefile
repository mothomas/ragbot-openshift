.DEFAULT_GOAL := help

# ---- Where images go ---------------------------------------------------------
REGISTRY ?= quay.io/CHANGE-ME
ENGINE   ?= podman
# OpenShift nodes are amd64; set explicitly so a Mac builds the right thing
PLATFORM ?= linux/amd64

# ---- Models baked into images (must match charts/ragbot/values.yaml llm.model) ---
LLM_MODEL   ?= gemma4:26b
EMBED_MODEL ?= nomic-embed-text
tagof = $(subst :,-,$(subst /,-,$(1)))

# ---- Pins (ragbot's own, from app/ragbot/Makefile) ------------------------------
AGENT_REF         ?= 7f1ef10c755502b1d4104b9bace9c5a09cd4b5a7
MCP_REF           ?= a01ce12c1b4ad7513eb95f162292fd5d79fc44bc

BENCH      = $(REGISTRY)/ragbot-bench:16
AGENT      = $(REGISTRY)/frappe-ai-agent:$(shell echo $(AGENT_REF) | cut -c1-8)
MCP        = $(REGISTRY)/frappe-mcp-server:$(shell echo $(MCP_REF) | cut -c1-8)
LLM        = $(REGISTRY)/ragbot-llm:$(call tagof,$(LLM_MODEL))
EMBED      = $(REGISTRY)/ragbot-embed:$(call tagof,$(EMBED_MODEL))

BUILD = $(ENGINE) build --platform $(PLATFORM)

help: ## List targets
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/' | expand -t20

images: image-bench image-agent image-mcp image-llm image-embed ## Build every image

push: ## Push every image
	@for i in $(BENCH) $(AGENT) $(MCP) $(LLM) $(EMBED); do echo "push $$i"; $(ENGINE) push $$i; done

image-bench: ## Frappe v16 + erpnext + drive + frappe_ai + rag (context: repo root)
	$(BUILD) -f images/bench/Dockerfile -t $(BENCH) .

image-agent: ## frappe-ai-agent
	$(BUILD) --build-arg AGENT_REF=$(AGENT_REF) -t $(AGENT) images/agent

image-mcp: ## frappe-mcp-server
	$(BUILD) --build-arg MCP_REF=$(MCP_REF) -t $(MCP) images/mcp

image-llm: ## Ollama + LLM_MODEL (ROSA GPU)
	$(BUILD) --build-arg MODEL=$(LLM_MODEL) -t $(LLM) images/ollama-model

image-embed: ## Ollama + EMBED_MODEL (on-prem CPU)
	$(BUILD) --build-arg MODEL=$(EMBED_MODEL) -t $(EMBED) images/ollama-model

values: ## Print the image values to paste into charts/ragbot/values.yaml
	@echo "images:"
	@echo "  bench: {repository: $(REGISTRY)/ragbot-bench, tag: \"16\"}"
	@echo "  agent: {repository: $(REGISTRY)/frappe-ai-agent, tag: $(lastword $(subst :, ,$(AGENT)))}"
	@echo "  mcp:   {repository: $(REGISTRY)/frappe-mcp-server, tag: $(lastword $(subst :, ,$(MCP)))}"
	@echo "  llm:   {repository: $(REGISTRY)/ragbot-llm, tag: $(call tagof,$(LLM_MODEL))}"
	@echo "  embed: {repository: $(REGISTRY)/ragbot-embed, tag: $(call tagof,$(EMBED_MODEL))}"
	@echo "llm: {model: $(LLM_MODEL)}"
	@echo "embed: {model: $(EMBED_MODEL)}"

lint: ## helm lint + render both roles
	helm lint charts/ragbot -f charts/ragbot/values-onprem.yaml
	helm lint charts/ragbot -f charts/ragbot/values-rosa.yaml
	helm template ragbot charts/ragbot -f charts/ragbot/values-onprem.yaml >/dev/null
	helm template ragbot charts/ragbot -f charts/ragbot/values-rosa.yaml >/dev/null

template-onprem: ## Render what the on-prem cluster gets
	@helm template ragbot charts/ragbot -n ragbot -f charts/ragbot/values-onprem.yaml

template-rosa: ## Render what the ROSA cluster gets
	@helm template ragbot charts/ragbot -n ragbot -f charts/ragbot/values-rosa.yaml

.PHONY: help images push image-bench image-agent image-mcp image-llm image-embed values lint template-onprem template-rosa
