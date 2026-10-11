import os
from unittest import TestCase
from unittest.mock import patch

import frappe

from rag.chat import delete_chat, detach, purge_orphan_attachments
from rag.ingest import CHAT
from rag.tests import test_chat as tc


class TestConflictKeepsBytes(TestCase):
	"""A delete that keeps meeting an index job gives up with the file whole, never a row without bytes.
	Its retries roll back, so the setup is committed and removed by name afterwards."""

	def setUp(self):
		self.session = tc._a_chat("kept")
		doc = {"doctype": "File", "file_name": "kept.txt", "content": tc.FACT, "is_private": 1}
		self.file = frappe.get_doc(doc | {"attached_to_doctype": CHAT, "attached_to_name": self.session}).insert()
		frappe.db.commit()

	def tearDown(self):
		frappe.db.rollback()
		frappe.delete_doc("AI Chat Session", self.session, force=True, ignore_missing=True)
		frappe.db.delete("AI Chat Message", {"session": self.session})
		frappe.db.delete("File", {"name": self.file.name})
		frappe.db.commit()
		if os.path.exists(self.file.get_full_path()):
			os.remove(self.file.get_full_path())

	def _chunks_conflict(self):
		delete = frappe.db.delete

		def conflict(doctype, *args, **kwargs):
			if doctype == "KB Chunk":
				raise frappe.QueryDeadlockError("1020")
			return delete(doctype, *args, **kwargs)

		return patch.object(frappe.db, "delete", side_effect=conflict)

	def test_detach_keeps_the_bytes(self):
		with self._chunks_conflict(), self.assertRaises(frappe.QueryDeadlockError):
			detach(self.file.name)
		self.assertTrue(os.path.exists(self.file.get_full_path()))

	def test_delete_chat_keeps_the_bytes(self):
		with self._chunks_conflict(), self.assertRaises(frappe.QueryDeadlockError):
			delete_chat(self.session)
		self.assertTrue(os.path.exists(self.file.get_full_path()))

	def test_the_daily_purge_keeps_the_bytes(self):
		orphan = {"attached_to_name": "never-started", "creation": "2020-01-01 00:00:00"}
		frappe.db.set_value("File", self.file.name, orphan, update_modified=False)
		frappe.db.commit()
		with self._chunks_conflict(), self.assertRaises(frappe.QueryDeadlockError):
			purge_orphan_attachments()
		self.assertTrue(os.path.exists(self.file.get_full_path()))
