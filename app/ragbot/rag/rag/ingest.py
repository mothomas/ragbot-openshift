import json
import mimetypes
import re
import time
import traceback
from itertools import batched
from pathlib import Path
from typing import Any
from uuid import uuid7

import chardet
import frappe
import frappe.monitor
import requests
from drive.api.permissions import user_has_permission
from drive.utils import STATUS_ACTIVE, is_site_file
from frappe import _
from frappe.utils.background_jobs import get_queues_timeout, is_job_enqueued

# What a site gets when its own configuration names neither. One bench serves many sites, so read
# both through ollama_url() and embed_model() at call time; these two names are only the fallback.
OLLAMA_URL = "http://host.docker.internal:11434"
EMBED_MODEL = "nomic-embed-text"
EMBED_DIM = 768  # must match the VECTOR(768) column in kb/doctype/kb_chunk/kb_chunk.py
EMBED_TIMEOUT = (5, 600)  # /api/embed stays silent until it has computed every vector
EMBED_BATCH = 64  # ~0.45s per chunk on a CPU, 0.02s on this stack's host Ollama; a book is many requests
# under the index queue's 1500 s: a document too long to embed is recorded and skipped, not killed unrecorded
EMBED_BUDGET_S = 1200
MAX_FILE_BYTES = 256 * 1024 * 1024  # ponytail: the blob is read whole; stream it if files grow past this
DETECT_BYTES = 200_000  # chardet 5.2.0 has no max_bytes of its own and feeds the whole buffer: ~5 s per 20 MB
# chardet's own floor is 0.20, which bytes(range(256)) clears at 0.266 as windows-1253
DETECT_CONFIDENCE = 0.5

INDEX_QUEUE = "index"  # its own worker (ADR-007), so indexing never waits on, or delays, a chat relay
WATCHED = ("status", "team")
RETRY_DAYS = 1  # retry_failed runs hourly, so a file gets about 24 tries before it is left to its Retry
CHAT = "AI Chat Session"  # files attached in a chat belong to it, never to Drive or the knowledge base
MESSAGE = "AI Chat Message"  # frappe_ai's own name for a turn in one of those chats
CHUNK_CHARS = 2000  # ~580 tokens of nomic-embed-text's 2048, sized for retrieval not for the window
# plain text that Drive labels application/* (its MIME sniffing gives these for .json, .yaml, .sql and .toml)
TEXT_APPLICATION_TYPES = {"application/json", "application/yaml", "application/sql", "application/toml"}
HTML_TYPES = {"text/html", "application/xhtml+xml"}


def ollama_url() -> str:
	return frappe.conf.get("rag_ollama_url") or OLLAMA_URL


def embed_model() -> str:
	return frappe.conf.get("rag_embed_model") or EMBED_MODEL


def is_chat_file(doc) -> bool:
	return getattr(doc, "attached_to_doctype", None) == CHAT and not getattr(doc, "team", None)


def on_file_update(doc, method=None):
	"""Queue a new Drive file, or one whose status or team changed, for indexing; a chat attachment on upload."""
	if is_chat_file(doc):
		if not doc.get_doc_before_save():
			_enqueue(doc)
		return
	if doc.is_folder or is_site_file(doc):
		# a file that just left Drive would keep chunks nobody can ever match
		if doc.get_doc_before_save() and doc.has_value_changed("team"):
			frappe.db.delete("KB Chunk", {"file": doc.name})
		return
	if doc.get_doc_before_save() and not any(doc.has_value_changed(f) for f in WATCHED):
		return
	_enqueue(doc)


def index_queue() -> str:
	"""The queue indexing runs on: `index` where the bench declares one, `long` where it has not."""
	# frappe.enqueue rejects a queue the bench has not declared, which would fail the upload itself, so a
	# bench without the workers entry keeps the old queue. Asking what enqueue validates against cannot disagree.
	return INDEX_QUEUE if INDEX_QUEUE in get_queues_timeout() else "long"


def _job_id(name: str) -> str:
	"""One spelling for both sides: index_state looks up what _enqueue wrote."""
	return f"rag-index-{name}"


def _enqueue(doc):
	# No deduplicate: it also skips while a STARTED job holds the old bytes, losing a trash-then-restore.
	# Dotted string, not the callable: RQ unpickles before frappe.init() (drive.utils: "object is not bound").
	try:
		frappe.enqueue(
			"rag.ingest.index_file",
			queue=index_queue(),
			enqueue_after_commit=True,
			job_id=_job_id(doc.name),
			name=doc.name,
			# frappe.monitor adopts a request's trace id but mints a fresh one for a job
			# (collect_job_meta reads only rq), so the upload's id travels as an argument (ADR-008)
			request_id=frappe.monitor.get_trace_id() or "",
		)
	except frappe.QueueOverloaded:
		# frappe checks the queue depth inside enqueue, before the after-commit deferral, so
		# letting this out fails the upload itself. Name the file instead: retry_failed catches up within the hour.
		frappe.log_error(
			"rag: indexing queue full, file left unindexed",
			doc.name,
			reference_doctype="File",
			reference_name=doc.name,
		)


def index_state(file: str) -> str:
	"""ready, indexing, failed for a format we cannot read, else error: it did not finish and may on a retry."""
	if frappe.db.exists("KB Chunk", {"file": file}):
		return "ready"
	if is_job_enqueued(_job_id(file)):
		return "indexing"
	doc = frappe.db.get_value("File", file, ["file_name", "mime_type"], as_dict=True)
	return "error" if doc and readable(doc) else "failed"


@frappe.whitelist(methods=["POST"])
def reindex(file: str) -> None:
	"""Index one Drive file again: the Retry the Documents list offers for a file whose indexing failed."""
	doc = frappe.get_doc("File", file)
	if not user_has_permission(doc, "read"):
		frappe.throw_permission_error()
	_enqueue(doc)


def on_file_trash(doc, method=None):
	# Drive soft-deletes to status=Removed, so this only fires for a framework-level
	# frappe.delete_doc, which would otherwise hit LinkExistsError on KB Chunk.file.
	frappe.db.delete("KB Chunk", {"file": doc.name})


def _mime(doc) -> str:
	# mime_type is Drive's field; a chat's attachment is a plain Frappe upload without one
	name = getattr(doc, "file_name", None) or ""
	return getattr(doc, "mime_type", None) or mimetypes.guess_type(name)[0] or ""


def readable(doc) -> bool:
	"""Whether extract_text can read this file's format at all; it still finds no text in some it can."""
	mime = _mime(doc)
	return (
		mime == "application/pdf"
		or mime.startswith("text/")
		or mime in TEXT_APPLICATION_TYPES
		or mime in HTML_TYPES
	)


def extract_text(doc) -> str:
	"""Plain text for a Drive file, or "" for a format we cannot read yet."""
	mime = _mime(doc)
	if not readable(doc):
		return ""
	# a chat's attachment is an ordinary private file, outside Drive's storage
	data = Path(doc.get_full_path()).read_bytes() if is_chat_file(doc) else doc.manager.get_file(doc).read()
	if mime != "application/pdf":
		text = _decode(data)
		if mime not in HTML_TYPES:
			return text
		# a web page's markup, scripts and styles are not its content; bs4 comes with it, so not in web workers
		from frappe.core.utils import html_to_plain_text

		return html_to_plain_text(text)
	import pymupdf  # 39MB RSS, keep it out of the web workers

	try:
		with pymupdf.open(stream=data, filetype="pdf") as pdf:
			if pdf.needs_pass:
				return ""
			# "blocks" keeps paragraph boundaries; ligatures (U+FB00-FB06) are expanded, since the embedding
			# model has no token for them and a query never contains them
			flags = pymupdf.TEXTFLAGS_BLOCKS & ~pymupdf.TEXT_PRESERVE_LIGATURES
			return "\n\n".join(
				b[4].strip()
				for page in pdf
				for b in _reading_order([b for b in page.get_text("blocks", flags=flags) if b[6] == 0], page.rect.width)
			)
	except pymupdf.FileDataError:
		return ""


def _reading_order(blocks: list, width: float) -> list:
	"""A page's text blocks in reading order, columns included; PyMuPDF's sort=True alternates two columns."""
	out, band = [], []

	def flush():
		cols = []  # [left, right, blocks]
		for b in sorted(band, key=lambda b: b[0]):
			col = next((c for c in cols if b[0] < c[1] and b[2] > c[0]), None)
			if col:
				col[0], col[1] = min(col[0], b[0]), max(col[1], b[2])
				col[2].append(b)
			else:
				cols.append([b[0], b[2], [b]])
		for col in sorted(cols, key=lambda c: c[0]):
			out.extend(sorted(col[2], key=lambda b: b[1]))
		band.clear()

	for b in sorted(blocks, key=lambda b: (b[1], b[0])):
		# ponytail: "most of the page" is 60% of its width; a table whose cells are separate blocks is read
		# column by column, as a two-column page is
		if b[2] - b[0] > 0.6 * width:
			flush()
			out.append(b)
		else:
			band.append(b)
	flush()
	return out


def _decode(data: bytes) -> str:
	# UTF-32 LE opens with the UTF-16 LE BOM, so it has to be tested first
	if data[:4] in (b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff"):
		return data.decode("utf-32", "replace")
	if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
		return data.decode("utf-16", "replace")
	try:
		return data.decode("utf-8-sig")
	except UnicodeDecodeError:
		return _legacy(data)


def _legacy(data: bytes) -> str:
	"""Text from a code page that is not UTF-8, or "" when the bytes are not text at all."""
	# chardet, which frappe installs and reads mail with, ranks the code pages; the first one worth
	# acting on wins, and where there is none the file indexes nothing rather than a page of mojibake
	for guess in chardet.detect_all(data[:DETECT_BYTES]):
		if guess["confidence"] < DETECT_CONFIDENCE:
			break
		# a classic Mac code page and its windows- twin share a language model, so short text ranks them a
		# hair apart (122 bytes of cp1251 Russian: MacCyrillic 0.987, windows-1251 0.980) and both decode
		# cleanly; macOS has written UTF-8 since Mac OS X, so the windows page is the likelier document
		if not guess["encoding"].lower().startswith("mac"):
			return data.decode(guess["encoding"], "replace")
	return ""


def chunk(text: str) -> list[str]:
	"""Whole paragraphs packed up to CHUNK_CHARS, splitting any paragraph too long to fit."""
	text = "\n".join(text.splitlines())  # a Windows upload has no "\n\n" at all
	paras = []
	for para in re.split(r"\n\s*\n", text):  # a blank line often holds a space or a tab
		para = para.strip()
		while len(para) > CHUNK_CHARS:
			# a line end first (a CSV or log row), then any whitespace, and a hard cut only when there is none
			window = para[:CHUNK_CHARS]
			cut = window.rfind("\n") + 1 or max(window.rfind(" "), window.rfind("\t")) + 1 or CHUNK_CHARS
			paras.append(para[:cut].strip())
			para = para[cut:].strip()
		if para:
			paras.append(para)

	out, buf, size = [], [], 0
	for para in paras:
		if buf and size + len(para) > CHUNK_CHARS:
			out.append("\n\n".join(buf))
			buf, size = [], 0
		buf.append(para)
		size += len(para) + 2
	if buf:
		out.append("\n\n".join(buf))
	return out


def embed(texts: list[str], prefix: str = "search_document", timeout=EMBED_TIMEOUT) -> list[list[float]]:
	"""Embed every text in batches, under nomic's task prefix, which Ollama does not add.

	Args:
		prefix: search_document to index, search_query to ask; mixing them ruins retrieval.
	"""
	vectors, deadline = [], time.monotonic() + EMBED_BUDGET_S
	for batch in batched(texts, EMBED_BATCH, strict=False):  # a short last batch is the point
		if time.monotonic() > deadline:
			raise TimeoutError(f"embedded {len(vectors)} of {len(texts)} chunks before the budget ran out")
		vectors += _embed_batch(list(batch), prefix, timeout)
	return vectors


def _embed_batch(texts: list[str], prefix: str, timeout) -> list[list[float]]:
	# not frappe's make_post_request: it passes no timeout at all, so a hung Ollama would park
	# this worker until RQ's 1500s death penalty fires
	model = embed_model()
	res = requests.post(
		f"{ollama_url()}/api/embed",
		json={
			"model": model,
			"input": [f"{prefix}: {t}" for t in texts],
			"truncate": False,  # a silent half-embedding is worse than a loud failure
		},
		timeout=timeout,
	)
	res.raise_for_status()
	vectors = res.json()["embeddings"]
	if len(vectors) != len(texts):
		frappe.throw(_("Ollama returned {0} embeddings for {1} chunks").format(len(vectors), len(texts)))
	if len(vectors[0]) != EMBED_DIM:
		frappe.throw(
			_("{0} returns {1}-dim vectors, the column is VECTOR({2})").format(model, len(vectors[0]), EMBED_DIM)
		)
	return vectors


# the fields _indexable reads
LIVE = ["is_folder", "team", "status", "file_type", "file_url", "content_doctype", "attached_to_doctype"]


def _indexable(doc) -> bool:
	drive = not (doc.is_folder or is_site_file(doc)) and doc.status == STATUS_ACTIVE and not doc._not_in_disk()
	return drive or is_chat_file(doc)


def _skip(doc, reason: str) -> dict:
	"""A file too large to index: no chunks, and one Error Log row an operator can find by the file."""
	frappe.db.delete("KB Chunk", {"file": doc.name})
	frappe.log_error("rag: file too large to index", reason, reference_doctype="File", reference_name=doc.name)
	return {"file": doc.name, "chunks": 0}


def index_file(name: str, request_id: str = ""):
	if request_id:
		# on this job's own monitor record, beside the uuid frappe minted for it
		frappe.monitor.add_data_to_monitor(trace_id=request_id)
	try:
		return _index_file(name)
	except Exception as exc:
		# Frappe logs a failed job with every frame's variables, and the frames below hold the document's text
		traceback.clear_frames(exc.__traceback__)
		raise


def _index_file(name: str):
	if not frappe.db.exists("File", name):
		# hard-deleted between the enqueue and this job. on_file_trash already took the chunks.
		return {"file": name, "chunks": 0}
	doc = frappe.get_doc("File", name)
	if not _indexable(doc):
		frappe.db.delete("KB Chunk", {"file": name})
		return {"file": name, "chunks": 0}
	if (doc.file_size or 0) > MAX_FILE_BYTES:
		return _skip(doc, f"{doc.file_size} bytes, over the {MAX_FILE_BYTES} the indexer reads")
	# Read before deleting, and do not catch: Drive maps every read failure onto
	# DoesNotExistError, so an S3 blip would otherwise commit an empty index.
	chunks = chunk(extract_text(doc))
	try:
		vectors = embed(chunks)
	except TimeoutError as exc:
		return _skip(doc, str(exc))
	except requests.RequestException as exc:
		if exc.response is not None and exc.response.status_code < 500:
			# Ollama rejected the request, so five more attempts reject it five times, each one
			# re-reading the blob and re-extracting the text. Fail now and log it once.
			raise
		# an Ollama restart should not leave the file unindexed: execute_job re-runs this up to
		# five times, 1 to 5 s apart (about 15 s in all). Retrying here as well would multiply the attempts.
		raise frappe.RetryBackgroundJobError(f"Ollama unreachable: {exc}") from exc
	# The snapshot predates embedding, so a delete or trash since is invisible and the chunks would outlive the
	# file: write, then re-read it under a lock, wait=False because a request deleting it waits on these chunks.
	# That lock, or a row changed since the snapshot (MariaDB 1020), means the file is changing: roll back.
	try:
		frappe.db.delete("KB Chunk", {"file": name})
		for seq, (content, vector) in enumerate(zip(chunks, vectors, strict=True)):
			# Raw SQL because `embedding` is not a DocField: an ORM insert would omit it.
			frappe.db.sql(
				"INSERT INTO `tabKB Chunk`"
				" (name, creation, modified, owner, modified_by, file, seq, content, model, embedding)"
				" VALUES (%s, NOW(6), NOW(6), %s, %s, %s, %s, %s, %s, VEC_FromText(%s))",
				(
					str(uuid7()),
					frappe.session.user,
					frappe.session.user,
					name,
					seq,
					content,
					embed_model(),
					json.dumps(vector, allow_nan=False),
				),
			)
		live = frappe.db.get_value("File", name, LIVE, as_dict=True, for_update=True, wait=False)
	except (frappe.QueryDeadlockError, frappe.QueryTimeoutError) as exc:
		frappe.db.rollback()
		if not frappe.db.exists("File", name):
			return {"file": name, "chunks": 0}
		# execute_job runs this again on the file's new state, up to five times, then writes an Error Log row
		raise frappe.RetryBackgroundJobError("File changed while indexing") from exc
	if not live or not _indexable(doc.update(live)):
		frappe.db.delete("KB Chunk", {"file": name})
		return {"file": name, "chunks": 0}
	return {"file": name, "chunks": len(chunks)}


def health():
	"""Everything that would make search quietly wrong, in one place."""
	model = embed_model()
	zero = "[" + ",".join(["0"] * EMBED_DIM) + "]"
	stats = frappe.db.sql(
		"""
		SELECT COUNT(*) AS chunks,
		       COALESCE(SUM(embedding IS NULL), 0) AS unembedded,
		       COALESCE(SUM(embedding = VEC_FromText(%(zero)s)), 0) AS zeroed,
		       COALESCE(SUM(model IS NULL OR model != %(model)s), 0) AS other_model
		FROM `tabKB Chunk`
		""",
		{"zero": zero, "model": model},
		as_dict=True,
	)[0]
	stats: dict[str, Any] = {k: int(v) for k, v in stats.items()}
	stats["indexed"] = bool(
		frappe.db.sql(
			"SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()"
			" AND TABLE_NAME = 'tabKB Chunk' AND INDEX_NAME = 'embedding'"
		)
	)
	problems = []
	if stats["unembedded"]:
		problems.append(
			f"{stats['unembedded']} chunks have no vector, and no vector sorts ahead of every real match"
		)
	if stats["zeroed"]:
		problems.append(
			f"{stats['zeroed']} chunks have an all-zero vector, which is the nearest neighbour of"
			" every question. A restored backup does this: frappe's mariadb-dump call has no"
			" --hex-blob, so every vector comes back as zeroes with no error"
		)
	if stats["other_model"]:
		problems.append(
			f"{stats['other_model']} chunks were embedded by another model, not {model}."
			" Two models put the same sentence in different places, so the distances mean nothing"
		)
	if stats["chunks"] and not stats["indexed"]:
		problems.append("there is no vector index, so every search reads the whole table")
	if problems:
		problems.append("fix with `bench --site <site> execute rag.ingest.reindex_all`, then migrate")
	stats["problems"] = problems
	return stats


def _to_index(since=None) -> list[str]:
	"""Every Active Drive file and chat attachment, or only those changed since `since`."""
	drive = {"is_folder": 0, "status": STATUS_ACTIVE, "team": ["is", "set"]}
	chat = {"attached_to_doctype": CHAT, "team": ["is", "not set"]}
	if since:
		drive["modified"] = chat["modified"] = [">", since]
	names = frappe.get_all("File", filters=drive, pluck="name")
	return names + frappe.get_all("File", filters=chat, pluck="name")


def retry_failed():
	"""Queue every file whose indexing may finish on another run: hourly, for a day, then it stays in error."""
	queued = 0
	since = frappe.utils.add_days(frappe.utils.now_datetime(), -RETRY_DAYS)
	for name in _to_index(since):
		if index_state(name) != "error":
			continue
		try:
			job = frappe.enqueue(
				"rag.ingest.index_file",
				queue=index_queue(),
				deduplicate=True,
				job_id=_job_id(name),
				name=name,
			)
		except frappe.QueueOverloaded:
			break  # a full queue is one of the reasons these are unindexed; the next hour catches up
		queued += job is not None
	return {"queued": queued}


def reindex_all():
	"""Queue every Active Drive file and chat attachment; a full queue stops it, so re-run while any remain."""
	names = _to_index()
	queued = 0
	for i, name in enumerate(names):
		try:
			job = frappe.enqueue(
				"rag.ingest.index_file",
				queue=index_queue(),
				deduplicate=True,
				job_id=_job_id(name),
				name=name,
			)
		except frappe.QueueOverloaded:
			return {"queued": queued, "remaining": len(names) - i}
		queued += job is not None  # None means deduplicate skipped one already in flight
	return {"queued": queued, "remaining": 0}
