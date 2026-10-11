from unittest import TestCase
from unittest.mock import patch

import frappe

from rag import ingest
from rag.tests import test_chat as tc


class TestIndexLimits(TestCase):
	"""A file too large to index gets no chunks and one Error Log row naming it, not a job killed unrecorded."""

	def tearDown(self):
		frappe.db.rollback()

	def _file(self):
		doc = {"doctype": "File", "file_name": "big.txt", "content": tc.FACT * 20, "is_private": 1}
		session = tc._a_chat("big")
		return frappe.get_doc(doc | {"attached_to_doctype": ingest.CHAT, "attached_to_name": session}).insert()

	def _logged(self, name):
		return frappe.db.count("Error Log", {"reference_doctype": "File", "reference_name": name})

	def test_a_file_over_the_byte_cap_is_not_read(self):
		f = self._file()
		with patch.object(ingest, "MAX_FILE_BYTES", 10), patch.object(ingest, "extract_text") as read:
			self.assertEqual(ingest.index_file(f.name)["chunks"], 0)
		read.assert_not_called()
		self.assertEqual(self._logged(f.name), 1)

	def test_a_document_that_outlasts_the_budget_is_recorded(self):
		f = self._file()
		with patch.object(ingest, "EMBED_BUDGET_S", -1):
			self.assertEqual(ingest.index_file(f.name)["chunks"], 0)
		self.assertEqual(frappe.db.count("KB Chunk", {"file": f.name}), 0)
		self.assertEqual(self._logged(f.name), 1)
