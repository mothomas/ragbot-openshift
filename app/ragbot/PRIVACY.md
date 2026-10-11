# What leaves this machine

Every outbound call this stack makes, what it carries, and how long anything is kept. Each entry
names the file it was read from. Where a number could not be measured without running the stack,
this says so instead of guessing.

The short answer for the stack as it ships: nothing leaves the host. Both models run on the host's
own Ollama, the agent and the MCP server talk only to containers on the compose network, and the
`/ask` frontend fetches nothing from a third party. A handful of settings can change that, and
each of them is named below.

## The embedding model

`rag/rag/ingest.py` posts to `<rag_ollama_url>/api/embed`:

- when a Drive file is indexed, the whole text of every chunk of it, 64 chunks to a request,
  each prefixed with `search_document:` and a space;
- the same for every file attached to a chat;
- when anyone asks a question, the question, prefixed with `search_query:` and a space, from `rag/rag/search.py`.

`rag_ollama_url` is site configuration. `make site` writes the host's own Ollama into it, so the
text stays on the machine. Point it at another host and the full text of every indexed document
goes there, in cleartext: the default scheme is `http` and rag adds no TLS of its own.

## The answering model

The agent builds one request per model call (`src/ai_agent/integrations/llm.py`). With
`AI_AGENT_LLM_PROVIDER=ollama`, which is the agent's default and which `compose.demo.yaml` does not
override, that request goes to `AI_AGENT_LLM_BASE_URL`, the same host Ollama.

With `openai`, `anthropic` or `google`, langchain's `init_chat_model` sends the same request to that
provider, over the internet, with `AI_AGENT_LLM_API_KEY`. The request holds:

- the system prompt;
- the page context Frappe forwards: route, doctype, docname and currency;
- up to 20 earlier messages of the chat (`src/ai_agent/services/chat.py`,
  `src/ai_agent/integrations/frappe_history.py`);
- the user's question;
- every tool result of the turn, which is where ERP rows from the MCP server and the passages
  `rag.search` returned enter the request.

Each tool result and each history row is cut to 8,000 characters first
(`agent_prompt_text_max_chars`). Nothing else is removed, so a hosted provider sees document text
and ERP data.

## Between the services

| From | To | What it carries |
| --- | --- | --- |
| frappe_ai's queue worker | the agent (`frappe_ai_agent_url`) | the question, the page context, and the user's `sid` cookie, so the agent acts as that user |
| the agent | the MCP server (`AI_AGENT_MCP_SERVER_URL`) | the tool name, its arguments and the forwarded `sid` |
| the agent | Frappe (`AI_AGENT_FRAPPE_URL`) | chat history reads and writes, and a CSRF token fetch |
| the MCP server | Frappe (`erpnext.base_url` in `mcp/config.yaml`) | the tool's own query, as the caller |
| the MCP server | Frappe (`token_info_url` in `mcp/config.yaml`) | the caller's `sid`, to ask Frappe who it belongs to |
| `/ask` and the desk sidebar | this site only | every fetch is same-origin |

frappe_ai refuses an agent URL that is not absolute http(s), that names a cloud metadata service,
that is link-local, or that resolves to a private address, and it requires https for a public one.
`frappe_ai_agent_url_unsafe_ok`, which `make site` sets, is what allows the local
`http://agent:8484`.

The MCP server can be given a model of its own (`llm:` in its config). `mcp/config.yaml` gives it
none, so it logs "AI-powered query processing will be disabled" at startup and calls no model. Give
it one and it calls that provider itself, from the server: with `provider_type: anthropic` the
address is fixed in its code at `https://api.anthropic.com/v1/messages`
(`internal/llm/anthropic.go`), and the other two provider types post to the `base_url` you give.

## The cloud metadata probes

With the Status panel on (`rag_status_panel`, on unless a site says otherwise), `rag/rag/status.py`
asks four metadata services where this server is running, once per worker process:

- `169.254.169.254` for AWS, Azure and DigitalOcean. That is a link-local address: the request
  never leaves the host's own link.
- `http://metadata.google.internal/...` for Google. The name has to be resolved first, so one DNS
  query for `metadata.google.internal` goes to whatever resolver the container uses. Nothing else
  is sent.
- Inside Kubernetes only, and only when `KUBERNETES_SERVICE_HOST` and a service-account token are
  both present, one request to the cluster's own API for this node's labels, to read its region and
  zone. It carries the pod's service-account token and stays inside the cluster.

The four metadata probes have a 0.3 s timeout each and carry no payload; the Kubernetes request
has 2 s and carries the token. The answer is cached for the life of the worker.
`bench --site <site> set-config rag_status_panel 0` stops all of it, and the panel with it.

`_ip()` opens a UDP socket towards the agent's address to pick a route; UDP connect sends no packet.

## Telemetry

- rag and `/ask` send none. `/ask` loads no font, script or image from anywhere but this site: an
  image in a model's answer is dropped unless its address is this origin (`fromThisSite` in
  `rag/frontend/lib/frappe.ts`), so a planted document cannot exfiltrate through an image URL.
- The agent exports OpenTelemetry spans only when `AI_AGENT_OTEL_ENDPOINT` is set. It is empty by
  default and `compose.demo.yaml` does not set it, so the `OTLPSpanExporter` is never constructed
  and nothing is exported (`src/ai_agent/observability/tracing.py`).
- **LangSmith is the exception, and it is not the agent's own switch.** langsmith is installed in
  the agent's image as a dependency of langchain-core. LangChain's callback manager attaches a
  `LangChainTracer` to every model and chain call whenever langsmith says tracing is on
  (`langchain_core/callbacks/manager.py`, `langchain_core/tracers/context.py`), and langsmith says
  it is on when any of `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING` or
  `LANGCHAIN_TRACING` is exactly `true` in the process environment (`langsmith/utils.py`,
  `tracing_is_enabled` and `get_env_var`, whose namespaces are `LANGSMITH` and `LANGCHAIN`). The
  tracer uploads the full contents of each run — prompts, tool results, answers — to LangSmith. The
  agent's own settings read only `AI_AGENT_*` names, so it neither rejects nor logs these four. If
  local-only operation matters, do not set them, and check the agent container's environment.

## What is kept, and for how long

| What | Where | How long |
| --- | --- | --- |
| Chunk text and its vector | the `KB Chunk` table | until the file is re-indexed, trashed, or leaves Drive, when the chunks go with it (`rag/rag/ingest.py`) |
| A chat, its messages, its sources and its tool calls | `AI Chat Session`, `AI Chat Message` | until the user deletes the chat. Deleting it is permanent: no Deleted Document copy is kept (ADR-014) |
| A file attached to a chat that was never started | Drive's file storage, and `KB Chunk` | one day, then a daily job removes it with its chunks (`rag/rag/chat.py`) |
| A user's chat content on erasure | as above | a Frappe Personal Data Deletion Request redacts it; frappe_ai declares the fields for it (ADR-014) |
| The audit trail of tool calls | the MCP server's log | the deployment's log retention. The line names the user, the tool, the doctype, the outcome and the duration, never arguments, results or passages |
| Error Log rows naming a file that could not be indexed | Frappe's `Error Log` | Frappe's own log clearing |
| One row per answered retrieval: the reader, the chat it served, the file ids it returned and the request's trace id, never the question | Frappe's `Access Log` | 90 days, the retention rag declares for it (`rag/rag/hooks.py`) |

How long a chat nobody deletes is kept is not decided: nothing expires chats automatically.
