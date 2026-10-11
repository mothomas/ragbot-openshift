from unittest import TestCase

import frappe

from rag.chat import delete_chat, detach
from rag.ingest import CHAT
from rag.tests import test_chat as tc


class TestDeletedForGood(TestCase):
	"""A chat the user deletes leaves no copy in Deleted Document (ADR-014)."""

	def tearDown(self):
		frappe.db.rollback()

	def _kept(self, doctype, name):
		return frappe.db.count("Deleted Document", {"deleted_doctype": doctype, "deleted_name": name})

	def test_a_deleted_chat_leaves_no_copy(self):
		session = tc._a_chat("gone")
		messages = frappe.get_all("AI Chat Message", filters={"session": session}, pluck="name")
		delete_chat(session)
		self.assertFalse(self._kept(CHAT, session))
		self.assertFalse(sum(self._kept("AI Chat Message", m) for m in messages))

	def test_a_detached_file_leaves_no_copy(self):
		doc = {"doctype": "File", "file_name": "gone.txt", "content": tc.FACT, "is_private": 1}
		session = tc._a_chat("x")
		file = frappe.get_doc(doc | {"attached_to_doctype": CHAT, "attached_to_name": session}).insert().name
		detach(file)
		self.assertFalse(self._kept("File", file))
