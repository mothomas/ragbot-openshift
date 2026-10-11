import frappe
from drive.api.list import files, shared
from drive.api.permissions import get_teams, user_has_permission
from drive.utils import STATUS_ACTIVE, get_default_team, get_home_folder

from rag.ingest import index_state
from rag.search import readable


@frappe.whitelist(methods=["GET"])
def folder(folder: str = "", search: str = "") -> dict:
	"""One Drive folder ("" for home plus shares), listed by Drive itself so its permission checks apply."""
	home = get_home_folder(get_default_team())["name"]
	current = folder or home
	rows = files(team="all" if search else get_default_team(), entity_name=current, search=search or None)
	if search or current == home:
		seen = {r["name"] for r in rows}
		rows += [r for r in shared(team="all", search=search or None) if r["name"] not in seen]
	return {
		# what Drive's upload_file and create_folder need: the folder and its team
		"folder": current,
		"team": frappe.db.get_value("File", current, "team"),
		"path": [{"name": "", "title": "Documents"}, *([] if current == home else _path(current, home))],
		"can_upload": bool(user_has_permission(current, "upload")),
		"items": [
			{
				"name": r["name"],
				"title": r["file_name"],
				"is_folder": bool(r.get("is_folder")),
				"size": r.get("file_size"),
				"modified": r.get("modified"),
				"type": r.get("file_type"),
				"owner": r.get("owner"),
				"owner_name": r.get("owner_full_name"),
				"children": r.get("child_count"),
				"write": bool(r.get("write")),
				**({} if r.get("is_folder") else {"state": index_state(r["name"])}),
			}
			for r in rows
		],
	}


def _path(current: str, home: str) -> list[dict]:
	# a folder shared from someone else's Drive stops at the first parent this user can't read,
	# so their folder names never show
	out = []
	while current and current != home and user_has_permission(current, "read"):
		title, parent = frappe.db.get_value("File", current, ["file_name", "folder"])
		out.append({"name": current, "title": title})
		current = parent
	return out[::-1]


@frappe.whitelist(methods=["GET"])
def documents() -> list[dict]:
	"""Drive files this user may read, newest first, each marked indexed or not."""
	frappe.has_permission("KB Chunk", "report", throw=True)
	return _readable_files()


def _readable_files() -> list[dict]:
	# search.readable walks Drive's permissions once per file, so the SQL below narrows the walk to
	# the files this reader could plausibly read; readable() alone decides, so this list cannot
	# disagree with what the chat may quote, and a filter that let too much through only costs time.
	me = frappe.session.user
	teams = get_teams(me)
	# Drive files a share as one Drive Permission row per entity, naming a user, a team (in `user`)
	# or everyone (an empty `user`), and access reaches everything inside that entity
	granted = frappe.get_all("Drive Permission", filters={"user": ["in", ["", me, *teams]]}, pluck="entity")
	public = frappe.get_all("Drive Team", filters={"public": 1}, pluck="name")
	rows = frappe.db.sql(
		"""
		WITH RECURSIVE reach AS (
			SELECT name FROM `tabFile` WHERE name IN %(granted)s
			-- UNION, not UNION ALL: a folder cycle would otherwise run to
			-- max_recursive_iterations and truncate this list without saying so
			UNION
			SELECT c.name FROM `tabFile` c JOIN reach r ON c.folder = r.name
		)
		SELECT f.name, f.file_name, f.owner, f.modified, f.file_size, f.mime_type,
		       EXISTS(SELECT 1 FROM `tabKB Chunk` c WHERE c.file = f.name) AS indexed
		FROM `tabFile` f
		WHERE f.is_folder = 0 AND f.team IS NOT NULL AND f.status = %(active)s
		  AND (%(everything)s OR f.owner = %(me)s OR f.team IN %(teams)s
		       OR f.name IN (SELECT name FROM reach))
		ORDER BY f.modified DESC
		""",
		{
			"active": STATUS_ACTIVE,
			"me": me,
			# Administrator reads every file (drive/api/permissions.py:257), so for it this filter
			# must not filter
			"everything": int(me == "Administrator"),
			# a tuple is what `IN %(x)s` expands; an empty one is a syntax error
			"granted": tuple(granted) or ("",),
			"teams": tuple(teams + public) or ("",),
		},
		as_dict=True,
	)
	return [dict(r, indexed=bool(r.indexed)) for r in rows if readable(r.name)]
