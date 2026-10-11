import unittest
from unittest.mock import patch

import frappe

from rag import ingest
from rag.ingest import index_state, reindex
from rag.library import folder
from rag.tests.drive_fixture import drive_file, remove

PROBE = "rag-retry-probe@example.com"


def _outage(name: str) -> None:
	"""What an embedding outage, a full queue or a killed worker leaves behind: no chunks, no job."""
	frappe.db.delete("KB Chunk", {"file": name})


class TestIndexStates(unittest.TestCase):
	"""A format the indexer cannot read and a run that did not finish are different states: the first
	never indexes, the second may on another run, so only the second is worth a Retry."""

	def test_a_readable_file_without_chunks_is_an_error_not_an_unreadable_file(self):
		text = drive_file("outage.txt", b"The Kestrel allowance is 600 AUD.", "text/plain")
		photo = drive_file("photo.png", b"\x89PNG\r\n\x1a\nnot really an image", "image/png")
		try:
			self.assertEqual(index_state(text), "ready")
			self.assertEqual(index_state(photo), "failed")
			_outage(text)
			self.assertEqual(index_state(text), "error")
			states = {i["title"]: i.get("state") for i in folder()["items"]}
			self.assertEqual((states["outage.txt"], states["photo.png"]), ("error", "failed"))
		finally:
			remove(text, photo)

	def test_retry_queues_that_one_file_for_the_indexer(self):
		name = drive_file("outage.txt", b"The Kestrel allowance is 600 AUD.", "text/plain")
		try:
			_outage(name)
			with patch.object(ingest.frappe, "enqueue") as enqueue:
				reindex(name)
			self.assertEqual(enqueue.call_args.args, ("rag.ingest.index_file",))
			self.assertEqual(enqueue.call_args.kwargs["name"], name)
			self.assertEqual(enqueue.call_args.kwargs["job_id"], f"rag-index-{name}")
		finally:
			remove(name)

	def test_nobody_reindexes_a_file_they_cannot_read(self):
		name = drive_file("private.txt", b"The Zephyr launch code is 4417.", "text/plain")
		try:
			frappe.get_doc(
				{
					"doctype": "User",
					"email": PROBE,
					"first_name": "Probe",
					"send_welcome_email": 0,
					"roles": [{"role": "Drive User"}],
				}
			).insert(ignore_permissions=True)
			frappe.set_user(PROBE)
			with self.assertRaises(frappe.PermissionError):
				reindex(name)
		finally:
			frappe.set_user("Administrator")
			frappe.db.rollback()
			remove(name)
