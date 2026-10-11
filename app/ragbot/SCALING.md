# Scaling

Every ceiling this stack has, the number it is set to, what gives way first when you reach it, and
what to do about it. Each line names the file it comes from. Nothing here is a target: the stack has
never been asked to carry a stated load, and where a number was measured the measurement is named.

Measured numbers come from the production audit's Phase 2 baseline on one M4 Max with
`gemma4:26b` on the host's Ollama. They are that machine's numbers, not a promise.

The rows sourced from `frappe_ai`, the agent and the MCP server are the rows that rot quietly: those
repositories are pinned here by commit (`AGENT_REF` and `MCP_REF` in the Makefile, `apps.json` for
frappe_ai), and nothing in `make check` asserts their numbers. Re-read them when you move a pin. The
rows sourced from `rag/`, from `compose.demo.yaml` and from frappe_docker move only when this
repository does.

## Answering a question

| Ceiling | Number | Where | What gives way first | Next step |
| --- | --- | --- | --- | --- |
| Answers at once, whole bench | 1 | one `queue-long` container (frappe_docker `compose.yaml`), and `bench worker` runs a single RQ process (frappe `commands/scheduler.py`, `utils/background_jobs.py: start_worker`) | the second question waits in the queue; nothing fails, the answer is just late | a second `queue-long` replica, or `bench worker-pool --num-workers N`, or give the relay its own queue as indexing has (ADR-007) |
| Answers at once, one user | 1 | frappe_ai refuses a second start while one runs | the user is told an answer is already running | by design; not a knob |
| How long a worker is held | 150 s, up to 330 s | frappe_ai `api/chat.py`: `timeout=settings.timeout + 30`, where the setting defaults to 120 and its `validate()` caps it at 300 | RQ kills the job; the user gets the failure message | lower the setting, or move the relay off RQ (needs an ADR) |
| One model call | 60 s | agent `config.py`: `llm_request_timeout_s` | the turn fails with a timeout | raise it, or use a smaller model |
| One turn, wall clock | 90 s | agent `config.py`: `agent_turn_timeout_s` | the turn ends and says so | raise it under frappe_ai's own timeout, never over it |
| Questions started per user | 30 a minute | frappe_ai `api/chat.py`: `_STARTS_PER_MINUTE` on `start_stream` | Frappe refuses the start | raise the decorator's limit |
| Questions per sid at the agent | 30 a minute | agent `config.py`: `agent_rate_limit` | the agent answers 429 | raise it in the agent's settings |
| History sent to the model | 20 messages | agent `services/chat.py`, `integrations/frappe_history.py` | older turns are simply not sent | raise the limit and the model's context together |
| Text of any one tool result or history row | 8000 characters | agent `config.py`: `agent_prompt_text_max_chars` | the rest is cut before the prompt | raise it and the context window together |

Measured: time to first token p50 2119 ms, p95 2146 ms with one chat; a whole short answer p50
2501 ms. Three simultaneous chats all finished, in 3.8 s, 4.6 s and 5.1 s. Time to first token was
not measured at two or four chats, nor during an indexing run, so the cost of the queue above is
inferred from the worker count, not measured.

## Serving a page or an API call

| Ceiling | Number | Where | What gives way first | Next step |
| --- | --- | --- | --- | --- |
| HTTP requests at once | 8 | 2 gunicorn workers x 4 threads (frappe_docker `compose.yaml`: `GUNICORN_WORKERS`, `GUNICORN_THREADS`) | requests queue in gunicorn; latency rises, nothing errors | raise either variable, then add a `backend` replica |
| One request | 120 s | `GUNICORN_TIMEOUT`, and nginx's `PROXY_READ_TIMEOUT` | gunicorn kills the worker, nginx answers 504 | keep slow work in a queue job, as the relay and indexing already do |
| One upload from `/ask` | 25 MiB | Frappe's `max_file_size`: System Settings, else the site config, else its own 25 MiB default, applied as `request.max_content_length` | Werkzeug answers 413. This is the ceiling a person meets, not the two below it | raise the System Settings field, and the two below with it |
| One request body at nginx | 50 MB | frappe_docker's `CLIENT_MAX_BODY_SIZE` | nginx answers 413 with no body at all, which is why Metis carries its own wording for that case | raise it |

Metis sends a file in one request (`driveUpload` in `rag/frontend/lib/frappe.ts`), so those two bound
the file itself; Drive's own API also accepts a chunked upload, where they bound one chunk.

Measured: `rag.search` p50 30.8 ms, p95 45.7 ms. Under load, search held 195 requests a second from
8 concurrent callers with no errors and p95 50 ms, and 194 a second at 16 with p95 108 ms: the 8
threads above are the reason throughput stops rising while latency keeps growing. Sixteen status
pollers at once answered with p95 169 ms and no failed request.

## Indexing a document

| Ceiling | Number | Where | What gives way first | Next step |
| --- | --- | --- | --- | --- |
| Files indexed at once | 1 | one `queue-index` container on its own queue (`compose.demo.yaml`, ADR-007) | uploads queue; an answer is never delayed, which is why the queue is separate | a second `queue-index` replica |
| One indexing job | 1500 s | the `index` queue's timeout, set bench-wide by the configurator in `compose.demo.yaml` | RQ kills the job; the file shows as not indexed and offers Retry | raise the queue timeout |
| Embedding one document | 1200 s | `rag/rag/ingest.py`: `EMBED_BUDGET_S` | the file is recorded, skipped and left with an Error Log row naming it; deliberately under the queue timeout above | raise both, in that order |
| One file's bytes | 256 MiB | `rag/rag/ingest.py`: `MAX_FILE_BYTES` | the file is skipped with an Error Log row; the blob is read whole into memory, which is why the ceiling exists. A browser upload never reaches it: the two request ceilings above are far smaller | stream the read (the `ponytail:` marker at that line) |
| Chunks per embed request | 64 | `rag/rag/ingest.py`: `EMBED_BATCH` | nothing; a bigger batch is one fewer round trip and more memory in Ollama | raise it if the embed model is remote and latency dominates |
| One embed request | 5 s to connect, 600 s to answer | `rag/rag/ingest.py`: `EMBED_TIMEOUT` | the job retries, then leaves the file for `retry_failed` | raise the read timeout for a slow model |
| Characters per chunk | 2000 | `rag/rag/ingest.py`: `CHUNK_CHARS` | nothing breaks; longer chunks retrieve worse, since the embedding model reads 2048 tokens | leave it: it is a retrieval decision, not a capacity one |
| Jobs waiting in one queue | 500, plus 50 for each site on the bench | frappe `utils/background_jobs.py`: `MAX_QUEUED_JOBS` and `_check_queue_size` | `frappe.enqueue` refuses; rag catches that, logs the file by name and lets `retry_failed` pick it up within the hour | raise `max_queued_jobs` in the bench config, or index faster |
| Retries before a file is left alone | about 24, one an hour | `rag/rag/ingest.py`: `RETRY_DAYS`, with `retry_failed` on the hourly schedule | the file stays unindexed until someone presses Retry | raise `RETRY_DAYS` |

## Finding a passage

| Ceiling | Number | Where | What gives way first | Next step |
| --- | --- | --- | --- | --- |
| Rows the permission filter may read | 500 | `rag/rag/search.py`: `WIDEN` | a user who may read very little of a large index gets fewer passages than they asked for, or none | put the permission filter in SQL; `c.team IN (get_teams(user))` is not that filter, as the comment at `WIDEN` says |
| Candidates the index returns | 10 x the asked-for limit, then `WIDEN` | `rag/rag/search.py`: `CANDIDATES` | more rows read per question | it is the over-fetch that pays for filtering after ranking |
| Passages one question may ask for | 20 | `rag/rag/search.py`, the clamp on `limit` | a larger request is silently clamped | raise the clamp with the model's context |
| Saved sources re-read at once | 500 | `rag/rag/search.py`: `MAX_REFS` | the rest of the list is ignored | raise it with the frontend's own message cap |
| Vector index search width | 500 per connection | `rag/rag/search.py`: `EF_SEARCH`; MariaDB's own default is 20 | at MariaDB's default some questions matched nothing; the reason is at the constant | lower it for speed, and measure recall when you do |
| Vector index graph cache | 16 MiB, one server-wide | MariaDB's `mhnsw_max_cache_size` default (<https://mariadb.com/docs/server/reference/sql-structure/vectors/vector-system-variables>) | past that the search reads graph nodes from disk instead of memory; search slows, nothing fails | raise the variable. How many chunks fit in 16 MiB is not stated here: it depends on the graph MariaDB builds, and this stack has not measured it |
| Vector index shape | one per table, `M=16`, cosine | `rag/rag/kb/doctype/kb_chunk/kb_chunk.py` | nothing, until you want to change it: MariaDB allows one vector index per table, so `M` and the distance are fixed after the first deploy | rebuild the table |
| Vector width | 768 | `rag/rag/ingest.py`: `EMBED_DIM`, and the `VECTOR(768)` column | an embedding model of another width is refused at index time with a message saying so | a different width means a new column and a full re-index |
| A chat's own attachments | every chunk of them, scanned | `rag/rag/search.py`: `_attached` | a plain scan the vector index cannot serve; fine for the handful of files a chat holds | index them like Drive files if chats start carrying many |

## Listing, previewing and deleting

| Ceiling | Number | Where | What gives way first | Next step |
| --- | --- | --- | --- | --- |
| Text preview fetched whole | 2 MiB | `rag/frontend/components/Documents.tsx`: `TEXT_LIMIT` | a larger text file is not previewed | the `ponytail:` marker at that line says what to do |
| Permission walks per folder listing | one per file | `rag/rag/library.py` | each walk is a recursive CTE over the folder ancestry; fine for hundreds of files | filter in SQL, the same change `WIDEN` needs |
| Deletes per chat deleted | one per message | `rag/rag/chat.py` | fine for hundreds of messages; `delete_doc` still checks each one | a bulk delete that keeps the permission check |

## Three reference sizes

The owner has not stated a load target, so these are the sizes the audit reports against, not sizes
the stack has been built or measured for.

**About 10 people, 3 chats at once.** Nothing in the request path is close: 3 of 8 threads. The
three chats serialise on the one long worker, and the Phase 2 run measured all three finishing in
3.8 s to 5.1 s. Indexing has its own worker and does not interfere. This is the size the stack runs
at today.

**About 100 people, 20 chats at once.** The single long worker is the wall, and it is the first
thing to give way: twenty answers of a few seconds each queue behind one another. Give the relay
its own queue and several workers, the move ADR-007 already made for indexing, and raise
`GUNICORN_WORKERS` so the polling the frontends do does not compete with it. What the one host
Ollama does with several answers at once is then the next question, and this stack has not
measured it.

**1,000 people or more, several replicas.** Beyond what this harness is. Nothing here has been
measured at that size, so nothing here says what it would take.

## Not a capacity ceiling, but a limit worth knowing

`rag/pyproject.toml` is never installed: the app is importable by path alone, so its dependencies
come from Drive's (`compose.demo.yaml`). The file declares them so the list is honest, not so a
resolver reads it.
