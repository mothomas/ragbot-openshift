from unittest import TestCase
from unittest.mock import patch

import frappe

from rag import ingest
from rag.tests import test_chat as tc


class TestIndexRetry(TestCase):
	"""A file another request is holding while it embeds must not stay unindexed: the job asks to run again."""

	def setUp(self):
		self.session = tc._a_chat("retry")
		self.file = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": "retry.txt",
				"content": tc.FACT,
				"is_private": 1,
				"attached_to_doctype": "AI Chat Session",
				"attached_to_name": self.session,
			}
		).insert()
		frappe.db.commit()
		self.worker = tc._worker()

	def tearDown(self):
		self.worker.close()
		frappe.db.rollback()
		frappe.db.delete("KB Chunk", {"file": self.file.name})
		frappe.db.delete("File", {"name": self.file.name})
		frappe.db.delete("AI Chat Message", {"session": self.session})
		frappe.db.delete("AI Chat Session", {"name": self.session})
		frappe.db.commit()

	def test_a_file_held_by_another_request_while_it_embeds_is_indexed_on_the_retry(self):
		def embed_while_the_file_is_held(texts, prefix="search_document"):
			# the lock, not a committed change: ADR-016 turns snapshot isolation off, so the re-read
			# no longer refuses a row another request has already committed
			self.worker.sql("SELECT name FROM `tabFile` WHERE name=%s FOR UPDATE", self.file.name)
			return [[0.1] * ingest.EMBED_DIM for _ in texts]

		with patch("rag.ingest.embed", side_effect=embed_while_the_file_is_held):
			self.assertRaises(frappe.RetryBackgroundJobError, ingest.index_file, self.file.name)
		frappe.db.rollback()  # what execute_job does before it runs the job again
		self.worker.rollback()  # the request that held it has ended by the time the retry runs
		with patch(
			"rag.ingest.embed", side_effect=lambda texts, prefix="": [[0.1] * ingest.EMBED_DIM for _ in texts]
		):
			self.assertGreater(ingest.index_file(self.file.name)["chunks"], 0)
