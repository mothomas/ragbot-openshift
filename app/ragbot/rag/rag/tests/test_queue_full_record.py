from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import frappe

from rag import ingest


class TestQueueFullRecord(TestCase):
	"""A file left unindexed by a full queue is linked from its Error Log row, where Error Log's filters look."""

	def test_the_row_links_the_file(self):
		with (
			patch.object(ingest.frappe, "enqueue", side_effect=frappe.QueueOverloaded("too many")),
			patch.object(ingest.frappe, "log_error") as log_error,
		):
			ingest._enqueue(SimpleNamespace(name="file1"))
		self.assertEqual(log_error.call_args.kwargs.get("reference_doctype"), "File")
		self.assertEqual(log_error.call_args.kwargs.get("reference_name"), "file1")
