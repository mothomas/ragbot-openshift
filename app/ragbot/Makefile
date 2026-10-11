.DEFAULT_GOAL := help

env-val = $(shell sed -n 's/^$(1)=//p' .env 2>/dev/null)

# the newest release tag BOTH frappe/build and frappe/base publish: build has v16.35.0, base stops here, and
# a floating version-16 would let the two base images move under a build that names nothing
FRAPPE_BRANCH     ?= v16.34.0
FRAPPE_DOCKER     ?= .build/frappe_docker
FRAPPE_DOCKER_REF ?= a0c5213
IMAGE             ?= $(or $(call env-val,CUSTOM_IMAGE),frappe-demo)
TAG               ?= $(or $(call env-val,CUSTOM_TAG),16)
BUILD_FLAGS       ?=

# docker clones the two repositories itself; a fragment ref must be the full 40-character SHA
AGENT_GIT    ?= https://github.com/vyogotech/frappe-ai-agent.git
AGENT_REF    ?= 7f1ef10c755502b1d4104b9bace9c5a09cd4b5a7
MCP_GIT      ?= https://github.com/vyogotech/frappe-mcp-server.git
MCP_REF      ?= a01ce12c1b4ad7513eb95f162292fd5d79fc44bc

COMPOSE_PROJECT  ?= frappe-demo
COMPOSE_EXTRA    ?=
AGENT_IMAGE      ?= frappe-ai-agent:local
MCP_IMAGE        ?= frappe-mcp-server:local
HTTP_PORT        ?= $(or $(call env-val,HTTP_PUBLISH_PORT),8080)
SITE             ?= $(or $(call env-val,SITE_NAME),demo.localhost)
ADMIN_PASSWORD   ?= $(or $(call env-val,ADMIN_PASSWORD),$(error ADMIN_PASSWORD is not in .env; make .env writes one))
DB_ROOT_PASSWORD ?= $(or $(call env-val,DB_PASSWORD),$(error DB_PASSWORD is not in .env; make .env writes one))
AI_MODEL         ?= $(or $(call env-val,AI_MODEL),gemma4:26b)
EMBED_MODEL      ?= $(or $(call env-val,EMBED_MODEL),nomic-embed-text)
AGENT_URL        ?= http://agent:8484

# Where Ollama runs: native (the host's own Ollama, which has a Mac's GPU) or container; README.md compares them.
OLLAMA ?= $(or $(call env-val,OLLAMA),native)
$(if $(filter native container,$(OLLAMA)),,$(error OLLAMA must be native or container, not "$(OLLAMA)"))
export COMPOSE_PROFILES := $(if $(filter container,$(OLLAMA)),ollama)
export OLLAMA_URL := $(if $(filter container,$(OLLAMA)),http://ollama:11434,http://host.docker.internal:11434)

FY               := $(shell date +%Y-%m | awk -F- '{y = $$2<7 ? $$1-1 : $$1; print y"-07-01 "y+1"-06-30"}')
SETUP_DEMO       ?= 1
# when `make check` started, read from the site's own clock; one marker per project and site
ERRORS_SINCE     = /tmp/ragbot-errors-since-$(COMPOSE_PROJECT)-$(SITE)

COMPOSE = docker compose --project-name $(COMPOSE_PROJECT) --project-directory . --env-file .env \
  -f $(FRAPPE_DOCKER)/compose.yaml \
  -f $(FRAPPE_DOCKER)/overrides/compose.mariadb.yaml \
  -f $(FRAPPE_DOCKER)/overrides/compose.redis.yaml \
  -f compose.demo.yaml $(if $(COMPOSE_EXTRA),-f $(COMPOSE_EXTRA))

# A clone rule only fires when its directory is missing, so the ref is checked out here
# instead: otherwise a stale tree builds silently and the pin above means nothing.
define at-ref
@git -C $(1) cat-file -e $(2)^{commit} 2>/dev/null \
  || git -C $(1) fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*'  # a pin may live on another branch
@git -C $(1) diff --quiet && git -C $(1) diff --cached --quiet \
  || { echo '$(1) has uncommitted changes; commit or stash them first' >&2; exit 1; }
@git -C $(1) checkout --quiet --detach $(2)
endef

# A suite needs a tree where an image build needs none, so one commit is fetched and checked out
# again every time. --git-dir=.git on every call: without it git walks up to this repository and
# checks the other project out over this working tree.
define at-pin
@mkdir -p $(1)
@[ -d $(1)/.git ] || git -C $(1) init --quiet
@git -C $(1) --git-dir=.git cat-file -e $(3)^{commit} 2>/dev/null \
  || git -C $(1) --git-dir=.git fetch --quiet --depth 1 $(2) $(3)
@git -C $(1) --git-dir=.git checkout --quiet --force --detach $(3)
endef

setup: ## Build everything and bring the whole demo up from scratch
	$(MAKE) image agent-image mcp-image
	$(MAKE) up site

help: ## List targets
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/' | expand -t22

$(FRAPPE_DOCKER):
	git clone --quiet https://github.com/frappe/frappe_docker.git $@
	git -C $@ checkout --quiet $(FRAPPE_DOCKER_REF)

.env:
	sed -e "s/^DB_PASSWORD=.*/DB_PASSWORD=$$(openssl rand -hex 16)/" \
	  -e "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$$(openssl rand -hex 16)/" .env.example > $@

image: $(FRAPPE_DOCKER) ## Build the image with erpnext, drive and frappe_ai
	$(call at-ref,$(FRAPPE_DOCKER),$(FRAPPE_DOCKER_REF))
	docker build $(BUILD_FLAGS) \
	  --build-arg=FRAPPE_PATH=https://github.com/frappe/frappe \
	  --build-arg=FRAPPE_BRANCH=$(FRAPPE_BRANCH) \
	  --build-arg=CACHE_BUST=$$(cksum apps.json | cut -d' ' -f1) \
	  --secret=id=apps_json,src=apps.json \
	  --tag=$(IMAGE):$(TAG) \
	  --file=$(FRAPPE_DOCKER)/images/layered/Containerfile \
	  $(FRAPPE_DOCKER)

agent-image: ## Build the AI agent image
	docker build $(BUILD_FLAGS) --tag=$(AGENT_IMAGE) $(AGENT_GIT)#$(AGENT_REF)

# MCP_REF still predates the multi-stage Dockerfile the MCP repository now has of its own, so the
# harness feeds it one (ADR-021). Delete mcp/Dockerfile and `--file=-` once MCP_REF passes it.
mcp-image: ## Build the MCP server image
	docker build $(BUILD_FLAGS) --tag=$(MCP_IMAGE) --file=- $(MCP_GIT)#$(MCP_REF) < mcp/Dockerfile

sbom: ## Write a CycloneDX SBOM for each image the demo runs, into sbom/
	@command -v syft >/dev/null || { echo 'sbom: syft is not installed (https://github.com/anchore/syft)' >&2; exit 1; }
	@mkdir -p sbom
	@for i in $(IMAGE):$(TAG) $(AGENT_IMAGE) $(MCP_IMAGE); do \
	  syft scan --quiet --output "cyclonedx-json=sbom/$$(echo $$i | tr '/:' '--').cdx.json" "docker:$$i"; \
	 done

model: ## Check the configured models are present on the host
	@for m in $(AI_MODEL) $(EMBED_MODEL); do \
	  case $$m in *:*) ;; *) m="$$m:latest";; esac; \
	  find "$(HOME)/.ollama/models/manifests" -type f -path "*/$$(echo $$m | tr : /)" 2>/dev/null \
	    | grep -q . || { \
	    echo "$$m is not on this host." >&2; \
	    echo "Ollama reads models from ~/.ollama/models on this host." >&2; \
	    echo "Run: ollama pull $$m" >&2; exit 1; }; \
	done

ollama: ## Check the host's Ollama answers when OLLAMA=native (the default)
ifeq ($(OLLAMA),native)
	@curl -sf -m 2 http://localhost:11434/api/version >/dev/null || { \
	  echo "Ollama is not running on this host: open the Ollama app or run ollama serve." >&2; \
	  echo "Or run it in a container: make up OLLAMA=container" >&2; exit 1; }
endif

up: $(FRAPPE_DOCKER) .env model ollama ## Start the stack (OLLAMA=container runs Ollama in Docker)
	$(COMPOSE) up -d
	@# nginx keeps the address backend had when it started; a recreated backend gets a new one
	@$(COMPOSE) restart frontend >/dev/null
ifeq ($(OLLAMA),native)
	@# a container left from OLLAMA=container would hold its model in memory for nothing
	@COMPOSE_PROFILES=ollama $(COMPOSE) rm --stop --force ollama >/dev/null 2>&1 || true
endif

down: ## Stop the stack, keep the data
	COMPOSE_PROFILES=ollama $(COMPOSE) down

destroy: ## Stop the stack and delete the data
	COMPOSE_PROFILES=ollama $(COMPOSE) down --volumes

site: ## Create the demo site, run setup and wire the agent
	@$(COMPOSE) exec backend bench new-site "$(SITE)" \
	  --mariadb-user-host-login-scope=% \
	  --db-root-password $(DB_ROOT_PASSWORD) \
	  --admin-password $(ADMIN_PASSWORD) \
	  --install-app erpnext --install-app drive --install-app frappe_ai --install-app rag \
	  --set-default
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" set-config frappe_ai_agent_url "$(AGENT_URL)"
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" set-config -p frappe_ai_agent_url_unsafe_ok 1
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" set-config rag_ollama_url "$(OLLAMA_URL)"
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" set-config rag_embed_model "$(EMBED_MODEL)"
	@# Without monitor, frappe.monitor.get_trace_id() is None: the browser's X-Frappe-Request-Id is
	@# dropped, nothing echoes it back and no Error Log row carries a trace_id (ADR-008).
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" set-config -p monitor 1
	@# Drive's non-flat storage builds a new folder's disk path from the parent's absolute URL, so
	@# the directory lands outside the site and create_folder fails (frappe/drive develop). Flat
	@# storage keeps folders as records only, which is all Metis's Documents view needs.
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" execute frappe.db.set_single_value --args '["Drive Disk Settings", "flat", 1]'
	@# bench build only installs when node_modules is absent (frappe/esbuild/esbuild.js run_app_build)
	@$(COMPOSE) exec -T backend sh -c 'cd apps/rag && yarn install --frozen-lockfile'
	@$(COMPOSE) exec -T backend bench build --app rag
	@$(MAKE) wizard

wizard: ## Complete the ERPNext setup wizard (idempotent)
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" execute \
	  frappe.desk.page.setup_wizard.setup_wizard.setup_complete \
	  --kwargs '{"args": {"language":"English","country":"Australia","timezone":"Australia/Adelaide","currency":"AUD","company_name":"L2X Technologies Pty Ltd","company_abbr":"L2X","chart_of_accounts":"Australia - Chart of Accounts with Account Numbers","fy_start_date":"$(word 1,$(FY))","fy_end_date":"$(word 2,$(FY))","setup_demo":$(SETUP_DEMO)}}' >/dev/null
	@test -n "$$($(COMPOSE) exec -T backend bench --site "$(SITE)" execute frappe.db.count --kwargs '{"dt":"Fiscal Year"}')" \
	  || { echo 'wizard: no fiscal year created, setup failed silently' >&2; exit 1; }
	@test -n "$$($(COMPOSE) exec -T backend bench --site "$(SITE)" execute frappe.db.count --kwargs '{"dt":"Company"}')" \
	  || { echo 'wizard: no company created, setup failed silently' >&2; exit 1; }
	@test -n "$$($(COMPOSE) exec -T backend bench --site "$(SITE)" execute frappe.db.count --kwargs '{"dt":"Account","filters":{"company":"L2X Technologies Pty Ltd"}}')" \
	  || { echo 'wizard: company has no accounts, chart of accounts name is wrong' >&2; exit 1; }
	@echo 'setup wizard complete'

service-suites: ## Run the pinned MCP server and agent suites, as CI does
	$(call at-pin,.build/frappe-mcp-server,$(MCP_GIT),$(MCP_REF))
	$(call at-pin,.build/frappe-ai-agent,$(AGENT_GIT),$(AGENT_REF))
	@$(MAKE) --no-print-directory -C .build/frappe-mcp-server test
	@# the agent keeps pytest in its dev extra, which only its own install target syncs
	@$(MAKE) --no-print-directory -C .build/frappe-ai-agent install test

check: not-the-demo service-suites ## Run the quality gates: lint, tests, index health, no new errors
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" execute frappe.utils.now > $(ERRORS_SINCE)
	@uvx --quiet ruff@0.16.8 check rag/
	@uv run --quiet --python 3.14 --no-project rag/tools/lint_docstrings.py
	@$(COMPOSE) exec -T backend sh -c 'cd apps/rag && yarn -s format:check'
	@$(COMPOSE) exec -T backend sh -c 'cd apps/rag && yarn -s test'
	@# on the test site: the suite makes and deletes its own Drive files; CI runs it without allow_tests
	@$(COMPOSE) exec -T -e CI=1 backend bench --site "$(TEST_SITE)" run-tests --app rag
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" execute rag.ingest.health \
	  | tee /dev/stderr | grep -q '"problems": \[\]' \
	  || { echo 'check: the index has problems, see above' >&2; exit 1; }
	@if $(COMPOSE) exec -T backend bench --site "$(SITE)" execute rag.ingest.health | grep -q '"chunks": 0'; \
	  then echo 'check: nothing is indexed, so the integration tests only skipped' >&2; exit 1; fi
	@# by creation time, not by a count: a row an unrelated user wrote before this run, or one the
	@# log cleanup deleted during it, must neither fail this gate nor hide a row that this run wrote
	@new=$$($(COMPOSE) exec -T backend bench --site "$(SITE)" execute frappe.db.get_all \
	  --kwargs "{'doctype': 'Error Log', 'filters': {'creation': ['>', '$$(cat $(ERRORS_SINCE))']}, \
	    'pluck': 'method', 'limit_page_length': 10}"); \
	  test -z "$$new" \
	  || { echo "check: this run logged Error Log row(s): $$new" >&2; exit 1; }
	@$(COMPOSE) exec -T -e PW="$(ADMIN_PASSWORD)" \
	  backend python -c "import json, os, urllib.request as u; \
	  base = 'http://frontend:8080'; \
	  web = u.build_opener(u.HTTPCookieProcessor()); \
	  web.open(u.Request(base + '/api/method/login', \
	    json.dumps({'usr': 'Administrator', 'pwd': os.environ['PW']}).encode(), \
	    {'Content-Type': 'application/json'})); \
	  rows = json.load(web.open(u.Request(base + '/api/method/rag.search.search', \
	    json.dumps({'query': 'leave', 'limit': 1}).encode(), \
	    {'Content-Type': 'application/json'})))['message']; \
	  assert rows, 'the endpoint answered but matched nothing'; \
	  assert set(rows[0]) >= {'file', 'seq', 'content', 'distance'}, rows[0]" \
	  || { echo 'check: the search endpoint the mcp tool calls is broken, see above' >&2; exit 1; }
	@test "$$($(COMPOSE) exec -T backend curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
	  -H 'Cookie: sid=not-a-session' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://mcp:8080/mcp)" = 401 \
	  || { echo 'check: the MCP server served a made-up sid, so its auth is off or not asking Frappe' >&2; exit 1; }
	@$(COMPOSE) exec -T backend mariadb-dump --print-defaults | grep -q hex-blob \
	  || { echo 'check: mariadb-client.cnf is being ignored, so a backup would zero every vector' >&2; exit 1; }
	@$(COMPOSE) exec -T backend bench --site "$(SITE)" execute frappe.db.sql \
	  --kwargs '{"query":"SELECT @@global.innodb_snapshot_isolation"}' | grep -qF '[[0]]' \
	  || { echo 'check: mariadb-server.cnf is being ignored, so a second simultaneous login 500s (ADR-016)' >&2; exit 1; }
	@echo 'check: all gates passed'

ask: ## Build the /ask frontend after changing rag/frontend
	@# bench build only installs when node_modules is absent (frappe/esbuild/esbuild.js run_app_build)
	@$(COMPOSE) exec -T backend sh -c 'cd apps/rag && yarn install --frozen-lockfile'
	@$(COMPOSE) exec -T backend bench build --app rag

apps: ## List the apps in the image
	@docker run --rm --entrypoint sh $(IMAGE):$(TAG) -c 'ls -1 apps'

bench: ## Run a bench command, e.g. make bench ARGS="--site demo.localhost list-apps"
	@$(COMPOSE) exec -T backend bench $(ARGS)

logs: ## Follow the logs
	$(COMPOSE) logs -f

shell: ## Open a shell in the backend container
	$(COMPOSE) exec backend bash

# The system checks change data, so they run against TEST_SITE through the test services in compose.test.yaml,
# never against SITE.
TEST_SITE       ?= test.localhost
TEST_HTTP_PORT  ?= 8081
TEST_AGENT_PORT ?= 8485
RAG_ONLY_SITE   ?= rag.localhost
FAI_ONLY_SITE   ?= fai.localhost
TEST_COMPOSE     = $(COMPOSE) -f compose.test.yaml
SYSTEM           = cd tests/system && TEST_SITE=$(TEST_SITE) TEST_HTTP_PORT=$(TEST_HTTP_PORT) TEST_AGENT_PORT=$(TEST_AGENT_PORT) \
  RAG_ONLY_SITE=$(RAG_ONLY_SITE) FAI_ONLY_SITE=$(FAI_ONLY_SITE) TEST_COMPOSE="$(TEST_COMPOSE)"
# build code under test with its own tag (docker build --tag=frappe-mcp-server:test <repo>) and pass it here,
# so the demo's images, which the demo services recreate from, stay what the pins built
TEST_AGENT_IMAGE ?= frappe-ai-agent:local
TEST_MCP_IMAGE   ?= frappe-mcp-server:local
export TEST_SITE TEST_HTTP_PORT TEST_AGENT_PORT TEST_AGENT_IMAGE TEST_MCP_IMAGE AGENT_IMAGE MCP_IMAGE

not-the-demo:  # another compose project's site is its own, even when SITE names it too
	@test "$(COMPOSE_PROJECT)" != frappe-demo -o "$(TEST_SITE)" != "$(SITE)" -o "$(DEMO_CHECKPOINT)" = 1 \
	  || { echo 'TEST_SITE must not be the demo site ($(SITE))' >&2; exit 1; }

demo-checkpoint: tests/system/node_modules ## After a checkpoint moves the demo: seed, smoke and clean up on SITE
	@cd tests/system && DEMO_CHECKPOINT=1 TEST_SITE=$(SITE) TEST_HTTP_PORT=$(HTTP_PORT) \
	  TEST_AGENT_PORT=$(TEST_AGENT_PORT) python3 demo_checkpoint.py $(ARGS)

new-test-site = $(COMPOSE) exec -T backend bench new-site "$(1)" --mariadb-user-host-login-scope=% \
  --db-root-password $(DB_ROOT_PASSWORD) --admin-password $(ADMIN_PASSWORD) $(foreach a,$(2),--install-app $(a))

test-stack: not-the-demo ## Start a frontend, MCP server and agent for TEST_SITE
	$(TEST_COMPOSE) up -d --no-deps test-frontend test-mcp test-agent

test-site: not-the-demo ## Create TEST_SITE with every app (once)
	@$(call new-test-site,$(TEST_SITE),erpnext drive frappe_ai rag)
	@$(COMPOSE) exec -T backend bench --site "$(TEST_SITE)" set-config frappe_ai_agent_url http://test-agent:8484
	@$(COMPOSE) exec -T backend bench --site "$(TEST_SITE)" set-config -p frappe_ai_agent_url_unsafe_ok 1
	@$(COMPOSE) exec -T backend bench --site "$(TEST_SITE)" set-config allow_tests true
	@$(COMPOSE) exec -T backend bench --site "$(TEST_SITE)" set-config -p monitor 1
	@$(COMPOSE) exec -T backend bench --site "$(TEST_SITE)" execute frappe.db.set_single_value --args '["Drive Disk Settings", "flat", 1]'
	@$(MAKE) wizard SITE=$(TEST_SITE) SETUP_DEMO=0

clean-setup: ## Prove a fresh clone still becomes a working product: make setup in a scratch project, then smoke
	@tests/system/clean-setup.sh

absence-sites: not-the-demo ## Create the two one-sided sites the absence matrix needs (once)
	@$(call new-test-site,$(RAG_ONLY_SITE),drive rag)
	@$(call new-test-site,$(FAI_ONLY_SITE),frappe_ai)

tests/system/node_modules: tests/system/package.json tests/system/yarn.lock
	@cd tests/system && yarn install --frozen-lockfile --silent && npx playwright install chromium >/dev/null
	@touch $@

test-seed: not-the-demo tests/system/node_modules ## Seed TEST_SITE with three users and their documents
	@$(SYSTEM) python3 seed.py

smoke: not-the-demo tests/system/node_modules ## Sign in, ask, a cited answer, permission denied (Playwright)
	@$(SYSTEM) TEST_WEB=http://$(TEST_SITE):$(TEST_HTTP_PORT) npx playwright test smoke.spec.ts

a11y: not-the-demo tests/system/node_modules ## axe, keyboard and announcement checks on Metis and the sidebar
	@$(SYSTEM) TEST_WEB=http://$(TEST_SITE):$(TEST_HTTP_PORT) ADMIN_PASSWORD=$(ADMIN_PASSWORD) npx playwright test a11y.spec.ts

firstpaint: not-the-demo tests/system/node_modules ## What /ask has to download before it can draw anything
	@$(SYSTEM) TEST_WEB=http://$(TEST_SITE):$(TEST_HTTP_PORT) npx playwright test firstpaint.spec.ts

visual: not-the-demo tests/system/node_modules ## Compare Metis and the sidebar against their screenshot baselines
	@$(SYSTEM) TEST_WEB=http://$(TEST_SITE):$(TEST_HTTP_PORT) ADMIN_PASSWORD=$(ADMIN_PASSWORD) npx playwright test visual.spec.ts

visual-baseline: not-the-demo tests/system/node_modules ## Take those baselines again; the pngs are reviewed by eye before they are committed
	@$(SYSTEM) TEST_WEB=http://$(TEST_SITE):$(TEST_HTTP_PORT) ADMIN_PASSWORD=$(ADMIN_PASSWORD) npx playwright test visual.spec.ts --update-snapshots

acl: not-the-demo tests/system/node_modules ## Retrieval honours Drive's sharing; a forged sid gets 401
	@$(SYSTEM) python3 acl.py

confirmation: not-the-demo tests/system/node_modules ## A write tool runs on the user's click, never on the model's word
	@$(SYSTEM) python3 confirmation.py

faults: not-the-demo tests/system/node_modules ## Kill the agent, MCP, the worker or Redis mid-answer; time the clear end
	@$(SYSTEM) python3 faults.py

observability: not-the-demo tests/system/node_modules ## One request id on every service's log lines, no secrets in them
	@$(SYSTEM) python3 observability.py

absence: not-the-demo tests/system/node_modules ## Each project alone and each single absence: a clear feature-off state
	@$(SYSTEM) python3 absence.py

perf: not-the-demo tests/system/node_modules ## Measure every layer against tests/system/perf-budgets.json
	@$(SYSTEM) python3 perf.py

load: not-the-demo tests/system/node_modules ## Saturation, three simultaneous chats, the rate limit and recovery
	@$(SYSTEM) python3 load.py

retrieval: not-the-demo ## recall@k and nDCG@k for rag.search.search against tests/system/retrieval.json
	@$(SYSTEM) python3 retrieval.py

staleness: not-the-demo ## Every container serves this checkout's code, and its assets match their source
	@$(SYSTEM) python3 staleness.py

citations: not-the-demo ## Every source an answer shows was a passage that answer retrieved
	@$(SYSTEM) python3 citations.py

search-walk: not-the-demo ## Queries and milliseconds the permission filter costs per reader, for search and the document listing
	@$(SYSTEM) python3 search_walk.py

vector-scale: not-the-demo ## Latency and recall@5 of the vector index at 1x, 10x and 100x the corpus
	@$(SYSTEM) python3 vector_scale.py

lifecycle: not-the-demo ## Install, migrate twice, uninstall and reinstall each Frappe app on a throwaway site
	@$(SYSTEM) python3 lifecycle.py


.PHONY: setup help model wizard image agent-image mcp-image sbom up down destroy site check ask apps bench logs shell \
  not-the-demo service-suites test-stack test-site absence-sites test-seed smoke a11y firstpaint acl confirmation faults observability absence perf load retrieval citations staleness search-walk vector-scale lifecycle visual visual-baseline
