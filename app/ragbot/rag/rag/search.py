import json
import logging

import frappe
import frappe.monitor
import redis
import requests
from drive.api.permissions import user_has_permission
from drive.utils import STATUS_ACTIVE
from frappe import _
from frappe.core.doctype.access_log.access_log import make_access_log
from frappe.utils import cint

from rag.ingest import CHAT, embed

# Permissions filter after ranking, so over-fetch 10x, then WIDEN for a user who can read little of it.
# ponytail: WIDEN is the recall ceiling; lifting it needs the permission filter in SQL, and
# `c.team IN (get_teams(user))` is not that filter: it drops a file shared directly with a non-member.
CANDIDATES = 10
WIDEN = 500
# a question embeds in under 0.1 s warm and a few seconds cold; answer before the MCP client's 30 s
QUERY_EMBED_TIMEOUT = (3, 20)
# the vector index is approximate: at the default mhnsw_ef_search of 20 some questions got no rows at all
EF_SEARCH = 500
MAX_QUERY_CHARS = 2000  # what one nomic-embed-text request takes; not CHUNK_CHARS, which sizes a stored chunk
MAX_REFS = 500  # one call per chat, and useChat reads at most 500 messages of it


def _log() -> logging.Logger:
	"""rag's own logger, raised to WARNING; frappe caches it per site, so setting the level again is free."""
	# ponytail: not frappe.log_error, which stores frappe.form_dict and a traceback holding every
	# frame's variables, so the question would land in the Error Log twice. The level is needed because
	# utils/logger.py:80 takes ERROR unless the DEV_SERVER environment variable lowers the default.
	logger = frappe.logger("rag")
	logger.setLevel(logging.WARNING)
	return logger


# POST, not GET: a question in the query string is written to every access log it passes (ADR-037)
@frappe.whitelist(methods=["POST"])
def search(query: str = "", limit: int = 5, session: str = "") -> list[dict]:
	"""Chunks nearest `query` in Drive files this user may read, plus the files attached to chat `session`."""
	try:
		frappe.has_permission("KB Chunk", "report", throw=True)
		if session and frappe.db.exists(CHAT, session):
			frappe.get_doc(CHAT, session).check_permission("read")
	except frappe.PermissionError:
		# in production frappe logs neither a throw nor a 403, so a refused search left no record at all
		# (app.py handle_exception only snapshots at 500 or with developer_mode on)
		_log().warning("search refused user=%s session=%s", frappe.session.user, session or "-")
		raise
	# A missing question is a 500 and a leaked traceback without the default; an over-long one is
	# a 400 from Ollama, which has the same effect. Both arrive from the model, not a person.
	query = (query or "").strip()[:MAX_QUERY_CHARS]
	if not query:
		return []  # embedding whitespace answers confidently from an unrelated document
	limit = max(1, min(cint(limit), 20))
	try:
		vector = json.dumps(embed([query], "search_query", QUERY_EMBED_TIMEOUT)[0], allow_nan=False)
	except requests.RequestException as exc:
		# the class alone: the message carries the Ollama URL, and the question must never be logged
		_log().error("search embed failed %s user=%s", type(exc).__name__, frappe.session.user)
		frappe.throw(_("the knowledge base cannot be searched right now ({0})").format(type(exc).__name__))

	allowed, out = {}, []
	for candidates in (limit * CANDIDATES, WIDEN):
		rows = _nearest(vector, candidates)  # pyrefly: ignore[unbound-name]  frappe.throw raises, typed -> None
		out = _readable(rows, limit, allowed)
		if len(out) == limit or len(rows) < candidates:
			break  # enough, or the whole index has been read
	if session:
		out = sorted(out + _attached(vector, session, limit), key=lambda r: r["distance"])[:limit]
	_audit("rag.search.search", session, out)
	return out


def _audit(method: str, session: str, out: list[dict]) -> None:
	"""Record who read which passages, in frappe's own Access Log; never the question they asked."""
	# Outside a test this is a redis rpush frappe drains every 15 minutes: best-effort, and it outlives
	# a rolled-back request. A redis fault must not fail a search that has already answered.
	try:
		make_access_log(
			# export_from and reference_document are the pair the desk turns into a link, so they name
			# the chat or neither; `method` is what says these are search results
			doctype=CHAT if session else None,
			document=session or None,
			method=method,
			# json, because make_access_log stores cstr(filters) and a python repr is nobody's format
			filters=json.dumps(
				{
					"files": sorted({r["file"] for r in out}),
					"count": len(out),
					# frappe's trace id for this request: the caller's own once it forwards one
					# (ADR-008), frappe's otherwise, which still joins the row to its monitor record
					"trace": frappe.monitor.get_trace_id() or "",
				}
			),
		)
	except (redis.RedisError, AttributeError) as exc:
		# AttributeError as well: frappe's own fallback for a redis outage iterates a dict as a list
		# (deferred_insert.py:23-25), so the degradation it intends raises instead
		_log().error("search audit failed %s user=%s", type(exc).__name__, frappe.session.user)


@frappe.whitelist(methods=["POST"])
def passages(refs: list | str) -> list[dict]:
	"""The text behind saved sources, read again now under this reader's own permissions.

	Args:
		refs: [{"file": ..., "seq": ...}]; a pair whose file the reader may no longer open is left out.
	"""
	frappe.has_permission("KB Chunk", "report", throw=True)
	want = {(r["file"], cint(r["seq"])) for r in frappe.parse_json(refs)[:MAX_REFS]}
	files = {f for f in {f for f, _ in want} if _may_reread(f)}
	if not files:
		return []
	rows = frappe.db.sql(
		"SELECT file, seq, content FROM `tabKB Chunk` WHERE file IN %(files)s AND seq IN %(seqs)s",
		{"files": tuple(files), "seqs": tuple({s for _, s in want})},
		as_dict=True,
	)
	out = [r for r in rows if (r["file"], r["seq"]) in want]
	# reopening a chat reads the same passages again, so this read is on the trail too
	_audit("rag.search.passages", "", out)
	return out


def _may_reread(file: str) -> bool:
	"""Whether this user may read this file's chunks now: a Drive file they can open, or their own attachment."""
	doc = frappe.db.get_value("File", file, ["team", "attached_to_doctype", "owner"], as_dict=True)
	if not doc:
		return False
	if not doc.team:
		return doc.attached_to_doctype == CHAT and doc.owner == frappe.session.user
	return readable(file)


def _attached(vector: str, session: str, limit: int) -> list[dict]:
	# ponytail: a plain scan of one chat's chunks, which the vector index cannot filter to; fine
	# for the handful of files a chat holds
	rows = frappe.db.sql(
		"""
		SELECT c.file, c.seq, c.content, f.file_name,
		       VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(%(v)s)) AS distance
		FROM `tabKB Chunk` c JOIN `tabFile` f ON f.name = c.file
		WHERE f.attached_to_doctype = %(chat)s AND f.attached_to_name = %(s)s
		  AND f.owner = %(user)s AND c.embedding IS NOT NULL
		ORDER BY distance
		LIMIT %(n)s
		""",
		{"v": vector, "chat": CHAT, "s": session, "user": frappe.session.user, "n": limit},
		as_dict=True,
	)
	return [dict(r, attachment=True) for r in rows]


def _nearest(vector: str, candidates: int) -> list[frappe._dict]:
	# per connection, so _attached's query after this one searches as widely
	# the f-string reads EF_SEARCH, this module's own int, and never caller input
	frappe.db.sql(f"SET SESSION mhnsw_ef_search = {EF_SEARCH}")  # nosemgrep: frappe-sql-format-injection
	# Exactly ORDER BY VEC_DISTANCE_COSINE(...) ASC LIMIT n: any DESC, arithmetic wrapper or
	# missing LIMIT and MariaDB drops the vector index. The NULL guard stays because
	# VEC_DISTANCE_COSINE(NULL, v) is NULL and NULL sorts first; it keeps the index, measured.
	rows = frappe.db.sql(
		"""
		SELECT c.file, c.seq, c.content,
		       VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(%(v)s)) AS distance
		FROM `tabKB Chunk` c
		WHERE c.embedding IS NOT NULL
		ORDER BY VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(%(v)s))
		LIMIT %(n)s
		""",
		{"v": vector, "n": candidates},
		as_dict=True,
	)
	# the index hands back candidates in its own order, not by the exact distance, at any ef_search
	return sorted(rows, key=lambda r: r.distance)


def _readable(rows: list[frappe._dict], limit: int, allowed: dict) -> list[dict]:
	"""The first `limit` rows this user may read, one check per file; `allowed` carries answers across calls."""
	out = []
	for r in rows:
		if r.file not in allowed:
			allowed[r.file] = readable(r.file)
		if allowed[r.file]:
			out.append(r)
		if len(out) == limit:
			break
	return out


def readable(file: str) -> bool:
	"""Whether this user may read this Drive file: the one rule search, Metis and the sources share."""
	# only Drive files have a team: a chat's attachment is marked Active too, but it belongs to
	# its chat and must never answer from the knowledge base. bool, not `IS NOT NULL`: an empty
	# team is not a team, and a second spelling is a second rule.
	return (
		bool(frappe.db.get_value("File", file, "team"))
		and _reachable(file)
		and bool(user_has_permission(file, "read"))
	)


def _reachable(file: str) -> bool:
	"""Still in Drive and in no trashed folder: Drive trashes only the folder, and its checks skip ancestors."""
	# <=>, not !=: status is nullable, and SUM skips the NULL that != yields, so no status would read as active
	trashed, found = frappe.db.sql(
		"""
		WITH RECURSIVE ancestry AS (
			SELECT name, folder, status FROM `tabFile` WHERE name = %(f)s
			UNION ALL
			SELECT p.name, p.folder, p.status FROM ancestry a JOIN `tabFile` p ON p.name = a.folder
		)
		SELECT SUM(NOT (status <=> %(active)s)), COUNT(*) FROM ancestry
		""",
		{"f": file, "active": STATUS_ACTIVE},
	)[0]
	return bool(found) and not trashed
