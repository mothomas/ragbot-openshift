from unittest import TestCase
from unittest.mock import patch

import frappe
import requests

from rag import ingest
from rag.tests import test_chat as tc


class TestIndexLog(TestCase):
	"""Frappe logs a failed job with every frame's variables; none of them may be the document's text."""

	def setUp(self):
		self.session = tc._a_chat("index log")
		self.file = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": "log.txt",
				"content": tc.FACT,
				"is_private": 1,
				"attached_to_doctype": "AI Chat Session",
				"attached_to_name": self.session,
			}
		).insert()
		frappe.db.commit()

	def tearDown(self):
		frappe.db.rollback()
		frappe.db.delete("KB Chunk", {"file": self.file.name})
		frappe.db.delete("File", {"name": self.file.name})
		frappe.db.delete("AI Chat Session", {"name": self.session})
		frappe.db.commit()

	def test_a_failed_job_logs_its_stack_without_the_text(self):
		refused = requests.HTTPError("400 Client Error", response=requests.Response())
		refused.response.status_code = 400
		with patch("rag.ingest.embed", side_effect=refused):
			try:
				ingest.index_file(self.file.name)
			except requests.HTTPError:
				logged = frappe.get_traceback(with_context=True)  # what execute_job writes to the Error Log
			else:
				self.fail("index_file swallowed the embedding failure")
		self.assertIn("in index_file", logged)
		self.assertNotIn("PELICAN-7", logged)
