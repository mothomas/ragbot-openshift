from unittest import TestCase
from unittest.mock import patch

import frappe

from rag.chat import purge_orphan_attachments
from rag.ingest import CHAT, EMBED_DIM, index_file
from rag.tests import test_chat as tc


class TestOrphanAttachments(TestCase):
	"""A file attached to a chat that never started goes after a day, with its chunks; nothing else does.
	The purge commits file by file, so the setup is removed by name afterwards."""

	def setUp(self):
		self.files, self.sessions = [], []

	def tearDown(self):
		frappe.db.rollback()
		for name in self.files:
			if frappe.db.exists("File", name):
				frappe.delete_doc("File", name, ignore_permissions=True, delete_permanently=True)
		for session in self.sessions:
			frappe.db.delete("AI Chat Message", {"session": session})
			frappe.db.delete("AI Chat Session", {"name": session})
		frappe.db.commit()

	def _chat_file(self, session: str, days_old: int) -> str:
		doc = {"doctype": "File", "file_name": "orphan.txt", "content": tc.FACT, "is_private": 1}
		name = frappe.get_doc(doc | {"attached_to_doctype": CHAT, "attached_to_name": session}).insert().name
		then = frappe.utils.add_days(frappe.utils.now_datetime(), -days_old)
		frappe.db.set_value("File", name, "creation", then, update_modified=False)
		self.files.append(name)
		return name

	def test_only_a_day_old_file_of_a_chat_that_never_started_goes(self):
		orphan = self._chat_file("never-started-" + frappe.generate_hash(length=6), days_old=2)
		fresh = self._chat_file("not-yet-started-" + frappe.generate_hash(length=6), days_old=0)
		self.sessions.append(tc._a_chat("started"))
		kept = self._chat_file(self.sessions[0], days_old=2)
		with patch("rag.ingest.embed", side_effect=lambda texts, prefix="": [[0.1] * EMBED_DIM for _ in texts]):
			index_file(orphan)
		self.assertTrue(frappe.db.count("KB Chunk", {"file": orphan}))
		purge_orphan_attachments()
		self.assertFalse(frappe.db.exists("File", orphan))
		self.assertFalse(frappe.db.count("KB Chunk", {"file": orphan}))
		self.assertTrue(frappe.db.exists("File", fresh))
		self.assertTrue(frappe.db.exists("File", kept))
