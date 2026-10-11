import frappe
from frappe import _

from rag.ingest import CHAT, MESSAGE, index_state


def _again_on_conflict(work, attempts=3):
	"""Run work, again in a fresh transaction while an index job's commit conflicts (1020, or its row lock)."""
	for _attempt in range(attempts - 1):
		try:
			return work()
		except frappe.QueryDeadlockError, frappe.QueryTimeoutError:
			frappe.db.rollback()
	return work()


def _drop_chunks(files: list[str]) -> None:
	"""Lock the files and drop their chunks; call it before delete_doc, whose on_trash deletes bytes for good."""
	if files:
		frappe.db.sql("SELECT name FROM `tabFile` WHERE name IN %s FOR UPDATE", (tuple(files),))
		frappe.db.delete("KB Chunk", {"file": ("in", files)})


@frappe.whitelist(methods=["POST"])
def delete_chat(session: str) -> None:
	"""Delete one of the user's chats with its messages, all or nothing."""

	def work():
		frappe.get_doc(CHAT, session).check_permission("delete")
		attached = {"attached_to_doctype": CHAT, "attached_to_name": session}
		_drop_chunks(frappe.get_all("File", filters=attached, pluck="name"))
		# ponytail: one delete per message, fine for hundreds; delete_doc still checks each one
		for name in frappe.get_all(MESSAGE, filters={"session": session}, pluck="name"):
			frappe.delete_doc(MESSAGE, name, delete_permanently=True)
		# for good, or Deleted Document keeps the whole chat for System Managers, as ADR-014 says
		frappe.delete_doc(CHAT, session, delete_permanently=True)

	_again_on_conflict(work)


@frappe.whitelist(methods=["GET"])
def attachments(session: str) -> list[dict]:
	"""The user's files attached to a chat, each with its index state; the chat may not exist yet."""
	if frappe.db.exists(CHAT, session):
		frappe.get_doc(CHAT, session).check_permission("read")
	files = frappe.get_all(
		"File",
		filters={"attached_to_doctype": CHAT, "attached_to_name": session, "owner": frappe.session.user},
		fields=["name", "file_name", "file_size"],
		order_by="creation asc",
	)
	return [dict(f, state=index_state(f.name)) for f in files]


@frappe.whitelist(methods=["POST"])
def detach(file: str) -> None:
	"""Remove a file from the chat it was attached to, with its chunks."""

	def work():
		doc = frappe.get_doc("File", file)
		if doc.attached_to_doctype != CHAT or doc.owner != frappe.session.user:
			frappe.throw(_("Not permitted"), frappe.PermissionError)
		_drop_chunks([file])
		frappe.delete_doc("File", file, delete_permanently=True)

	_again_on_conflict(work)


def purge_orphan_attachments():
	"""Delete chat attachments over a day old whose chat was never created, with their chunks."""
	if not frappe.db.table_exists(CHAT):  # frappe_ai is optional
		return
	orphans = frappe.db.sql(
		"""SELECT f.name FROM `tabFile` f LEFT JOIN `tabAI Chat Session` s ON s.name = f.attached_to_name
		WHERE f.attached_to_doctype = %s AND IFNULL(f.team, '') = '' AND s.name IS NULL AND f.creation < %s""",
		(CHAT, frappe.utils.add_days(frappe.utils.now_datetime(), -1)),
		pluck=True,
	)
	for name in orphans:
		_drop_chunks([name])
		frappe.delete_doc("File", name, ignore_permissions=True, delete_permanently=True)
		# the bytes are already gone, so a conflict on the next file must not roll this row back
		frappe.db.commit()  # nosemgrep: frappe-manual-commit
