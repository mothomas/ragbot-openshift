from unittest import TestCase
from unittest.mock import patch

import frappe

from rag import ingest
from rag.tests import test_chat as tc


class TestReindexAll(TestCase):
	"""The upload path and health() send an operator to reindex_all, so it must reach chat attachments."""

	def tearDown(self):
		frappe.db.rollback()

	def test_a_chat_attachment_is_queued(self):
		session = tc._a_chat("reindex")
		doc = {"doctype": "File", "file_name": "reindex.txt", "content": tc.FACT, "is_private": 1}
		chat_file = frappe.get_doc(doc | {"attached_to_doctype": ingest.CHAT, "attached_to_name": session}).insert()
		with patch.object(ingest.frappe, "enqueue") as enqueue:
			ingest.reindex_all()
		self.assertIn(chat_file.name, {c.kwargs["name"] for c in enqueue.call_args_list})
