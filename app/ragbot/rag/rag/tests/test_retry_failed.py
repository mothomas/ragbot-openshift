import unittest
from unittest.mock import patch

import frappe
from frappe.utils import add_days, now_datetime

from rag import ingest
from rag.ingest import RETRY_DAYS, retry_failed
from rag.tests.drive_fixture import drive_file, remove


def _outage(name: str) -> None:
	"""What a full queue, an embedding outage or a killed worker leaves behind: no chunks, no job."""
	frappe.db.delete("KB Chunk", {"file": name})
	frappe.db.commit()


def _queued() -> set[str]:
	with patch.object(ingest.frappe, "enqueue") as enqueue:
		retry_failed()
	return {c.kwargs["name"] for c in enqueue.call_args_list}


class TestRetryFailed(unittest.TestCase):
	"""An indexing failure another run may clear is retried without an operator, and only for a day."""

	def test_it_queues_a_readable_file_whose_indexing_did_not_finish(self):
		name = drive_file("outage.txt", b"The Kestrel allowance is 600 AUD.", "text/plain")
		try:
			self.assertNotIn(name, _queued())  # it is indexed
			_outage(name)
			self.assertIn(name, _queued())
		finally:
			remove(name)

	def test_it_leaves_a_format_the_indexer_cannot_read(self):
		name = drive_file("photo.png", b"\x89PNG\r\n\x1a\nnot really an image", "image/png")
		try:
			self.assertEqual(ingest.index_state(name), "failed")
			self.assertNotIn(name, _queued())
		finally:
			remove(name)

	def test_it_gives_up_on_a_file_that_has_been_failing_for_longer_than_the_window(self):
		name = drive_file("stale.txt", b"The Kestrel allowance is 600 AUD.", "text/plain")
		try:
			_outage(name)
			frappe.db.set_value(
				"File", name, "modified", add_days(now_datetime(), -RETRY_DAYS - 1), update_modified=False
			)
			frappe.db.commit()
			self.assertNotIn(name, _queued())
			self.assertEqual(ingest.index_state(name), "error")  # still visible, with its own Retry
		finally:
			remove(name)
